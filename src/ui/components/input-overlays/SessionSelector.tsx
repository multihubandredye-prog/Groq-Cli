import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { listSessions } from '../../../utils/session-store.js';

interface SessionSelectorProps {
  onSubmit: (sessionId: string) => void;
  onCancel: () => void;
}

export default function SessionSelector({ onSubmit, onCancel }: SessionSelectorProps) {
  const sessions = React.useMemo(() => listSessions().slice(0, 12), []);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.return) {
      if (sessions.length > 0) {
        onSubmit(sessions[selectedIndex].id);
      } else {
        onCancel();
      }
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(sessions.length - 1, prev + 1));
      return;
    }

    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }
  });

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">💾 Nenhuma conversa salva ainda.</Text>
        <Text color="gray" dimColor>
          As conversas são salvas automaticamente após cada mensagem que você envia.
        </Text>
        <Text color="gray" dimColor>Pressione Esc para voltar.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="cyan" bold>💾 Retomar conversa — ↑/↓ para navegar · Enter para selecionar · Esc cancela</Text>
      </Box>

      <Box flexDirection="column">
        {sessions.map((s, i) => {
          const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString('pt-BR') : '?';
          const selected = i === selectedIndex;
          return (
            <Box key={s.id} flexDirection="column" marginBottom={i === sessions.length - 1 ? 0 : 1}>
              <Text
                color={selected ? 'black' : 'white'}
                backgroundColor={selected ? 'cyan' : undefined}
                bold={selected}
              >
                {selected ? '> ' : '  '}
                {s.title}
              </Text>
              {selected && (
                <Box marginLeft={4}>
                  <Text color="gray" dimColor>
                    {s.messageCount} mensagens · última atividade: {when}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
