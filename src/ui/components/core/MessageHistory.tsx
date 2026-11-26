import React, { useRef } from 'react';
import { Box, Text, Static } from 'ink';
import { ChatMessage } from '../../hooks/useAgent.js';
import ToolHistoryItem from '../display/ToolHistoryItem.js';
import Stats from '../display/Stats.js';
import { parseMarkdown, MarkdownElement, parseInlineElements } from '../../../utils/markdown.js';

interface Usage {
  queue_time: number;
  prompt_tokens: number;
  prompt_time: number;
  completion_tokens: number;
  completion_time: number;
  total_tokens: number;
  total_requests?: number;
  total_time: number;
}

interface MessageHistoryProps {
  messages: ChatMessage[];
  showReasoning?: boolean;
  usageData?: Usage;
}

// Janela de mensagens que permanecem dinâmicas (streaming + updates da última tool).
// Tudo antes disso é impresso UMA ÚNICA VEZ via <Static> (scrollback nativo do terminal)
// — elimina o repaint completo que fazia a tela do Termux subir e descer sem parar!
const LIVE_WINDOW = 3;
const REASONING_DISPLAY_CHARS = 420;

function MessageHistory({ messages, showReasoning = true, usageData }: MessageHistoryProps) {
  // Contador de mensagens "seladas" — só cresce (append-only, exigência do <Static>)
  const sealedCountRef = useRef(0);

  if (sealedCountRef.current > messages.length) {
    sealedCountRef.current = 0; // /clear ou sessão retomada → recomeça
  }
  const targetSealed = Math.max(0, messages.length - LIVE_WINDOW);
  if (targetSealed > sealedCountRef.current) {
    sealedCountRef.current = targetSealed;
  }

  const sealed = messages.slice(0, sealedCountRef.current);
  const live = messages.slice(sealedCountRef.current);

  const formatTimestamp = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const renderMessage = (message: ChatMessage) => {
    const timestamp = formatTimestamp(message.timestamp);

    switch (message.role) {
      case 'user':
        return (
          <Box key={message.id} marginBottom={1}>
            <Text color="cyan" bold>{'> '} </Text>
            <Text color="gray">{message.content}</Text>
          </Box>
        );

      case 'assistant':
        const markdownElements = parseMarkdown(message.content);
        // Reasoning longo (medium effort) é cortado: mostra só a "cauda" do pensamento
        const reasoningText = message.reasoning
          ? message.reasoning.length > REASONING_DISPLAY_CHARS
            ? '…' + message.reasoning.slice(-REASONING_DISPLAY_CHARS)
            : message.reasoning
          : undefined;

        return (
          <Box key={message.id} marginBottom={1} flexDirection="column">
            {reasoningText && showReasoning && (
              <Box marginBottom={1}>
                <Text italic dimColor>
                  {reasoningText}
                </Text>
              </Box>
            )}
            {message.content && markdownElements.map((element, index) => {
              switch (element.type) {
                case 'code-block':
                  return (
                    <Box key={index} marginY={1} paddingLeft={2}>
                      <Text color="cyan">{element.content}</Text>
                    </Box>
                  );
                case 'heading':
                  return (
                    <Text key={index} bold color={element.level && element.level <= 2 ? "yellow" : "white"}>
                      {element.content}
                    </Text>
                  );
                case 'mixed-line':
                  const inlineElements = parseInlineElements(element.content);
                  return (
                    <Text key={index}>
                      {inlineElements.map((inlineElement, inlineIndex) => {
                        switch (inlineElement.type) {
                          case 'code':
                            return <Text key={inlineIndex} color="cyan">{inlineElement.content}</Text>;
                          case 'bold':
                            return <Text key={inlineIndex} bold>{inlineElement.content}</Text>;
                          case 'italic':
                            return <Text key={inlineIndex} italic>{inlineElement.content}</Text>;
                          default:
                            return <Text key={inlineIndex}>{inlineElement.content}</Text>;
                        }
                      })}
                    </Text>
                  );
                default:
                  return <Text key={index}>{element.content}</Text>;
              }
            })}
          </Box>
        );

      case 'system':
        // Handle special system message types
        if (message.type === 'stats') {
          return (
            <Box key={message.id} marginBottom={1}>
              <Stats usage={message.usageSnapshot || usageData} />
            </Box>
          );
        }

        // Subtle in-flow notices (model failover, context compaction, key rotation)
        if (message.type === 'notice') {
          return (
            <Box key={message.id} marginBottom={1}>
              <Text color="cyan" dimColor italic>
                {message.content}
              </Text>
            </Box>
          );
        }

        return (
          <Box key={message.id} marginBottom={1}>
            <Text color="yellow" italic>
              {message.content}
            </Text>
          </Box>
        );

      case 'tool_execution':
        if (message.toolExecution) {
          return (
            <Box key={message.id} marginBottom={1}>
              <ToolHistoryItem execution={message.toolExecution} />
            </Box>
          );
        }
        return (
          <Box key={message.id} marginBottom={1}>
            <Text color="blue">Tool: {message.content}</Text>
          </Box>
        );

      default:
        return (
          <Box key={message.id} marginBottom={1}>
            <Text color="gray" dimColor>
              Unknown: {message.content}
            </Text>
          </Box>
        );
    }
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.length === 0 ? (
        <Box justifyContent="center" paddingY={2} flexDirection="column" alignItems="center">
          <Text color="gray" dimColor italic>
            Assistente de código Groq com streaming em tempo real, memória de sessão e failover automático de modelos.
          </Text>
          <Text color="gray" dimColor italic>
            Dicas: /resume retoma conversas · /lesson ensina uma preferência permanente · /help para todos os comandos.
          </Text>
        </Box>
      ) : (
        <>
          {/* Mensagens finalizadas: impressas uma única vez no scrollback do terminal.
              Nunca são redesenhadas → ZERO flicker/scroll independente do tamanho da conversa. */}
          <Static items={sealed}>
            {(message: ChatMessage) => (
              <Box key={message.id} paddingX={1}>
                {renderMessage(message)}
              </Box>
            )}
          </Static>

          {/* Apenas as últimas mensagens (streaming/tool ativa) ficam dinâmicas */}
          {live.map((message: ChatMessage) => (
            <Box key={message.id} paddingX={1}>
              {renderMessage(message)}
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}

// Memoização anti-flicker: só re-renderiza o histórico quando as mensagens
// realmente mudarem (evita repaint completo a cada tick do timer do Termux!)
export default React.memo(
  MessageHistory,
  (prev, next) =>
    prev.messages === next.messages &&
    prev.showReasoning === next.showReasoning &&
    (prev.usageData?.total_tokens ?? 0) === (next.usageData?.total_tokens ?? 0)
);
