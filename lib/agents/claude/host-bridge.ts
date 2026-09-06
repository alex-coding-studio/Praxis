import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import {
  isHostToolSuspension,
  type HostTool,
  type HostToolContinuation,
} from '../runtime-driver.ts';
import {
  hostJobCompletionPrompt,
  type HostJobBroker,
  type HostJobEvent,
  type HostJobRequest,
} from '../host-job-broker.ts';

export const claudeMcpServerName = 'praxis';
const mcpProtocolVersion = '2025-06-18';

export const runJobTool = {
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

export type BridgeSuspension = {
  tool: string;
  completion: Promise<HostToolContinuation & { jobResult?: HostJobEvent }>;
};
export type BridgeThread = {
  token: string;
  hostJobs: boolean;
  workingDirectory: string;
  broker: HostJobBroker;
  hostTools: Map<string, HostTool>;
  turn?: {
    stopped: boolean;
    pendingSuspension?: BridgeSuspension;
    onActivity?: (summary: string) => void;
    onSuspended?: (tool: string) => void;
    onJobStarted?: (jobId: string, label: string) => void;
    onGraceExpired?: () => void;
  };
  graceMs: number;
  graceTimer?: ReturnType<typeof setTimeout>;
};
type JsonRpc = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

export class ClaudeHostBridge {
  private threads = new Map<string, BridgeThread>();
  private server?: http.Server;
  private serverReady?: Promise<number>;

  register(threadId: string, thread: BridgeThread) {
    this.threads.set(threadId, thread);
    return this.listen();
  }
  thread(threadId: string) {
    return this.threads.get(threadId);
  }
  unregister(threadId: string) {
    const thread = this.threads.get(threadId);
    if (thread?.graceTimer) clearTimeout(thread.graceTimer);
    this.threads.delete(threadId);
  }
  toolDefinitions(thread: BridgeThread) {
    const defined = thread.hostJobs ? [runJobTool] : [];
    for (const tool of thread.hostTools.values())
      defined.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as typeof runJobTool.inputSchema,
      });
    return defined;
  }
  toolNames(thread: BridgeThread) {
    const names = thread.hostJobs ? [runJobTool.name] : [];
    for (const name of thread.hostTools.keys()) names.push(name);
    return names;
  }

  listen() {
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
        server.unref();
        resolve(address.port);
      });
    });
    return this.serverReady;
  }

  async close() {
    for (const threadId of Array.from(this.threads.keys()))
      this.unregister(threadId);
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
    this.server = undefined;
    this.serverReady = undefined;
  }

  private handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    const match = request.url?.match(/^\/mcp\/([0-9a-f-]{36})$/);
    const thread = match ? this.threads.get(match[1]) : undefined;
    if (!thread) {
      response.writeHead(404).end();
      return;
    }
    const provided = request.headers.authorization ?? '';
    const expected = `Bearer ${thread.token}`;
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
      void this.handleRpc(thread, body, response);
    });
  }

  private async handleRpc(
    thread: BridgeThread,
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
    if (message.method === 'initialize')
      return reply({
        protocolVersion: mcpProtocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'praxis', version: '0.1.0' },
      });
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list')
      return reply({ tools: this.toolDefinitions(thread) });
    if (message.method === 'tools/call') {
      const rawName = message.params?.name;
      const name = typeof rawName === 'string' ? rawName : '';
      const arguments_ =
        (message.params?.arguments as Record<string, unknown> | undefined) ??
        {};
      const text = await this.callTool(thread, name, arguments_);
      return reply({
        content: [{ type: 'text', text: text.text }],
        isError: !text.success,
      });
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      }),
    );
  }

  private armSuspensionGrace(thread: BridgeThread) {
    if (thread.graceTimer) clearTimeout(thread.graceTimer);
    thread.graceTimer = setTimeout(() => {
      thread.turn?.onGraceExpired?.();
    }, thread.graceMs);
    thread.graceTimer.unref?.();
  }
  clearGrace(thread: BridgeThread) {
    if (thread.graceTimer) clearTimeout(thread.graceTimer);
    thread.graceTimer = undefined;
  }

  private async callTool(
    thread: BridgeThread,
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<{ success: boolean; text: string }> {
    const turn = thread.turn;
    turn?.onActivity?.(`Running tool: ${name}`);
    if (!turn || turn.stopped)
      return { success: false, text: 'No active Claude turn.' };
    if (turn.pendingSuspension)
      return {
        success: false,
        text: 'A Host operation is already pending. End this turn now; do not start or poll another one.',
      };
    if (name === runJobTool.name && thread.hostJobs) {
      try {
        const request = arguments_ as Partial<HostJobRequest> & {
          workingDirectory?: string;
        };
        const job = await thread.broker.run({
          label: String(request.label ?? ''),
          executable: String(request.executable ?? ''),
          arguments: Array.isArray(request.arguments)
            ? request.arguments.map(String)
            : [],
          workingDirectory: path.resolve(
            thread.workingDirectory,
            request.workingDirectory ?? '.',
          ),
          timeoutMs:
            typeof request.timeoutMs === 'number'
              ? request.timeoutMs
              : undefined,
        });
        this.armSuspensionGrace(thread);
        turn.pendingSuspension = {
          tool: runJobTool.name,
          completion: job.completion.then((result) => ({
            prompt: hostJobCompletionPrompt(result),
            jobResult: result,
          })),
        };
        turn.onJobStarted?.(job.id, String(request.label ?? ''));
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
    const tool = thread.hostTools.get(name);
    if (!tool) return { success: false, text: 'Unsupported Host tool.' };
    try {
      const result = await tool.call(arguments_);
      if (isHostToolSuspension(result)) {
        this.armSuspensionGrace(thread);
        turn.pendingSuspension = {
          tool: tool.name,
          completion: result.continuation,
        };
        turn.onSuspended?.(tool.name);
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

export const claudeHostBridge = new ClaudeHostBridge();
