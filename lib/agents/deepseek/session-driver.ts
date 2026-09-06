import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
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
import { buildDeepseekPatches, summarize } from './runtime.ts';
import { deepseekEffort } from './models.ts';

export type DeepseekSessionDriverOptions = {
  brokerFactory: (input: AgentRuntimeThreadInput) => HostJobBroker;
  hostTools?: HostTool[];
  load?: () => Promise<SessionModules>;
};

type DshAgent = {
  session: { id: unknown; seq: number; events: readonly unknown[] };
  whenIdle: () => Promise<void>;
  followup: (message: unknown) => void;
  cancel: (cause: { kind: 'user' }) => void;
};

type DshAgentHandle = { agent: DshAgent; dispose: () => Promise<void> };

export type SessionModules = {
  boot: (
    name: string,
    configPath: string,
    patches: unknown[],
    prepare: undefined,
    baseUrl: string,
  ) => Promise<{
    fiber: { dispose: () => Promise<void> };
    get: (name: string) => unknown;
  }>;
  loadOverlayPatches: (name: string, file: string) => unknown[];
  SessionId: (id: string) => unknown;
  createUserMessage: (message: unknown) => unknown;
  ReasoningEffortId: (effort: string) => unknown;
  installModelSelection: (ctx: unknown, selection: unknown) => unknown;
};

type SessionRuntime = SessionModules & {
  agents: {
    create: (options: unknown) => Promise<DshAgentHandle>;
    resume: (options: unknown) => Promise<DshAgentHandle>;
  };
  sessions: { flush: (session: unknown) => Promise<unknown> };
  tools: { register: (definition: unknown) => () => void };
  close: () => Promise<void>;
};

type ThreadState = {
  thread: AgentRuntimeThread;
  broker: HostJobBroker;
  handle: DshAgentHandle;
  sessionId: string;
  turn?: TurnState;
};

type TurnState = {
  threadId: string;
  turnId: string;
  finalOutput: string;
  stopped: boolean;
  onEvent?: (event: AgentRuntimeEvent) => void;
  pendingSuspension?: {
    tool: string;
    completion: Promise<HostToolContinuation & { jobResult?: HostJobEvent }>;
  };
};

const RUN_JOB_TOOL = 'run_job';

function findNodeModules(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'node_modules');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('DeepSeek runtime could not locate node_modules.');
}

async function loadSessionModules(): Promise<SessionModules> {
  const appBoot = await import('@deepseek-ai/dsh-app-boot');
  const session = await import('@deepseek-ai/dsh-session');
  const llm = await import('@deepseek-ai/dsh-llm');
  const agent = await import('@deepseek-ai/dsh-agent');
  return {
    boot: appBoot.boot as unknown as SessionModules['boot'],
    loadOverlayPatches:
      appBoot.loadOverlayPatches as unknown as SessionModules['loadOverlayPatches'],
    SessionId: session.SessionId as unknown as SessionModules['SessionId'],
    createUserMessage:
      llm.createUserMessage as unknown as SessionModules['createUserMessage'],
    ReasoningEffortId:
      llm.ReasoningEffortId as unknown as SessionModules['ReasoningEffortId'],
    installModelSelection:
      agent.installModelSelection as unknown as SessionModules['installModelSelection'],
  };
}

async function bootSessionRuntime(
  workingDirectory: string,
  load: () => Promise<SessionModules> = loadSessionModules,
  access: AgentRuntimeThread['access'] = 'workspace-write',
): Promise<SessionRuntime> {
  const dsh = await load();
  const nodeModules = findNodeModules(dirname(fileURLToPath(import.meta.url)));
  const patchFile = join(
    nodeModules,
    '@deepseek-ai',
    'dsh-base',
    'cordis.patch.yml',
  );
  const patches = buildDeepseekPatches(
    dsh.loadOverlayPatches('praxis', patchFile),
    workingDirectory,
    access === 'read-only' ? 'read-only' : 'workspace-write',
  );
  const baseUrl = pathToFileURL(join(nodeModules, '/')).href;
  const configDir = await mkdtemp(join(tmpdir(), 'praxis-dsh-'));
  const configPath = join(configDir, 'cordis.yml');
  await writeFile(configPath, '[]\n');
  const ctx = await dsh.boot('praxis', configPath, patches, undefined, baseUrl);
  const agents = ctx.get('agents') as SessionRuntime['agents'] | undefined;
  const sessions = ctx.get('sessions') as
    | SessionRuntime['sessions']
    | undefined;
  const tools = ctx.get('tools') as SessionRuntime['tools'] | undefined;
  if (agents === undefined || sessions === undefined || tools === undefined) {
    await ctx.fiber.dispose();
    await rm(configDir, { recursive: true, force: true });
    throw new Error('DeepSeek runtime booted without its Agent services.');
  }
  return {
    ...dsh,
    agents,
    sessions,
    tools,
    close: async () => {
      await ctx.fiber.dispose();
      await rm(configDir, { recursive: true, force: true });
    },
  };
}

