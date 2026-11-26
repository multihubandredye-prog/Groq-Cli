import * as path from 'path';

export interface OutlineEntry {
  line: number;
  kind: string;
  label: string;
}

/**
 * Gera um mapa estrutural super compacto de arquivos grandes (HTML, CSS, JS, TS, Python, etc.)
 * com números exatos de linha para edição cirúrgica sem estourar o limite de 8.000 TPM da Groq!
 */
export function buildFileOutline(content: string, filePath: string, maxEntries = 55): string {
  const lines = content.split(/\r?\n/);
  const entries: OutlineEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const lineNum = i + 1;

    // Blocos HTML principais
    if (/^<!DOCTYPE/i.test(trimmed) || /^<(html|head|style|body|main|header|nav|footer|script)\b/i.test(trimmed)) {
      entries.push({ line: lineNum, kind: 'TAG', label: trimmed.slice(0, 80) });
      continue;
    }
    if (/^<\/(style|body|script)>/i.test(trimmed)) {
      entries.push({ line: lineNum, kind: 'END', label: trimmed.slice(0, 40) });
      continue;
    }

    // Elementos com ID em HTML
    const idMatch = trimmed.match(/<([a-z0-9-]+)[^>]*\bid=["']([^"']+)["']/i);
    if (idMatch) {
      entries.push({ line: lineNum, kind: 'ID', label: `<${idMatch[1]}#${idMatch[2]}>` });
      continue;
    }

    // Seletores / variáveis raiz de CSS
    if (/^(:root|\[data-theme|@media\b|@keyframes\b)/.test(trimmed)) {
      entries.push({ line: lineNum, kind: 'CSS', label: trimmed.slice(0, 80) });
      continue;
    }

    // Comentários divisores de seção (/* === ... === */ ou // === ... === ou <!-- ... -->)
    if (
      (/^\/\*/.test(trimmed) && /===|---/.test(trimmed)) ||
      (/^\/\//.test(trimmed) && /===|---/.test(trimmed)) ||
      /^<!--\s*[A-ZÀ-Ú0-9 _-]{4,}\s*-->/i.test(trimmed)
    ) {
      entries.push({ line: lineNum, kind: 'SEC', label: trimmed.slice(0, 80) });
      continue;
    }

    // Funções, classes, interfaces e constantes de topo em JS/TS/Python
    const codeDecl = trimmed.match(
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\s+[A-Za-z0-9_$]+|class\s+[A-Za-z0-9_$]+|interface\s+[A-Za-z0-9_$]+|type\s+[A-Za-z0-9_$]+|def\s+[A-Za-z0-9_]+|const\s+[A-Za-z0-9_$]+\s*=\s*(?:async\s*)?\()/
    );
    if (codeDecl) {
      entries.push({ line: lineNum, kind: 'CODE', label: trimmed.slice(0, 85) });
    }
  }

  let sampled = entries;
  if (entries.length > maxEntries) {
    const step = entries.length / maxEntries;
    sampled = [];
    for (let idx = 0; idx < maxEntries; idx++) {
      sampled.push(entries[Math.min(entries.length - 1, Math.floor(idx * step))]);
    }
  }

  const sizeKb = (Buffer.byteLength(content, 'utf8') / 1024).toFixed(1);
  const header = `=== FILE OUTLINE: ${path.basename(filePath)} (${lines.length} lines · ${sizeKb} KB) ===`;
  const body =
    sampled.length > 0
      ? sampled.map(e => `L${e.line} [${e.kind}] ${e.label}`).join('\n')
      : '(No structural landmarks detected; use read_file with start_line/end_line or grep_file)';

  return `${header}\n${body}`;
}

export interface GrepFileMatch {
  line: number;
  matchText: string;
  snippet: string;
}

export function grepInFileContent(
  content: string,
  pattern: string,
  options: { isRegex?: boolean; caseSensitive?: boolean; contextLines?: number; maxMatches?: number } = {}
): { totalMatches: number; matches: GrepFileMatch[] } {
  const { isRegex = false, caseSensitive = false, contextLines = 2, maxMatches = 35 } = options;
  const lines = content.split(/\r?\n/);

  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = caseSensitive ? '' : 'i';
  let regex: RegExp;
  try {
    regex = new RegExp(isRegex ? pattern : escaped, flags);
  } catch {
    regex = new RegExp(escaped, flags);
  }

  const matches: GrepFileMatch[] = [];
  let totalMatches = 0;

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      totalMatches++;
      if (matches.length < maxMatches) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        const ctx: string[] = [];
        for (let j = start; j <= end; j++) {
          const marker = j === i ? '>' : ' ';
          ctx.push(`${marker} L${j + 1}: ${lines[j].slice(0, 180)}`);
        }
        matches.push({
          line: i + 1,
          matchText: lines[i].trim().slice(0, 140),
          snippet: ctx.join('\n'),
        });
      }
    }
  }

  return { totalMatches, matches };
}
