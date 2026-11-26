import { CommandDefinition, CommandContext } from '../base.js';
import { loadLessons, clearLessons } from '../../utils/lessons.js';

export const lessonsCommand: CommandDefinition = {
  command: 'lessons',
  description: 'List (or /lessons clear) your saved lessons/preferences',
  handler: ({ addMessage, args }: CommandContext) => {
    const arg = (args || '').trim().toLowerCase();

    if (arg === 'clear' || arg === 'limpar') {
      clearLessons();
      addMessage({ role: 'system', content: '🗑️ Todas as lições memorizadas foram apagadas.' });
      return;
    }

    const lessons = loadLessons();
    if (lessons.length === 0) {
      addMessage({
        role: 'system',
        content: '💾 Nenhuma lição memorizada ainda.\nUse /lesson <regra> para ensinar uma preferência (ex.: "/lesson sempre definir background-color completo ao pedir cor de botão").\nA IA também aprende sozinha: quando você corrige uma resposta dela, ela pode salvar a correção com a ferramenta add_lesson.',
      });
      return;
    }

    const lines = lessons.map((l, i) => `${i + 1}. ${l}`).join('\n');
    addMessage({
      role: 'system',
      content: `💾 Lições memorizadas (aplicadas em todas as conversas):\n${lines}\n\nAdicionar: /lesson <regra> · Apagar todas: /lessons clear`,
    });
  },
};