export class DeepseekSessionDriver implements AgentSessionDriver {
  readonly provider = 'deepseek' as const;
  readonly capabilities: AgentRuntimeCapabilities = {
    persistentThreads: true,
    pushToolResults: true,
    turnResume: true,
    turnInterrupt: true,
  };

  private options: DeepseekSessionDriverOptions;
  private hostTools: Map<string, HostTool>;
  private threads = new Map<string, ThreadState>();
  private runtime?: SessionRuntime;
  private activeTurn?: TurnState;

  constructor(options: DeepseekSessionDriverOptions) {
    this.options = options;
    this.hostTools = new Map(
      (options.hostTools ?? []).map((tool) => [tool.name, tool]),
    );
  }

  async startThread(
    input: AgentRuntimeThreadInput,
  ): Promise<AgentRuntimeThread> {
    const runtime = await this.ensureRuntime(input);
    const provider = 'deepseek-official';
    const model = input.profile.model || 'deepseek-v4-flash';
    const effort = deepseekEffort(input.profile.effort ?? '');
    const selection = {
      provider,
      model,
      ...(effort === undefined
        ? {}
        : { reasoningEffort: runtime.ReasoningEffortId(effort) }),
    };
    const setup = (agentCtx: Context) => {
      runtime.installModelSelection(agentCtx, {
        current: selection,
        assembled: undefined,
      });
    };
    const handle = await runtime.agents.create({
      sessionId: runtime.SessionId(`session-${randomUUID()}`),
      meta: { cwd: input.workingDirectory },
      agentOptions: { provider, model },
      setup,
    });
    const sessionId = String(handle.agent.session.id);
    const thread: AgentRuntimeThread = {
      provider: this.provider,
      threadId: sessionId,
      profile: input.profile,
      workingDirectory: input.workingDirectory,
      access: input.access,
      instructions: input.instructions,
      hostJobs: input.hostJobs,
    };
    this.threads.set(sessionId, {
      thread,
      broker: this.options.brokerFactory(input),
      handle,
      sessionId,
    });
    return thread;
  }

  async resumeThread(thread: AgentRuntimeThread): Promise<AgentRuntimeThread> {
    const runtime = await this.ensureRuntime(thread);
    if (!this.threads.has(thread.threadId)) {
      const handle = await runtime.agents.resume({
        resumeSessionId: runtime.SessionId(thread.threadId),
        agentOptions: {
          provider: 'deepseek-official',
          model: thread.profile.model || 'deepseek-v4-flash',
        },
      });
      this.threads.set(thread.threadId, {
        thread,
        broker: this.options.brokerFactory({
          profile: thread.profile,
          workingDirectory: thread.workingDirectory,
          access: thread.access,
        }),
        handle,
        sessionId: thread.threadId,
      });
    }
    return thread;
  }

  startTurn(
    thread: AgentRuntimeThread,
    input: AgentRuntimeTurnInput,
  ): AgentRuntimeTurn {
    const state = this.threads.get(thread.threadId);
    if (!state) {
      return {
        completion: Promise.reject(new Error('Unknown DeepSeek session.')),
        interrupt: () => {},
      };
    }
    let turn!: TurnState;
    const completion = new Promise<AgentRuntimeTurnResult>(
      (resolve, reject) => {
        turn = {
          threadId: thread.threadId,
          turnId: `${thread.threadId}:${randomUUID().slice(0, 8)}`,
          finalOutput: '',
          stopped: false,
          onEvent: input.onEvent,
        };
        state.turn = turn;
        this.activeTurn = turn;
        void this.runPhysicalTurn(state, input.prompt)
          .then((result) => {
            state.turn = undefined;
            this.activeTurn = undefined;
            resolve(result);
          })
          .catch((error: Error) => {
            state.turn = undefined;
            this.activeTurn = undefined;
            reject(error);
          });
      },
    );
    return {
      completion,
      interrupt: () => {
        turn.stopped = true;
        state.handle.agent.cancel({ kind: 'user' });
        state.broker.cancelAll();
      },
    };
  }

  async close(): Promise<void> {
    for (const state of this.threads.values()) {
      state.broker.cancelAll();
      await state.handle.dispose();
    }
    this.threads.clear();
    await this.runtime?.close();
    this.runtime = undefined;
  }

  private async ensureRuntime(
    input: Pick<
      AgentRuntimeThreadInput,
      'workingDirectory' | 'access' | 'hostJobs'
    >,
  ): Promise<SessionRuntime> {
    if (this.runtime) return this.runtime;
    const runtime = await bootSessionRuntime(
      input.workingDirectory,
      this.options.load ?? loadSessionModules,
      input.access,
    );
    if (input.access !== 'read-only' && input.hostJobs !== false)
      runtime.tools.register(this.runJobDefinition());
    for (const tool of this.hostTools.values())
      runtime.tools.register(this.hostToolDefinition(tool));
    this.runtime = runtime;
    return runtime;
  }

