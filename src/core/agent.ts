import Groq from 'groq-sdk';
import type { ClientOptions } from 'groq-sdk';
import { executeTool } from '../tools/tools.js';
import { validateReadBeforeEdit, getReadBeforeEditError, markFileAsRead } from '../tools/validators.js';
import { ALL_TOOL_SCHEMAS, DANGEROUS_TOOLS, APPROVAL_REQUIRED_TOOLS } from '../tools/tool-schemas.js';
import { ConfigManager } from '../utils/local-settings.js';
import { getProxyAgent, getProxyInfo } from '../utils/proxy-config.js';
import { resolveSmartPath, canonicalizePath } from '../utils/file-ops.js';
import {
  FREE_TIER_MODEL_POOL,
  supportsParallelToolCalls,
  getOptimalReasoningEffort,
} from '../utils/models.js';
import {
  SavedSession,
  saveSession,
  findSessionByQuery,
} from '../utils/session-store.js';
import { buildLessonsPromptBlock, loadLessons } from '../utils/lessons.js';
import fs from 'fs';
import path from 'path';

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Free-Tier token budget constants (Groq: 8.000 TPM per model, per organization)
// Request size = prompt tokens + reserved completion tokens → must stay ≤ 8.000!
// ─────────────────────────────────────────────────────────────────────────────
const TPM_LIMIT = 8000;
const TPM_SAFETY_MARGIN = 350;
const MAX_COMPLETION_TOKENS = 3072; // was 8000 — the original cause of instant HTTP 413!
const MIN_COMPLETION_TOKENS = 1024;
const CHARS_PER_TOKEN = 3.4; // conservative estimate for mixed code/JSON
const TOOLS_SCHEMA_TOKENS = Math.ceil(JSON.stringify(ALL_TOOL_SCHEMAS).length / CHARS_PER_TOKEN);

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type FailoverErrorKind =
  | 'auth'
  | 'payload'      // 413 TPM / oversized request
  | 'rate'         // 429 RPM/TPM/TPD
  | 'model'        // 404 / decommissioned
  | 'tool_salvage' // 400 tool_use_failed / malformed JSON generation
  | 'server'
  | 'network'
  | 'abort'
  | 'unknown';

interface ClassifiedGroqError {
  kind: FailoverErrorKind;
  summary: string;
  code?: string;
  bucket?: string;
  isDaily?: boolean;
  retryAfterSeconds?: number;
  failedGeneration?: string;
}

function classifyGroqError(error: any): ClassifiedGroqError {
  const status = typeof error?.status === 'number' ? error.status : 0;
  const payload = error?.error?.error ?? error?.error ?? {};
  const code = payload?.code ? String(payload.code) : '';
  const message: string = payload?.message || error?.message || String(error ?? 'unknown error');
  const failedGeneration: string | undefined = payload?.failed_generation || error?.failed_generation;

  const summary = code ? `API ${status || ''} ${code}: ${message}`.trim() : `API ${status || ''}: ${message}`.trim();

  if (error?.name === 'AbortError' || /request was aborted|operation was aborted/i.test(message)) {
    return { kind: 'abort', summary };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', summary, code };
  }
  if (status === 413) {
    const bucketMatch = message.match(/tokens per (minute|day)/i);
    return { kind: 'payload', summary, code, bucket: bucketMatch ? bucketMatch[0] : 'TPM' };
  }
  if (status === 429) {
    const isDaily = /per day|daily|TPD|RPD|requests per day/i.test(message);
    let retryAfterSeconds: number | undefined;
    try {
      const headers: any = error?.headers;
      const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
      const parsed = raw != null ? parseFloat(String(raw)) : NaN;
      if (!isNaN(parsed) && parsed > 0) retryAfterSeconds = parsed;
    } catch {
      // headers not accessible
    }
    const bucketMatch = message.match(/(tokens per minute|tokens per day|requests per minute|requests per day)/i);
    return { kind: 'rate', summary, code, isDaily, retryAfterSeconds, bucket: bucketMatch ? bucketMatch[0] : 'rate limit' };
  }
  if (status === 404 || code === 'model_not_found' || /model_decommissioned|decommissioned|model not found/i.test(message)) {
    return { kind: 'model', summary, code };
  }
  if (status === 400 && (code === 'tool_use_failed' || code === 'json_validate_failed' || code === 'json_not_valid' || failedGeneration)) {
    return { kind: 'tool_salvage', summary, code, failedGeneration };
  }
  if (status >= 500) {
    return { kind: 'server', summary, code };
  }
  if (status === 0 && /fetch failed|network|ENOTFOUND|ECONN|EAI_AGAIN|socket|timeout|aborted/i.test(message)) {
    return { kind: 'network', summary };
  }
  return { kind: 'unknown', summary, code };
}

