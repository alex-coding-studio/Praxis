import { publishActivity, type LocalAgentActivity } from './activity.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import {
  codexSkillConfig,
  readCodexSkills,
  withSkillCatalog,
  type SkillCatalog,
  type ExecutionAccess,
} from './skills.ts';
import type { ReasoningEffort } from './model-types.ts';
import type { LocalAgentUsage } from './usage.ts';
import type { CardEnvironmentManifest } from '../card-host-operations.ts';
import { bootRuntime, renderDeepseekContext } from './deepseek/runtime.ts';

export type LocalAgentKind = 'codex' | 'claude' | 'deepseek';

export type { LocalAgentUsage } from './usage.ts';

export type LocalAgentResult = {
  agentSessionId: string | null;
  finalOutput: string;
  usage: LocalAgentUsage | null;
  sessionUsage?: LocalAgentUsage | null;
  executionAccess?: ExecutionAccess;
};

export type LocalAgentRun = {
  completion: Promise<LocalAgentResult>;
  cancel: () => void;
};

export type LocalAgentRunInput = {
  onActivity?: (activity: LocalAgentActivity) => void;
  isolatedProcessGroup?: boolean;
  disableDelegation?: boolean;
  workingDirectory: string;
  prompt: string;
  resumeSessionId?: string;
  sessionUsageBaseline?: LocalAgentUsage | null;
  model?: string;
  effort?: ReasoningEffort;
  access?: 'read-only' | 'workspace-write';
  protectedPath?: string;
  allowedSkillPaths?: string[];
  environment?: NodeJS.ProcessEnv;
  gitWritePaths?: string[];
  primaryRepositoryPath?: string;
  candidatePublication?: {
    environment: CardEnvironmentManifest;
    actionId: string;
    roundId: string;
  };
};

type CodexEvent =
  | { type: 'thread.started'; thread_id: string }
  | {
      type: 'item.completed';
      item: { type: string; text?: string };
    }
  | {
      type: 'turn.completed';
      usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        cache_write_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      };
    }
  | { type: 'turn.failed'; error?: { message?: string } }
  | { type: 'error'; message?: string };

type ClaudeEvent =
  | { type: 'system'; subtype: string; session_id?: string }
  | {
      type: 'result';
      subtype: string;
      is_error?: boolean;
      result?: string;
      session_id?: string;
      usage?: {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        output_tokens?: number;
        output_tokens_details?: { thinking_tokens?: number };
      };
    }
  | { type: string };

export function startLocalAgentRun(
  agent: LocalAgentKind,
  input: LocalAgentRunInput,
): LocalAgentRun {
  if (agent === 'claude') return startClaudeRun(input);
  if (agent === 'deepseek') return startDeepseekRun(input);
  return startCodexRun(input);
}

export function startDeepseekRun(input: LocalAgentRunInput): LocalAgentRun {
  if (input.access === 'workspace-write') {
    return {
      completion: Promise.reject(
        new Error('DeepSeek supports read-only runs only.'),
      ),
      cancel: () => {},
    };
  }
  const controller = new AbortController();
  const completion = (async () => {
    const context = await renderDeepseekContext(input.workingDirectory);
    const runtime = await bootRuntime(input.workingDirectory);
    try {
      const result = await runtime.runTurn(
        {
          prompt: input.prompt + context,
          model: input.model,
          effort: input.effort,
          resumeSessionId: input.resumeSessionId,
          workingDirectory: input.workingDirectory,
        },
        controller.signal,
      );
      return {
        agentSessionId: result.sessionId,
        finalOutput: result.finalOutput,
        usage: null,
      };
    } finally {
      await runtime.close();
    }
  })();
  return {
    completion,
    cancel: () => controller.abort(),
  };
}

export function parseLocalAgentEvent(line: string): unknown {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object' || !('type' in value)) return null;
    return value;
  } catch {
    return null;
  }
}

export function parseCodexEvent(line: string): CodexEvent | null {
  return parseLocalAgentEvent(line) as CodexEvent | null;
}

export function parseClaudeEvent(line: string): ClaudeEvent | null {
  return parseLocalAgentEvent(line) as ClaudeEvent | null;
}

export function startCodexRun(
  input: LocalAgentRunInput,
  discover = readCodexSkills,
  launch = launchCodexRun,
): LocalAgentRun {
  const controller = new AbortController();
  let run: LocalAgentRun | undefined;
  const completion = discover(input.workingDirectory, {
    signal: controller.signal,
  }).then((catalog) => {
    if (controller.signal.aborted)
      throw new Error('Execution canceled before Agent startup.');
    const executionAccess =
      input.access === 'workspace-write'
        ? (catalog.executionAccess ?? 'workspace-write')
        : 'read-only';
    const permissionContext =
      executionAccess === 'full-access'
        ? '\n\nExecution permissions: Full Access, selected in local Codex settings. There is no OS filesystem sandbox protecting the primary checkout or planning store. You must still work only in the Card worktree, preserve host-owned records, and follow the explicit PR and acceptance boundaries. Full Access is not authorization for unrelated actions.'
        : '';
    run = launch(
      {
        ...input,
        prompt:
          withSkillCatalog(input.prompt, catalog, input.allowedSkillPaths) +
          permissionContext,
      },
      catalog,
    );
    return run.completion.then((result) => ({ ...result, executionAccess }));
  });
  return {
    completion,
    cancel: () => {
      controller.abort();
      run?.cancel();
    },
  };
}

