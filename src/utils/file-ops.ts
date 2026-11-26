import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IGNORE_PATTERNS } from './constants.js';

/**
 * Resolve caminhos relativos, absolutos (`/storage/emulated/0/...`), `~/` e atalhos Android Termux (`@sdcard`, `@downloads`).
 */
export function resolveSmartPath(rawPath: string = '.'): string {
  const trimmed = (rawPath || '.').trim();
  if (!trimmed) return path.resolve('.');

  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  const shortcuts: Array<[string, string]> = [
    ['@sdcard', '/storage/emulated/0'],
    ['@downloads', '/storage/emulated/0/Download'],
    ['@dcim', '/storage/emulated/0/DCIM'],
    ['@documents', '/storage/emulated/0/Documents'],
    ['@pictures', '/storage/emulated/0/Pictures'],
  ];

  for (const [prefix, target] of shortcuts) {
    if (trimmed === prefix) return target;
    if (trimmed.startsWith(`${prefix}/`)) {
      return path.join(target, trimmed.slice(prefix.length + 1));
    }
  }

  return path.resolve(trimmed);
}

/**
 * Normaliza symlinks (ex: `~/storage/downloads/a.html` === `/storage/emulated/0/Download/a.html`)
 * para que `validateReadBeforeEdit` nunca falhe por diferença de symlink!
 */
export function canonicalizePath(rawPath: string): string {
  const resolved = resolveSmartPath(rawPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Write content to a file with safety checks
 */
export async function writeFile(filepath: string, content: string, force: boolean = false, backup: boolean = false): Promise<boolean> {
  const filePath = resolveSmartPath(filepath);
  
  try {
    const parentDir = path.dirname(filePath);
    await fs.promises.mkdir(parentDir, { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Create a directory with parent directories
 */
export async function createDirectory(directoryPath: string): Promise<boolean> {
  try {
    await fs.promises.mkdir(resolveSmartPath(directoryPath), { recursive: true });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Delete a file with safety checks
 */
export async function deleteFile(filepath: string, force: boolean = false): Promise<boolean> {
  const filePath = resolveSmartPath(filepath);
  
  try {
    const stats = await fs.promises.stat(filePath);
    
    if (!force) {
      return false;
    }
    
    if (stats.isFile()) {
      await fs.promises.unlink(filePath);
    } else if (stats.isDirectory()) {
      await fs.promises.rm(filePath, { recursive: true, force: true });
    }
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return false;
    }
    return false;
  }
}

/**
 * Simple tree display for list_files tool (supports symlinks like Termux ~/storage/downloads)
 */
export async function displayTree(
  directory: string = '.', 
  pattern: string = '*', 
  recursive: boolean = false, 
  showHidden: boolean = false
): Promise<string> {
  const directoryPath = resolveSmartPath(directory);
  
  try {
    const exists = await fs.promises.access(directoryPath).then(() => true).catch(() => false);
    if (!exists) {
      return `Directory not found: ${directory}`;
    }
    
    const items = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    const enriched: Array<{ name: string; isDir: boolean }> = [];

    for (const item of items) {
      const fullPath = path.join(directoryPath, item.name);
      if (shouldIgnore(fullPath)) continue;
      if (!showHidden && item.name.startsWith('.')) continue;

      let isDir = item.isDirectory();
      if (!isDir && item.isSymbolicLink()) {
        try {
          isDir = (await fs.promises.stat(fullPath)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      enriched.push({ name: item.name, isDir });
    }

    enriched.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    
    let output = `${path.basename(directoryPath) || directoryPath}/\n`;
    
    enriched.slice(0, 120).forEach((item, index, arr) => {
      const isLast = index === arr.length - 1;
      const prefix = isLast ? '└── ' : '├── ';
      output += item.isDir ? `${prefix}${item.name}/\n` : `${prefix}${item.name}\n`;
    });

    if (enriched.length > 120) {
      output += `... (${enriched.length - 120} more items)\n`;
    }
    
    return output.trim();
  } catch (error) {
    return `Error reading directory: ${error}`;
  }
}

/**
 * Check if a file or directory should be ignored
 */
export function shouldIgnore(filePath: string): boolean {
  const pathStr = path.resolve(filePath);
  const name = path.basename(pathStr);
  
  for (const pattern of IGNORE_PATTERNS) {
    if (pattern.includes('*')) {
      const regexPattern = pattern.replace(/\*/g, '.*');
      const regex = new RegExp(regexPattern);
      if (regex.test(name)) {
        return true;
      }
    } else {
      if (pathStr.includes(pattern) || name === pattern) {
        return true;
      }
    }
  }
  
  const allowedHiddenFiles = new Set(['.env', '.gitignore', '.dockerfile']);
  if (name.startsWith('.') && !allowedHiddenFiles.has(name)) {
    return true;
  }
  
  return false;
}
