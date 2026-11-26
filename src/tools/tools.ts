import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, createDirectory, displayTree, resolveSmartPath, canonicalizePath } from '../utils/file-ops.js';
import { buildFileOutline, grepInFileContent } from '../utils/code-intel.js';
import { setReadFilesTracker, markFileAsRead } from './validators.js';

const execAsync = promisify(exec);

export interface ToolResult {
  success: boolean;
  content?: any;
  data?: any;
  message?: string;
  error?: string;
}

interface TaskUpdate {
  id: string;
  status: 'pending' | 'in_progress' | 'completed';
  notes?: string;
}

interface Task {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  notes?: string;
  updated_at?: string;
}

let currentTaskList: {
  user_query: string;
  tasks: Task[];
  created_at: string;
} | null = null;

const readFiles = new Set<string>();

export function getReadFilesTracker(): Set<string> {
  return readFiles;
}

setReadFilesTracker(readFiles);

const LARGE_FILE_LINE_THRESHOLD = 180;
const MAX_LINES_PER_READ = 160;

/**
 * Format key parameters for tool call display in the Ink UI
 */
export function formatToolParams(
  toolName: string,
  toolArgs: Record<string, any>,
  options: { includePrefix?: boolean; separator?: string } = {}
): string {
  const { includePrefix = true, separator = '=' } = options;

  const paramMappings: Record<string, string[]> = {
    read_file: ['file_path', 'start_line', 'end_line'],
    grep_file: ['file_path', 'pattern'],
    create_file: ['file_path'],
    edit_file: ['file_path'],
    replace_lines: ['file_path', 'start_line', 'end_line'],
    delete_file: ['file_path'],
    list_files: ['directory'],
    search_files: ['pattern', 'directory'],
    execute_command: ['command'],
    create_tasks: [],
    update_tasks: [],
  };

  const keyParams = paramMappings[toolName] || [];
  if (keyParams.length === 0) {
    return '';
  }

  const paramParts = keyParams
    .filter(param => param in toolArgs && toolArgs[param] !== undefined)
    .map(param => {
      let value = toolArgs[param];
      if (typeof value === 'string' && value.length > 52) {
        value = value.substring(0, 49) + '...';
      } else if (Array.isArray(value) && value.length > 3) {
        value = `[${value.length} items]`;
      }
      return `${param}${separator}${JSON.stringify(value)}`;
    });

  if (paramParts.length === 0) {
    return includePrefix ? `Arguments: ${JSON.stringify(toolArgs)}` : JSON.stringify(toolArgs);
  }

  const formattedParams = paramParts.join(', ');
  return includePrefix ? `Parameters: ${formattedParams}` : formattedParams;
}

export function createToolResponse(
  success: boolean,
  data?: any,
  message: string = '',
  error: string = ''
): ToolResult {
  const response: ToolResult = { success };

  if (success) {
    if (data !== undefined) {
      response.content = data;
    }
    if (message) {
      response.message = message;
    }
  } else {
    response.error = error;
    if (message) {
      response.message = message;
    }
  }

  return response;
}

/**
 * Read file contents safely:
 * - Never dumps 4,000+ line files raw into LLM messages (prevents HTTP 413 Request Too Large!)
 * - Automatically generates a structural outline + lines 1-90 when called without start_line on large files
 * - Caps individual line slices to MAX_LINES_PER_READ (160 lines)
 */
