import type { AgentRuntimeEvent } from '../../agents/runtime-driver.ts';
import type {
  LogActor,
  RunLogInput,
} from '../../execution-observability/types.ts';

export function agentRunLogEntry(
  actor: LogActor,
  event: AgentRuntimeEvent,
): RunLogInput | undefined {
  if (event.type === 'activity')
    return {
      level: 'INFO',
      actor,
      phase: 'EXECUTE',
      event: 'agent.activity',
      message: event.summary,
    };
  if (event.type === 'session-process')
    return {
      level: 'INFO',
      actor,
      phase: 'EXECUTE',
      event: 'agent.session-process',
      message: [
        `session=${event.threadId}`,
        `pid=${String(event.pid ?? 'unknown')}`,
        `launch=${event.launch}`,
        `cli=${event.cliVersion ?? 'unknown'}`,
        `model=${event.model ?? 'default'}`,
        `effort=${event.effort ?? 'default'}`,
        `resumed=${event.resumed}`,
        `instructions=${event.instructionsHash}`,
        `tools=${event.toolsHash}`,
      ].join(' '),
    };
  if (event.type === 'request-usage')
    return {
      level: 'INFO',
      actor,
      phase: 'EXECUTE',
      event: 'agent.request-usage',
      message: [
        `session=${event.threadId}`,
        `turn=${event.turnId}`,
        `request=${event.requestKey}`,
        `pid=${String(event.pid ?? 'unknown')}`,
        `launch=${event.launch}`,
        `input=${event.inputTokens}`,
        `cache-read=${event.cachedInputTokens}`,
        `cache-write=${event.cacheWriteInputTokens}`,
        `output=${event.outputTokens}`,
      ].join(' '),
    };
  return undefined;
}
