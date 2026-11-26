import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Persistência de sessões (memória da CLI):
 * cada conversa é salva em ~/.groq/sessions/<id>.json com mensagens,
 * ledger de arquivos e um resumo — permitindo retomar dias depois
 * exatamente de onde parou.
 */

export interface SessionFileEntry {
  lastAction: string;
  detail: string;
  lineCount?: number;
  ts: number;
}

export interface SavedSession {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: any[];
  fileLedger: Array<[string, SessionFileEntry]>;
  editLedger: string[];
  summary?: string;
}

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

function sessionsDir(): string {
  return path.join(os.homedir(), '.groq', 'sessions');
}

function sessionPath(id: string): string {
  // sanitiza o id para nome de arquivo seguro
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return path.join(sessionsDir(), `${safe}.json`);
}

export function slugifyTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48) || 'sessao';
}

export function saveSession(session: SavedSession): string {
  try {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const file = sessionPath(session.id);
    fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // noop
    }
    return file;
  } catch (error) {
    throw new Error(`Failed to save session: ${error}`);
  }
}

export function loadSessionById(id: string): SavedSession | null {
  try {
    const file = sessionPath(id);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data || !Array.isArray(data.messages)) return null;
    return data as SavedSession;
  } catch {
    return null;
  }
}

export function listSessions(): SessionListItem[] {
  try {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return [];
    const items: SessionListItem[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
        if (data && Array.isArray(data.messages)) {
          items.push({
            id: String(data.id || name.replace(/\.json$/, '')),
            title: String(data.title || 'Sem título'),
            updatedAt: String(data.updatedAt || data.createdAt || ''),
            messageCount: data.messages.length,
          });
        }
      } catch {
        // ignora arquivos corrompidos
      }
    }
    // mais recentes primeiro
    items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return items;
  } catch {
    return [];
  }
}

export function findSessionByQuery(query: string): SavedSession | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  // 1) por id exato
  const byId = loadSessionById(q);
  if (byId) return byId;
  // 2) por trecho do título (case-insensitive)
  const all = listSessions();
  const match = all.find(s => s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  if (match) return loadSessionById(match.id);
  return null;
}
