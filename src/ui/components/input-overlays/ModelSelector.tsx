import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { AVAILABLE_MODELS } from '../../../utils/models.js';

interface ModelSelectorProps {
  onSubmit: (model: string) => void;
  onCancel: () => void;
  currentModel?: string;
}

export default function ModelSelector({ onSubmit, onCancel, currentModel }: ModelSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const currentIndex = AVAILABLE_MODELS.findIndex(model => model.id === currentModel);
    return currentIndex >= 0 ? currentIndex : 0;
  });

  useInput((input, key) => {
    if (key.return) {
      onSubmit(AVAILABLE_MODELS[selectedIndex].id);
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
      setSelectedIndex(prev => Math.min(AVAILABLE_MODELS.length - 1, prev + 1));
      return;
    }

    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="cyan" bold>Select Groq Model (Auto-Failover Enabled)</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="gray" dimColor>
          When a model hits its rate limit (TPM/TPD), Groq-CLI automatically switches to the next available model without losing your conversation!
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {AVAILABLE_MODELS.map((model, index) => (
          <Box key={model.id} flexDirection="column" marginBottom={index === AVAILABLE_MODELS.length - 1 ? 0 : 1}>
            <Text
              color={index === selectedIndex ? 'black' : 'white'}
              backgroundColor={index === selectedIndex ? 'cyan' : undefined}
              bold={index === selectedIndex}
            >
              {index === selectedIndex ? <Text bold>{'>'}</Text> : '  '}{' '}
              {model.name}
              {model.id === currentModel ? ' (current)' : ''}
            </Text>
            {index === selectedIndex && model.description && (
              <Box marginLeft={4}>
                <Text color="gray" dimColor>
                  {model.description}
                </Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
