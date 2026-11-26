import { CommandDefinition, CommandContext } from '../base.js';
import { listSessions } from '../../utils/session-store.js';

export const resumeCommand: CommandDefinition = {
  command: 'resume',
  description: 'Resume a saved conversation (/resume <nº> or title)',
  handler: ({ addMessage, agent, resetMessages, args }: CommandContext) => {
    const query = (args || '').trim();

    if (!query) {
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

    if (!agent || typeof agent.resumeSession !== 'function') {
      addMessage({ role: 'system', content: '🔴 Agente não disponível para retomar sessão.' });
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

    const result = agent.resumeSession(target);
    if (!result) {
      addMessage({ role: 'system', content: `🔴 Conversa não encontrada para "${query}". Use /sessions para listar as salvos.` });
      return;
    }

    // Limpa a UI; a memória restaurada fica no agente
    if (resetMessages) resetMessages();

    addMessage({
      role: 'system',
      content: `💾 Sessão "${result.title}" retomada! ${result.messageCount} mensagens restauradas (modelo: ${result.model}).\nA memória da conversa foi recarregada — pode continuar de onde parou.`,
    });
  },
};
