import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
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
import { publishActivity } from '../activity.ts';
import { normalizeClaudeUsage, parseClaudeEvent } from '../transport.ts';

export const claudeMcpServerName = 'praxis';
export const claudeSuspensionGraceMs = 60000;
const mcpProtocolVersion = '2025-06-18';
const runJobTool = {
  name: 'run_job',
  description:
    'Start one long command in the current Card workspace. The Host owns the process, log and cancellation. After calling it, end this turn immediately with one short line; Praxis resumes this session with the completion result. Never call wait or poll.',
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

export type ClaudeSessionDriverOptions = {
  command?: string;
  arguments?: string[];
  environment?: NodeJS.ProcessEnv;
  brokerFactory: (input: AgentRuntimeThreadInput) => HostJobBroker;
  hostTools?: HostTool[];
  suspensionGraceMs?: number;
};
type ThreadState = {
  thread: AgentRuntimeThread;
  token: string;
  hostJobs: boolean;
  instructions?: string;
  sessionStarted: boolean;
  broker: HostJobBroker;
  turn?: TurnState;
};
type TurnState = {
  threadId: string;
  turnId: string;
  finalOutput: string;
  usage: AgentRuntimeTurnResult['usage'];
  onEvent?: (event: AgentRuntimeEvent) => void;
  resolve: (result: AgentRuntimeTurnResult) => void;
  reject: (error: Error) => void;
  stopped: boolean;
  child?: ChildProcessWithoutNullStreams;
  graceTimer?: ReturnType<typeof setTimeout>;
  suspensionExpired?: boolean;
  pendingSuspension?: {
    tool: string;
    completion: Promise<HostToolContinuation & { jobResult?: HostJobEvent }>;
  };
};
type JsonRpc = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
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
  private threads = new Map<string, ThreadState>();
  private server?: http.Server;
  private serverReady?: Promise<number>;

  constructor(options: ClaudeSessionDriverOptions) {
    this.options = options;
    this.hostTools = new Map(
      (options.hostTools ?? []).map((tool) => [tool.name, tool]),
    );
  }

  async startThread(input: AgentRuntimeThreadInput) {
    const threadId = randomUUID();
    const thread: AgentRuntimeThread = {
      provider: this.provider,
      threadId,
      profile: input.profile,
      workingDirectory: input.workingDirectory,
      access: input.access,
      instructions: input.instructions,
      hostJobs: input.hostJobs,
    };
    this.threads.set(threadId, {
      thread,
      token: randomUUID(),
      hostJobs: input.hostJobs !== false,
      instructions: input.instructions,
      sessionStarted: false,
      broker: this.options.brokerFactory(input),
    });
    await this.listen();
    return thread;
  }

  async resumeThread(thread: AgentRuntimeThread) {
    if (!this.threads.has(thread.threadId))
      this.threads.set(thread.threadId, {
        thread,
        token: randomUUID(),
        hostJobs: thread.hostJobs !== false,
        instructions: thread.instructions,
        sessionStarted: true,
        broker: this.options.brokerFactory({
          profile: thread.profile,
          workingDirectory: thread.workingDirectory,
          access: thread.access,
        }),
      });
    await this.listen();
    return thread;
  }

  startTurn(
    thread: AgentRuntimeThread,
    input: AgentRuntimeTurnInput,
  ): AgentRuntimeTurn {
    const state = this.threads.get(thread.threadId);
    let turn!: TurnState;
    const completion = new Promise<AgentRuntimeTurnResult>(
      (resolve, reject) => {
        turn = {
          threadId: thread.threadId,
          turnId: '',
          finalOutput: '',
          usage: null,
          onEvent: input.onEvent,
          resolve,
          reject,
          stopped: false,
        };
        if (!state) {
          reject(new Error('Unknown Claude session.'));
          return;
        }
        if (state.turn) {
          reject(new Error('A Claude turn is already running.'));
          return;
        }
        state.turn = turn;
        void this.runPhysicalTurn(state, input.prompt, state.sessionStarted)
          .then((result) => {
            state.turn = undefined;
            resolve(result);
          })
          .catch((error: Error) => {
            state.turn = undefined;
            reject(error);
          });
      },
    );
    return {
      completion,
      interrupt: () => {
        turn.stopped = true;
        terminate(turn.child);
        state?.broker.cancelAll();
      },
    };
  }

  async close() {
    for (const state of this.threads.values()) {
      state.broker.cancelAll();
      if (state.turn) {
        state.turn.stopped = true;
        if (state.turn.graceTimer) clearTimeout(state.turn.graceTimer);
        state.turn.graceTimer = undefined;
        terminate(state.turn.child);
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
    this.server = undefined;
    this.serverReady = undefined;
  }

  private async runPhysicalTurn(
    state: ThreadState,
    prompt: string,
    resume: boolean,
  ): Promise<AgentRuntimeTurnResult> {
    const turn = state.turn!;
    if (turn.stopped) throw new Error('Agent turn interrupted.');
    const port = await this.listen();
    const toolNames = [
      ...(state.hostJobs ? ['run_job'] : []),
      ...this.hostTools.keys(),
    ];
    const arguments_ = [
      ...(this.options.arguments ?? []),
      ...buildClaudeSessionArguments({
        access: state.thread.access,
        model: state.thread.profile.model || undefined,
        effort: state.thread.profile.effort || undefined,
        sessionId: state.thread.threadId,
        resume,
        mcpUrl: `http://127.0.0.1:${port}/mcp/${state.thread.threadId}`,
        token: state.token,
        toolNames,
        instructions: state.instructions,
      }),
    ];
    const environment = { ...(this.options.environment ?? process.env) };
    delete environment.ANTHROPIC_API_KEY;
    const child = spawn(this.options.command ?? 'claude', arguments_, {
      cwd: state.thread.workingDirectory,
      env: environment,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    state.sessionStarted = true;
    turn.child = child;
    turn.turnId = `${state.thread.threadId}:${randomUUID().slice(0, 8)}`;
    turn.finalOutput = '';
    turn.pendingSuspension = undefined;
    turn.onEvent?.({
      type: 'turn-started',
      threadId: turn.threadId,
      turnId: turn.turnId,
      at: new Date().toISOString(),
    });
    child.stdin.end(prompt);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    let reportedError = '';
    let turnUsage: AgentRuntimeTurnResult['usage'] = null;
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const lines = readline.createInterface({ input: child.stdout });
    for await (const line of lines) {
      const event = parseClaudeEvent(line);
      if (!event) continue;
      publishActivity(event, (activity) => {
        if (
          activity.summary.startsWith(
            `Running tool: mcp__${claudeMcpServerName}__`,
          )
        )
          return;
        turn.onEvent?.({
          type: 'activity',
          threadId: turn.threadId,
          turnId: turn.turnId,
          summary: activity.summary,
          at: new Date().toISOString(),
        });
      });
      if (event.type === 'result' && 'subtype' in event) {
        turnUsage = normalizeClaudeUsage(event.usage);
        if (event.is_error || event.subtype !== 'success')
          reportedError =
            typeof event.result === 'string' && event.result
              ? event.result
              : `Claude ended the turn with ${event.subtype}.`;
        else if (typeof event.result === 'string')
          turn.finalOutput = event.result;
      }
    }
    const exitCode = await exit;
    turn.child = undefined;
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    turn.graceTimer = undefined;
    turn.usage = addUsage(turn.usage, turnUsage);
    turn.onEvent?.({
      type: 'turn-completed',
      threadId: turn.threadId,
      turnId: turn.turnId,
      usage: turnUsage,
      at: new Date().toISOString(),
    });
    if (turn.stopped) throw new Error('Agent turn interrupted.');
    if (turn.suspensionExpired)
      throw new Error(
        'Claude did not end its physical turn after a Host operation was suspended. The Host stopped the process instead of waiting for the Action deadline.',
      );
    if (exitCode !== 0 || reportedError)
      throw new Error(
        reportedError || stderr.trim() || 'Claude did not complete.',
      );
    const suspension = pendingSuspensionOf(turn);
    if (!suspension) {
      if (!turn.finalOutput)
        throw new Error('Claude returned no final output.');
      return {
        threadId: turn.threadId,
        turnId: turn.turnId,
        finalOutput: turn.finalOutput,
        usage: turn.usage,
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
    else
      turn.onEvent?.({
        type: 'tool-resumed',
        threadId: turn.threadId,
        turnId: turn.turnId,
        tool: suspension.tool,
        at: new Date().toISOString(),
      });
    if ('finalOutput' in result)
      return {
        threadId: turn.threadId,
        turnId: turn.turnId,
        finalOutput: result.finalOutput,
        usage: turn.usage,
      };
    return this.runPhysicalTurn(state, result.prompt, true);
  }

  private listen() {
    if (this.serverReady) return this.serverReady;
    this.serverReady = new Promise<number>((resolve, reject) => {
      const server = http.createServer((request, response) =>
        this.handleHttp(request, response),
      );
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string')
          return reject(new Error('Loopback MCP server has no port.'));
        this.server = server;
        resolve(address.port);
      });
    });
    return this.serverReady;
  }

  private handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    const match = request.url?.match(/^\/mcp\/([0-9a-f-]{36})$/);
    const state = match ? this.threads.get(match[1]) : undefined;
    if (!state) {
      response.writeHead(404).end();
      return;
    }
    const provided = request.headers.authorization ?? '';
    const expected = `Bearer ${state.token}`;
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body = `${body}${chunk}`;
      if (body.length > 2_000_000) request.destroy();
    });
    request.on('end', () => {
      void this.handleRpc(state, body, response);
    });
  }

  private async handleRpc(
    state: ThreadState,
    body: string,
    response: http.ServerResponse,
  ) {
    let message: JsonRpc;
    try {
      message = JSON.parse(body) as JsonRpc;
    } catch {
      response.writeHead(400).end();
      return;
    }
    const reply = (result: unknown) => {
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result }),
        );
    };
    if (message.id === undefined || message.id === null) {
      response.writeHead(202).end();
      return;
    }
    if (message.method === 'initialize') {
      reply({
        protocolVersion: mcpProtocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'praxis', version: '0.1.0' },
      });
      return;
    }
    if (message.method === 'ping') {
      reply({});
      return;
    }
    if (message.method === 'tools/list') {
      reply({
        tools: [
          ...(state.hostJobs ? [runJobTool] : []),
          ...[...this.hostTools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ],
      });
      return;
    }
    if (message.method === 'tools/call') {
      const rawName = message.params?.name;
      const name = typeof rawName === 'string' ? rawName : '';
      const arguments_ =
        (message.params?.arguments as Record<string, unknown> | undefined) ??
        {};
      const text = await this.callTool(state, name, arguments_);
      reply({
        content: [{ type: 'text', text: text.text }],
        isError: !text.success,
      });
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      }),
    );
  }

  private armSuspensionGrace(turn: TurnState) {
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    turn.graceTimer = setTimeout(() => {
      turn.suspensionExpired = true;
      terminate(turn.child);
    }, this.options.suspensionGraceMs ?? claudeSuspensionGraceMs);
    turn.graceTimer.unref?.();
  }

  private async callTool(
    state: ThreadState,
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<{ success: boolean; text: string }> {
    const turn = state.turn;
    turn?.onEvent?.({
      type: 'activity',
      threadId: turn.threadId,
      turnId: turn.turnId,
      summary: `Running tool: ${name}`,
      at: new Date().toISOString(),
    });
    if (!turn || turn.stopped)
      return { success: false, text: 'No active Claude turn.' };
    if (turn.pendingSuspension)
      return {
        success: false,
        text: 'A Host operation is already pending. End this turn now; do not start or poll another one.',
      };
    if (name === 'run_job' && state.hostJobs) {
      try {
        const request = arguments_ as Partial<HostJobRequest> & {
          workingDirectory?: string;
        };
        const job = await state.broker.run({
          label: String(request.label ?? ''),
          executable: String(request.executable ?? ''),
          arguments: Array.isArray(request.arguments)
            ? request.arguments.map(String)
            : [],
          workingDirectory: path.resolve(
            state.thread.workingDirectory,
            request.workingDirectory ?? '.',
          ),
          timeoutMs:
            typeof request.timeoutMs === 'number'
              ? request.timeoutMs
              : undefined,
        });
        this.armSuspensionGrace(turn);
        turn.pendingSuspension = {
          tool: 'run_job',
          completion: job.completion.then((result) => ({
            prompt: hostJobCompletionPrompt(result),
            jobResult: result,
          })),
        };
        turn.onEvent?.({
          type: 'job-started',
          threadId: turn.threadId,
          turnId: turn.turnId,
          jobId: job.id,
          label: String(request.label ?? ''),
          at: new Date().toISOString(),
        });
        return {
          success: true,
          text: `Host job ${job.id} started. End this turn now with one short line and do not call any other tool; Praxis resumes this session with the operating-system result.`,
        };
      } catch (error) {
        return {
          success: false,
          text: error instanceof Error ? error.message : 'Host job failed.',
        };
      }
    }
    const tool = this.hostTools.get(name);
    if (!tool) return { success: false, text: 'Unsupported Host tool.' };
    try {
      const result = await tool.call(arguments_);
      if (isHostToolSuspension(result)) {
        this.armSuspensionGrace(turn);
        turn.pendingSuspension = {
          tool: tool.name,
          completion: result.continuation,
        };
        turn.onEvent?.({
          type: 'tool-suspended',
          threadId: turn.threadId,
          turnId: turn.turnId,
          tool: tool.name,
          at: new Date().toISOString(),
        });
        return {
          success: true,
          text: `${result.acknowledgement} End this turn now with one short line and do not call any other tool; Praxis resumes this session when the Host operation settles.`,
        };
      }
      return { success: true, text: JSON.stringify(result) };
    } catch (error) {
      return {
        success: false,
        text: error instanceof Error ? error.message : 'Host tool failed.',
      };
    }
  }
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

function pendingSuspensionOf(turn: TurnState) {
  return turn.pendingSuspension;
}

function terminate(child: ChildProcessWithoutNullStreams | undefined) {
  if (!child || child.exitCode !== null) return;
  try {
    if (child.pid && process.platform !== 'win32')
      process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {}
  const force = setTimeout(() => {
    if (child.exitCode === null) {
      try {
        if (child.pid && process.platform !== 'win32')
          process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    }
  }, 2000);
  force.unref();
}
