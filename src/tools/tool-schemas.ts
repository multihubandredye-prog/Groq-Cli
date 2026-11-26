/**
 * Lean, token-optimized Tool Schemas for Groq function calling API.
 * Designed to keep per-request prompt overhead small (<1,250 tokens) on Groq's 8K TPM tier
 * while enabling surgical operations on 5,000+ line files and absolute/Android paths.
 */

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export const READ_FILE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read file contents. Supports relative or absolute paths (e.g. "/storage/emulated/0/Download/app.html"). On large files (>180 lines) without start_line, returns a structural outline + lines 1-90; pass start_line & end_line (max 160 lines per call) to inspect specific sections.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Relative or absolute path to the file.',
        },
        start_line: {
          type: 'integer',
          description: '1-indexed starting line (optional).',
          minimum: 1,
        },
        end_line: {
          type: 'integer',
          description: '1-indexed ending line (optional, max 160 lines per read).',
          minimum: 1,
        },
      },
      required: ['file_path'],
    },
  },
};

export const GREP_FILE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'grep_file',
    description:
      'Search inside ONE specific file (text or regex) and return matching line numbers with surrounding context. Ideal for finding CSS variables, selectors, buttons, or functions in large files.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Relative or absolute path to the target file.',
        },
        pattern: {
          type: 'string',
          description: 'Substring or regular expression to find.',
        },
        is_regex: {
          type: 'boolean',
          description: 'Treat pattern as RegExp (default: false).',
        },
        context_lines: {
          type: 'integer',
          description: 'Surrounding context lines 0-10 (default: 2).',
          minimum: 0,
          maximum: 10,
        },
      },
      required: ['file_path', 'pattern'],
    },
  },
};

export const CREATE_FILE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'create_file',
    description:
      'Create a new file or directory. For existing files, prefer edit_file or replace_lines unless replacing everything with overwrite=true.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Relative or absolute path.',
        },
        content: {
          type: 'string',
          description: 'File content ("" for directories).',
        },
        file_type: {
          type: 'string',
          enum: ['file', 'directory'],
          description: 'file or directory (default: file).',
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite if exists (default: false).',
        },
      },
      required: ['file_path', 'content'],
    },
  },
};

export const EDIT_FILE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'edit_file',
    description:
      'Modify an existing file by exact text replacement. Supports single replacement (old_text + new_text) OR batch replacements in one call via edits=[{old_text, new_text, replace_all?}]. Inspect the target section with read_file or grep_file first.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Relative or absolute path to the file.',
        },
        old_text: {
          type: 'string',
          description: 'Exact text to replace (for single edit).',
        },
        new_text: {
          type: 'string',
          description: 'Replacement text (for single edit).',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences of old_text (default: false).',
        },
        edits: {
          type: 'array',
          description: 'Batch multiple replacements in one call.',
          items: {
            type: 'object',
            properties: {
              old_text: { type: 'string' },
              new_text: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['old_text', 'new_text'],
          },
        },
      },
      required: ['file_path'],
    },
  },
};

export const REPLACE_LINES_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'replace_lines',
    description:
      'Surgically replace a line range [start_line..end_line] (1-indexed, inclusive) in an existing file with new_content. Great for updating CSS/HTML/JS blocks in large files without repeating huge old_text.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Relative or absolute path to the file.',
        },
        start_line: {
          type: 'integer',
          description: 'First line number to replace (1-indexed).',
          minimum: 1,
        },
        end_line: {
          type: 'integer',
          description: 'Last line number to replace (1-indexed, inclusive).',
          minimum: 1,
        },
        new_content: {
          type: 'string',
          description: 'New lines to insert in place of start_line..end_line.',
        },
      },
      required: ['file_path', 'start_line', 'end_line', 'new_content'],
    },
  },
};

