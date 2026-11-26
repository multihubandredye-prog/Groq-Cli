import { CommandDefinition, CommandContext } from '../base.js';
import { addLesson } from '../../utils/lessons.js';

export const lessonCommand: CommandDefinition = {
  command: 'lesson',
  description: 'Teach a lasting preference (/lesson <regra>) — saved for ALL sessions',
  handler: ({ addMessage, args }: CommandContext) => {
    const text = (args || '').trim();

    if (!text) {
      addMessage({
        role: 'system',
        content: [
          'Uso: /lesson <regra ou preferência>',
          '',
          'Exemplos:',
          '- /lesson Quando eu pedir cor de botão, SEMPRE definir o background-color completo no CSS',
          '- /lesson Prefiro tema escuro com tons azul/verde nos meus projetos',
          '- /lesson Sempre atualizar a versão no cabeçalho ao modificar o projeto vip',
          '',
          'As lições são injetadas automaticamente em todas as conversas futuras.',
        ].join('\n'),
      });
      return;
    }

    try {
      const result = addLesson(text);
      if (result.duplicate) {
        addMessage({
          role: 'system',
          content: `💾 Essa lição já estava memorizada: "${result.lesson}" (${result.lessons.length} lições no total).`,
        });
        return;
      }
      addMessage({
        role: 'system',
        content: `💾 Lição memorizada para TODAS as sessões futuras:\n"${result.lesson}"\n\nTotal: ${result.lessons.length} lições. Veja todas com /lessons.`,
      });
    } catch (error) {
      addMessage({ role: 'system', content: `🔴 Não foi possível salvar a lição: ${error}` });
    }
  },
};