export async function readFile(
  filePath: string,
  startLine?: number,
  endLine?: number
): Promise<ToolResult> {
  try {
    const resolvedPath = resolveSmartPath(filePath);

    try {
      await fs.promises.access(resolvedPath);
    } catch {
      return createToolResponse(false, undefined, '', `Error: File not found: ${filePath}`);
    }

    const stats = await fs.promises.stat(resolvedPath);
    if (!stats.isFile()) {
      return createToolResponse(false, undefined, '', 'Error: Path is not a file');
    }

    if (stats.size > 50 * 1024 * 1024) {
      return createToolResponse(false, undefined, '', 'Error: File too large (max 50MB)');
    }

    const content = await fs.promises.readFile(resolvedPath, 'utf-8');
    const lines = content.split(/\r?\n/);

    markFileAsRead(resolvedPath);

    // Explicit line range requested
    if (startLine !== undefined) {
      const start = Math.max(1, Math.floor(startLine));
      const startIdx = start - 1;
      if (startIdx >= lines.length) {
        return createToolResponse(
          false,
          undefined,
          '',
          `Error: start_line (${start}) exceeds total lines (${lines.length})`
        );
      }

      const requestedEnd = endLine !== undefined ? Math.floor(endLine) : start + MAX_LINES_PER_READ - 1;
      const cappedEnd = Math.min(lines.length, Math.max(start, Math.min(requestedEnd, start + MAX_LINES_PER_READ - 1)));
      const selectedContent = lines.slice(startIdx, cappedEnd).join('\n');
      const truncatedNote =
        endLine !== undefined && endLine > cappedEnd
          ? ` (capped to ${MAX_LINES_PER_READ} lines; read ${cappedEnd + 1}..${endLine} next if needed)`
          : '';
      const message = `Read lines ${start}-${cappedEnd} of ${lines.length} from ${filePath}${truncatedNote}`;
      return createToolResponse(true, selectedContent, message);
    }

    // Large file without start_line -> return structural outline + lines 1..90!
    if (lines.length > LARGE_FILE_LINE_THRESHOLD) {
      const outline = buildFileOutline(content, resolvedPath);
      const previewEnd = Math.min(90, lines.length);
      const previewLines = lines.slice(0, previewEnd).join('\n');
      const smartPayload =
        `${outline}\n\n` +
        `=== PREVIEW LINES 1-${previewEnd} OF ${lines.length} ===\n` +
        `${previewLines}\n\n` +
        `[NOTE: Large file (${lines.length} lines). Full dump omitted to fit token limits. ` +
        `Use grep_file(file_path="${filePath}", pattern="...") to locate selectors/variables/buttons, ` +
        `or read_file(file_path="${filePath}", start_line=..., end_line=...) to inspect specific ranges.]`;

      return createToolResponse(
        true,
        smartPayload,
        `Mapped outline + lines 1-${previewEnd} (of ${lines.length}) from ${filePath}`
      );
    }

    const message = `Read ${lines.length} lines from ${filePath}`;
    return createToolResponse(true, content, message);
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      return createToolResponse(false, undefined, '', `Error: File not found: ${filePath}`);
    }
    return createToolResponse(false, undefined, '', 'Error: Failed to read file');
  }
}

/**
 * Search directly inside a single file (fast, works on external paths like /storage/emulated/0/Download/...)
 */
export async function grepFile(
  filePath: string,
  pattern: string,
  isRegex: boolean = false,
  contextLines: number = 2
): Promise<ToolResult> {
  try {
    const resolvedPath = resolveSmartPath(filePath);
    try {
      await fs.promises.access(resolvedPath);
    } catch {
      return createToolResponse(false, undefined, '', `Error: File not found: ${filePath}`);
    }

    const stats = await fs.promises.stat(resolvedPath);
    if (!stats.isFile()) {
      return createToolResponse(false, undefined, '', 'Error: Path is not a file');
    }

    const content = await fs.promises.readFile(resolvedPath, 'utf-8');
    markFileAsRead(resolvedPath);

    const { totalMatches, matches } = grepInFileContent(content, pattern, {
      isRegex,
      contextLines: Math.min(10, Math.max(0, contextLines ?? 2)),
      maxMatches: 35,
    });

    if (totalMatches === 0) {
      return createToolResponse(
        true,
        `No matches for "${pattern}" in ${filePath}.`,
        `0 matches in ${path.basename(resolvedPath)}`
      );
    }

    const formatted = matches.map(m => m.snippet).join('\n---\n');
    const summaryMsg = `Found ${totalMatches} match(es) in ${path.basename(resolvedPath)}${totalMatches > matches.length ? ` (showing first ${matches.length})` : ''}`;
    return createToolResponse(true, `${summaryMsg}:\n${formatted}`, summaryMsg);
  } catch (error) {
    return createToolResponse(false, undefined, '', `Error: grep_file failed - ${error}`);
  }
}