  private async runPhysicalTurn(
    state: ThreadState,
    prompt: string,
  ): Promise<AgentRuntimeTurnResult> {
    const turn = state.turn!;
    const runtime = this.runtime!;
    const { agent } = state.handle;
    turn.finalOutput = '';
    turn.pendingSuspension = undefined;
    turn.onEvent?.({
      type: 'turn-started',
      threadId: turn.threadId,
      turnId: turn.turnId,
      at: new Date().toISOString(),
    });
    await agent.whenIdle();
    if (turn.stopped) throw new Error('Agent turn interrupted.');
    const firstSeq = agent.session.seq;
    agent.followup(
      runtime.createUserMessage({
        content: [
          {
            type: 'text',
            text: state.thread.instructions
              ? `${state.thread.instructions}\n\n${prompt}`
              : prompt,
          },
        ],
        source: { kind: 'user' },
      }),
    );
    await agent.whenIdle();
    if (turn.stopped) throw new Error('Agent turn interrupted.');
    turn.finalOutput = summarize(agent.session.events, firstSeq);
    turn.onEvent?.({
      type: 'turn-completed',
      threadId: turn.threadId,
      turnId: turn.turnId,
      usage: null,
      at: new Date().toISOString(),
    });
    await runtime.sessions.flush(agent.session);
    const suspension = turn.pendingSuspension as TurnState['pendingSuspension'];
    if (!suspension) {
      if (!turn.finalOutput)
        throw new Error('DeepSeek returned no final output.');
      return {
        threadId: turn.threadId,
        turnId: turn.turnId,
        finalOutput: turn.finalOutput,
        usage: null,
      };
    }
    const result = await suspension.completion;
    if (turn.stopped) throw new Error('Agent turn interrupted.');
    turn.pendingSuspension = undefined;
    if (result.jobResult)
      turn.onEvent?.({
        type: 'job-completed',
        threadId: turn.threadId,
        turnId: turn.turnId,
        jobId: result.jobResult.jobId,
        exitCode: result.jobResult.exitCode,
        at: result.jobResult.endedAt ?? new Date().toISOString(),
      });
    if ('finalOutput' in result)
      return {
        threadId: turn.threadId,
        turnId: turn.turnId,
        finalOutput: result.finalOutput,
        usage: null,
      };
    return this.runPhysicalTurn(state, result.prompt);
  }

  private requireSuspensionSlot(): TurnState {
    const turn = this.activeTurn;
    if (!turn) throw new Error('No active DeepSeek turn.');
    if (turn.pendingSuspension)
      throw new Error('A Host operation is already pending.');
    return turn;
  }

  private armSuspension(suspension: {
    tool: string;
    acknowledgement: string;
    completion: Promise<HostToolContinuation & { jobResult?: HostJobEvent }>;
  }): string {
    const turn = this.requireSuspensionSlot();
    turn.pendingSuspension = {
      tool: suspension.tool,
      completion: suspension.completion,
    };
    return suspension.acknowledgement;
  }

  private hostToolDefinition(tool: HostTool) {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
        render: (_args: unknown, value: { message: string }) => [
          { type: 'text', text: value.message },
        ],
      },
      execute: async (
        args: Record<string, unknown>,
        exec: { concludeTurn: () => void },
      ) => {
        this.requireSuspensionSlot();
        const result = await tool.call(args);
        if (isHostToolSuspension(result)) {
          const message = this.armSuspension({
            tool: tool.name,
            acknowledgement: result.acknowledgement,
            completion: result.continuation,
          });
          exec.concludeTurn();
          return { message };
        }
        return { message: JSON.stringify(result) };
      },
    };
  }

  private runJobDefinition() {
    return {
      name: RUN_JOB_TOOL,
      description:
        'Start one long command in the current Card workspace. Praxis suspends this physical turn and resumes with the completion result. Never call wait or poll.',
      parameters: {
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
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
        render: (_args: unknown, value: { message: string }) => [
          { type: 'text', text: value.message },
        ],
      },
      execute: async (
        args: Partial<HostJobRequest> & { workingDirectory?: string },
        exec: { concludeTurn: () => void },
      ) => {
        const turn = this.requireSuspensionSlot();
        const state = this.threads.get(turn.threadId);
        if (!state) throw new Error('Unknown DeepSeek session.');
        const job = await state.broker.run({
          label: String(args.label ?? ''),
          executable: String(args.executable ?? ''),
          arguments: Array.isArray(args.arguments)
            ? args.arguments.map(String)
            : [],
          workingDirectory: join(
            state.thread.workingDirectory,
            args.workingDirectory ?? '.',
          ),
          timeoutMs:
            typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        });
        turn.onEvent?.({
          type: 'job-started',
          threadId: turn.threadId,
          turnId: turn.turnId,
          jobId: job.id,
          label: String(args.label ?? ''),
          at: new Date().toISOString(),
        });
        const message = this.armSuspension({
          tool: RUN_JOB_TOOL,
          acknowledgement: `Host job ${job.id} started. End this turn now with one short line; Praxis resumes this session with the operating-system result.`,
          completion: job.completion.then((result) => ({
            prompt: hostJobCompletionPrompt(result),
            jobResult: result,
          })),
        });
        exec.concludeTurn();
        return { message };
      },
    };
  }
}
