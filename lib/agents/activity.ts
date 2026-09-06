export type LocalAgentJobActivity = {
  jobId: string;
  label: string;
  command: string;
  status: 'running' | 'completed' | 'failed' | 'canceled';
  exitCode: number | null;
  logRef: string;
};
export type LocalAgentActivity = {
  kind: 'message' | 'tool' | 'result';
  phase?: 'started' | 'completed';
  summary: string;
  job?: LocalAgentJobActivity;
};
export function redactRecord(text: string) {
  return text
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,})\b/g,
      '[redacted]',
    )
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(
      /(--(?:api[-_]key|access[-_]token|refresh[-_]token|token|password|secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1[redacted]',
    )
    .replace(
      /((?:password|token|api[_-]?key|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    );
}
export function redactActivity(text: string) {
  return redactRecord(text).slice(0, 600);
}
export function readLocalAgentActivity(
  value: unknown,
): LocalAgentActivity | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (
    (event.type === 'item.started' || event.type === 'item.completed') &&
    event.item &&
    typeof event.item === 'object'
  ) {
    const item = event.item as Record<string, unknown>;
    if (item.type === 'reasoning') return null;
    if (item.type === 'agent_message' && typeof item.text === 'string')
      return {
        kind: 'message',
        summary: item.text.trim().startsWith('{')
          ? 'Agent report received.'
          : redactActivity(item.text),
      };
    if (item.type === 'command_execution')
      return {
        kind: 'tool',
        phase: event.type === 'item.started' ? 'started' : 'completed',
        summary: redactActivity(
          `${event.type === 'item.started' ? 'Running' : 'Finished'}: ${typeof item.command === 'string' ? item.command : 'shell command'}${typeof item.exit_code === 'number' ? ` (exit ${item.exit_code})` : ''}`,
        ),
      };
    if (item.type === 'file_change')
      return { kind: 'tool', summary: 'Workspace files changed.' };
    if (item.type === 'mcp_tool_call')
      return {
        kind: 'tool',
        phase: event.type === 'item.started' ? 'started' : 'completed',
        summary: redactActivity(
          `${event.type === 'item.started' ? 'Running' : 'Finished'} tool: ${typeof item.tool === 'string' ? item.tool : 'MCP'}`,
        ),
      };
  }
  if (
    event.type === 'assistant' &&
    event.message &&
    typeof event.message === 'object'
  ) {
    const content = (event.message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const item = content.find(
        (item) =>
          item &&
          typeof item === 'object' &&
          (item.type === 'text' || item.type === 'tool_use'),
      );
      if (item?.type === 'text' && typeof item.text === 'string')
        return {
          kind: 'message',
          summary: item.text.trim().startsWith('{')
            ? 'Agent report received.'
            : redactActivity(item.text),
        };
      if (item?.type === 'tool_use') {
        const input =
          item.input && typeof item.input === 'object'
            ? (item.input as Record<string, unknown>)
            : {};
        const detail =
          item.name === 'Bash' && typeof input.command === 'string'
            ? input.command.trim().split('\n')[0]
            : typeof input.file_path === 'string'
              ? input.file_path
              : typeof input.path === 'string'
                ? input.path
                : '';
        return {
          kind: 'tool',
          phase: 'started',
          summary: redactActivity(
            `Running tool: ${String(item.name)}${detail ? ` — ${detail}` : ''}`,
          ),
        };
      }
    }
  }
  if (
    event.type === 'turn.failed' ||
    event.type === 'error' ||
    (event.type === 'result' && event.is_error === true)
  )
    return { kind: 'result', summary: 'Agent reported an execution error.' };
  if (event.type === 'turn.completed' || event.type === 'result')
    return { kind: 'result', summary: 'Agent call completed.' };
  return null;
}
export function publishActivity(
  value: unknown,
  listener?: (activity: LocalAgentActivity) => void,
) {
  const event = value as {
    type?: unknown;
    message?: { content?: unknown };
  } | null;
  if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const item of event.message.content)
      publishActivity(
        {
          ...event,
          message: { ...event.message, content: item ? [item] : [] },
          type: 'assistant-block',
        },
        listener,
      );
    return;
  }
  const normalized =
    event?.type === 'assistant-block' ? { ...event, type: 'assistant' } : value;
  const activity = readLocalAgentActivity(normalized);
  if (activity && listener) {
    try {
      listener(activity);
    } catch {}
  }
}