export async function createFile(
  filePath: string,
  content: string,
  fileType: string = 'file',
  overwrite: boolean = false
): Promise<ToolResult> {
  try {
    const targetPath = resolveSmartPath(filePath);
    const exists = await fs.promises.access(targetPath).then(() => true).catch(() => false);
    if (exists && !overwrite) {
      return createToolResponse(false, undefined, '', 'Error: File already exists, use edit_file, replace_lines, or overwrite=true');
    }

    if (fileType === 'directory') {
      const result = await createDirectory(targetPath);
      if (result) {
        return createToolResponse(true, { path: targetPath, type: 'directory' }, `Directory created: ${filePath}`);
      }
      return createToolResponse(false, undefined, '', 'Error: Failed to create directory');
    } else if (fileType === 'file') {
      const result = await writeFile(targetPath, content, overwrite, true);
      if (result) {
        markFileAsRead(targetPath);
        return createToolResponse(true, undefined, `File created: ${filePath}`);
      }
      return createToolResponse(false, undefined, '', 'Error: Failed to create file');
    }
    return createToolResponse(false, undefined, '', "Error: Invalid file_type, must be 'file' or 'directory'");
  } catch (error) {
    return createToolResponse(false, undefined, '', 'Error: Failed to create file or directory');
  }
}

function stripAccidentalLineNumbers(snippet: string): string {
  const lines = snippet.split('\n');
  if (lines.length > 0 && lines.every(l => !l.trim() || /^(?:>\s*)?L?\d+:\s?/.test(l))) {
    return lines.map(l => l.replace(/^(?:>\s*)?L?\d+:\s?/, '')).join('\n');
  }
  return snippet;
}

/**
 * Edit an existing file (supports single replacement OR batch `edits[]`, plus CRLF tolerance!)
 */
export async function editFile(
  filePath: string,
  oldText?: string,
  newText?: string,
  replaceAll: boolean = false,
  edits?: Array<{ old_text: string; new_text: string; replace_all?: boolean }>
): Promise<ToolResult> {
  try {
    const resolvedPath = resolveSmartPath(filePath);
    const exists = await fs.promises.access(resolvedPath).then(() => true).catch(() => false);
    if (!exists) {
      return createToolResponse(false, undefined, '', `Error: File not found: ${filePath}`);
    }

    const originalRaw = await fs.promises.readFile(resolvedPath, 'utf-8');
    const usesCrlf = originalRaw.includes('\r\n');
    let working = originalRaw.replace(/\r\n/g, '\n');

    const editList: Array<{ old_text: string; new_text: string; replace_all?: boolean }> =
      Array.isArray(edits) && edits.length > 0
        ? edits
        : oldText !== undefined && newText !== undefined
          ? [{ old_text: oldText, new_text: newText, replace_all: replaceAll }]
          : [];

    if (editList.length === 0) {
      return createToolResponse(
        false,
        undefined,
        '',
        'Error: Provide old_text & new_text, or a non-empty edits[] array.'
      );
    }

    let totalReplacements = 0;

    for (let idx = 0; idx < editList.length; idx++) {
      const item = editList[idx];
      let targetOld = String(item.old_text ?? '').replace(/\r\n/g, '\n');
      let targetNew = String(item.new_text ?? '').replace(/\r\n/g, '\n');

      if (!targetOld) {
        return createToolResponse(false, undefined, '', `Error: old_text in edit #${idx + 1} cannot be empty`);
      }

      if (!working.includes(targetOld)) {
        // Fallback if LLM accidentally copied L12: prefixes from grep_file
        const strippedOld = stripAccidentalLineNumbers(targetOld);
        if (strippedOld !== targetOld && working.includes(strippedOld)) {
          targetOld = strippedOld;
          targetNew = stripAccidentalLineNumbers(targetNew);
        } else {
          return createToolResponse(
            false,
            undefined,
            '',
            `Error: old_text not found in ${path.basename(resolvedPath)} (edit #${idx + 1}: "${targetOld.slice(0, 60).replace(/\n/g, '\\n')}..."). Re-read the exact lines or use replace_lines.`
          );
        }
      }

      const doAll = Boolean(item.replace_all ?? replaceAll);
      if (doAll) {
        const occurrences = working.split(targetOld).length - 1;
        working = working.split(targetOld).join(targetNew);
        totalReplacements += occurrences;
      } else {
        working = working.replace(targetOld, targetNew);
        totalReplacements += 1;
      }
    }

    const finalOut = usesCrlf ? working.replace(/\n/g, '\r\n') : working;
    const result = await writeFile(resolvedPath, finalOut, true, true);
    if (result) {
      markFileAsRead(resolvedPath);
      return createToolResponse(
        true,
        undefined,
        `Applied ${totalReplacements} replacement(s) in ${filePath}`
      );
    }
    return createToolResponse(false, undefined, '', 'Error: Failed to write changes to file');
  } catch (error) {
    return createToolResponse(false, undefined, '', `Error: Failed to edit file - ${error}`);
  }
}

