import { randomUUID } from 'node:crypto';
import {
  type AgentRuntimeCapabilities,
  type AgentRuntimeEvent,
  type AgentRuntimeThread,
  type AgentRuntimeThreadInput,
  type AgentRuntimeTurn,
  type AgentRuntimeTurnInput,
  type AgentRuntimeTurnResult,
  type AgentSessionDriver,
  type HostTool,
} from '../runtime-driver.ts';
import { HostJobBroker } from '../host-job-broker.ts';
import {
  ClaudeHostBridge,
  claudeHostBridge,
  claudeMcpServerName,
  type BridgeThread,
} from './host-bridge.ts';
import { ClaudeSessionPool, claudeSessionPool } from './session-pool.ts';

export { claudeMcpServerName } from './host-bridge.ts';
export const claudeSuspensionGraceMs = 60000;

const startedThreads = new Set<string>();

export type ClaudeSessionDriverOptions = {
  command?: string;
  arguments?: string[];
  environment?: NodeJS.ProcessEnv;
  brokerFactory: (input: AgentRuntimeThreadInput) => HostJobBroker;
  hostTools?: HostTool[];
  suspensionGraceMs?: number;
  bridge?: ClaudeHostBridge;
  pool?: ClaudeSessionPool;
};

export function buildClaudeSessionArguments(input: {
  access: AgentRuntimeThread['access'];
  model?: string;
  effort?: string;
  sessionId: string;
  resume: boolean;
  mcpUrl: string;
  token: string;
  toolNames: string[];
  instructions?: string;
}) {
  const write = input.access !== 'read-only';
  return [
    '--print',
    '--restricted',
    '--setting-sources',
    '',
    '--tools',
    write ? 'Read,Glob,Grep,Edit,Write,Bash' : 'Read,Glob,Grep',
    ...(write ? ['--permission-mode', 'acceptEdits'] : []),
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        [claudeMcpServerName]: {
          type: 'http',
          url: input.mcpUrl,
          headers: { Authorization: `Bearer ${input.token}` },
        },
      },
    }),
    '--strict-mcp-config',
    ...(input.toolNames.length
      ? [
          '--allowedTools',
          input.toolNames
            .map((name) => `mcp__${claudeMcpServerName}__${name}`)
            .join(','),
        ]
      : []),
    ...(input.instructions
      ? ['--append-system-prompt', input.instructions]
      : []),
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--effort', input.effort] : []),
    ...(input.resume
      ? ['--resume', input.sessionId]
      : ['--session-id', input.sessionId]),
  ];
}

export class ClaudeSessionDriver implements AgentSessionDriver {
  readonly provider = 'claude' as const;
  readonly capabilities: AgentRuntimeCapabilities = {
    persistentThreads: true,
    pushToolResults: true,
    turnResume: true,
    turnInterrupt: true,
  };
  private options: ClaudeSessionDriverOptions;
  private hostTools: Map<string, HostTool>;
  private bridge: ClaudeHostBridge;
  private pool: ClaudeSessionPool;
  private leased = new Map<string, number>();

  constructor(options: ClaudeSessionDriverOptions) {
    this.options = options;
    this.hostTools = new Map(
      (options.hostTools ?? []).map((tool) => [tool.name, tool]),
    );
    this.bridge = options.bridge ?? claudeHostBridge;
    this.pool = options.pool ?? claudeSessionPool;
  }

  async startThread(input: AgentRuntimeThreadInput) {
    const threadId = randomUUID();
    return this.attach(threadId, input, false);
  }

  async resumeThread(thread: AgentRuntimeThread) {
    startedThreads.add(thread.threadId);
    return this.attach(
      thread.threadId,
      {
        profile: thread.profile,
        workingDirectory: thread.workingDirectory,
        access: thread.access,
        instructions: thread.instructions,
        hostJobs: thread.hostJobs,
      },
      true,
    );
  }

