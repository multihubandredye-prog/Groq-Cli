import { canonicalizePath, resolveSmartPath } from '../utils/file-ops.js';

// Track which files have been read in the current session
let readFiles: Set<string> | null = null;

export function setReadFilesTracker(tracker: Set<string>) {
  readFiles = tracker;
}

export function markFileAsRead(filePath: string): void {
  if (!readFiles) return;
  readFiles.add(resolveSmartPath(filePath));
  readFiles.add(canonicalizePath(filePath));
}

// Check if a file has been read before allowing edits
export function validateReadBeforeEdit(filePath: string): boolean {
  if (!readFiles) {
    return true;
  }
  return (
    readFiles.has(resolveSmartPath(filePath)) ||
    readFiles.has(canonicalizePath(filePath))
  );
}

export function getReadBeforeEditError(filePath: string): string {
  return `File must be read or inspected first before editing. Use read_file or grep_file on: ${filePath}`;
}
