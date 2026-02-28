import type { IngestTraceInput } from '../../models/types.js';

/**
 * Scenario 2: Code Agent Tool Error (FAILED)
 *
 * A coding assistant is asked to add a logging utility. It generates the
 * code correctly but calls write_file targeting the wrong path — writing
 * to the project's config directory instead of src/utils/. This overwrites
 * the existing tsconfig.json, breaking the project build.
 *
 * 7 steps, ~8k tokens, 6.2s.
 */
export function codeAgentError(baseTime: Date): IngestTraceInput {
  const t = (offsetMs: number) => new Date(baseTime.getTime() - offsetMs).toISOString();

  return {
    agent_name: 'code-pilot',
    agent_version: '1.4.2',
    trigger: 'user_message',
    status: 'failed',
    input: {
      task: 'Add a logging utility to src/utils/logger.ts',
      workspace: '/home/dev/my-project',
      language: 'typescript',
    },
    output: {
      files_modified: ['tsconfig.json'],
      error: 'write_file targeted wrong path — overwrote tsconfig.json',
    },
    started_at: t(7_200_000), // 2 hours ago
    ended_at: t(7_200_000 - 6_200),
    total_duration_ms: 6200,
    total_tokens: 8200,
    total_cost_usd: 0.033,
    error: 'write_file targeted wrong path — overwrote tsconfig.json',
    tags: ['coding', 'tool-error', 'file-write'],
    metadata: { ide: 'vscode', extension_version: '3.1.0' },
    steps: [
      {
        step_number: 1,
        step_type: 'thought',
        name: 'plan_implementation',
        input: { task: 'Add a logging utility to src/utils/logger.ts' },
        output: {
          plan: [
            'Read existing project structure',
            'Generate logger.ts with log levels',
            'Write file to src/utils/logger.ts',
            'Update barrel export in src/utils/index.ts',
          ],
        },
        started_at: t(7_200_000),
        duration_ms: 300,
        tokens_used: 1200,
        metadata: {},
      },
      {
        step_number: 2,
        step_type: 'tool_call',
        name: 'read_directory',
        input: { path: '/home/dev/my-project', recursive: false },
        output: {
          entries: ['src/', 'tests/', 'tsconfig.json', 'package.json', '.gitignore'],
        },
        started_at: t(7_200_000 - 300),
        duration_ms: 120,
        tokens_used: 400,
        metadata: { tool: 'filesystem' },
      },
      {
        step_number: 3,
        step_type: 'tool_call',
        name: 'read_file',
        input: { path: '/home/dev/my-project/src/utils/index.ts' },
        output: {
          content: "export * from './helpers.js';\nexport * from './validators.js';\n",
          size_bytes: 64,
        },
        started_at: t(7_200_000 - 420),
        duration_ms: 80,
        tokens_used: 300,
        metadata: { tool: 'filesystem' },
      },
      {
        step_number: 4,
        step_type: 'llm_call',
        name: 'generate_logger_code',
        input: {
          instruction: 'Generate a TypeScript logging utility with debug, info, warn, error levels',
          existing_exports: "export * from './helpers.js';\nexport * from './validators.js';",
        },
        output: {
          code: "import chalk from 'chalk';\n\nexport type LogLevel = 'debug' | 'info' | 'warn' | 'error';\n\nconst LEVEL_COLORS = { debug: chalk.dim, info: chalk.blue, warn: chalk.yellow, error: chalk.red };\n\nexport function log(level: LogLevel, message: string): void {\n  const prefix = LEVEL_COLORS[level](`[${level.toUpperCase()}]`);\n  console.log(`${prefix} ${message}`);\n}\n",
          language: 'typescript',
        },
        started_at: t(7_200_000 - 500),
        duration_ms: 2800,
        tokens_used: 3500,
        model: 'claude-3-sonnet',
        metadata: { temperature: 0.2 },
        snapshot: {
          context_window: { messages: 5, total_tokens: 5400 },
          environment: { workspace: '/home/dev/my-project' },
          tool_state: { filesystem: 'connected' },
          token_count: 5400,
        },
      },
      {
        step_number: 5,
        step_type: 'tool_call',
        name: 'write_file',
        input: {
          path: '/home/dev/my-project/tsconfig.json',
          content: "import chalk from 'chalk';\n\nexport type LogLevel = ...",
        },
        output: { bytes_written: 312, path: '/home/dev/my-project/tsconfig.json' },
        started_at: t(7_200_000 - 3300),
        duration_ms: 150,
        tokens_used: 200,
        error: 'File written to wrong path — tsconfig.json overwritten with TypeScript source code',
        metadata: { tool: 'filesystem', intended_path: 'src/utils/logger.ts' },
        snapshot: {
          context_window: { messages: 6, total_tokens: 5600 },
          environment: { workspace: '/home/dev/my-project' },
          tool_state: { filesystem: 'connected', last_write: 'tsconfig.json' },
          token_count: 5600,
        },
      },
      {
        step_number: 6,
        step_type: 'tool_call',
        name: 'run_build',
        input: { command: 'npm run build', cwd: '/home/dev/my-project' },
        output: {
          exit_code: 1,
          stderr: "error TS5024: Compiler option 'module' requires a value of type string.",
        },
        started_at: t(7_200_000 - 3450),
        duration_ms: 2400,
        tokens_used: 1800,
        error: "Build failed: tsconfig.json is no longer valid JSON",
        metadata: { tool: 'shell' },
      },
      {
        step_number: 7,
        step_type: 'error',
        name: 'abort_with_error',
        input: { build_exit_code: 1, file_overwritten: 'tsconfig.json' },
        output: {
          error_type: 'wrong_file_target',
          recovery_suggestion: 'Restore tsconfig.json from git and retry write to src/utils/logger.ts',
        },
        started_at: t(7_200_000 - 5850),
        duration_ms: 350,
        tokens_used: 800,
        error: 'write_file targeted wrong path — overwrote tsconfig.json',
        metadata: { recoverable: true },
      },
    ],
  };
}
