import { CommandDefinition, CommandContext } from '../base.js';
import { listSessions } from '../../utils/session-store.js';

export const sessionsCommand: CommandDefinition = {
  command: 'sessions',
  description: 'List saved conversations (persistent memory)',
  handler: ({ addMessage }: CommandContext) => {
    const all = listSessions();

    if (all.length === 0) {
      addMessage({
        role: 'system',
        content:
          '💾 Nenhuma conversa salva ainda.\nAs conversas são salvas automaticamente após cada mensagem em ~/.groq/sessions/ — você pode fechar o Terminal e voltar dias depois com /resume.',
      });
      return;
    }

    const lines = all
      .slice(0, 20)
      .map((s, i) => {
        const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString('pt-BR') : '?';
        return `${i + 1}. ${s.title} — ${s.messageCount} msgs · ${when}`;
      })
      .join('\n');

    addMessage({
      role: 'system',
      content: `💾 Conversas salvas (mais recentes primeiro):\n${lines}\n\nUse /resume <número> ou /resume <trecho do título> para retomar de onde parou.`,
    });
  },
};