/**
 * Surgically replace lines [startLine..endLine] (1-indexed, inclusive)
 */
export async function replaceLines(
  filePath: string,
  startLine: number,
  endLine: number,
  newContent: string
): Promise<ToolResult> {
  try {
    const resolvedPath = resolveSmartPath(filePath);
    const exists = await fs.promises.access(resolvedPath).then(() => true).catch(() => false);
    if (!exists) {
      return createToolResponse(false, undefined, '', `Error: File not found: ${filePath}`);
    }

    const raw = await fs.promises.readFile(resolvedPath, 'utf-8');
    const usesCrlf = raw.includes('\r\n');
    const lines = raw.replace(/\r\n/g, '\n').split('\n');

    const s = Math.max(1, Math.floor(startLine));
    const e = Math.min(lines.length, Math.floor(endLine));
    if (s > e || s > lines.length) {
      return createToolResponse(
        false,
        undefined,
        '',
        `Error: Invalid line range ${startLine}..${endLine} (file has ${lines.length} lines)`
      );
    }

    const cleanNew = stripAccidentalLineNumbers(newContent.replace(/\r\n/g, '\n'));
    const replacementLines = cleanNew === '' ? [] : cleanNew.split('\n');
    lines.splice(s - 1, e - s + 1, ...replacementLines);

    const updated = lines.join(usesCrlf ? '\r\n' : '\n');
    const ok = await writeFile(resolvedPath, updated, true, true);
    if (!ok) {
      return createToolResponse(false, undefined, '', 'Error: Failed to write updated lines');
    }
    markFileAsRead(resolvedPath);
    return createToolResponse(
      true,
      undefined,
      `Replaced lines ${s}-${e} (${e - s + 1} -> ${replacementLines.length} lines) in ${filePath}`
    );
  } catch (error) {
    return createToolResponse(false, undefined, '', `Error: replace_lines failed - ${error}`);
  }
}

export async function deleteFile(filePath: string, recursive: boolean = false): Promise<ToolResult> {
  try {
    const targetPath = resolveSmartPath(filePath);
    const currentWorkingDir = path.resolve(process.cwd());

    if (targetPath === currentWorkingDir) {
      return createToolResponse(false, undefined, '', 'Error: Cannot delete the root project directory');
    }

    const exists = await fs.promises.access(targetPath).then(() => true).catch(() => false);
    if (!exists) {
      return createToolResponse(false, undefined, '', 'Error: Path not found');
    }

    const stats = await fs.promises.stat(targetPath);
    if (stats.isDirectory() && !recursive) {
      const items = await fs.promises.readdir(targetPath);
      if (items.length > 0) {
        return createToolResponse(false, undefined, '', 'Error: Directory not empty, use recursive=true');
      }
    }

    if (stats.isDirectory()) {
      await fs.promises.rm(targetPath, { recursive, force: true });
    } else {
      await fs.promises.unlink(targetPath);
    }

    const fileType = stats.isDirectory() ? 'directory' : 'file';
    return createToolResponse(true, undefined, `Deleted ${fileType}: ${filePath}`);
  } catch (error) {
    return createToolResponse(false, undefined, '', 'Error: Failed to delete');
  }
}

