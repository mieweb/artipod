/**
 * Tool definitions matching vscode-copilot-chat schemas exactly
 * These are the OpenAI function calling compatible definitions
 */

import {
  ToolName,
  ToolDefinition,
} from './types';

/**
 * Maximum lines per read operation (matches vscode-copilot-chat)
 */
export const MAX_LINES_PER_READ = 2000;

/**
 * read_file tool definition (v1 format with startLine/endLine)
 */
export const readFileDefinition: ToolDefinition = {
  name: ToolName.ReadFile,
  description: `Read the contents of a file.

You must specify the line range you're interested in. Line numbers are 1-indexed. If the file contents returned are insufficient for your task, you may call this tool again to retrieve more content. Prefer reading larger ranges over doing many small reads.`,
  inputSchema: {
    type: 'object',
    required: ['filePath', 'startLine', 'endLine'],
    properties: {
      filePath: {
        type: 'string',
        description: 'The absolute path of the file to read.',
      },
      startLine: {
        type: 'number',
        description: 'The line number to start reading from, 1-based.',
      },
      endLine: {
        type: 'number',
        description: 'The inclusive line number to end reading at, 1-based.',
      },
    },
  },
};

/**
 * read_file tool definition (v2 format with offset/limit)
 */
export const readFileV2Definition: ToolDefinition = {
  name: ToolName.ReadFile,
  description: `Read the contents of a file. Line numbers are 1-indexed. This tool will truncate its output at ${MAX_LINES_PER_READ} lines and may be called repeatedly with offset and limit parameters to read larger files in chunks.`,
  inputSchema: {
    type: 'object',
    required: ['filePath'],
    properties: {
      filePath: {
        type: 'string',
        description: 'The absolute path of the file to read.',
      },
      offset: {
        type: 'number',
        description: 'Optional: the 1-based line number to start reading from. Only use this if the file is too large to read at once. If not specified, the file will be read from the beginning.',
      },
      limit: {
        type: 'number',
        description: 'Optional: the maximum number of lines to read. Only use this together with `offset` if the file is too large to read at once.',
      },
    },
  },
};

/**
 * create_file tool definition
 */
export const createFileDefinition: ToolDefinition = {
  name: ToolName.CreateFile,
  description: `This is a tool for creating a new file in the workspace. The file will be created with the specified content. The directory will be created if it does not already exist. Never use this tool to edit a file that already exists.`,
  inputSchema: {
    type: 'object',
    required: ['filePath', 'content'],
    properties: {
      filePath: {
        type: 'string',
        description: 'The absolute path to the file to create.',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file.',
      },
    },
  },
};

/**
 * list_dir tool definition
 */
export const listDirDefinition: ToolDefinition = {
  name: ToolName.ListDirectory,
  description: `List the contents of a directory. Result will have the name of the child. If the name ends in /, it's a folder, otherwise a file`,
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: {
        type: 'string',
        description: 'The absolute path to the directory to list.',
      },
    },
  },
};

/**
 * create_directory tool definition
 */
export const createDirectoryDefinition: ToolDefinition = {
  name: ToolName.CreateDirectory,
  description: `Create a new directory structure in the workspace. Will recursively create all directories in the path, like mkdir -p. You do not need to use this tool before using create_file, that tool will automatically create the needed directories.`,
  inputSchema: {
    type: 'object',
    required: ['dirPath'],
    properties: {
      dirPath: {
        type: 'string',
        description: 'The absolute path to the directory to create.',
      },
    },
  },
};

/**
 * replace_string_in_file tool definition
 */
