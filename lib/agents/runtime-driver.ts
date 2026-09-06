import type { AgentProfile } from './profile.ts';
import type { LocalAgentUsage } from './transport.ts';

export type AgentRuntimeProvider = 'codex' | 'claude' | 'deepseek';
export type AgentRuntimeCapabilities = {
  persistentThreads: boolean;
  pushToolResults: boolean;
  turnResume: boolean;
  turnInterrupt: boolean;
};
export type AgentRuntimeThread = {
  instructions?: string;
  hostJobs?: boolean;
  provider: AgentRuntimeProvider;
  threadId: string;
  profile: AgentProfile;
  workingDirectory: string;
  access: 'read-only' | 'workspace-write' | 'full-access';
};
export type HostToolContinuation = { prompt: string } | { finalOutput: string };
export type HostToolSuspension = {
  suspend: true;
  acknowledgement: string;
  continuation: Promise<HostToolContinuation>;
};
export type HostTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (arguments_: Record<string, unknown>) => Promise<unknown>;
};
export function isHostToolSuspension(
  value: unknown,
): value is HostToolSuspension {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as HostToolSuspension).suspend === true &&
    typeof (value as HostToolSuspension).acknowledgement === 'string' &&
    (value as HostToolSuspension).continuation instanceof Promise
  );
}
export type AgentRuntimeEvent =
  | { type: 'turn-started'; threadId: string; turnId: string; at: string }
  | {
      type: 'activity';
      threadId: string;
      turnId: string;
      summary: string;
      at: string;
    }
  | {
      type: 'job-started';
      threadId: string;
      turnId: string;
      jobId: string;
      label: string;
      at: string;
    }
  | {
      type: 'job-completed';
      threadId: string;
      turnId: string;
      jobId: string;
      exitCode: number | null;
      at: string;
    }
  | {
      type: 'tool-suspended';
      threadId: string;
      turnId: string;
      tool: string;
      at: string;
    }
  | {
      type: 'tool-resumed';
      threadId: string;
      turnId: string;
      tool: string;
      at: string;
    }
  | {
      type: 'turn-completed';
      threadId: string;
      turnId: string;
      usage: LocalAgentUsage | null;
      at: string;
    };
export type AgentRuntimeTurnResult = {
  threadId: string;
  turnId: string;
  finalOutput: string;
  usage: LocalAgentUsage | null;
};
export type AgentRuntimeTurn = {
  completion: Promise<AgentRuntimeTurnResult>;
  interrupt: () => void;
};
export type AgentRuntimeThreadInput = {
  advertiseHostJobs?: boolean;
  profile: AgentProfile;
  workingDirectory: string;
  access: 'read-only' | 'workspace-write' | 'full-access';
  instructions?: string;
  hostJobs?: boolean;
};
export type AgentRuntimeTurnInput = {
  prompt: string;
  onEvent?: (event: AgentRuntimeEvent) => void;
};
export interface AgentSessionDriver {
  readonly provider: AgentRuntimeProvider;
  readonly capabilities: AgentRuntimeCapabilities;
  startThread(input: AgentRuntimeThreadInput): Promise<AgentRuntimeThread>;
  resumeThread(thread: AgentRuntimeThread): Promise<AgentRuntimeThread>;
  startTurn(
    thread: AgentRuntimeThread,
    input: AgentRuntimeTurnInput,
  ): AgentRuntimeTurn;
  close(): Promise<void>;
  dispose?(reason?: string): Promise<void>;
}