export async function listFiles(
  directory: string = '.',
  pattern: string = '*',
  recursive: boolean = false,
  showHidden: boolean = false
): Promise<ToolResult> {
  try {
    const dirPath = resolveSmartPath(directory);

    const exists = await fs.promises.access(dirPath).then(() => true).catch(() => false);
    if (!exists) {
      return createToolResponse(false, undefined, '', `Error: Directory not found: ${directory}`);
    }

    const stats = await fs.promises.stat(dirPath);
    if (!stats.isDirectory()) {
      return createToolResponse(false, undefined, '', 'Error: Path is not a directory');
    }

    const treeOutput = await displayTree(dirPath, pattern, recursive, showHidden);
    return createToolResponse(true, treeOutput, `Listed ${directory}`);
  } catch (error) {
    return createToolResponse(false, undefined, '', 'Error: Failed to list files');
  }
}

export async function searchFiles(
  pattern: string,
  filePattern: string = '*',
  directory: string = '.',
  caseSensitive: boolean = false,
  patternType: 'substring' | 'regex' | 'exact' | 'fuzzy' = 'substring',
  fileTypes?: string[],
  excludeDirs?: string[],
  excludeFiles?: string[],
  maxResults: number = 30,
  contextLines: number = 0,
  groupByFile: boolean = false
): Promise<ToolResult> {
  try {
    const searchDir = resolveSmartPath(directory);

    const exists = await fs.promises.access(searchDir).then(() => true).catch(() => false);
    if (!exists) {
      return createToolResponse(false, undefined, '', `Error: Path not found: ${directory}`);
    }

    const stats = await fs.promises.stat(searchDir);
    // If LLM passed a file path to search_files, delegate directly to grepFile!
    if (stats.isFile()) {
      return grepFile(searchDir, pattern, patternType === 'regex', contextLines);
    }
    if (!stats.isDirectory()) {
      return createToolResponse(false, undefined, '', 'Error: Path is not a directory');
    }

    const cappedMax = Math.min(Math.max(1, maxResults || 30), 40);
    const defaultExcludeDirs = ['.git', 'node_modules', '.next', 'dist', 'build', '.cache', 'Android'];
    const defaultExcludeFiles = ['*.log', '*.tmp', '*.cache', '*.lock'];

    const finalExcludeDirs = [...defaultExcludeDirs, ...(excludeDirs || [])];
    const finalExcludeFiles = [...defaultExcludeFiles, ...(excludeFiles || [])];

    let searchRegex: RegExp;
    try {
      switch (patternType) {
        case 'exact':
          searchRegex = new RegExp(escapeRegex(pattern), caseSensitive ? 'g' : 'gi');
          break;
        case 'regex':
          searchRegex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
          break;
        case 'fuzzy': {
          const fuzzyPattern = pattern.split('').map(escapeRegex).join('.*');
          searchRegex = new RegExp(fuzzyPattern, caseSensitive ? 'g' : 'gi');
          break;
        }
        case 'substring':
        default:
          searchRegex = new RegExp(escapeRegex(pattern), caseSensitive ? 'g' : 'gi');
          break;
      }
    } catch {
      return createToolResponse(false, undefined, '', 'Error: Invalid regex pattern');
    }

    const filesToSearch = await collectFiles(
      searchDir,
      filePattern,
      fileTypes,
      finalExcludeDirs,
      finalExcludeFiles
    );

    if (filesToSearch.length === 0) {
      return createToolResponse(true, [], 'No files found matching criteria');
    }

    const results: SearchResult[] = [];
    let totalMatches = 0;

    for (const filePath of filesToSearch) {
      if (totalMatches >= cappedMax) break;

      try {
        const fStat = await fs.promises.stat(filePath);
        if (fStat.size > 2 * 1024 * 1024) continue; // skip huge >2MB blobs during folder scan

        const content = await fs.promises.readFile(filePath, 'utf-8');
        const lines = content.split(/\r?\n/);
        const fileMatches: SearchMatch[] = [];

        for (let i = 0; i < lines.length && totalMatches < cappedMax; i++) {
          const line = lines[i];
          const matches = Array.from(line.matchAll(searchRegex));

          if (matches.length > 0) {
            const contextStart = Math.max(0, i - contextLines);
            const contextEnd = Math.min(lines.length - 1, i + contextLines);

            const contextLinesArray: string[] = [];
            for (let j = contextStart; j <= contextEnd; j++) {
              contextLinesArray.push(lines[j].slice(0, 180));
            }

            fileMatches.push({
              lineNumber: i + 1,
              lineContent: line.slice(0, 180),
              contextLines: contextLines > 0 ? contextLinesArray : undefined,
              matchPositions: matches.slice(0, 5).map(match => ({
                start: match.index || 0,
                end: (match.index || 0) + match[0].length,
                text: match[0].slice(0, 80),
              })),
            });

            totalMatches++;
          }
        }

        if (fileMatches.length > 0) {
          results.push({
            filePath: filePath.startsWith(process.cwd()) ? path.relative(process.cwd(), filePath) : filePath,
            matches: fileMatches,
            totalMatches: fileMatches.length,
          });
        }
      } catch {
        continue;
      }
    }

    const formattedResults = groupByFile
      ? results
      : results.flatMap(fileResult =>
          fileResult.matches.map(match => ({
            filePath: fileResult.filePath,
            lineNumber: match.lineNumber,
            lineContent: match.lineContent,
            contextLines: match.contextLines,
          }))
        );

    const message = `Found ${totalMatches} match(es) in ${results.length} file(s)`;
    return createToolResponse(true, formattedResults, message);
  } catch {
    return createToolResponse(false, undefined, '', 'Error: Failed to search files');
  }
}

