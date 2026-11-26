import { Box, Text } from 'ink';
import { ToolExecution } from '../../hooks/useAgent.js';
import DiffPreview from './DiffPreview.js';
import { formatToolParams } from '../../../tools/tools.js';

// Limita o output renderizado de qualquer ferramenta — outputs gigantes (grep com
// dezenas de matches, builds longos) são a principal causa de repaint/scroll no Termux!
const MAX_TOOL_OUTPUT_LINES = 12;

function clipOutput(text: string, max: number = MAX_TOOL_OUTPUT_LINES): { text: string; hidden: number } {
  const lines = text.split('\n');
  if (lines.length <= max) return { text, hidden: 0 };
  return { text: lines.slice(0, max).join('\n'), hidden: lines.length - max };
}

function HiddenNote({ hidden }: { hidden: number }) {
  if (hidden <= 0) return null;
  return (
    <Text color="gray" dimColor>
      … (+{hidden} linha{hidden > 1 ? 's' : ''} ocult{hidden > 1 ? 'as' : 'a'} — output completo no arquivo/seu editor)
    </Text>
  );
}

interface ToolHistoryItemProps {
  execution: ToolExecution;
}

export default function ToolHistoryItem({ execution }: ToolHistoryItemProps) {
  const { name, args, status, result } = execution;

  const getStatusIcon = () => {
    switch (status) {
      case 'completed':
        return '🟢';
      case 'failed':
        return '🔴';
      case 'canceled':
        return '🚫';
      default:
        return '?';
    }
  };

  const getStatusColor = () => {
    switch (status) {
      case 'completed':
        return 'green';
      case 'failed':
        return 'red';
      case 'canceled':
        return 'gray';
      default:
        return 'white';
    }
  };


  const shouldShowDiff = (toolName: string) => {
    return ['create_file', 'edit_file', 'replace_lines'].includes(toolName);
  };


  const renderResult = (toolName: string, result: any) => {
    const content = result.content;
    
    // Handle execute_command output format
    if (typeof content === 'string' && content.includes('stdout:') && content.includes('stderr:')) {
      const lines = content.split('\n');
      let stdoutLines: string[] = [];
      let stderrLines: string[] = [];
      let currentSection = '';
      
      for (const line of lines) {
        if (line.startsWith('stdout:')) {
          currentSection = 'stdout';
          const stdoutContent = line.substring(7).trim();
          if (stdoutContent) stdoutLines.push(stdoutContent);
        } else if (line.startsWith('stderr:')) {
          currentSection = 'stderr';
          const stderrContent = line.substring(7).trim();
          if (stderrContent) stderrLines.push(stderrContent);
        } else if (currentSection === 'stdout') {
          stdoutLines.push(line);
        } else if (currentSection === 'stderr') {
          stderrLines.push(line);
        }
      }

      const out = clipOutput(stdoutLines.join('\n'), 10);
      const err = clipOutput(stderrLines.join('\n'), 4);

      return (
        <>
          {out.text.trim() && (
            <Text color="white">{out.text.trimEnd()}</Text>
          )}
          {err.text.trim() && (
            <Text color="yellow">{err.text.trimEnd()}</Text>
          )}
          {(out.hidden > 0 || err.hidden > 0) && (
            <HiddenNote hidden={out.hidden + err.hidden} />
          )}
        </>
      );
    }
    
    // Handle directory tree output for list_files
    if (toolName === 'list_files') {
      const raw = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      const clipped = clipOutput(raw, 16);
      return (
        <Text color="cyan">
          {clipped.text}
          {clipped.hidden > 0 ? `\n… (+${clipped.hidden} linhas ocultas)` : ''}
        </Text>
      );
    }
    
    // Handle file content for read_file; don't show content
    if (toolName === 'read_file') {
      return null;
    }

    // Handle file content for search_files / grep_file; show only concise summary message
    if (toolName === 'search_files' || toolName === 'grep_file') {
      return result?.message ? <Text color="gray">{result.message}</Text> : null;
    }

    // Default handling — sempre limitado para não redesenhar tela gigante
    const rawDefault = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const clippedDefault = clipOutput(rawDefault);
    return (
      <Box flexDirection="column">
        <Text color="white">{clippedDefault.text}</Text>
        <HiddenNote hidden={clippedDefault.hidden} />
      </Box>
    );
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={getStatusColor()} paddingX={1}>
      <Box>
        <Text color={getStatusColor()}>
          {getStatusIcon()} <Text bold>{name}</Text>
        </Text>
      </Box>
      
      {(name === 'create_tasks' || name === 'update_tasks') && result?.content?.tasks ? (
        <Box flexDirection="column">
          {result.content.tasks.map((task: any, index: number) => {
            const statusSymbol = task.status === 'pending' ? '☐' : (task.status === 'in_progress' ? '🔄' : '✓');
            const isCompleted = task.status === 'completed';
            return (
              <Text key={task.id || index} color={isCompleted ? 'green' : 'white'}>
                {statusSymbol} {task.description}
              </Text>
            );
          })}
        </Box>
      ) : formatToolParams(name, args, { includePrefix: false, separator: ': ' }) ? (
        <Box>
          <Text color="gray">
            {formatToolParams(name, args, { includePrefix: false, separator: ': ' })}
          </Text>
        </Box>
      ) : null}

      {shouldShowDiff(name) && status === 'completed' && (
        <Box>
          <DiffPreview 
            toolName={name}
            toolArgs={args}
            isHistorical={true}
          />
        </Box>
      )}

      {status === 'completed' && result && (
        <Box>
          {result.success ? (
            <Box flexDirection="column">
              {result.content && !(name === 'create_tasks' || name === 'update_tasks') && (
                <Box flexDirection="column">
                  {renderResult(name, result)}
                </Box>
              )}
              {result.message && !result.content && !(name === 'create_tasks' || name === 'update_tasks') && (
                <Text color="gray">
                  {result.message}
                </Text>
              )}
            </Box>
          ) : (
            <Text color="red">
              Tool failed: {result.error || 'Unknown error'}
            </Text>
          )}
        </Box>
      )}

      {status === 'failed' && (
        <Box>
          <Text color="red">
            Tool execution failed
            {result?.error && (
              <Text color="gray">
                {' '}({result.error})
              </Text>
            )}
          </Text>
        </Box>
      )}

      {status === 'canceled' && (
        <Box>
          <Text color="gray">
            Tool execution canceled by user
          </Text>
        </Box>
      )}
    </Box>
  );
}