export class Agent {
  private client: Groq | null = null;
  private activeApiKey: string | null = null;
  private messages: Message[] = [];
  private apiKey: string | null = null;
  private model: string;
  private temperature: number;
  private sessionAutoApprove: boolean = false;
  private systemMessage: string;
  private configManager: ConfigManager;
  private proxyOverride?: string;
  private onToolStart?: (name: string, args: Record<string, any>) => void;
  private onToolEnd?: (name: string, result: any) => void;
  private onToolApproval?: (toolName: string, toolArgs: Record<string, any>) => Promise<{ approved: boolean; autoApproveSession?: boolean }>;
  private onThinkingText?: (content: string, reasoning?: string) => void;
  private onFinalMessage?: (content: string, reasoning?: string) => void;
  private onMaxIterations?: (maxIterations: number) => Promise<boolean>;
  private onApiUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; total_time?: number }) => void;
  private onError?: (error: string) => Promise<boolean>;
  private onStatus?: (message: string) => void;
  private onStreamDelta?: (delta: { content: string; reasoning: string }) => void;
  private requestCount: number = 0;
  private currentAbortController: AbortController | null = null;
  private isInterrupted: boolean = false;

  // ── Session intelligence: active-file ledger, edit history and read cache ──
  private sessionFileLedger = new Map<string, { lastAction: string; detail: string; lineCount?: number; ts: number }>();
  private editLedger: string[] = [];
  private readResultCache = new Map<string, { content: any; message: string }>();
  private readCacheIndex = new Map<string, Set<string>>(); // canonical path -> cache keys

  // ── Session memory (auto-save/resume em ~/.groq/sessions) + aprovação por arquivo ──
  private sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  private sessionCreatedAt = new Date().toISOString();
  private sessionTitle = '';
  private approvedFiles = new Set<string>();
  private lessonsFingerprint = '';
  private checklistAskedThisTurn = false;

  private constructor(
    model: string,
    temperature: number,
    systemMessage: string | null,
    debug?: boolean,
    proxyOverride?: string
  ) {
    this.model = model;
    this.temperature = temperature;
    this.configManager = new ConfigManager();
    this.proxyOverride = proxyOverride;

    // Set debug mode
    debugEnabled = debug || false;

    // Build system message
    if (systemMessage) {
      this.systemMessage = systemMessage;
    } else {
      this.systemMessage = this.buildDefaultSystemMessage();
    }

    // Add system message to conversation
    this.messages.push({ role: 'system', content: this.systemMessage });

    // Inject user lessons (memória de preferências/correções de ~/.groq/lessons.md)
    const lessonsBlock = buildLessonsPromptBlock();
    if (lessonsBlock) {
      this.messages.push({ role: 'system', content: lessonsBlock });
      this.lessonsFingerprint = this.getLessonsFingerprint();
    }

    // Load project context if available
    try {
      const explicitContextFile = process.env.GROQ_CONTEXT_FILE;
      const baseDir = process.env.GROQ_CONTEXT_DIR || process.cwd();
      const contextPath = explicitContextFile || path.join(baseDir, '.groq', 'context.md');
      const contextLimit = parseInt(process.env.GROQ_CONTEXT_LIMIT || '20000', 10);
      if (fs.existsSync(contextPath)) {
        const ctx = fs.readFileSync(contextPath, 'utf-8');
        const trimmed = ctx.length > contextLimit ? ctx.slice(0, contextLimit) + '\n... [truncated]' : ctx;
        const contextSource = explicitContextFile ? contextPath : '.groq/context.md';
        this.messages.push({
          role: 'system',
          content: `Project context loaded from ${contextSource}. Use this as high-level reference when reasoning about the repository.\n\n${trimmed}`
        });
      }
    } catch (error) {
      if (debugEnabled) {
        debugLog('Failed to load project context:', error);
      }
    }
  }

  static async create(
    model: string,
    temperature: number,
    systemMessage: string | null,
    debug?: boolean,
    proxyOverride?: string
  ): Promise<Agent> {
    // Check for default model in config if model not explicitly provided
    const configManager = new ConfigManager();
    const defaultModel = configManager.getDefaultModel();
    const selectedModel = defaultModel || model;

    const agent = new Agent(
      selectedModel,
      temperature,
      systemMessage,
      debug,
      proxyOverride
    );
    return agent;
  }

  private buildDefaultSystemMessage(): string {
    return `You are a coding assistant powered by ${this.model} on Groq (Free Tier: only 8.000 tokens/min — BE TOKEN-EFFICIENT in every tool call).

LANGUAGE: Always respond in the same language the user writes in (Portuguese/Brazilian Portuguese if they write in Portuguese) — including your reasoning/thinking text. Keep final answers short: 1-3 sentences plus a brief summary of what changed.

THINKING: Plan before acting. Before the first tool call, reason about the goal, the exact files/lines involved and the edit strategy. Think carefully on every code modification (exact old_text, line ranges, side effects) instead of rushing — quality over speed.

TOOLS (all accept absolute Android paths like /storage/emulated/0/Download/file.html, ~/ paths, or relative paths — never waste turns listing directories to "find" a file whose path you already know):
- read_file: without start_line/end_line, files >180 lines return a structural OUTLINE + first 90 lines instead of the full content. NEVER re-read the same file/region twice in a session.
- grep_file: search inside ONE file for a pattern (returns exact line numbers) — the fastest way to locate colors, ids, functions or text in large files.
- search_files: find text across many files at once.
- list_files: only when you truly don't know the directory structure.
- edit_file: exact old_text→new_text replacement; supports batch edits:[{old_text,new_text}] for multiple changes in one call.
- replace_lines: rewrite an exact line range (start_line, end_line, new_content) — ideal for large files once grep/outline gave you the line numbers.
- create_file: for new files only (or overwrite=true to fully replace an existing one).
- execute_command: quick commands only (tests, builds, ls, git status) — never servers or long-running processes.

LARGE-FILE WORKFLOW (files >500 lines, e.g. single-file HTML apps):
1. read_file without lines → outline + first 90 lines
2. grep_file to find the exact lines you need
3. read_file with start_line/end_line for a small window if context is missing
4. edit_file (exact text) or replace_lines (exact line range)
5. verify with grep_file

SELF-VERIFICATION (AUTO): if you edited files in this turn, BEFORE finishing re-check EVERY user request against the final file with grep_file (e.g. did the requested background-color actually land on the button?). If anything requested is missing, fix it now. End with a short checklist of what was done.

MEMORY: when the user corrects you or states a durable preference, save it immediately with add_lesson so you remember it in ALL future sessions.

STRICT RULES:
- MANDATORY: read_file or grep_file the target file before any edit_file/replace_lines.
- Text matching in edit_file must be EXACT (including whitespace/indentation).
- Tool outputs are capped — work with windows, outlines and grep, never full-file dumps.
- NEVER prefix tool names with "repo_browser.".
- Check the [SESSION FILE CONTEXT] system note: reuse exact paths and line knowledge already collected this session.
- Prefer the grep_file TOOL for searching inside files — NOT shell grep/awk via execute_command (saves tokens and avoids approval prompts).
- Don't generate markdown tables.

IMPLEMENTATION TASKS: when asked to build/create/modify something, USE TOOLS on real files — never reply with text-only plans.
When asked about your identity, identify yourself as a coding assistant running on the ${this.model} model via Groq.`;
  }

  public setToolCallbacks(callbacks: {
    onToolStart?: (name: string, args: Record<string, any>) => void;
    onToolEnd?: (name: string, result: any) => void;
    onToolApproval?: (toolName: string, toolArgs: Record<string, any>) => Promise<{ approved: boolean; autoApproveSession?: boolean }>;
    onThinkingText?: (content: string) => void;
    onFinalMessage?: (content: string) => void;
    onMaxIterations?: (maxIterations: number) => Promise<boolean>;
    onApiUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; total_time?: number }) => void;
    onError?: (error: string) => Promise<boolean>;
    onStatus?: (message: string) => void;
    onStreamDelta?: (delta: { content: string; reasoning: string }) => void;
  }) {
    this.onToolStart = callbacks.onToolStart;
    this.onToolEnd = callbacks.onToolEnd;
    this.onToolApproval = callbacks.onToolApproval;
    this.onThinkingText = callbacks.onThinkingText;
    this.onFinalMessage = callbacks.onFinalMessage;
    this.onMaxIterations = callbacks.onMaxIterations;
    this.onApiUsage = callbacks.onApiUsage;
    this.onError = callbacks.onError;
    this.onStatus = callbacks.onStatus;
    this.onStreamDelta = callbacks.onStreamDelta;
  }

  private notifyStatus(message: string): void {
    debugLog('Status:', message);
    if (this.onStatus) {
      try {
        this.onStatus(message);
      } catch {
        // never let a UI callback break the agent loop
      }
    }
  }

  public setApiKey(apiKey: string): void {
    debugLog('Setting API key in agent...');
    debugLog('API key provided:', apiKey ? `${apiKey.substring(0, 8)}...` : 'empty');
    this.apiKey = apiKey;
    this.activeApiKey = apiKey;

    // Get proxy configuration (with override if provided)
    const proxyAgent = getProxyAgent(this.proxyOverride);
    const proxyInfo = getProxyInfo(this.proxyOverride);

    if (proxyInfo.enabled) {
      debugLog(`Using ${proxyInfo.type} proxy: ${proxyInfo.url}`);
    }

    // Initialize Groq client with proxy if available
    const clientOptions: ClientOptions = { apiKey };
    if (proxyAgent) {
      clientOptions.httpAgent = proxyAgent;
    }

    this.client = new Groq(clientOptions);
    debugLog('Groq client initialized with provided API key' + (proxyInfo.enabled ? ' and proxy' : ''));
  }

  /** Re-init the Groq client only when the key actually changes (used for key rotation). */
  private ensureClient(apiKey: string): void {
    if (this.client && this.activeApiKey === apiKey) return;
    this.setApiKey(apiKey);
  }

  public saveApiKey(apiKey: string): void {
    this.configManager.setApiKey(apiKey);
    this.setApiKey(apiKey);
  }

  public clearApiKey(): void {
    this.configManager.clearApiKey();
    this.apiKey = null;
    this.activeApiKey = null;
    this.client = null;
  }

  public clearHistory(): void {
    // /clear inicia uma sessão NOVA (a anterior permanece salva em ~/.groq/sessions)
    this.sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.sessionCreatedAt = new Date().toISOString();
    this.sessionTitle = '';
    this.approvedFiles.clear();
    this.sessionFileLedger.clear();
    this.editLedger.length = 0;
    this.readResultCache.clear();
    this.readCacheIndex.clear();
    this.messages = this.messages.filter(msg => msg.role === 'system');
  }

  public setModel(model: string, options: { persist?: boolean } = {}): void {
    const persist = options.persist !== false;
    this.model = model;
    if (persist) {
      this.configManager.setDefaultModel(model);
    }
    // Update system message to reflect new model
    const newSystemMessage = this.buildDefaultSystemMessage();
    this.systemMessage = newSystemMessage;
    // Update the system message in the conversation
    const systemMsgIndex = this.messages.findIndex(msg => msg.role === 'system' && msg.content.includes('coding assistant'));
    if (systemMsgIndex >= 0) {
      this.messages[systemMsgIndex].content = newSystemMessage;
    }
  }

  public getCurrentModel(): string {
    return this.model;
  }

  private getLessonsFingerprint(): string {
    try {
      const lessons = loadLessons();
      return `${lessons.length}|${lessons.map(l => l.length).join(',')}`;
    } catch {
      return '0|';
    }
  }

  /** Recarrega o bloco de lições se ~/.groq/lessons.md mudou (ex.: /lesson na mesma sessão). */
  private refreshLessonsBlock(): void {
    const fingerprint = this.getLessonsFingerprint();
    if (fingerprint === this.lessonsFingerprint) return;
    this.lessonsFingerprint = fingerprint;

    this.messages = this.messages.filter(
      m => !(m.role === 'system' && (m.content || '').startsWith('[LIÇÕES MEMORIZADAS'))
    );
    const block = buildLessonsPromptBlock();
    if (block) {
      this.messages.push({ role: 'system', content: block });
    }
    debugLog('Lessons block refreshed', { fingerprint, hasBlock: !!block });
  }

  public setSessionAutoApprove(enabled: boolean): void {
    this.sessionAutoApprove = enabled;
  }

  public interrupt(): void {
    debugLog('Interrupting current request');
    this.isInterrupted = true;

    if (this.currentAbortController) {
      debugLog('Aborting current API request');
      this.currentAbortController.abort();
    }

    // Add interruption message to conversation
    this.messages.push({
      role: 'system',
      content: 'User has interrupted the request.'
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Context compaction engine (sliding window over conversation blocks)
  // ───────────────────────────────────────────────────────────────────────────

  private estimateTextTokens(text: string): number {
    return Math.ceil((text?.length || 0) / CHARS_PER_TOKEN);
  }

  private estimateMessagesTokens(messages: Message[]): number {
    let total = 0;
    for (const m of messages) {
      total += 4; // role/instruction overhead per message
      total += this.estimateTextTokens(m.content);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          total += this.estimateTextTokens(tc?.function?.name || '');
          total += this.estimateTextTokens(tc?.function?.arguments || '');
        }
      }
    }
    return total;
  }

  private messageBudgetTokens(emergency: boolean): number {
    const usable = TPM_LIMIT - TPM_SAFETY_MARGIN - TOOLS_SCHEMA_TOKENS - 140;
    const budget = emergency ? usable - MIN_COMPLETION_TOKENS : usable - MAX_COMPLETION_TOKENS;
    return Math.floor(emergency ? budget * 0.75 : budget);
  }

  /** Group the conversation into atomic blocks: [assistant(+tool_calls) ... its tool results] or standalone messages. */
  private buildBlocks(): Message[][] {
    const blocks: Message[][] = [];
    let current: Message[] = [];
    for (const msg of this.messages) {
      if (msg.role === 'tool') {
        current.push(msg);
        continue;
      }
      if (current.length) {
        blocks.push(current);
        current = [];
      }
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        current.push(msg); // block stays open so its tool results join it
        continue;
      }
      blocks.push([msg]);
    }
    if (current.length) blocks.push(current);
    return blocks;
  }

  private buildSessionContextMessage(): Message | null {
    if (this.sessionFileLedger.size === 0 && this.editLedger.length === 0) return null;

    const fileLines: string[] = [];
    const entries = [...this.sessionFileLedger.entries()].slice(-6);
    for (const [p, info] of entries) {
      fileLines.push(
        `- ${p}${info.lineCount ? ` (${info.lineCount} lines)` : ''} — last: ${info.lastAction}${info.detail ? ` (${info.detail})` : ''}`
      );
    }

    const ledgerLines = this.editLedger.slice(-6).map((l, i) => `${i + 1}. ${l}`);

    let content = [
      '[SESSION FILE CONTEXT — automatically tracked, refreshes every turn]',
      'Known file paths (reuse these EXACT paths; never list directories to find them again):',
      ...fileLines,
      this.editLedger.length > 0 ? 'Recent change ledger (most recent last):' : '',
      ...ledgerLines,
      'For large files never re-read everything: use grep_file, read_file with start_line/end_line, or replace_lines with exact line numbers.',
    ].filter(Boolean).join('\n');

    if (content.length > 2600) {
      content = '[SESSION FILE CONTEXT — truncated]\n' + content.slice(content.length - 2600);
    }

    return { role: 'system', content };
  }

  private summarizeBlock(block: Message[]): string | null {
    const first = block[0];
    if (!first || first.role === 'system') return null;
    const clip = (s: string, n = 90) => (s || '').replace(/\s+/g, ' ').slice(0, n);
    if (first.role === 'user') {
      return `user: "${clip(first.content)}"`;
    }
    if (first.role === 'assistant') {
      if (first.tool_calls?.length) {
        const names = first.tool_calls.map((tc: any) => {
          let arg = '';
          try {
            const a = typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || {};
            arg = a.file_path || a.directory || a.pattern || '';
          } catch {
            arg = '';
          }
          return `${tc.function?.name}${arg ? `(${arg})` : '()'}`;
        }).join(', ');
        return `assistant → tools: ${clip(names, 120)}`;
      }
      return `assistant: "${clip(first.content)}"`;
    }
    return null;
  }

  private buildOptimizedMessages(emergency: boolean): Message[] {
    const blocks = this.buildBlocks();

    const firstNonSystem = blocks.findIndex(b => !(b.length === 1 && b[0].role === 'system'));
    const leadingSystemCount = firstNonSystem === -1 ? blocks.length : firstNonSystem;

    const sessionCtx = this.buildSessionContextMessage();
    const sessionCtxTokens = sessionCtx ? this.estimateMessagesTokens([sessionCtx]) : 0;
    const budget = Math.max(600, this.messageBudgetTokens(emergency) - sessionCtxTokens);

    const toolCharLimit = emergency ? 350 : 1400;
    const argCharLimit = emergency ? 160 : 240;
    const recentFullBlocks = emergency ? 1 : 2;

    // Walk from the newest block backwards deciding what still fits
    const kept: Array<{ index: number; mode: 'full' | 'trimmed' }> = [];
    const droppedIndexes: number[] = [];
    let remaining = budget;

    for (let i = blocks.length - 1; i >= leadingSystemCount; i--) {
      const isRecent = kept.length < recentFullBlocks;
      const fullTokens = this.estimateBlockTokens(blocks[i]);
      const trimmedTokens = this.estimateBlockTokens(blocks[i], toolCharLimit, argCharLimit);

      if (isRecent && fullTokens <= remaining) {
        kept.unshift({ index: i, mode: 'full' });
        remaining -= fullTokens;
      } else if (trimmedTokens <= remaining) {
        kept.unshift({ index: i, mode: 'trimmed' });
        remaining -= trimmedTokens;
      } else {
        droppedIndexes.unshift(i);
      }
    }

    // Leading system messages (main prompt + project context) always stay
    const leading: Message[] = [];
    for (let i = 0; i < leadingSystemCount; i++) {
      for (const msg of blocks[i]) {
        if (emergency && msg.content.length > 6000) {
          leading.push({
            role: msg.role,
            content: msg.content.slice(0, 6000) + '\n…[project context truncated to fit token limits]',
          });
        } else {
          leading.push(msg);
        }
      }
    }

    // Compact the dropped history into one small summary note
    const summaryMessages: Message[] = [];
    if (droppedIndexes.length > 0) {
      const summaryLines: string[] = [];
      for (const idx of droppedIndexes) {
        const line = this.summarizeBlock(blocks[idx]);
        if (line) summaryLines.push(line);
      }
      const keptSummaryLines = summaryLines.slice(-16);
      let summaryBody = keptSummaryLines.map(l => (l.length > 130 ? l.slice(0, 127) + '…' : l)).join('\n');
      while (summaryBody.length > 2200 && keptSummaryLines.length > 3) {
        keptSummaryLines.shift();
        summaryBody = keptSummaryLines.map(l => (l.length > 130 ? l.slice(0, 127) + '…' : l)).join('\n');
      }
      summaryMessages.push({
        role: 'system',
        content: `[COMPACTED CONTEXT] Earlier steps of this session (oldest first) were compacted to respect the 8K TPM limit:\n${summaryBody}`,
      });
    }

    // Render kept blocks with the chosen compression level
    const rendered: Message[] = [];
    for (const k of kept) {
      rendered.push(...this.renderBlock(blocks[k.index], k.mode, toolCharLimit, argCharLimit));
    }

    const finalMessages = [...leading, ...(sessionCtx ? [sessionCtx] : []), ...summaryMessages, ...rendered];
    return finalMessages;
  }

  private estimateBlockTokens(block: Message[], toolCharLimit?: number, argCharLimit?: number): number {
    let total = 4;
    for (const m of block) {
      let content = m.content || '';
      if (toolCharLimit !== undefined && m.role === 'tool' && content.length > toolCharLimit) {
        content = content.slice(0, toolCharLimit) + '…';
      }
      total += this.estimateTextTokens(content);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let args = tc?.function?.arguments || '';
          if (argCharLimit !== undefined && args.length > argCharLimit) {
            args = args.slice(0, argCharLimit) + '…';
          }
          total += this.estimateTextTokens(args) + 4;
        }
      }
    }
    return total;
  }

  private renderBlock(block: Message[], mode: 'full' | 'trimmed', toolCharLimit: number, argCharLimit: number): Message[] {
    if (mode === 'full') return block;
    return block.map(m => {
      if (m.role === 'tool') {
        const c = m.content || '';
        if (c.length > toolCharLimit) {
          const head = Math.ceil(toolCharLimit * 0.7);
          const tail = Math.max(0, toolCharLimit - head);
          return {
            ...m,
            content:
              c.slice(0, head) +
              `\n…[tool output truncated — ${c.length - toolCharLimit} chars omitted]…\n` +
              (tail > 0 ? c.slice(-tail) : ''),
          };
        }
        return m;
      }
      if (m.role === 'assistant' && m.tool_calls) {
        return {
          ...m,
          tool_calls: m.tool_calls.map(tc => {
            const a = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc?.function?.arguments || {});
            return a.length > argCharLimit
              ? { ...tc, function: { ...tc.function, arguments: a.slice(0, argCharLimit) + '…[args truncated in history]' } }
              : tc;
          }),
        };
      }
      if ((m.role === 'assistant' || m.role === 'user') && (m.content || '').length > 1500) {
        const c = m.content;
        return { ...m, content: c.slice(0, 1000) + `\n…[content truncated, ${c.length - 1000} chars omitted]…\n` + c.slice(-400) };
      }
      return m;
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Session intelligence: read cache + file ledger
  // ───────────────────────────────────────────────────────────────────────────

  private getCachedReadResult(toolName: string, toolArgs: Record<string, any>): { content: any; message: string } | null {
    try {
      const resolved = resolveSmartPath(toolArgs.file_path);
      const stat = fs.statSync(resolved);
      const key = this.buildReadCacheKey(toolName, resolved, stat.mtimeMs, toolArgs);
      return this.readResultCache.get(key) || null;
    } catch {
      return null;
    }
  }

  private buildReadCacheKey(toolName: string, resolvedPath: string, mtimeMs: number, toolArgs: Record<string, any>): string {
    return [
      toolName,
      resolvedPath,
      mtimeMs,
      toolArgs.start_line ?? '',
      toolArgs.end_line ?? '',
      toolArgs.pattern ?? '',
      toolArgs.is_regex ?? '',
      toolArgs.context_lines ?? '',
    ].join('|');
  }

  private cacheReadResult(toolName: string, toolArgs: Record<string, any>, result: any): void {
    try {
      const resolved = resolveSmartPath(toolArgs.file_path);
      const stat = fs.statSync(resolved);
      const key = this.buildReadCacheKey(toolName, resolved, stat.mtimeMs, toolArgs);
      this.readResultCache.set(key, { content: result.content, message: result.message || '' });

      let canon = '';
      try {
        canon = canonicalizePath(toolArgs.file_path);
      } catch {
        canon = resolved;
      }
      if (!this.readCacheIndex.has(canon)) this.readCacheIndex.set(canon, new Set());
      this.readCacheIndex.get(canon)!.add(key);

      // Keep the cache small
      if (this.readResultCache.size > 12) {
        const oldest = this.readResultCache.keys().next().value;
        if (oldest !== undefined) {
          this.readResultCache.delete(oldest);
          for (const set of this.readCacheIndex.values()) set.delete(oldest);
        }
      }
    } catch {
      // cache is best-effort
    }
  }

  private invalidateReadCache(filePath: string): void {
    try {
      let canon = '';
      try {
        canon = canonicalizePath(filePath);
      } catch {
        canon = resolveSmartPath(filePath);
      }
      const keys = this.readCacheIndex.get(canon);
      if (keys) {
        for (const k of keys) this.readResultCache.delete(k);
        this.readCacheIndex.delete(canon);
      }
    } catch {
      // best-effort
    }
  }

  private trackFileAccess(toolName: string, toolArgs: Record<string, any>, result: any): void {
    if (!result?.success) return;
    const target = toolArgs?.file_path || toolArgs?.path || (toolName === 'list_files' ? toolArgs?.directory : undefined);
    if (!target || typeof target !== 'string') return;

    try {
      let canon: string;
      try {
        canon = canonicalizePath(target);
      } catch {
        canon = resolveSmartPath(target);
      }

      const isMutating = ['edit_file', 'replace_lines', 'create_file', 'delete_file'].includes(toolName);
      if (isMutating) {
        this.invalidateReadCache(target);
      }

      let detail = '';
      if (toolName === 'edit_file') {
        const n = Array.isArray(toolArgs.edits) && toolArgs.edits.length > 0 ? toolArgs.edits.length : 1;
        detail = `${n} text replacement${n > 1 ? 's' : ''}`;
      } else if (toolName === 'replace_lines') {
        detail = `L${toolArgs.start_line}-${toolArgs.end_line} rewritten`;
      } else if (toolName === 'create_file') {
        detail = `created (${String(toolArgs.content || '').split('\n').length} lines)`;
      } else if (toolName === 'delete_file') {
        detail = 'deleted';
      }

      const info = this.sessionFileLedger.get(canon) || { lastAction: '', detail: '', ts: 0 };
      info.lastAction = toolName;
      info.detail = detail;
      info.ts = Date.now();

      if (toolName === 'read_file' || toolName === 'grep_file') {
        const msg = result?.message || '';
        const m = msg.match(/\(of (\d+)\)/) || msg.match(/of (\d+) lines?/i);
        if (m) info.lineCount = parseInt(m[1], 10);
      }

      this.sessionFileLedger.set(canon, info);

      if (isMutating) {
        this.editLedger.push(`${toolName} → ${target}${detail ? ` (${detail})` : ''}`);
        if (this.editLedger.length > 10) this.editLedger.shift();
      }
    } catch {
      // ledger is best-effort
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Main chat loop
  // ───────────────────────────────────────────────────────────────────────────

  async chat(userInput: string): Promise<void> {
    try {
      await this.chatInner(userInput);
    } finally {
      // Auto-save da conversa após CADA turno — memória persistente em ~/.groq/sessions/
      this.persistSession();
    }
  }

  private async chatInner(userInput: string): Promise<void> {
    // Reset interrupt flag at the start of a new chat
    this.isInterrupted = false;

    // Check API key on first message send
    if (!this.client) {
      debugLog('Initializing Groq client...');
      // Try environment variable first
      const envApiKey = process.env.GROQ_API_KEY;
      if (envApiKey) {
        debugLog('Using API key from environment variable');
        this.setApiKey(envApiKey);
      } else {
        // Try config file (supports multi-key pools for rotation)
        debugLog('Environment variable GROQ_API_KEY not found, checking config file');
        const keys = this.configManager.getApiKeys();
        const configApiKey = keys.length > 0 ? keys[0] : null;
        if (configApiKey) {
          debugLog('Using API key from config file');
          this.setApiKey(configApiKey);
        } else {
          debugLog('No API key found anywhere');
          throw new Error('No API key available. Please use /login to set your Groq API key.');
        }
      }
      debugLog('Groq client initialized successfully');
    }

    // Add user message
    this.messages.push({ role: 'user', content: userInput });

    // Título padrão da sessão = primeiro pedido do usuário
    if (!this.sessionTitle) {
      this.sessionTitle = userInput.replace(/\s+/g, ' ').trim().slice(0, 48) || 'Sessão sem título';
    }

    // Recarrega lições do usuário (se ~/.groq/lessons.md mudou) e zera o checklist do turno
    this.refreshLessonsBlock();
    this.checklistAskedThisTurn = false;
    const editsAtStart = this.editLedger.length;

    const maxIterations = 50;
    let iteration = 0;

    while (true) { // Outer loop for iteration reset
      while (iteration < maxIterations) {
        // Check for interruption before each iteration
        if (this.isInterrupted) {
          debugLog('Chat loop interrupted by user');
          this.currentAbortController = null;
          return;
        }

        try {
          // Check client exists
          if (!this.client) {
            throw new Error('Groq client not initialized');
          }

          debugLog('Making API call to Groq with model:', this.model);
          debugLog('Messages count:', this.messages.length);
          debugLog('Last few messages:', this.messages.slice(-3));

          // The whole request (compaction + model/key failover) happens inside
          const response = await this.callWithFailover();

          debugLog('Full API response received:', response);
          debugLog('Response usage:', response.usage);
          debugLog('Response finish_reason:', response.choices[0].finish_reason);
          debugLog('Response choices length:', response.choices.length);

          const message = response.choices[0].message;

          // Extract reasoning if present
          const reasoning = (message as any).reasoning;

          // Pass usage data to callback if available
          if (response.usage && this.onApiUsage) {
            this.onApiUsage({
              prompt_tokens: response.usage.prompt_tokens,
              completion_tokens: response.usage.completion_tokens,
              total_tokens: response.usage.total_tokens,
              total_time: response.usage.total_time
            });
          }
          debugLog('Message content length:', message.content?.length || 0);
          debugLog('Message has tool_calls:', !!message.tool_calls);
          debugLog('Message tool_calls count:', message.tool_calls?.length || 0);

          if (response.choices[0].finish_reason !== 'stop' && response.choices[0].finish_reason !== 'tool_calls') {
            debugLog('WARNING - Unexpected finish_reason:', response.choices[0].finish_reason);
          }

          // Handle tool calls if present
          if (message.tool_calls) {
            // Show thinking text or reasoning if present
            if (message.content || reasoning) {
              if (this.onThinkingText) {
                this.onThinkingText(message.content || '', reasoning);
              }
            }

            // Add assistant message to history
            const assistantMsg: Message = {
              role: 'assistant',
              content: message.content || ''
            };
            assistantMsg.tool_calls = message.tool_calls;
            this.messages.push(assistantMsg);

            // Execute tool calls
            for (const toolCall of message.tool_calls) {
              // Check for interruption before each tool execution
              if (this.isInterrupted) {
                debugLog('Tool execution interrupted by user');
                this.currentAbortController = null;
                return;
              }

              const result = await this.executeToolCall(toolCall);

              // Add tool result to conversation (including rejected ones)
              this.messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(result)
              });

              // Check if user rejected the tool, if so, stop processing
              if (result.userRejected) {
                // Add a note to the conversation that the user rejected the tool
                this.messages.push({
                  role: 'system',
                  content: `The user rejected the ${toolCall.function.name} tool execution. The response has been terminated. Please wait for the user's next instruction.`
                });
                return;
              }
            }

            // Continue loop to get model response to tool results
            iteration++;
            continue;
          }

          // No tool calls, this is the final response
          const content = message.content || '';

          // AUTO-VERIFICAÇÃO: houve edições neste turno → exigir checklist 1x antes de encerrar.
          // É o que impede a IA de "esquecer" um pedido (ex.: cor de fundo de um botão)!
          if (this.editLedger.length > editsAtStart && !this.checklistAskedThisTurn) {
            this.checklistAskedThisTurn = true;
            debugLog('Triggering mandatory self-verification checklist');
            this.messages.push({
              role: 'system',
              content: '[AUTO-VERIFICAÇÃO OBRIGATÓRIA] Você editou arquivos neste turno, mas AINDA NÃO encerrou. Passos: (1) releia TODOS os pedidos feitos pelo usuário nesta última mensagem; (2) para CADA pedido, confirme com grep_file ou read_file que a mudança está REALMENTE presente no arquivo final (ex.: a cor de fundo pedida está aplicada no botão certo?); (3) se algo pedido ficou faltando ou parcial, faça a edição agora; (4) só então dê a resposta final com um checklist curto por item: ✓ concluído ou ⚠️ pendente.',
            });
            iteration++;
            continue;
          }

          debugLog('Final response - no tool calls detected');
          debugLog('Final content length:', content.length);
          debugLog('Final content preview:', content.substring(0, 200));

          if (this.onFinalMessage) {
            debugLog('Calling onFinalMessage callback');
            this.onFinalMessage(content, reasoning);
          } else {
            debugLog('No onFinalMessage callback set');
          }

          // Add final response to conversation history
          this.messages.push({
            role: 'assistant',
            content: content
          });

          debugLog('Final response added to conversation history, exiting chat loop');
          this.currentAbortController = null; // Clear abort controller
          return; // Successfully completed, exit both loops

        } catch (error) {
          this.currentAbortController = null; // Clear abort controller

          // Check if this is an abort error due to user interruption
          if (error instanceof Error && (
            error.message.includes('Request was aborted') ||
            error.message.includes('The operation was aborted') ||
            error.name === 'AbortError'
          )) {
            debugLog('API request aborted due to user interruption');
            // Don't add error message if it's an interruption - the interrupt message was already added
            return;
          }

          debugLog('Error occurred during API call:', error);
          debugLog('Error details:', {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : 'No stack available'
          });

          // Add API error as context message instead of terminating chat
          let errorMessage = 'Unknown error occurred';
          let is401Error = false;

          if (error instanceof Error) {
            // Check if it's an API error with more details
            if ('status' in error && 'error' in error) {
              const apiError = error as any;
              is401Error = apiError.status === 401;
              if (apiError.error?.error?.message) {
                errorMessage = `API Error (${apiError.status}): ${apiError.error.error.message}`;
                if (apiError.error.error.code) {
                  errorMessage += ` (Code: ${apiError.error.error.code})`;
                }
              } else {
                errorMessage = `API Error (${apiError.status}): ${error.message}`;
              }
            } else {
              errorMessage = `Error: ${error.message}`;
            }
          } else {
            errorMessage = `Error: ${String(error)}`;
          }

          // For 401 errors (invalid API key), don't retry - terminate immediately
          if (is401Error) {
            throw new Error(`${errorMessage}. Please check your API key and use /login to set a valid key.`);
          }

          // Ask user if they want to retry via callback
          if (this.onError) {
            const shouldRetry = await this.onError(errorMessage);
            if (shouldRetry) {
              // User wants to retry - continue the loop without adding error to conversation
              iteration++;
              continue;
            } else {
              // User chose not to retry - add error message and return
              this.messages.push({
                role: 'system',
                content: `Request failed with error: ${errorMessage}. User chose not to retry.`
              });
              return;
            }
          } else {
            // No error callback available - use old behavior
            // Add error context to conversation for model to see and potentially recover
            this.messages.push({
              role: 'system',
              content: `Previous API request failed with error: ${errorMessage}. Please try a different approach or ask the user for clarification.`
            });

            // Continue conversation loop to let model attempt recovery
            iteration++;
            continue;
          }
        }
      }

      // Hit max iterations, ask user if they want to continue
      if (iteration >= maxIterations) {
        let shouldContinue = false;
        if (this.onMaxIterations) {
          shouldContinue = await this.onMaxIterations(maxIterations);
        }
        if (shouldContinue) {
          iteration = 0; // Reset iteration counter
          continue; // Continue the outer loop
        } else {
          return; // Exit both loops
        }
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Automatic model + API-key failover across the Groq Free-Tier pool
  // ───────────────────────────────────────────────────────────────────────────

  private buildRequestBody(model: string, messages: Message[], promptTokensEstimate: number): any {
    const maxTokens = Math.max(
      MIN_COMPLETION_TOKENS,
      Math.min(MAX_COMPLETION_TOKENS, TPM_LIMIT - TPM_SAFETY_MARGIN - promptTokensEstimate)
    );

    const request: any = {
      model,
      messages,
      tools: ALL_TOOL_SCHEMAS,
      tool_choice: 'auto',
      temperature: this.temperature,
      max_tokens: maxTokens,
    };

    // Only request parallel tool calls on models that actually support it
    // (openai/gpt-oss-* do NOT support parallel tool use on Groq!)
    if (supportsParallelToolCalls(model)) {
      request.parallel_tool_calls = true;
    }

    const effort = getOptimalReasoningEffort(model);
    if (effort) {
      request.reasoning_effort = effort;
    }

    return request;
  }

  private async callWithFailover(): Promise<any> {
    // Build the model rotation order: current model first, then the rest of the Free-Tier pool
    const primaryIdx = Math.max(0, FREE_TIER_MODEL_POOL.indexOf(this.model));
    const pool = [
      ...new Set([
        this.model,
        ...FREE_TIER_MODEL_POOL.slice(primaryIdx + 1),
        ...FREE_TIER_MODEL_POOL.slice(0, primaryIdx),
      ]),
    ];

    const keyList = this.configManager.getApiKeys();
    const keys = keyList.length > 0 ? keyList : this.apiKey ? [this.apiKey] : [];

    if (keys.length === 0) {
      throw new Error('No API key available. Please use /login to set your Groq API key.');
    }

    let emergencyUsed = 0;   // how many times we rebuilt the context with emergency compaction
    let waitUsed = 0;        // short retry-after waits already consumed
    let sameComboRetries = 0;
    let lastErrorSummary = 'unknown error';

    let modelIdx = 0;
    let keyIdx = 0;
    let guard = 0;

    while (modelIdx < pool.length && guard++ < 60) {
      const model = pool[modelIdx];

      if (keyIdx >= keys.length) {
        modelIdx++;
        keyIdx = 0;
        sameComboRetries = 0;
        continue;
      }

      const apiKey = keys[keyIdx];

      try {
        this.ensureClient(apiKey);

        const messages = this.buildOptimizedMessages(emergencyUsed > 0);
        const promptEstimate = TOOLS_SCHEMA_TOKENS + 140 + this.estimateMessagesTokens(messages);
        const request = this.buildRequestBody(model, messages, promptEstimate);

        debugLog(`Attempt → model=${model} keyIndex=${keyIdx} emergency=${emergencyUsed > 0} estPromptTokens≈${promptEstimate} maxTokens=${request.max_tokens}`);
        this.requestCount++;
        const curlCommand = generateCurlCommand(this.apiKey!, request, this.requestCount);
        if (curlCommand) {
          debugLog('Equivalent curl command:', curlCommand);
        }

        this.currentAbortController = new AbortController();
        const response = await this.streamCompletion(request);

        // Success — adopt the model that answered
        if (model !== this.model) {
          this.notifyStatus(`🔄 Continuando automaticamente com o modelo ${model} — histórico da conversa preservado.`);
        }
        this.model = model;
        this.currentAbortController = null;
        return response;

      } catch (error) {
        this.currentAbortController = null;
        const cls = classifyGroqError(error);
        lastErrorSummary = cls.summary;

        if (cls.kind === 'abort') {
          throw error;
        }

        debugLog('API attempt failed', { model, keyIndex: keyIdx, kind: cls.kind, code: cls.code, summary: cls.summary });

        switch (cls.kind) {
          case 'auth': {
            this.notifyStatus(
              `🔑 Chave API #${keyIdx + 1} rejeitada (401). ${
                keyIdx + 1 < keys.length ? `Tentando automaticamente a chave #${keyIdx + 2}...` : 'Nenhuma chave válida restante.'
              }`
            );
            sameComboRetries = 0;
            keyIdx++;
            break;
          }

          case 'payload': {
            // 413: request (prompt + completion) exceeded the model TPM bucket
            if (sameComboRetries < 1 && emergencyUsed < 2) {
              emergencyUsed++;
              sameComboRetries++;
              this.notifyStatus(`🧹 Contexto excedeu o limite de tokens do ${model}. Comprimindo o histórico da conversa e tentando de novo...`);
              break; // retry same model + same key
            }
            sameComboRetries = 0;
            const nextIsKey = keyIdx + 1 < keys.length;
            this.notifyStatus(
              `📦 ${model} não comporta mais o contexto (${cls.bucket || 'TPM'}). ${
                nextIsKey ? 'Testando a próxima chave API...' : 'Alternando para o próximo modelo...'
              }`
            );
            keyIdx++;
            break;
          }

          case 'rate': {
            const canWait =
              !cls.isDaily &&
              cls.retryAfterSeconds !== undefined &&
              cls.retryAfterSeconds <= 20 &&
              waitUsed < 1 &&
              modelIdx === 0 &&
              keyIdx === 0;

            if (canWait) {
              waitUsed++;
              this.notifyStatus(`⏳ Limite de velocidade no ${model} (${cls.bucket}). Aguardando ${cls.retryAfterSeconds}s antes de tentar de novo...`);
              await sleep(cls.retryAfterSeconds! * 1000 + 400);
              break; // retry same combo
            }

            sameComboRetries = 0;
            const nextIsKey = keyIdx + 1 < keys.length;
            this.notifyStatus(
              cls.isDaily
                ? `🚫 Cota DIÁRIA esgotada para ${model} (chave #${keyIdx + 1}). ${
                    nextIsKey ? 'Trocando para a próxima chave...' : 'Alternando para o próximo modelo...'
                  }`
                : `⚠️ ${model} atingiu o limite de ${cls.bucket || 'velocidade'} (chave #${keyIdx + 1}). ${
                    nextIsKey ? 'Trocando para a próxima chave...' : 'Alternando para o próximo modelo...'
                  }`
            );
            keyIdx++;
            break;
          }

          case 'model': {
            sameComboRetries = 0;
            this.notifyStatus(`🗑️ Modelo ${model} indisponível (${cls.code || '404'}). Alternando para o próximo modelo...`);
            keyIdx = keys.length; // skip remaining keys for a dead model
            break;
          }

          case 'tool_salvage': {
            const salvaged = this.salvageToolUseFailure(cls.failedGeneration, cls.summary);
            if (salvaged && sameComboRetries < 1) {
              sameComboRetries++;
              break; // retry same combo after repair
            }
            this.notifyStatus(`🛠️ O ${model} gerou uma chamada de ferramenta malformada. Tentando o próximo modelo...`);
            sameComboRetries = 0;
            keyIdx++;
            break;
          }

          default: {
            // server / network / unknown → one quick same-combo retry, then move on
            if (sameComboRetries < 1) {
              sameComboRetries++;
              await sleep(700);
              break;
            }
            sameComboRetries = 0;
            keyIdx++;
            break;
          }
        }
      }
    }

    throw new Error(
      `Todos os modelos do Free Tier (${pool.join(', ')}) e ${keys.length} chave(s) API foram tentados sem sucesso. Último erro: ${lastErrorSummary}. Dicas: aguarde ~1 minuto (limite TPM), cadastre uma chave extra com /login (rotação automática) ou troque de modelo com /model.`
    );
  }

  /**
   * Executa a requisição em MODO STREAMING: o raciocínio (reasoning) e o texto
   * aparecem em tempo real no terminal enquanto o modelo pensa, e as tool calls
   * são acumuladas dos deltas até o fim. Erros no meio do stream propagam para
   * o mesmo fluxo de failover de modelo/chave.
   */
  private async streamCompletion(request: any): Promise<any> {
    const stream: any = await this.client!.chat.completions.create(
      { ...request, stream: true, stream_options: { include_usage: true } } as any,
      { signal: this.currentAbortController!.signal }
    );

    let content = '';
    let reasoning = '';
    const toolCallsAcc: any[] = [];
    let finishReason: string | null = null;
    let usage: any = null;
    let lastEmit = 0;

    const emitDelta = (force = false) => {
      if (!this.onStreamDelta) return;
      const now = Date.now();
      if (!force && now - lastEmit < 60) return; // throttle ~16fps p/ não piscar o terminal
      lastEmit = now;
      try {
        this.onStreamDelta({ content, reasoning });
      } catch {
        // callback de UI nunca quebra o agente
      }
    };

    try {
      for await (const chunk of stream) {
        const choice = chunk?.choices?.[0];
        const delta: any = choice?.delta || {};
        if (delta.reasoning) reasoning += delta.reasoning;
        if (delta.content) content += delta.content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            if (!toolCallsAcc[idx]) {
              toolCallsAcc[idx] = {
                id: tc.id || `call_${idx}`,
                type: 'function',
                function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' },
              };
            } else {
              if (tc.id) toolCallsAcc[idx].id = tc.id;
              if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments;
            }
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if ((chunk as any).usage) usage = (chunk as any).usage;
        if (delta.content || delta.reasoning) emitDelta();
      }
    } catch (error) {
      // Falha no meio do stream → mesmo fluxo de failover (compaction/modelo/chave)
      debugLog('Stream interrupted mid-response:', error);
      throw error instanceof Error ? error : new Error(String(error));
    }

    emitDelta(true);

    const message: any = { role: 'assistant', content };
    const calls = toolCallsAcc.filter(Boolean);
    if (calls.length > 0) message.tool_calls = calls;
    if (reasoning) message.reasoning = reasoning;

    return {
      choices: [{ message, finish_reason: finishReason || 'stop' }],
      usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  /**
   * Recover from HTTP 400 `tool_use_failed`: keep the raw generation as an
   * assistant turn and ask the model to re-issue ONE clean tool call.
   */
  private salvageToolUseFailure(failedGeneration: string | undefined, reason: string): boolean {
    try {
      this.messages.push({
        role: 'assistant',
        content: (failedGeneration || '').slice(0, 1200) || '(previous response lost)',
      });
      this.messages.push({
        role: 'user',
        content: `SYSTEM REPAIR NOTE: your previous response failed with "${reason}" because the tool call was malformed or truncated. Re-issue the SAME intent now as ONE clean tool call with valid JSON arguments matching the tool schema exactly (no extra text, no markdown fences).`,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Memória de sessão: auto-save, resumo e retomada (~/.groq/sessions/*.json)
  // ───────────────────────────────────────────────────────────────────────────

  public getSessionId(): string {
    return this.sessionId;
  }

  public getSessionTitle(): string {
    return this.sessionTitle;
  }

  public setSessionTitle(title: string): void {
    const clean = (title || '').replace(/\s+/g, ' ').trim().slice(0, 64);
    if (!clean) throw new Error('O título não pode ser vazio');
    this.sessionTitle = clean;
    this.persistSession();
  }

  /** Resumo local (sem custo de API) do que aconteceu na sessão até agora. */
  private buildSessionSummary(): string {
    const userMsgs = this.messages
      .filter(m => m.role === 'user' && !/SYSTEM REPAIR NOTE/.test(m.content))
      .map(m => m.content.replace(/\s+/g, ' ').trim())
      .filter(c => c.length > 0);
    const steps = userMsgs.slice(-8).map(s => `- ${s.length > 110 ? s.slice(0, 107) + '…' : s}`);
    const files = [...this.sessionFileLedger.keys()].slice(-6).map(p => `- ${p}`);
    return [
      steps.length ? 'Pedidos do usuário (cronologia):' : '',
      ...steps,
      files.length ? 'Arquivos trabalhados:' : '',
      ...files,
    ].filter(Boolean).join('\n');
  }

  public persistSession(): void {
    try {
      const userCount = this.messages.filter(m => m.role === 'user').length;
      if (userCount === 0) return; // nada para salvar ainda
      const session: SavedSession = {
        id: this.sessionId,
        title: this.sessionTitle || 'Sessão sem título',
        model: this.model,
        createdAt: this.sessionCreatedAt,
        updatedAt: new Date().toISOString(),
        messages: this.messages,
        fileLedger: [...this.sessionFileLedger.entries()],
        editLedger: [...this.editLedger],
        summary: this.buildSessionSummary(),
      };
      saveSession(session);
      debugLog('Session persisted:', { id: this.sessionId, title: session.title, messages: session.messages.length });
    } catch (error) {
      debugLog('Failed to persist session:', error);
    }
  }

  /**
   * Retoma uma conversa salva: restaura mensagens, modelo, ledger de arquivos
   * e injeta uma nota de memória para o agente continuar o raciocínio de onde parou.
   */
  public resumeSession(query: string): { title: string; messageCount: number; model: string } | null {
    const saved = findSessionByQuery(query);
    if (!saved) return null;

    // Volta para o modelo da sessão salva (sem alterar o padrão do usuário)
    if (saved.model) this.setModel(saved.model, { persist: false });

    const currentSystem = this.messages.filter(m => m.role === 'system');
    const restored = saved.messages.filter(m => m.role !== 'system');

    const memoryNote = [
      `[SESSÃO RETOMADA] Conversa "${saved.title}" (última atividade: ${saved.updatedAt}).`,
      saved.summary ? `Resumo do que já aconteceu:\n${saved.summary}` : '',
      'Continue exatamente de onde a conversa parou.',
    ].filter(Boolean).join('\n');

    this.messages = [...currentSystem, { role: 'system', content: memoryNote }, ...restored];

    this.sessionId = saved.id;
    this.sessionTitle = saved.title;
    this.sessionFileLedger = new Map(saved.fileLedger || []);
    this.editLedger = [...(saved.editLedger || [])];
    this.readResultCache.clear();
    this.readCacheIndex.clear();

    // Arquivos já lidos na sessão anterior → permite editar sem reler
    try {
      for (const p of this.sessionFileLedger.keys()) markFileAsRead(p);
    } catch {
      // best-effort
    }

    debugLog('Session resumed:', { id: saved.id, title: saved.title, restored: restored.length });
    return { title: saved.title, messageCount: restored.length, model: this.model };
  }

  private async executeToolCall(toolCall: any): Promise<Record<string, any>> {
    try {
      // Strip 'repo_browser.' prefix if present (some models hallucinate this)
      let toolName = toolCall.function.name;
      if (toolName.startsWith('repo_browser.')) {
        toolName = toolName.substring('repo_browser.'.length);
      }

      // Handle truncated/malformed tool call arguments
      let toolArgs: any;
      try {
        const rawArgs =
          typeof toolCall.function.arguments === 'string'
            ? toolCall.function.arguments
            : JSON.stringify(toolCall.function.arguments || {});
        toolArgs = JSON.parse(rawArgs);
        if (toolArgs === null || typeof toolArgs !== 'object') toolArgs = {};
        // Common model slip-up: "path" instead of "file_path"
        if (!toolArgs.file_path && toolArgs.path && typeof toolArgs.path === 'string') {
          toolArgs.file_path = toolArgs.path;
        }
      } catch (error) {
        return {
          error: `Tool arguments truncated or invalid JSON: ${error}. Please re-issue this tool call with valid JSON arguments (or break it into smaller pieces).`,
          success: false
        };
      }

      // Notify UI about tool start
      if (this.onToolStart) {
        this.onToolStart(toolName, toolArgs);
      }

      // Redundant-read guard: identical read on an unchanged file → cached answer
      if ((toolName === 'read_file' || toolName === 'grep_file') && toolArgs.file_path) {
        const cached = this.getCachedReadResult(toolName, toolArgs);
        if (cached) {
          const result = {
            success: true,
            content: cached.content,
            message:
              (cached.message || 'identical read') +
              ' [CACHED: this exact file region is unchanged since your previous read — do NOT read it again; proceed directly with edit_file / replace_lines using the information you already have.]',
          };
          if (this.onToolEnd) {
            this.onToolEnd(toolName, result);
          }
          return result;
        }
      }

      // Check read-before-edit for edit tools
      if ((toolName === 'edit_file' || toolName === 'replace_lines') && toolArgs.file_path) {
        if (!validateReadBeforeEdit(toolArgs.file_path)) {
          const errorMessage = getReadBeforeEditError(toolArgs.file_path);
          const result = { error: errorMessage, success: false };
          if (this.onToolEnd) {
            this.onToolEnd(toolName, result);
          }
          return result;
        }
      }

      // Check if tool needs approval (only after validation passes)
      const isDangerous = DANGEROUS_TOOLS.includes(toolName);
      const requiresApproval = APPROVAL_REQUIRED_TOOLS.includes(toolName);
      const needsApproval = isDangerous || requiresApproval;

      // For APPROVAL_REQUIRED_TOOLS, check if session auto-approval is enabled
      const canAutoApprove = requiresApproval && !isDangerous && this.sessionAutoApprove;

      // Memória de aprovação por arquivo: um arquivo aprovado 1x na sessão não pergunta de novo
      const isFileEditTool = toolName === 'edit_file' || toolName === 'replace_lines' || toolName === 'create_file';
      let fileAlreadyApproved = false;
      if (isFileEditTool && toolArgs.file_path) {
        try {
          fileAlreadyApproved = this.approvedFiles.has(canonicalizePath(toolArgs.file_path));
        } catch {
          fileAlreadyApproved = false;
        }
      }

      if (needsApproval && fileAlreadyApproved) {
        this.notifyStatus(`🔁 ${toolName} aprovado automaticamente (arquivo já autorizado nesta sessão).`);
      }

      if (needsApproval && !canAutoApprove && !fileAlreadyApproved) {
        let approvalResult: { approved: boolean; autoApproveSession?: boolean };

        if (this.onToolApproval) {
          // Check for interruption before waiting for approval
          if (this.isInterrupted) {
            const result = { error: 'Tool execution interrupted by user', success: false, userRejected: true };
            if (this.onToolEnd) {
              this.onToolEnd(toolName, result);
            }
            return result;
          }

          approvalResult = await this.onToolApproval(toolName, toolArgs);

          // Check for interruption after approval process
          if (this.isInterrupted) {
            const result = { error: 'Tool execution interrupted by user', success: false, userRejected: true };
            if (this.onToolEnd) {
              this.onToolEnd(toolName, result);
            }
            return result;
          }
        } else {
          // No approval callback available, reject by default
          approvalResult = { approved: false };
        }

        // Registra aprovação por arquivo para o resto da sessão
        if (approvalResult.approved && isFileEditTool && toolArgs.file_path) {
          try {
            this.approvedFiles.add(canonicalizePath(toolArgs.file_path));
          } catch {
            // best-effort
          }
        }

        // Enable session auto-approval if requested (only for APPROVAL_REQUIRED_TOOLS)
        if (approvalResult.autoApproveSession && requiresApproval && !isDangerous) {
          this.sessionAutoApprove = true;
        }

        if (!approvalResult.approved) {
          const result = { error: 'Tool execution canceled by user', success: false, userRejected: true };
          if (this.onToolEnd) {
            this.onToolEnd(toolName, result);
          }
          return result;
        }
      }

      // Execute tool
      const result = await executeTool(toolName, toolArgs);

      // Session intelligence: cache reads + track the file ledger
      if ((toolName === 'read_file' || toolName === 'grep_file') && result?.success && toolArgs.file_path) {
        this.cacheReadResult(toolName, toolArgs, result);
      }
      this.trackFileAccess(toolName, toolArgs, result);

      // Notify UI about tool completion
      if (this.onToolEnd) {
        this.onToolEnd(toolName, result);
      }

      return result;

    } catch (error) {
      const errorMsg = `Tool execution error: ${error}`;
      return { error: errorMsg, success: false };
    }
  }
}

// Debug logging to file
const DEBUG_LOG_FILE = path.join(process.cwd(), 'debug-agent.log');
let debugLogCleared = false;
let debugEnabled = false;

function debugLog(message: string, data?: any) {
  if (!debugEnabled) return;

  // Clear log file on first debug log of each session
  if (!debugLogCleared) {
    fs.writeFileSync(DEBUG_LOG_FILE, '');
    debugLogCleared = true;
  }

  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}${data ? '\n' + JSON.stringify(data, null, 2) : ''}\n`;
  fs.appendFileSync(DEBUG_LOG_FILE, logEntry);
}

function generateCurlCommand(apiKey: string, requestBody: any, requestCount: number): string {
  if (!debugEnabled) return '';

  const maskedApiKey = `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 8)}`;

  // Write request body to JSON file
  const jsonFileName = `debug-request-${requestCount}.json`;
  const jsonFilePath = path.join(process.cwd(), jsonFileName);
  fs.writeFileSync(jsonFilePath, JSON.stringify(requestBody, null, 2));

  const curlCmd = `curl -X POST "https://api.groq.com/openai/v1/chat/completions" \\
  -H "Authorization: Bearer ${maskedApiKey}" \\
  -H "Content-Type: application/json" \\
  -d @${jsonFileName}`;

  return curlCmd;
}