export const DELETE_FILE_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'delete_file',
    description: 'Delete a file or directory.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to delete.' },
        recursive: { type: 'boolean', description: 'Delete directory recursively.' },
      },
      required: ['file_path'],
    },
  },
};

export const EXECUTE_COMMAND_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'execute_command',
    description:
      'Run short-lived shell commands that finish and exit (tests, builds, git, scripts). Never start long-running servers.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run.' },
        command_type: {
          type: 'string',
          enum: ['bash', 'python', 'setup', 'run'],
          description: 'bash, python, setup, or run.',
        },
        working_directory: { type: 'string', description: 'Optional cwd.' },
        timeout: { type: 'integer', description: 'Timeout seconds (1-300).', minimum: 1, maximum: 300 },
      },
      required: ['command', 'command_type'],
    },
  },
};

export const SEARCH_FILES_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'search_files',
    description:
      'Search text/regex across files in a directory. (If you already know the exact file path, prefer grep_file instead.)',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern.' },
        directory: { type: 'string', description: 'Directory (or file) path, default ".".' },
        file_pattern: { type: 'string', description: 'Filename glob e.g. "*.ts".' },
        pattern_type: {
          type: 'string',
          enum: ['substring', 'regex', 'exact', 'fuzzy'],
        },
        case_sensitive: { type: 'boolean' },
        context_lines: { type: 'integer', minimum: 0, maximum: 8 },
        max_results: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['pattern'],
    },
  },
};

export const LIST_FILES_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'list_files',
    description: 'List directory contents (only when you do not already have the exact file path).',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory path (default ".").' },
        pattern: { type: 'string' },
        recursive: { type: 'boolean' },
        show_hidden: { type: 'boolean' },
      },
      required: [],
    },
  },
};

export const CREATE_TASKS_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'create_tasks',
    description: 'Create a structured checklist for complex multi-file projects.',
    parameters: {
      type: 'object',
      properties: {
        user_query: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['id', 'description'],
          },
        },
      },
      required: ['user_query', 'tasks'],
    },
  },
};

export const UPDATE_TASKS_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'update_tasks',
    description: 'Update task statuses in the checklist.',
    parameters: {
      type: 'object',
      properties: {
        task_updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              notes: { type: 'string' },
            },
            required: ['id', 'status'],
          },
        },
      },
      required: ['task_updates'],
    },
  },
};

export const ADD_LESSON_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'add_lesson',
    description: 'Persiste uma preferência ou correção duradoura do usuário (carregada em TODAS as sessões futuras). Use sempre que o usuário corrigir ou expressar uma preferência permanente, ex.: sempre incluir o background-color completo ao pedir cor de botão.',
    parameters: {
      type: 'object',
      properties: {
        lesson: {
          type: 'string',
          description: 'Regra curta e imperativa no idioma do usuário (max ~200 chars), ex.: "Quando pedir cor de botão, sempre definir background-color completo no CSS".',
        },
      },
      required: ['lesson'],
    },
  },
};

export const ALL_TOOL_SCHEMAS = [
  READ_FILE_SCHEMA,
  GREP_FILE_SCHEMA,
  CREATE_FILE_SCHEMA,
  EDIT_FILE_SCHEMA,
  REPLACE_LINES_SCHEMA,
  DELETE_FILE_SCHEMA,
  SEARCH_FILES_SCHEMA,
  LIST_FILES_SCHEMA,
  CREATE_TASKS_SCHEMA,
  UPDATE_TASKS_SCHEMA,
  ADD_LESSON_SCHEMA,
  EXECUTE_COMMAND_SCHEMA,
];

export const SAFE_TOOLS = [
  'read_file',
  'grep_file',
  'list_files',
  'search_files',
  'create_tasks',
  'update_tasks',
  'add_lesson',
];

export const APPROVAL_REQUIRED_TOOLS = [
  'create_file',
  'edit_file',
  'replace_lines',
];

export const DANGEROUS_TOOLS = [
  'delete_file',
  'execute_command',
];