interface SearchMatch {
  lineNumber: number;
  lineContent: string;
  contextLines?: string[];
  matchPositions: Array<{
    start: number;
    end: number;
    text: string;
  }>;
}

interface SearchResult {
  filePath: string;
  matches: SearchMatch[];
  totalMatches: number;
}

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function collectFiles(
  directory: string,
  filePattern: string,
  fileTypes?: string[],
  excludeDirs?: string[],
  excludeFiles?: string[]
): Promise<string[]> {
  const files: string[] = [];
  const visitedDirs = new Set<string>();
  const MAX_FILES_COLLECTED = 400;

  async function walkDirectory(dir: string, depth: number): Promise<void> {
    if (depth > 6 || files.length >= MAX_FILES_COLLECTED) return;
    const realDir = canonicalizePath(dir);
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (files.length >= MAX_FILES_COLLECTED) break;
        const fullPath = path.join(dir, entry.name);

        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            const st = await fs.promises.stat(fullPath);
            isDir = st.isDirectory();
            isFile = st.isFile();
          } catch {
            continue;
          }
        }

        if (isDir) {
          if (excludeDirs && excludeDirs.some(pattern => matchesPattern(entry.name, pattern))) {
            continue;
          }
          if (entry.name.startsWith('.') && !entry.name.match(/^\.(config|env)$/)) {
            continue;
          }
          await walkDirectory(fullPath, depth + 1);
        } else if (isFile) {
          if (fileTypes && fileTypes.length > 0) {
            const ext = path.extname(entry.name).slice(1);
            if (!fileTypes.includes(ext)) continue;
          }
          if (!matchesPattern(entry.name, filePattern)) continue;
          if (excludeFiles && excludeFiles.some(pattern => matchesPattern(entry.name, pattern))) {
            continue;
          }
          if (isBinaryFile(entry.name)) continue;
          files.push(fullPath);
        }
      }
    } catch {
      // ignore unreadable dirs
    }
  }

  await walkDirectory(directory, 0);
  return files;
}