export const replaceStringDefinition: ToolDefinition = {
  name: ToolName.ReplaceString,
  description: `This is a tool for making edits in an existing file in the workspace. For moving or renaming files, use run in terminal tool with the 'mv' command instead. For larger edits, split them into smaller edits and call the edit tool multiple times to ensure accuracy. Before editing, always ensure you have the context to understand the file's contents and context. To edit a file, provide: 1) filePath (absolute path), 2) oldString (MUST be the exact literal text to replace including all whitespace, indentation, newlines, and surrounding code etc), and 3) newString (MUST be the exact literal text to replace \`oldString\` with (also including all whitespace, indentation, newlines, and surrounding code etc.). Ensure the resulting code is correct and idiomatic.). Each use of this tool replaces exactly ONE occurrence of oldString.

CRITICAL for \`oldString\`: Must uniquely identify the single instance to change. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string matches multiple locations, or does not match exactly, the tool will fail. Never use 'Lines 123-456 omitted' from summarized documents or ...existing code... comments in the oldString or newString.`,
  inputSchema: {
    type: 'object',
    required: ['filePath', 'oldString', 'newString'],
    properties: {
      filePath: {
        type: 'string',
        description: 'An absolute path to the file to edit.',
      },
      oldString: {
        type: 'string',
        description: 'The exact literal text to replace, preferably unescaped. For single replacements (default), include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. For multiple replacements, specify expected_replacements parameter. If this string is not the exact literal text (i.e. you escaped it) or does not match exactly, the tool will fail.',
      },
      newString: {
        type: 'string',
        description: 'The exact literal text to replace `old_string` with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic.',
      },
    },
  },
};

/**
 * multi_replace_string_in_file tool definition
 */
export const multiReplaceStringDefinition: ToolDefinition = {
  name: ToolName.MultiReplaceString,
  description: `This tool allows you to apply multiple replace_string_in_file operations in a single call, which is more efficient than calling replace_string_in_file multiple times. It takes an array of replacement operations and applies them sequentially. Each replacement operation has the same parameters as replace_string_in_file: filePath, oldString, newString, and explanation. This tool is ideal when you need to make multiple edits across different files or multiple edits in the same file. The tool will provide a summary of successful and failed operations.`,
  inputSchema: {
    type: 'object',
    required: ['explanation', 'replacements'],
    properties: {
      explanation: {
        type: 'string',
        description: 'A brief explanation of what the multi-replace operation will accomplish.',
      },
      replacements: {
        type: 'array',
        description: 'An array of replacement operations to apply sequentially.',
      },
    },
  },
};

/**
 * apply_patch tool definition (GPT-5 compatible format)
 */
export const applyPatchDefinition: ToolDefinition = {
  name: ToolName.ApplyPatch,
  description: `Use the \`apply_patch\` tool to edit files.
Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

May be immediately followed by *** Move to: <new path> if you want to rename the file.
Then one or more "hunks", each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change's [context_after] lines in the second change's [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs.
- If a code block is repeated so many times in a class or function such that even a single \`@@\` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple \`@@\` statements to jump to the right context.

The full grammar definition is below:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

A full patch can combine several operations:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file
- File references must be ABSOLUTE, NEVER RELATIVE.`,
  inputSchema: {
    type: 'object',
    required: ['input', 'explanation'],
    properties: {
      input: {
        type: 'string',
        description: 'The patch text in the format described above.',
      },
      explanation: {
        type: 'string',
        description: 'A brief explanation of what the patch accomplishes.',
      },
    },
  },
};

/**
 * file_search tool definition
 */
export const fileSearchDefinition: ToolDefinition = {
  name: ToolName.FindFiles,
  description: `Search for files in the workspace by glob pattern. This only returns the paths of matching files. Use this tool when you know the exact filename pattern of the files you're searching for. Glob patterns match from the root of the workspace folder. Examples:
- **/*.{js,ts} to match all js/ts files in the workspace.
- src/** to match all files under the top-level src folder.
- **/foo/**/*.js to match all js files under any foo folder in the workspace.`,
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'Search for files with names or paths matching this glob pattern.',
      },
      maxResults: {
        type: 'number',
        description: 'The maximum number of results to return. Do not use this unless necessary, it can slow things down. By default, only some matches are returned. If you use this and don\'t see what you\'re looking for, you can try again with a more specific query or a larger maxResults.',
      },
    },
  },
};

