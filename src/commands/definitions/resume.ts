import { CommandDefinition, CommandContext } from '../base.js';
import { listSessions } from '../../utils/session-store.js';

export const resumeCommand: CommandDefinition = {
  command: 'resume',
  description: 'Resume a saved conversation (arrow keys to pick)',
  handler: ({ addMessage, resumeConversation, setShowSessionSelector, args }: CommandContext) => {
    const query = (args || '').trim();

    // Sem argumentos → abre o SELETOR interativo (setas ↑/↓ + Enter)
    if (!query) {
      if (setShowSessionSelector) {
        setShowSessionSelector(true);
        return;
      }
      const all = listSessions();
      if (all.length === 0) {
        addMessage({
          role: 'system',
          content: '💾 Nenhuma conversa salva ainda. Comece conversar — tudo é salvo automaticamente.',
        });
        return;
      }
      const lines = all.slice(0, 20).map((s, i) => `${i + 1}. ${s.title} — ${s.messageCount} msgs`).join('\n');
      addMessage({
        role: 'system',
        content: `Uso: /resume <número> ou /resume <trecho do título>\n\n💾 Conversas salvas:\n${lines}`,
      });
      return;
    }

    if (!resumeConversation) {
      addMessage({ role: 'system', content: '🔴 Retomada de sessão não disponível nesta tela.' });
      return;
    }

    // Resolve índice numérico para id da sessão
    let target = query;
    if (/^\d+$/.test(query)) {
      const all = listSessions();
      const idx = parseInt(query, 10) - 1;
      if (idx < 0 || idx >= all.length) {
        addMessage({ role: 'system', content: `🔴 Não existe conversa de número ${query}. Use /sessions para listar.` });
        return;
      }
      target = all[idx].id;
    }

    const result = resumeConversation(target);
    if (!result) {
      addMessage({ role: 'system', content: `🔴 Conversa não encontrada para "${query}". Use /sessions para listar as salvas.` });
      return;
    }
  },
};
