import { CommandDefinition, CommandContext } from '../base.js';

export const renameCommand: CommandDefinition = {
  command: 'rename',
  description: 'Rename the current conversation (/rename <novo nome>)',
  handler: ({ addMessage, agent, args }: CommandContext) => {
    const title = (args || '').trim();

    if (!title) {
      addMessage({ role: 'system', content: 'Uso: /rename <novo nome da conversa>' });
      return;
    }

    if (!agent || typeof agent.setSessionTitle !== 'function') {
      addMessage({ role: 'system', content: '🔴 Agente não disponível para renomear a sessão.' });
      return;
    }

    try {
      agent.setSessionTitle(title);
      addMessage({ role: 'system', content: `💾 Conversa renomeada para "${title}".` });
    } catch (error) {
      addMessage({ role: 'system', content: `🔴 Não foi possível renomear: ${error}` });
    }
  },
};