  private async attach(
    threadId: string,
    input: AgentRuntimeThreadInput,
    started: boolean,
  ) {
    const thread: AgentRuntimeThread = {
      provider: this.provider,
      threadId,
      profile: input.profile,
      workingDirectory: input.workingDirectory,
      access: input.access,
      instructions: input.instructions,
      hostJobs: input.hostJobs,
    };
    const existing = this.bridge.thread(threadId);
    const bridgeThread: BridgeThread = {
      token: existing?.token ?? randomUUID(),
      hostJobs: input.hostJobs !== false,
      workingDirectory: input.workingDirectory,
      broker: existing?.broker ?? this.options.brokerFactory(input),
      hostTools: this.hostTools,
      graceMs: this.options.suspensionGraceMs ?? claudeSuspensionGraceMs,
    };
    await this.bridge.register(threadId, bridgeThread);
    if (started) startedThreads.add(threadId);
    return thread;
  }

  startTurn(
    thread: AgentRuntimeThread,
    input: AgentRuntimeTurnInput,
  ): AgentRuntimeTurn {
    const threadId = thread.threadId;
    let stop: (() => void) | undefined;
    const completion = this.runLogicalTurn(thread, input, (fn) => {
      stop = fn;
    });
    return {
      completion,
      interrupt: () => {
        const bridgeThread = this.bridge.thread(threadId);
        if (bridgeThread?.turn) bridgeThread.turn.stopped = true;
        bridgeThread?.broker.cancelAll();
        stop?.();
      },
    };
  }