function launchCodexRun(
  input: LocalAgentRunInput,
  catalog: SkillCatalog,
): LocalAgentRun {
  const child = spawnCodex(input, catalog);
  child.stdin.end(input.prompt);
  return trackLocalAgentRun(
    child,
    (child, canceled) =>
      consumeCodexRun(
        child,
        canceled,
        input.onActivity,
        input.sessionUsageBaseline,
      ),
    Boolean(input.isolatedProcessGroup || input.access === 'workspace-write'),
  );
}

function startClaudeRun(input: LocalAgentRunInput): LocalAgentRun {
  const child = spawnClaude(input);
  child.stdin.end(input.prompt);
  return trackLocalAgentRun(
    child,
    (child, canceled) => consumeClaudeRun(child, canceled, input.onActivity),
    Boolean(input.isolatedProcessGroup || input.access === 'workspace-write'),
  );
}

function trackLocalAgentRun(
  child: ChildProcessWithoutNullStreams,
  consume: (
    child: ChildProcessWithoutNullStreams,
    wasCanceled: () => boolean,
  ) => Promise<LocalAgentResult>,
  processGroup = false,
): LocalAgentRun {
  let canceled = false;
  const completion = consume(child, () => canceled);

  return {
    completion,
    cancel: () => {
      if (canceled || child.exitCode !== null) return;
      canceled = true;
      const stop = (signal: NodeJS.Signals) => {
        try {
          if (processGroup && process.platform !== 'win32' && child.pid)
            process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };
      stop('SIGTERM');
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null) stop('SIGKILL');
      }, 2_000);
      forceTimer.unref();
    },
  };
}

export function buildCodexArguments(
  input: LocalAgentRunInput,
  catalog?: SkillCatalog,
) {
  const { workingDirectory, resumeSessionId } = input;
  if (input.access === 'workspace-write' && resumeSessionId)
    throw new Error(
      'Execution requires a fresh Session with explicit permissions.',
    );
  return [
    ...(resumeSessionId
      ? [
          'exec',
          'resume',
          '--ignore-user-config',
          '--ignore-rules',
          '--skip-git-repo-check',
          '--json',
        ]
      : [
          'exec',
          '--ignore-user-config',
          '--ignore-rules',
          '--skip-git-repo-check',
          ...(input.access === 'workspace-write' &&
          catalog?.executionAccess === 'full-access'
            ? [
                '-c',
                'approval_policy="never"',
                '--sandbox',
                'danger-full-access',
              ]
            : input.access === 'workspace-write' &&
                catalog?.executionAccess !== 'read-only'
              ? [
                  '-c',
                  'approval_policy="never"',
                  '-c',
                  'default_permissions="praxis_action"',
                  '-c',
                  `permissions.praxis_action={extends=":workspace",filesystem={":root"="read",":workspace_roots"={"."="write",".git"="write"}${input.primaryRepositoryPath ? `,${JSON.stringify(input.primaryRepositoryPath)}="read"` : ''}${(input.gitWritePaths ?? []).map((entry) => `,${JSON.stringify(entry)}="write"`).join('')}${input.protectedPath ? `,${JSON.stringify(input.protectedPath)}="read"` : ''}},network={enabled=true}}`,
                ]
              : ['--sandbox', 'read-only']),
          '--json',
          '-C',
          workingDirectory,
        ]),
    ...(catalog
      ? ['-c', codexSkillConfig(catalog, input.allowedSkillPaths)]
      : []),
    ...(input.disableDelegation
      ? ['--disable', 'multi_agent', '--disable', 'multi_agent_v2']
      : []),
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort
      ? ['-c', `model_reasoning_effort=${JSON.stringify(input.effort)}`]
      : []),
    ...(resumeSessionId ? [resumeSessionId] : []),
    '-',
  ];
}

