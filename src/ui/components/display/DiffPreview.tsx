import React from 'react';
import { Box, Text } from 'ink';
import * as fs from 'fs';
import { validateReadBeforeEdit, getReadBeforeEditError } from '../../../tools/validators.js';
import { resolveSmartPath } from '../../../utils/file-ops.js';

interface DiffChunk {
  header: string;
  lines: string[];
}

interface EditEntry {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

interface ToolArgs {
  old_text?: string;
  new_text?: string;
  replace_all?: boolean;
  edits?: EditEntry[];
  start_line?: number;
  end_line?: number;
  new_content?: string;
  content?: string;
  file_path?: string;
}

interface DiffPreviewProps {
  toolName: string;
  toolArgs: ToolArgs;
  isHistorical?: boolean;
}

const MAX_DISPLAY_DIFF_LINES = 45;

function DiffPreview({ toolName, toolArgs, isHistorical = false }: DiffPreviewProps) {
  const toolArgsJson = JSON.stringify(toolArgs);
  const [diffChunks, setDiffChunks] = React.useState<DiffChunk[]>([]);
  const [totalHiddenLines, setTotalHiddenLines] = React.useState(0);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    generateDiff();
  }, [toolName, toolArgsJson]);

  const generateDiff = async () => {
    try {
      setIsLoading(true);
      setError(null);
      setTotalHiddenLines(0);

      if (!isHistorical && (toolName === 'edit_file' || toolName === 'replace_lines') && toolArgs.file_path) {
        if (!validateReadBeforeEdit(toolArgs.file_path)) {
          setError(getReadBeforeEditError(toolArgs.file_path));
          return;
        }
      }

      const filePath = toolArgs.file_path;
      if (!filePath) {
        setError('No file path provided');
        return;
      }

      let reconstructedOriginal = '';
      let simulatedContent = '';

      if (isHistorical) {
        if (Array.isArray(toolArgs.edits) && toolArgs.edits.length > 0) {
          reconstructedOriginal = toolArgs.edits.map(e => e.old_text).join('\n...\n');
          simulatedContent = toolArgs.edits.map(e => e.new_text).join('\n...\n');
        } else if (toolArgs.old_text !== undefined && toolArgs.new_text !== undefined) {
          reconstructedOriginal = toolArgs.old_text;
          simulatedContent = toolArgs.new_text;
        } else if (toolName === 'replace_lines' && toolArgs.new_content !== undefined) {
          reconstructedOriginal = `[Lines ${toolArgs.start_line}-${toolArgs.end_line}]`;
          simulatedContent = toolArgs.new_content;
        } else if (toolArgs.content !== undefined) {
          reconstructedOriginal = '';
          simulatedContent = toolArgs.content;
        }
      } else {
        let originalContent = '';
        try {
          const resolvedPath = resolveSmartPath(filePath);
          const raw = await fs.promises.readFile(resolvedPath, 'utf-8');
          originalContent = raw.replace(/\r\n/g, '\n');
        } catch {
          originalContent = '';
        }

        reconstructedOriginal = originalContent;

        if (toolName === 'replace_lines' && toolArgs.start_line && toolArgs.end_line) {
          const lines = originalContent.split('\n');
          const s = Math.max(1, Math.floor(toolArgs.start_line));
          const e = Math.min(lines.length, Math.floor(toolArgs.end_line));
          const newLines = (toolArgs.new_content ?? '').replace(/\r\n/g, '\n').split('\n');
          const copy = [...lines];
          if (s <= e && s <= copy.length) {
            copy.splice(s - 1, e - s + 1, ...newLines);
          }
          simulatedContent = copy.join('\n');
        } else if (Array.isArray(toolArgs.edits) && toolArgs.edits.length > 0) {
          let working = originalContent;
          for (const ed of toolArgs.edits) {
            const o = (ed.old_text || '').replace(/\r\n/g, '\n');
            const n = (ed.new_text || '').replace(/\r\n/g, '\n');
            if (o && working.includes(o)) {
              working = ed.replace_all ? working.split(o).join(n) : working.replace(o, n);
            }
          }
          simulatedContent = working;
        } else if (toolArgs.old_text !== undefined && toolArgs.new_text !== undefined) {
          const o = toolArgs.old_text.replace(/\r\n/g, '\n');
          const n = toolArgs.new_text.replace(/\r\n/g, '\n');
          if (originalContent.includes(o)) {
            simulatedContent = toolArgs.replace_all
              ? originalContent.split(o).join(n)
              : originalContent.replace(o, n);
          } else {
            simulatedContent = originalContent;
          }
        } else {
          simulatedContent = (toolArgs.content || '').replace(/\r\n/g, '\n');
        }
      }

      const origLines = reconstructedOriginal ? reconstructedOriginal.split('\n') : [];
      const simLines = simulatedContent ? simulatedContent.split('\n') : [];

      const diff = generateFastUnifiedDiff(
        origLines,
        simLines,
        `${filePath} (original)`,
        `${filePath} (new)`,
        3
      );

      if (diff.length === 0) {
        setDiffChunks([]);
        return;
      }

      const chunks = parseDiffIntoChunks(diff);
      // Cap total rendered lines so mobile Termux screens always keep approval options visible!
      let count = 0;
      let hidden = 0;
      const cappedChunks: DiffChunk[] = [];
      for (const ch of chunks) {
        if (count >= MAX_DISPLAY_DIFF_LINES) {
          hidden += ch.lines.length;
          continue;
        }
        const room = MAX_DISPLAY_DIFF_LINES - count;
        if (ch.lines.length <= room) {
          cappedChunks.push(ch);
          count += ch.lines.length;
        } else {
          cappedChunks.push({ header: ch.header, lines: ch.lines.slice(0, room) });
          hidden += ch.lines.length - room;
          count += room;
        }
      }
      setTotalHiddenLines(hidden);
      setDiffChunks(cappedChunks);
    } catch (err) {
      setError(`Error generating diff: ${err}`);
    } finally {
      setIsLoading(false);
    }
  };

  const renderDiffLine = (line: string, index: number) => {
    const clipped = line.length > 120 ? line.slice(0, 117) + '...' : line;
    if (clipped.startsWith('+++') || clipped.startsWith('---')) {
      return (
        <Text key={index} bold color="blue">
          {clipped}
        </Text>
      );
    } else if (clipped.startsWith('@@')) {
      return (
        <Text key={index} color="cyan">
          {clipped}
        </Text>
      );
    } else if (clipped.startsWith('+')) {
      return (
        <Text key={index} backgroundColor="rgb(124, 214, 114)" color="black">
          + {clipped.slice(1)}
        </Text>
      );
    } else if (clipped.startsWith('-')) {
      return (
        <Text key={index} backgroundColor="rgb(214, 114, 114)" color="black">
          - {clipped.slice(1)}
        </Text>
      );
    } else if (clipped.startsWith(' ')) {
      return (
        <Text key={index} dimColor>
          {'  ' + clipped.slice(1)}
        </Text>
      );
    }
    return (
      <Text key={index} dimColor>
        {clipped}
      </Text>
    );
  };

  if (isLoading) {
    return (
      <Box>
        <Text color="yellow">Generating diff preview...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (diffChunks.length === 0) {
    return (
      <Box>
        <Text dimColor>No changes to show</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Diff Preview:</Text>
      {diffChunks.map((chunk, chunkIndex) => (
        <Box key={chunkIndex} flexDirection="column" marginTop={chunkIndex > 0 ? 1 : 0}>
          {chunkIndex > 0 && <Text dimColor>...</Text>}
          {chunk.lines.map((line, lineIndex) => renderDiffLine(line, lineIndex))}
        </Box>
      ))}
      {totalHiddenLines > 0 && (
        <Text dimColor>... (+{totalHiddenLines} more diff lines)</Text>
      )}
    </Box>
  );
}

/**
 * Fast O(Delta) Unified Diff:
 * Strips identical prefix & suffix lines BEFORE running LCS so 5,000+ line HTML/JS files
 * render diffs in < 1ms instead of freezing Termux with a 25M-cell matrix!
 */
function generateFastUnifiedDiff(
  originalLines: string[],
  newLines: string[],
  fromFile: string,
  toFile: string,
  context: number = 3
): string[] {
  let prefix = 0;
  const minLen = Math.min(originalLines.length, newLines.length);
  while (prefix < minLen && originalLines[prefix] === newLines[prefix]) {
    prefix++;
  }

  if (prefix === originalLines.length && prefix === newLines.length) {
    return [];
  }

  let origEnd = originalLines.length - 1;
  let newEnd = newLines.length - 1;
  while (origEnd >= prefix && newEnd >= prefix && originalLines[origEnd] === newLines[newEnd]) {
    origEnd--;
    newEnd--;
  }

  const ctxStart = Math.max(0, prefix - context);
  const origCtxEnd = Math.min(originalLines.length - 1, origEnd + context);
  const newCtxEnd = Math.min(newLines.length - 1, newEnd + context);

  const subOrig = originalLines.slice(ctxStart, origCtxEnd + 1);
  const subNew = newLines.slice(ctxStart, newCtxEnd + 1);

  // If delta window is still huge (e.g. creating a 2,000-line file), build linear hunk without quadratic LCS
  if (subOrig.length * subNew.length > 120_000) {
    const out: string[] = [
      `--- ${fromFile}`,
      `+++ ${toFile}`,
      `@@ -${ctxStart + 1},${subOrig.length} +${ctxStart + 1},${subNew.length} @@`,
    ];
    for (const l of subOrig.slice(0, 25)) out.push(`-${l}`);
    if (subOrig.length > 25) out.push(` ... (${subOrig.length - 25} removed lines omitted)`);
    for (const l of subNew.slice(0, 25)) out.push(`+${l}`);
    if (subNew.length > 25) out.push(` ... (${subNew.length - 25} added lines omitted)`);
    return out;
  }

  const m = subOrig.length;
  const n = subNew.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (subOrig[i - 1] === subNew[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  const ops: Array<{ type: 'equal' | 'delete' | 'insert'; line: string; origIdx: number; newIdx: number }> = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && subOrig[i - 1] === subNew[j - 1]) {
      ops.unshift({ type: 'equal', line: subOrig[i - 1], origIdx: ctxStart + i, newIdx: ctxStart + j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      ops.unshift({ type: 'insert', line: subNew[j - 1], origIdx: ctxStart + i, newIdx: ctxStart + j });
      j--;
    } else {
      ops.unshift({ type: 'delete', line: subOrig[i - 1], origIdx: ctxStart + i, newIdx: ctxStart + j });
      i--;
    }
  }

  const out: string[] = [
    `--- ${fromFile}`,
    `+++ ${toFile}`,
    `@@ -${ctxStart + 1},${subOrig.length} +${ctxStart + 1},${subNew.length} @@`,
  ];

  for (const op of ops) {
    if (op.type === 'equal') out.push(` ${op.line}`);
    else if (op.type === 'delete') out.push(`-${op.line}`);
    else out.push(`+${op.line}`);
  }
  return out;
}

function parseDiffIntoChunks(diffLines: string[]): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let currentChunk: DiffChunk | null = null;

  for (const line of diffLines) {
    if (line.startsWith('@@')) {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = { header: line, lines: [line] };
    } else if (currentChunk) {
      currentChunk.lines.push(line);
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

// Memoização anti-flicker: re-renderiza apenas quando args/nome mudam de verdade
export default React.memo(DiffPreview);