function matchesPattern(filename: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true;
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexPattern}$`, 'i').test(filename);
}

function isBinaryFile(filename: string): boolean {
  const binaryExtensions = [
    '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib',
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg', '.webp',
    '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.opus', '.ogg', '.m4a', '.wav',
    '.zip', '.tar', '.gz', '.bz2', '.rar', '.7z',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  ];
  const ext = path.extname(filename).toLowerCase();
  return binaryExtensions.includes(ext);
}

export async function executeCommand(
  command: string,
  commandType: string,
  workingDirectory?: string,
  timeout: number = 30000
): Promise<ToolResult> {
  try {
    if (!['bash', 'python', 'setup', 'run'].includes(commandType)) {
      return createToolResponse(false, undefined, '', 'Error: Invalid command_type');
    }

    let cwdToUse = process.cwd();
    if (workingDirectory) {
      const wdPath = resolveSmartPath(workingDirectory);
      const exists = await fs.promises.access(wdPath).then(() => true).catch(() => false);
      if (!exists) {
        return createToolResponse(false, undefined, '', 'Error: Working directory not found');
      }
      cwdToUse = wdPath;
    }

    const execCommand =
      commandType === 'python'
        ? `python3 -c "${command.replace(/"/g, '\\"')}"`
        : command;

    const { stdout, stderr } = await execAsync(execCommand, {
      timeout,
      cwd: cwdToUse,
      maxBuffer: 2 * 1024 * 1024,
    });

    const trimmedStdout = stdout.length > 4000 ? stdout.slice(0, 4000) + '\n...[truncated]' : stdout;
    const trimmedStderr = stderr.length > 2000 ? stderr.slice(0, 2000) + '\n...[truncated]' : stderr;

    return createToolResponse(
      true,
      `stdout: ${trimmedStdout}\nstderr: ${trimmedStderr}`,
      'Command executed successfully'
    );
  } catch (error: any) {
    const isTimeout = error.killed && error.signal === 'SIGTERM';
    if (isTimeout) {
      return createToolResponse(false, undefined, '', 'Error: Command timed out');
    }
    const detail = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').slice(0, 1500);
    return createToolResponse(false, undefined, '', `Error: Command failed - ${detail}`);
  }
}

export async function createTasks(userQuery: string, tasks: Task[]): Promise<ToolResult> {
  try {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      if (!task.id || !task.description) {
        return createToolResponse(false, undefined, '', `Error: Task ${i} missing required fields (id, description)`);
      }
      if (!task.status) task.status = 'pending';
      if (!['pending', 'in_progress', 'completed'].includes(task.status)) {
        return createToolResponse(false, undefined, '', `Error: Invalid status '${task.status}' for task ${task.id}`);
      }
    }

    currentTaskList = {
      user_query: userQuery,
      tasks,
      created_at: new Date().toISOString(),
    };

    const snapshot = {
      user_query: currentTaskList.user_query,
      tasks: currentTaskList.tasks.map(task => ({ ...task })),
      created_at: currentTaskList.created_at,
    };

    return createToolResponse(
      true,
      snapshot,
      `Created task list with ${tasks.length} tasks for: ${userQuery}`
    );
  } catch (error) {
    return createToolResponse(false, undefined, '', `Error: Failed to create tasks - ${error}`);
  }
}