/**
 * grep_search tool definition
 */
export const grepSearchDefinition: ToolDefinition = {
  name: ToolName.FindTextInFiles,
  description: `Do a fast text search in the workspace. Use this tool when you want to search with an exact string or regex. If you are not sure what words will appear in the workspace, prefer using regex patterns with alternation (|) or character classes to search for multiple potential words at once instead of making separate searches. For example, use 'function|method|procedure' to look for all of those words at once. Use includePattern to search within files matching a specific pattern, or in a specific file, using a relative path. Use this tool when you want to see an overview of a particular file, instead of using read_file many times to look for code within a file.`,
  inputSchema: {
    type: 'object',
    required: ['query', 'isRegexp'],
    properties: {
      query: {
        type: 'string',
        description: 'The pattern to search for in files in the workspace. Use regex with alternation (e.g., \'word1|word2|word3\') or character classes to find multiple potential words in a single search. Be sure to set the isRegexp property properly to declare whether it\'s a regex or plain text pattern. Is case-insensitive.',
      },
      isRegexp: {
        type: 'boolean',
        description: 'Whether the pattern is a regex.',
      },
      includePattern: {
        type: 'string',
        description: 'Search files matching this glob pattern. Will be applied to the relative path of files within the workspace. To search recursively inside a folder, use a proper glob pattern like "src/folder/**". Do not use | in includePattern.',
      },
      maxResults: {
        type: 'number',
        description: 'The maximum number of results to return. Do not use this unless necessary, it can slow things down. By default, only some matches are returned. If you use this and don\'t see what you\'re looking for, you can try again with a more specific query or a larger maxResults.',
      },
    },
  },
};

/**
 * All core tool definitions
 */
export const coreToolDefinitions: ToolDefinition[] = [
  readFileDefinition,
  createFileDefinition,
  listDirDefinition,
  createDirectoryDefinition,
];

/**
 * All edit tool definitions
 */
export const editToolDefinitions: ToolDefinition[] = [
  replaceStringDefinition,
  multiReplaceStringDefinition,
  applyPatchDefinition,
];

/**
 * run_in_terminal tool definition
 */
export const runInTerminalDefinition: ToolDefinition = {
  name: ToolName.RunTerminal,
  description: `Execute a bash command in the pod's sandboxed container environment. Commands run in the /context directory where all mounts are accessible at /context/<mount-name>. Use 'cd' commands to change directories as needed.

Container Environment:
- Working directory: /context (default)
- Default timeout: 30 seconds
- Maximum timeout: 5 minutes (300000ms)
- Resource limits: 512MB memory, 1 CPU core
- Security: seccomp sandbox, no new privileges, minimal capabilities
- User: unprivileged 'artipod' user

Success is determined by exit code: exitCode === 0 means success, non-zero means failure.`,
  inputSchema: {
    type: 'object',
    required: ['command'],
    properties: {
      command: {
        type: 'string',
        description: 'Bash command to execute. Can include pipes, redirects, and other bash features. Use "cd <dir> && <command>" to run commands in specific directories.',
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds. Overrides the pod\'s default timeout. Will be clamped to range [1000, 300000] (1 second to 5 minutes).',
      },
    },
  },
};

/**
 * All container tool definitions
 */
export const containerToolDefinitions: ToolDefinition[] = [
  runInTerminalDefinition,
];

/**
 * All search tool definitions
 */
export const searchToolDefinitions: ToolDefinition[] = [
  fileSearchDefinition,
  grepSearchDefinition,
];

/**
 * All tool definitions
 */
export const allToolDefinitions: ToolDefinition[] = [
  ...coreToolDefinitions,
  ...editToolDefinitions,
  ...containerToolDefinitions,
  ...searchToolDefinitions,
];

/**
 * Get tool definition by name
 */
export function getToolDefinition(name: ToolName | string): ToolDefinition | undefined {
  return allToolDefinitions.find(def => def.name === name);
}
