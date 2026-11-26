import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Memória de lições (~/.groq/lessons.md):
 * correções e preferências do usuário que a CLI aprende e injeta em TODAS as
 * sessões futuras — a forma de "treinar" a CLI sem alterar os pesos do modelo.
 *
 * Ex.: "sempre adicionar background-color completo quando eu pedir cor de botão".
 */

const MAX_LESSONS = 40;
const MAX_LESSON_CHARS = 220;

function lessonsFile(): string {
  return path.join(os.homedir(), '.groq', 'lessons.md');
}

function normalizeLesson(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LESSON_CHARS);
}

function lessonKey(lesson: string): string {
  return normalizeLesson(lesson).toLowerCase().replace(/[áàâãä]/g, 'a').replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i').replace(/[óòôõö]/g, 'o').replace(/[úùûü]/g, 'u').replace(/[^a-z0-9]/g, '');
}

export function loadLessons(): string[] {
  try {
    const file = lessonsFile();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    const lessons: string[] = [];
    for (const line of lines) {
      // ignora cabeçalhos markdown e linhas vazias
      const cleaned = normalizeLesson(line.replace(/^[-*]\s*/, ''));
      if (!cleaned || cleaned.startsWith('#')) continue;
      lessons.push(cleaned);
    }
    return lessons;
  } catch {
    return [];
  }
}

export function addLesson(text: string): { added: boolean; lesson?: string; duplicate?: boolean; lessons: string[] } {
  const lesson = normalizeLesson(text);
  if (!lesson || lesson.length < 4) {
    return { added: false, lessons: loadLessons() };
  }

  const existing = loadLessons();
  const key = lessonKey(lesson);
  // dedupe: lição idêntica (ignorando acentos/pontuação) não é gravada de novo
  if (existing.some(l => lessonKey(l) === key)) {
    return { added: false, duplicate: true, lesson, lessons: existing };
  }

  existing.push(lesson);
  // mantém as mais recentes se estourar o limite
  const kept = existing.slice(Math.max(0, existing.length - MAX_LESSONS));

  try {
    const file = lessonsFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const body = [
      '# Lições memorizadas da CLI (preferências e correções do usuário)',
      '',
      ...kept.map(l => `- ${l}`),
      '',
    ].join('\n');
    fs.writeFileSync(file, body, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // noop
    }
    return { added: true, lesson, lessons: kept };
  } catch (error) {
    throw new Error(`Failed to save lesson: ${error}`);
  }
}

/** Bloco compacto para injetar no system prompt (≈0 tokens se não houver lições). */
export function buildLessonsPromptBlock(maxChars = 1400): string | null {
  const lessons = loadLessons();
  if (lessons.length === 0) return null;
  const kept: string[] = [];
  let total = 0;
  for (let i = lessons.length - 1; i >= 0; i--) {
    const l = lessons[i];
    if (total + l.length > maxChars) break;
    kept.unshift(l);
    total += l.length;
  }
  if (kept.length === 0) return null;
  return [
    '[LIÇÕES MEMORIZADAS DESTE USUÁRIO — siga OBRIGATORIAMENTE em toda tarefa]',
    ...kept.map(l => `- ${l}`),
    'Quando o usuário te corrigir ou expressar uma preferência duradoura, salve-a imediatamente com a ferramenta add_lesson.',
  ].join('\n');
}

export function clearLessons(): void {
  try {
    const file = lessonsFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // best-effort
  }
}
