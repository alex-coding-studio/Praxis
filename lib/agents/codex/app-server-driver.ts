import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import {
  isHostToolSuspension,
  type AgentRuntimeCapabilities,
  type AgentRuntimeEvent,
  type AgentRuntimeThread,
  type AgentRuntimeThreadInput,
  type AgentRuntimeTurn,
  type AgentRuntimeTurnInput,
  type AgentRuntimeTurnResult,
  type AgentSessionDriver,
  type HostTool,
  type HostToolContinuation,
} from '../runtime-driver.ts';
import {
  HostJobBroker,
  hostJobCompletionPrompt,
  type HostJobEvent,
  type HostJobRequest,
} from '../host-job-broker.ts';

export type CodexAppServerDriverOptions = {
  command?: string;
  arguments?: string[];
  environment?: NodeJS.ProcessEnv;
  brokerFactory: (input: AgentRuntimeThreadInput) => HostJobBroker;
  hostTools?: HostTool[];
};
const workerInstructions =
  'Complete only the assigned worker task. Do not create or delegate to other agents. Use the Host run_job tool for long-running commands. It starts the job and Praxis interrupts this physical turn; do not call wait or poll. Praxis starts a continuation turn in this same thread when the operating-system process exits.';
const runJobTool = {
  type: 'function',
  name: 'run_job',
  description:
    'Start one long command in the current Card workspace. Praxis suspends this physical turn and starts a continuation turn with the completion result. Never call wait or poll.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['label', 'executable', 'arguments'],
    properties: {
      label: { type: 'string' },
      executable: { type: 'string' },
      arguments: { type: 'array', items: { type: 'string' } },
      workingDirectory: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1 },
    },
  },
};
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
type RpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
type TurnState = {
  threadId: string;
  turnId: string;
  finalOutput: string;
  usage: AgentRuntimeTurnResult['usage'];
  onEvent?: (event: AgentRuntimeEvent) => void;
  resolve: (result: AgentRuntimeTurnResult) => void;
  reject: (error: Error) => void;
  lastTurnUsage: AgentRuntimeTurnResult['usage'];
  stopped: boolean;
  physicalCompleted: boolean;
  continuationStarted: boolean;
  pendingSuspension?: {
    tool: string;
    jobId?: string;
    completion: Promise<HostToolContinuation>;
  };
  suspensionResult?: { tool: string; jobId?: string } & HostToolContinuation;
};

export class CodexAppServerDriver implements AgentSessionDriver {
  readonly provider = 'codex' as const;
  readonly capabilities: AgentRuntimeCapabilities = {
    persistentThreads: true,
    pushToolResults: true,
    turnResume: true,
    turnInterrupt: true,
  };
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private threads = new Map<string, AgentRuntimeThread>();
  private brokers = new Map<string, HostJobBroker>();
  private hostJobs = new Map<string, boolean>();
  private turns = new Map<string, TurnState>();
  private suspended = new Set<TurnState>();
  private bufferedTurnMessages = new Map<string, RpcMessage[]>();
  private ready: Promise<void>;
  private brokerFactory: CodexAppServerDriverOptions['brokerFactory'];
  private hostTools: Map<string, HostTool>;

  constructor(options: CodexAppServerDriverOptions) {
    this.brokerFactory = options.brokerFactory;
    this.hostTools = new Map(
      (options.hostTools ?? []).map((tool) => [tool.name, tool]),
    );
    this.child = spawn(
      options.command ?? 'codex',
      options.arguments ?? ['app-server', '--stdio'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: options.environment ?? agentProcessEnvironment(),
      },
    );
    readline
      .createInterface({ input: this.child.stdout })
      .on('line', (line) => this.receive(line));
    this.child.stderr.on('data', () => {});
    this.child.on('error', (error) => this.failAll(error));
    this.child.on('exit', () =>
      this.failAll(new Error('Codex App Server exited.')),
    );
    this.ready = this.initialize();
  }

