import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { publishActivity } from '../activity.ts';
import { normalizeClaudeUsage, parseClaudeEvent } from '../transport.ts';
import type { LocalAgentUsage } from '../transport.ts';

export type ResidentTurnOutcome = {
  finalOutput: string;
  usage: LocalAgentUsage | null;
  error?: string;
};
export type ResidentTurnInput = {
  prompt: string;
  onActivity?: (summary: string) => void;
  onTurnUsage?: (usage: LocalAgentUsage | null) => void;
};
export type ResidentRequestUsage = {
  requestKey: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
};
export type ResidentProcessIdentity = {
  pid: number | undefined;
  launch: number;
  cliVersion?: string;
};
export type ClaudeResidentOptions = {
  command: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  workingDirectory: string;
  signature: string;
  launch?: number;
};

type QueuedTurn = ResidentTurnInput & {
  resolve: (outcome: ResidentTurnOutcome) => void;
  reject: (error: Error) => void;
  finalOutput: string;
  usage: LocalAgentUsage | null;
  error?: string;
  settled: boolean;
};

export class ClaudeResidentProcess {
  readonly signature: string;
  private options: ClaudeResidentOptions;
  private child?: ChildProcessWithoutNullStreams;
  private queue: QueuedTurn[] = [];
  private active?: QueuedTurn;
  private stderr = '';
  private stopped?: string;
  private exited?: Promise<void>;
  private requestUsage = new Map<string, ResidentRequestUsage>();
  private unflushed = new Set<string>();
  private usageSink?: (
    usage: ResidentRequestUsage,
    identity: ResidentProcessIdentity,
  ) => void;
  private readySink?: (identity: ResidentProcessIdentity) => void;
  private cliVersion?: string;

  constructor(options: ClaudeResidentOptions) {
    this.options = options;
    this.signature = options.signature;
  }

  get running() {
    return Boolean(this.child) && !this.stopped;
  }
  get pid() {
    return this.child?.pid;
  }
  get requestCount() {
    return this.requestUsage.size;
  }
  get identity(): ResidentProcessIdentity {
    return {
      pid: this.child?.pid,
      launch: this.options.launch ?? 1,
      cliVersion: this.cliVersion,
    };
  }
  observe(
    usageSink?: (
      usage: ResidentRequestUsage,
      identity: ResidentProcessIdentity,
    ) => void,
    readySink?: (identity: ResidentProcessIdentity) => void,
  ) {
    this.usageSink = usageSink;
    this.readySink = readySink;
  }

  start() {
    if (this.child) return this;
    const child = spawn(this.options.command, this.options.arguments, {
      cwd: this.options.workingDirectory,
      env: this.options.environment,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.consume(line));
    this.exited = new Promise<void>((resolve) => {
      const finish = (reason: string) => {
        lines.close();
        this.settleAll(reason);
        resolve();
      };
      child.once('error', (error) => finish(error.message));
      child.once('close', (code, signal) =>
        finish(
          this.stopped ??
            `Claude process ended before the turn completed (code ${String(code)}, signal ${String(signal)}).`,
        ),
      );
    });
    return this;
  }

  send(input: ResidentTurnInput) {
    return new Promise<ResidentTurnOutcome>((resolve, reject) => {
      if (this.stopped) return reject(new Error(this.stopped));
      this.queue.push({
        ...input,
        resolve,
        reject,
        finalOutput: '',
        usage: null,
        settled: false,
      });
      this.pump();
    });
  }

  private pump() {
    if (this.active || this.queue.length === 0 || !this.child || this.stopped)
      return;
    const turn = this.queue.shift()!;
    this.active = turn;
    this.child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: turn.prompt },
        parent_tool_use_id: null,
      })}\n`,
    );
  }

  private consume(line: string) {
    this.recordProcess(line);
    const event = parseClaudeEvent(line);
    if (!event) return;
    const turn = this.active;
    publishActivity(event, (activity) => turn?.onActivity?.(activity.summary));
    this.recordUsage(line);
    if (event.type !== 'result' || !('subtype' in event)) return;
    const usage = normalizeClaudeUsage(event.usage);
    if (!turn) return;
    turn.usage = usage;
    turn.onTurnUsage?.(usage);
    if (event.is_error || event.subtype !== 'success')
      turn.error =
        typeof event.result === 'string' && event.result
          ? event.result
          : `Claude ended the turn with ${event.subtype}.`;
    else if (typeof event.result === 'string') turn.finalOutput = event.result;
    this.active = undefined;
    this.flushUsage();
    this.settle(turn, {
      finalOutput: turn.finalOutput,
      usage: turn.usage,
      error: turn.error,
    });
    this.pump();
  }

  private recordProcess(line: string) {
    if (this.cliVersion) return;
    let value: {
      type?: string;
      subtype?: string;
      claude_code_version?: string;
    };
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (value.type !== 'system' || value.subtype !== 'init') return;
    this.cliVersion = value.claude_code_version ?? 'unknown';
    this.readySink?.(this.identity);
  }

  private flushUsage() {
    for (const key of this.unflushed) {
      const usage = this.requestUsage.get(key);
      if (usage) this.usageSink?.(usage, this.identity);
    }
    this.unflushed.clear();
  }

  private recordUsage(line: string) {
    let value: {
      type?: string;
      requestId?: string;
      message?: { id?: string; usage?: Record<string, unknown> };
    };
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (value.type !== 'assistant') return;
    const usage = value.message?.usage;
    if (!usage) return;
    const key = `${value.requestId ?? ''}|${value.message?.id ?? ''}`;
    const number = (name: string) =>
      typeof usage[name] === 'number' ? (usage[name] as number) : 0;
    const previous = this.requestUsage.get(key);
    const next: ResidentRequestUsage = {
      requestKey: key,
      inputTokens: Math.max(previous?.inputTokens ?? 0, number('input_tokens')),
      cachedInputTokens: Math.max(
        previous?.cachedInputTokens ?? 0,
        number('cache_read_input_tokens'),
      ),
      cacheWriteInputTokens: Math.max(
        previous?.cacheWriteInputTokens ?? 0,
        number('cache_creation_input_tokens'),
      ),
      outputTokens: Math.max(
        previous?.outputTokens ?? 0,
        number('output_tokens'),
      ),
    };
    this.requestUsage.set(key, next);
    this.unflushed.add(key);
  }

  private settle(turn: QueuedTurn, outcome: ResidentTurnOutcome) {
    if (turn.settled) return;
    turn.settled = true;
    turn.resolve(outcome);
  }

  private settleAll(reason: string) {
    this.stopped ??= reason;
    const detail = this.stderr.trim();
    const error = new Error(detail ? `${reason} ${detail}` : reason);
    const pending = [
      ...(this.active ? [this.active] : []),
      ...this.queue.splice(0),
    ];
    this.active = undefined;
    for (const turn of pending) {
      if (turn.settled) continue;
      turn.settled = true;
      turn.reject(error);
    }
  }

  kill() {
    this.stopped ??= 'The Praxis host process is shutting down.';
    terminate(this.child);
  }

  async dispose(reason = 'Claude session was closed by the Host.') {
    if (!this.child) {
      this.settleAll(reason);
      return;
    }
    this.stopped ??= reason;
    this.settleAll(reason);
    terminate(this.child);
    await this.exited;
    this.child = undefined;
  }
}

export function terminate(child: ChildProcessWithoutNullStreams | undefined) {
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