export async function updateTasks(taskUpdates: TaskUpdate[]): Promise<ToolResult> {
  try {
    if (!currentTaskList) {
      return createToolResponse(false, undefined, '', 'Error: No task list exists. Create tasks first.');
    }

    const updatesMade: Array<{
      id: string;
      description: string;
      old_status: string;
      new_status: string;
    }> = [];

    for (const update of taskUpdates) {
      if (!update.id || !update.status) {
        return createToolResponse(false, undefined, '', 'Error: Task update missing required fields (id, status)');
      }
      if (!['pending', 'in_progress', 'completed'].includes(update.status)) {
        return createToolResponse(false, undefined, '', `Error: Invalid status '${update.status}'`);
      }

      let taskFound = false;
      for (const task of currentTaskList.tasks) {
        if (task.id === update.id) {
          const oldStatus = task.status;
          task.status = update.status;
          if (update.notes) task.notes = update.notes;
          task.updated_at = new Date().toISOString();
          updatesMade.push({
            id: update.id,
            description: task.description,
            old_status: oldStatus,
            new_status: update.status,
          });
          taskFound = true;
          break;
        }
      }

      if (!taskFound) {
        return createToolResponse(false, undefined, '', `Error: Task '${update.id}' not found`);
      }
    }

    const snapshot = {
      user_query: currentTaskList.user_query,
      tasks: currentTaskList.tasks.map(task => ({ ...task })),
      created_at: currentTaskList.created_at,
    };

    return createToolResponse(true, snapshot, `Updated ${updatesMade.length} task(s)`);
  } catch (error) {
    return createToolResponse(false, undefined, '', `Error: Failed to update tasks - ${error}`);
  }
}

export const TOOL_REGISTRY = {
  read_file: readFile,
  grep_file: grepFile,
  create_file: createFile,
  edit_file: editFile,
  replace_lines: replaceLines,
  delete_file: deleteFile,
  list_files: listFiles,
  search_files: searchFiles,
  execute_command: executeCommand,
  create_tasks: createTasks,
  update_tasks: updateTasks,
};

export async function executeTool(toolName: string, toolArgs: Record<string, any>): Promise<ToolResult> {
  if (!(toolName in TOOL_REGISTRY)) {
    return createToolResponse(false, undefined, '', `Error: Unknown tool "${toolName}"`);
  }

  try {
    switch (toolName) {
      case 'read_file':
        return await readFile(toolArgs.file_path, toolArgs.start_line, toolArgs.end_line);
      case 'grep_file':
        return await grepFile(toolArgs.file_path, toolArgs.pattern, toolArgs.is_regex, toolArgs.context_lines);
      case 'create_file':
        return await createFile(toolArgs.file_path, toolArgs.content, toolArgs.file_type, toolArgs.overwrite);
      case 'edit_file':
        return await editFile(
          toolArgs.file_path,
          toolArgs.old_text,
          toolArgs.new_text,
          toolArgs.replace_all,
          toolArgs.edits
        );
      case 'replace_lines':
        return await replaceLines(
          toolArgs.file_path,
          toolArgs.start_line,
          toolArgs.end_line,
          toolArgs.new_content
        );
      case 'delete_file':
        return await deleteFile(toolArgs.file_path, toolArgs.recursive);
      case 'list_files':
        return await listFiles(toolArgs.directory, toolArgs.pattern, toolArgs.recursive, toolArgs.show_hidden);
      case 'search_files':
        return await searchFiles(
          toolArgs.pattern,
          toolArgs.file_pattern,
          toolArgs.directory,
          toolArgs.case_sensitive,
          toolArgs.pattern_type,
          toolArgs.file_types,
          toolArgs.exclude_dirs,
          toolArgs.exclude_files,
          toolArgs.max_results,
          toolArgs.context_lines,
          toolArgs.group_by_file
        );
      case 'execute_command':
        return await executeCommand(
          toolArgs.command,
          toolArgs.command_type,
          toolArgs.working_directory,
          toolArgs.timeout
        );
      case 'create_tasks':
        return await createTasks(toolArgs.user_query, toolArgs.tasks);
      case 'update_tasks':
        return await updateTasks(toolArgs.task_updates);
      default:
        return createToolResponse(false, undefined, '', 'Error: Tool not implemented');
    }
  } catch (error) {
    if (error instanceof TypeError) {
      return createToolResponse(false, undefined, '', 'Error: Invalid tool arguments');
    }
    return createToolResponse(false, undefined, '', `Error: Unexpected tool error - ${error}`);
  }
}