  async startThread(input: AgentRuntimeThreadInput) {
    await this.ready;
    const response = (await this.request('thread/start', {
      cwd: input.workingDirectory,
      model: input.profile.model || null,
      sandbox:
        input.access === 'full-access' ? 'danger-full-access' : input.access,
      approvalPolicy: 'never',
      multiAgentMode: 'explicitRequestOnly',
      developerInstructions: input.instructions ?? workerInstructions,
      ephemeral: false,
      dynamicTools: [
        ...(input.hostJobs === false && !input.advertiseHostJobs
          ? []
          : [runJobTool]),
        ...[...this.hostTools.values()].map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      ],
    })) as { thread: { id: string } };
    const thread = {
      provider: this.provider,
      threadId: response.thread.id as string,
      profile: input.profile,
      workingDirectory: input.workingDirectory,
      access: input.access,
      instructions: input.instructions,
      hostJobs: input.hostJobs,
    };
    this.threads.set(thread.threadId, thread);
    this.brokers.set(thread.threadId, this.brokerFactory(input));
    this.hostJobs.set(thread.threadId, input.hostJobs !== false);
    return thread;
  }

  async resumeThread(thread: AgentRuntimeThread) {
    await this.ready;
    await this.request('thread/resume', {
      threadId: thread.threadId,
      cwd: thread.workingDirectory,
      model: thread.profile.model || null,
      sandbox:
        thread.access === 'full-access' ? 'danger-full-access' : thread.access,
      developerInstructions: thread.instructions,
      approvalPolicy: 'never',
    });
    this.hostJobs.set(thread.threadId, thread.hostJobs !== false);
    this.threads.set(thread.threadId, thread);
    if (!this.brokers.has(thread.threadId))
      this.brokers.set(
        thread.threadId,
        this.brokerFactory({
          profile: thread.profile,
          workingDirectory: thread.workingDirectory,
          access: thread.access,
        }),
      );
    return thread;
  }

  startTurn(
    thread: AgentRuntimeThread,
    input: AgentRuntimeTurnInput,
  ): AgentRuntimeTurn {
    let state!: TurnState;
    const completion = new Promise<AgentRuntimeTurnResult>(
      (resolve, reject) => {
        state = {
          threadId: thread.threadId,
          turnId: '',
          finalOutput: '',
          usage: null,
          lastTurnUsage: null,
          onEvent: input.onEvent,
          resolve,
          reject,
          stopped: false,
          physicalCompleted: false,
          continuationStarted: false,
        };
        void this.startPhysicalTurn(thread, input.prompt, state).catch(reject);
      },
    );
    return {
      completion,
      interrupt: () => {
        state.stopped = true;
        if (state.turnId)
          void this.request('turn/interrupt', {
            threadId: thread.threadId,
            turnId: state.turnId,
          }).catch(() => undefined);
        this.brokers.get(thread.threadId)?.cancelAll();
      },
    };
  }

  private async startPhysicalTurn(
    thread: AgentRuntimeThread,
    prompt: string,
    state: TurnState,
  ) {
    await this.ready;
    const started = (await this.request('turn/start', {
      threadId: thread.threadId,
      input: [{ type: 'text', text: prompt }],
      model: thread.profile.model || null,
      effort: thread.profile.effort || null,
    })) as { turn: { id: string } };
    state.turnId = started.turn.id;
    state.finalOutput = '';
    state.lastTurnUsage = null;
    state.physicalCompleted = false;
    state.continuationStarted = false;
    this.suspended.delete(state);
    this.turns.set(state.turnId, state);
    state.onEvent?.({
      type: 'turn-started',
      threadId: state.threadId,
      turnId: state.turnId,
      at: new Date().toISOString(),
    });
    const buffered = this.bufferedTurnMessages.get(state.turnId) ?? [];
    this.bufferedTurnMessages.delete(state.turnId);
    for (const message of buffered) this.receive(JSON.stringify(message));
  }