  private async runLogicalTurn(
    thread: AgentRuntimeThread,
    input: AgentRuntimeTurnInput,
    registerStop: (stop: () => void) => void,
  ): Promise<AgentRuntimeTurnResult> {
    const threadId = thread.threadId;
    const bridgeThread = this.bridge.thread(threadId);
    if (!bridgeThread) throw new Error('Unknown Claude session.');
    if (bridgeThread.turn) throw new Error('A Claude turn is already running.');
    const port = await this.bridge.listen();
    const toolNames = this.bridge.toolNames(bridgeThread);
    const resume = startedThreads.has(threadId);
    const arguments_ = [
      ...(this.options.arguments ?? []),
      ...buildClaudeSessionArguments({
        access: thread.access,
        model: thread.profile.model || undefined,
        effort: thread.profile.effort || undefined,
        sessionId: threadId,
        resume,
        mcpUrl: `http://127.0.0.1:${port}/mcp/${threadId}`,
        token: bridgeThread.token,
        toolNames,
        instructions: thread.instructions,
      }),
    ];
    const environment = { ...(this.options.environment ?? process.env) };
    delete environment.ANTHROPIC_API_KEY;
    const signature = JSON.stringify([
      this.options.command ?? 'claude',
      configurationArguments(arguments_),
      thread.workingDirectory,
      toolNames,
    ]);
    const resident = await this.pool.acquire(threadId, {
      command: this.options.command ?? 'claude',
      arguments: arguments_,
      environment,
      workingDirectory: thread.workingDirectory,
      signature,
    });
    this.leased.set(threadId, (this.leased.get(threadId) ?? 0) + 1);
    startedThreads.add(threadId);

    let stopped = false;
    const turnState: NonNullable<BridgeThread['turn']> = { stopped: false };
    bridgeThread.turn = turnState;
    let cancelWait: (error: Error) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      cancelWait = reject;
    });
    cancelled.catch(() => {});
    const abort = (reason: string) => {
      stopped = true;
      turnState.stopped = true;
      cancelWait(new Error('Agent turn interrupted.'));
      void this.pool.dispose(threadId, reason);
    };
    registerStop(() => abort('Agent turn interrupted.'));
    turnState.onGraceExpired = () =>
      abort(
        'Claude did not end its physical turn after a Host operation was suspended. The Host stopped the process instead of waiting for the Action deadline.',
      );

    let usage: AgentRuntimeTurnResult['usage'] = null;
    let prompt = input.prompt;
    const emit = (event: AgentRuntimeEvent) => input.onEvent?.(event);
    try {
      for (;;) {
        const turnId = `${threadId}:${randomUUID().slice(0, 8)}`;
        turnState.onActivity = (summary) => {
          if (summary.startsWith(`Running tool: mcp__${claudeMcpServerName}__`))
            return;
          emit({
            type: 'activity',
            threadId,
            turnId,
            summary,
            at: new Date().toISOString(),
          });
        };
        turnState.onJobStarted = (jobId, label) =>
          emit({
            type: 'job-started',
            threadId,
            turnId,
            jobId,
            label,
            at: new Date().toISOString(),
          });
        turnState.onSuspended = (tool) =>
          emit({
            type: 'tool-suspended',
            threadId,
            turnId,
            tool,
            at: new Date().toISOString(),
          });
        emit({
          type: 'turn-started',
          threadId,
          turnId,
          at: new Date().toISOString(),
        });
        const outcome = await resident.send({
          prompt,
          onActivity: (summary) => turnState.onActivity?.(summary),
        });
        this.bridge.clearGrace(bridgeThread);
        usage = addUsage(usage, outcome.usage);
        emit({
          type: 'turn-completed',
          threadId,
          turnId,
          usage: outcome.usage,
          at: new Date().toISOString(),
        });
        if (stopped || turnState.stopped)
          throw new Error('Agent turn interrupted.');
        if (outcome.error) throw new Error(outcome.error);
        const suspension = turnState.pendingSuspension;
        if (!suspension) {
          if (!outcome.finalOutput)
            throw new Error('Claude returned no final output.');
          return {
            threadId,
            turnId,
            finalOutput: outcome.finalOutput,
            usage,
          };
        }
        const result = await Promise.race([suspension.completion, cancelled]);
        turnState.pendingSuspension = undefined;
        if (stopped || turnState.stopped)
          throw new Error('Agent turn interrupted.');
        if (result.jobResult)
          emit({
            type: 'job-completed',
            threadId,
            turnId,
            jobId: result.jobResult.jobId,
            exitCode: result.jobResult.exitCode,
            at: result.jobResult.endedAt ?? new Date().toISOString(),
          });
        else
          emit({
            type: 'tool-resumed',
            threadId,
            turnId,
            tool: suspension.tool,
            at: new Date().toISOString(),
          });
        if ('finalOutput' in result)
          return { threadId, turnId, finalOutput: result.finalOutput, usage };
        prompt = result.prompt;
      }
    } finally {
      this.bridge.clearGrace(bridgeThread);
      bridgeThread.turn = undefined;
    }
  }

  async close() {
    for (const [threadId, count] of this.leased)
      for (let taken = 0; taken < count; taken += 1)
        this.pool.release(threadId);
    this.leased.clear();
  }

  async dispose(reason?: string) {
    for (const threadId of this.leased.keys()) {
      await this.pool.dispose(threadId, reason);
      this.bridge.unregister(threadId);
      startedThreads.delete(threadId);
    }
    this.leased.clear();
  }
}

export function configurationArguments(values: string[]) {
  const session = values.lastIndexOf('--session-id');
  const resumed = values.lastIndexOf('--resume');
  const marker = Math.max(session, resumed);
  const withoutSession = marker < 0 ? values : values.slice(0, marker);
  return withoutSession.filter(
    (value) => !value.startsWith('http://127.0.0.1:'),
  );
}

function addUsage(
  total: AgentRuntimeTurnResult['usage'],
  next: AgentRuntimeTurnResult['usage'],
): AgentRuntimeTurnResult['usage'] {
  if (!next) return total;
  if (!total) return next;
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
    cacheWriteInputTokens:
      total.cacheWriteInputTokens + next.cacheWriteInputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    reasoningOutputTokens:
      total.reasoningOutputTokens + next.reasoningOutputTokens,
  };
}