function spawnCodex(input: LocalAgentRunInput, catalog: SkillCatalog) {
  const { workingDirectory } = input;
  const environment = { ...(input.environment ?? process.env) };
  delete environment.OPENAI_API_KEY;

  const arguments_ = buildCodexArguments(input, catalog);
  return spawn('codex', arguments_, {
    cwd: workingDirectory,
    env: environment,
    detached:
      (input.isolatedProcessGroup || input.access === 'workspace-write') &&
      process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function buildClaudeArguments(
  resumeSessionId?: string,
  profile?: Pick<LocalAgentRunInput, 'model' | 'effort' | 'access'>,
) {
  return [
    '--print',
    '--safe-mode',
    '--restricted',
    '--tools',
    profile?.access === 'workspace-write'
      ? 'Read,Glob,Grep,Edit,Write,Bash'
      : 'Read,Glob,Grep',
    ...(profile?.access === 'workspace-write'
      ? ['--permission-mode', 'acceptEdits']
      : []),
    '--output-format',
    'stream-json',
    '--verbose',
    ...(profile?.model ? ['--model', profile.model] : []),
    ...(profile?.effort ? ['--effort', profile.effort] : []),
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
  ];
}

function spawnClaude(input: LocalAgentRunInput) {
  const { workingDirectory, resumeSessionId } = input;
  const environment = { ...(input.environment ?? process.env) };
  delete environment.ANTHROPIC_API_KEY;

  return spawn('claude', buildClaudeArguments(resumeSessionId, input), {
    cwd: workingDirectory,
    env: environment,
    detached:
      (input.isolatedProcessGroup || input.access === 'workspace-write') &&
      process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function consumeCodexRun(
  child: ChildProcessWithoutNullStreams,
  wasCanceled: () => boolean,
  listener?: (activity: LocalAgentActivity) => void,
  sessionUsageBaseline?: LocalAgentUsage | null,
) {
  let agentSessionId: string | null = null;
  let finalOutput = '';
  let usage: LocalAgentUsage | null = null;
  let reportedError = '';
  const stderr = collectStderr(child);
  const exit = watchExit(child);

  const lines = readline.createInterface({ input: child.stdout });
  for await (const line of lines) {
    const event = parseCodexEvent(line);
    if (!event) continue;
    publishActivity(event, listener);
    if (event.type === 'thread.started') {
      agentSessionId = event.thread_id;
    } else if (
      event.type === 'item.completed' &&
      event.item.type === 'agent_message' &&
      typeof event.item.text === 'string'
    ) {
      finalOutput = event.item.text;
    } else if (event.type === 'turn.completed') {
      usage = normalizeCodexUsage(event.usage);
    } else if (event.type === 'turn.failed') {
      reportedError = event.error?.message ?? 'The Codex turn failed.';
    } else if (event.type === 'error') {
      reportedError = event.message ?? 'Codex reported an error.';
    }
  }

  const exitCode = await exit;
  if (wasCanceled()) throw new Error('The Agent Run was canceled.');
  if (exitCode !== 0 || reportedError) {
    throw new Error(
      reportedError || stderr.read().trim() || 'Codex did not complete.',
    );
  }
  if (!finalOutput) throw new Error('Codex returned no final output.');
  return {
    agentSessionId,
    finalOutput,
    usage: localAgentUsageDelta(usage, sessionUsageBaseline),
    sessionUsage: usage,
  };
}

async function consumeClaudeRun(
  child: ChildProcessWithoutNullStreams,
  wasCanceled: () => boolean,
  listener?: (activity: LocalAgentActivity) => void,
) {
  let agentSessionId: string | null = null;
  let finalOutput = '';
  let usage: LocalAgentUsage | null = null;
  let reportedError = '';
  const stderr = collectStderr(child);
  const exit = watchExit(child);

  const lines = readline.createInterface({ input: child.stdout });
  for await (const line of lines) {
    const event = parseClaudeEvent(line);
    if (!event) continue;
    publishActivity(event, listener);
    if (
      event.type === 'system' &&
      'subtype' in event &&
      event.subtype === 'init' &&
      typeof event.session_id === 'string'
    ) {
      agentSessionId = event.session_id;
    } else if (event.type === 'result' && 'subtype' in event) {
      usage = normalizeClaudeUsage(event.usage);
      if (event.is_error || event.subtype !== 'success') {
        reportedError =
          typeof event.result === 'string' && event.result
            ? event.result
            : `Claude ended the turn with ${event.subtype}.`;
      } else if (typeof event.result === 'string') {
        finalOutput = event.result;
      }
    }
  }

  const exitCode = await exit;
  if (wasCanceled()) throw new Error('The Agent Run was canceled.');
  if (exitCode !== 0 || reportedError) {
    throw new Error(
      reportedError || stderr.read().trim() || 'Claude did not complete.',
    );
  }
  if (!finalOutput) throw new Error('Claude returned no final output.');
  return { agentSessionId, finalOutput, usage };
}

function collectStderr(child: ChildProcessWithoutNullStreams) {
  let buffered = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    buffered = `${buffered}${chunk}`.slice(-4_000);
  });
  return { read: () => buffered };
}

function watchExit(child: ChildProcessWithoutNullStreams) {
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
}

function normalizeCodexUsage(
  usage: Extract<CodexEvent, { type: 'turn.completed' }>['usage'],
): LocalAgentUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
    cacheWriteInputTokens: usage.cache_write_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? 0,
  };
}

export function localAgentUsageDelta(
  cumulative: LocalAgentUsage | null,
  baseline?: LocalAgentUsage | null,
) {
  if (!cumulative || !baseline) return cumulative;
  const keys = [
    'inputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
    'reasoningOutputTokens',
  ] as const;
  if (keys.some((key) => cumulative[key] < baseline[key])) return cumulative;
  return Object.fromEntries(
    keys.map((key) => [key, cumulative[key] - baseline[key]]),
  ) as LocalAgentUsage;
}

export function normalizeClaudeUsage(
  usage: Extract<ClaudeEvent, { type: 'result' }>['usage'],
): LocalAgentUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteInputTokens: usage.cache_creation_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningOutputTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}