  async close() {
    for (const broker of this.brokers.values()) broker.cancelAll();
    this.child.kill('SIGTERM');
  }

  private async initialize() {
    await this.request('initialize', {
      clientInfo: {
        name: 'praxis',
        title: 'Praxis',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
  }

  private send(value: unknown) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receive(line: string) {
    let message: RpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === 'item/tool/call') {
      const turnId = stringValue(message.params?.turnId);
      if (!this.turns.has(turnId)) {
        const buffered = this.bufferedTurnMessages.get(turnId) ?? [];
        if (buffered.length < 100) buffered.push(message);
        this.bufferedTurnMessages.set(turnId, buffered);
        return;
      }
      void this.handleToolCall(message);
      return;
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    const nestedTurn = message.params?.turn as
      | Record<string, unknown>
      | undefined;
    const turnId = stringValue(message.params?.turnId ?? nestedTurn?.id);
    const turn = this.turns.get(turnId);
    if (!turn) {
      if (turnId) {
        const buffered = this.bufferedTurnMessages.get(turnId) ?? [];
        if (buffered.length < 100) buffered.push(message);
        this.bufferedTurnMessages.set(turnId, buffered);
      }
      return;
    }
    this.receiveTurnMessage(message);
  }

  private receiveTurnMessage(message: RpcMessage) {
    const nestedTurn = message.params?.turn as
      | Record<string, unknown>
      | undefined;
    const turn = this.turns.get(
      stringValue(message.params?.turnId ?? nestedTurn?.id),
    );
    if (!turn) return;
    const now = new Date().toISOString();
    if (
      message.method === 'item/started' ||
      message.method === 'item/completed'
    ) {
      const item = message.params?.item as Record<string, unknown> | undefined;
      if (item?.type === 'agentMessage') {
        turn.finalOutput = stringValue(item.text ?? item.message);
        const summary = turn.finalOutput.trim().startsWith('{')
          ? 'Agent report received.'
          : turn.finalOutput.slice(0, 600);
        if (summary)
          turn.onEvent?.({
            type: 'activity',
            threadId: turn.threadId,
            turnId: turn.turnId,
            summary,
            at: now,
          });
      }
      if (item?.type === 'fileChange')
        turn.onEvent?.({
          type: 'activity',
          threadId: turn.threadId,
          turnId: turn.turnId,
          summary: 'Workspace files changed.',
          at: now,
        });
      if (item?.type === 'commandExecution') {
        const phase =
          message.method === 'item/started' ? 'Running' : 'Finished';
        turn.onEvent?.({
          type: 'activity',
          threadId: turn.threadId,
          turnId: turn.turnId,
          summary: `${phase}: ${stringValue(item.command).slice(0, 560)}`,
          at: now,
        });
      }
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const tokenUsage = message.params?.tokenUsage as
        | Record<string, unknown>
        | undefined;
      turn.usage = normalizeUsage(
        tokenUsage?.total ?? tokenUsage ?? message.params?.usage,
      );
      turn.lastTurnUsage = normalizeUsage(tokenUsage?.last) ?? turn.usage;
    }
    if (message.method === 'turn/completed') {
      this.turns.delete(turn.turnId);
      turn.physicalCompleted = true;
      turn.onEvent?.({
        type: 'turn-completed',
        threadId: turn.threadId,
        turnId: turn.turnId,
        usage: turn.lastTurnUsage,
        at: now,
      });
      if (turn.pendingSuspension) {
        this.continueAfterSuspension(turn);
        return;
      }
      if (turn.stopped) {
        turn.reject(new Error('Agent turn interrupted.'));
        return;
      }
      turn.resolve({
        threadId: turn.threadId,
        turnId: turn.turnId,
        finalOutput: turn.finalOutput,
        usage: turn.usage,
      });
    }
  }

  private async handleToolCall(message: RpcMessage) {
    const params = message.params ?? {};
    const hostTool = this.hostTools.get(stringValue(params.tool));
    if (hostTool) {
      const turn = this.turns.get(stringValue(params.turnId));
      turn?.onEvent?.({
        type: 'activity',
        threadId: turn.threadId,
        turnId: turn.turnId,
        summary: `Running tool: ${hostTool.name}`,
        at: new Date().toISOString(),
      });
      if (turn?.pendingSuspension) {
        this.reply(
          message,
          false,
          'A Host operation is already pending. Do not start or poll another one.',
        );
        return;
      }
      try {
        const result = await hostTool.call(
          (params.arguments as Record<string, unknown> | undefined) ?? {},
        );
        if (isHostToolSuspension(result)) {
          if (!turn) throw new Error('Unknown App Server turn.');
          this.suspend(turn, message, {
            tool: hostTool.name,
            acknowledgement: result.acknowledgement,
            completion: result.continuation,
          });
          return;
        }
        this.reply(message, true, JSON.stringify(result));
      } catch (error) {
        this.send({
          id: message.id,
          result: {
            success: false,
            contentItems: [
              {
                type: 'inputText',
                text:
                  error instanceof Error ? error.message : 'Host tool failed.',
              },
            ],
          },
        });
      }
      return;
    }
    const threadId = stringValue(params.threadId);
    if (params.tool !== 'run_job' || this.hostJobs.get(threadId) === false) {
      this.send({
        id: message.id,
        result: {
          success: false,
          contentItems: [{ type: 'inputText', text: 'Unsupported Host tool.' }],
        },
      });
      return;
    }
    const thread = this.threads.get(threadId);
    const broker = this.brokers.get(threadId);
    const turn = this.turns.get(stringValue(params.turnId));
    turn?.onEvent?.({
      type: 'activity',
      threadId: turn.threadId,
      turnId: turn.turnId,
      summary: 'Running tool: run_job',
      at: new Date().toISOString(),
    });
    if (!thread || !broker || !turn) {
      this.send({
        id: message.id,
        result: {
          success: false,
          contentItems: [
            { type: 'inputText', text: 'Unknown App Server thread.' },
          ],
        },
      });
      return;
    }
    if (turn.pendingSuspension) {
      this.reply(
        message,
        false,
        'A Host job is already running. Do not start or poll another task.',
      );
      return;
    }
    try {
      const arguments_ = params.arguments as Partial<HostJobRequest> & {
        workingDirectory?: string;
      };
      const workingDirectory = path.resolve(
        thread.workingDirectory,
        arguments_.workingDirectory ?? '.',
      );
      const job = await broker.run({
        label: String(arguments_.label ?? ''),
        executable: String(arguments_.executable ?? ''),
        arguments: Array.isArray(arguments_.arguments)
          ? arguments_.arguments.map(String)
          : [],
        workingDirectory,
        timeoutMs:
          typeof arguments_.timeoutMs === 'number'
            ? arguments_.timeoutMs
            : undefined,
      });
      turn.onEvent?.({
        type: 'job-started',
        threadId,
        turnId: turn.turnId,
        jobId: job.id,
        label: String(arguments_.label ?? ''),
        at: new Date().toISOString(),
      });
      this.suspend(turn, message, {
        tool: 'run_job',
        jobId: job.id,
        acknowledgement: `Host job ${job.id} started. Praxis will interrupt this physical turn and start a continuation turn with the operating-system result. Do not call wait, write_stdin, or another tool.`,
        completion: job.completion.then((result) => ({
          prompt: hostJobCompletionPrompt(result),
          jobResult: result,
        })),
      });
    } catch (error) {
      this.send({
        id: message.id,
        result: {
          success: false,
          contentItems: [
            {
              type: 'inputText',
              text: error instanceof Error ? error.message : 'Host job failed.',
            },
          ],
        },
      });
    }
  }

  private reply(message: RpcMessage, success: boolean, text: string) {
    this.send({
      id: message.id,
      result: { success, contentItems: [{ type: 'inputText', text }] },
    });
  }

  private suspend(
    turn: TurnState,
    message: RpcMessage,
    suspension: {
      tool: string;
      jobId?: string;
      acknowledgement: string;
      completion: Promise<HostToolContinuation & { jobResult?: HostJobEvent }>;
    },
  ) {
    turn.pendingSuspension = {
      tool: suspension.tool,
      jobId: suspension.jobId,
      completion: suspension.completion,
    };
    this.suspended.add(turn);
    if (suspension.tool !== 'run_job')
      turn.onEvent?.({
        type: 'tool-suspended',
        threadId: turn.threadId,
        turnId: turn.turnId,
        tool: suspension.tool,
        at: new Date().toISOString(),
      });
    this.reply(message, true, suspension.acknowledgement);
    void suspension.completion
      .then((result) => {
        turn.suspensionResult = {
          tool: suspension.tool,
          jobId: suspension.jobId,
          ...result,
        };
        if (result.jobResult)
          turn.onEvent?.({
            type: 'job-completed',
            threadId: turn.threadId,
            turnId: turn.turnId,
            jobId: result.jobResult.jobId,
            exitCode: result.jobResult.exitCode,
            at: result.jobResult.endedAt ?? new Date().toISOString(),
          });
        this.continueAfterSuspension(turn);
      })
      .catch((error: Error) => turn.reject(error));
    void this.request('turn/interrupt', {
      threadId: turn.threadId,
      turnId: turn.turnId,
    }).catch((error: Error) => turn.reject(error));
  }

  private continueAfterSuspension(turn: TurnState) {
    if (
      !turn.physicalCompleted ||
      !turn.suspensionResult ||
      turn.continuationStarted
    )
      return;
    if (turn.stopped) {
      turn.reject(new Error('Agent turn interrupted.'));
      return;
    }
    turn.continuationStarted = true;
    const result = turn.suspensionResult;
    turn.pendingSuspension = undefined;
    turn.suspensionResult = undefined;
    this.suspended.delete(turn);
    if (result.tool !== 'run_job')
      turn.onEvent?.({
        type: 'tool-resumed',
        threadId: turn.threadId,
        turnId: turn.turnId,
        tool: result.tool,
        at: new Date().toISOString(),
      });
    if ('finalOutput' in result) {
      turn.resolve({
        threadId: turn.threadId,
        turnId: turn.turnId,
        finalOutput: result.finalOutput,
        usage: turn.usage,
      });
      return;
    }
    const thread = this.threads.get(turn.threadId);
    if (!thread) {
      turn.reject(new Error('Unknown App Server thread.'));
      return;
    }
    void this.startPhysicalTurn(thread, result.prompt, turn).catch(turn.reject);
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const turn of this.turns.values()) turn.reject(error);
    this.turns.clear();
    for (const turn of this.suspended) turn.reject(error);
    this.suspended.clear();
    this.bufferedTurnMessages.clear();
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function normalizeUsage(value: unknown) {
  if (!value) return null;
  const usage = value as Record<string, unknown>;
  return {
    inputTokens: Number(usage.inputTokens ?? usage.input_tokens ?? 0),
    cachedInputTokens: Number(
      usage.cachedInputTokens ?? usage.cached_input_tokens ?? 0,
    ),
    cacheWriteInputTokens: Number(
      usage.cacheWriteInputTokens ?? usage.cache_write_input_tokens ?? 0,
    ),
    outputTokens: Number(usage.outputTokens ?? usage.output_tokens ?? 0),
    reasoningOutputTokens: Number(
      usage.reasoningOutputTokens ?? usage.reasoning_output_tokens ?? 0,
    ),
  };
}

function agentProcessEnvironment() {
  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  return environment;
}
