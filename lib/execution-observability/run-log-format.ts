import {
  LOG_ACTORS,
  LOG_LEVELS,
  LOG_PHASES,
  type LogActor,
  type LogLevel,
  type LogPhase,
  type RunLogEntry,
} from './types.ts';

export const LOG_EVENT_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
export const LOG_MESSAGE_LIMIT = 2_000;
const CONTINUATION = '    ';
const SEPARATOR = ' — ';

const linePattern = new RegExp(
  `^(\\d{6}) (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z) (${LOG_LEVELS.join('|')}) (${LOG_ACTORS.join('|')}) (${LOG_PHASES.join('|')}) (\\S+)${SEPARATOR}([\\s\\S]*)$`,
);

function isControlCharacter(code: number) {
  return (code < 32 && code !== 9 && code !== 10) || code === 127;
}

export function sanitizeLogMessage(text: string) {
  const normalized = text.replace(/\r\n?/g, '\n');
  let cleaned = '';
  for (let index = 0; index < normalized.length; index += 1) {
    if (!isControlCharacter(normalized.charCodeAt(index)))
      cleaned += normalized[index];
  }
  cleaned = cleaned.trim();
  return cleaned.length > LOG_MESSAGE_LIMIT
    ? `${cleaned.slice(0, LOG_MESSAGE_LIMIT - 1)}…`
    : cleaned;
}

export function formatRunLogLine(entry: RunLogEntry) {
  const message = entry.message.split('\n').join(`\n${CONTINUATION}`);
  return `${String(entry.sequence).padStart(6, '0')} ${entry.at} ${entry.level} ${entry.actor} ${entry.phase} ${entry.event}${SEPARATOR}${message}`;
}

export function parseRunLogText(text: string): RunLogEntry[] {
  const entries: RunLogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (/^\s/.test(line)) {
      const previous = entries.at(-1);
      if (previous) previous.message += `\n${line.replace(/^\s{1,4}/, '')}`;
      continue;
    }
    const match = linePattern.exec(line);
    if (!match) continue;
    entries.push({
      sequence: Number(match[1]),
      at: match[2],
      level: match[3] as LogLevel,
      actor: match[4] as LogActor,
      phase: match[5] as LogPhase,
      event: match[6],
      message: match[7],
    });
  }
  return entries;
}

export function renderRunLogText(entries: RunLogEntry[]) {
  return entries.map((entry) => `${formatRunLogLine(entry)}\n`).join('');
}

const noise = new Set(['Agent report received.', 'Agent call completed.']);

const lifecycle =
  /^(?:run|phase|response|cancel|process|operation|materialization)\./;

export function isReadableActivity(entry: RunLogEntry) {
  if (entry.event === 'job.progress') return false;
  if (entry.actor === 'HOST' && lifecycle.test(entry.event)) return false;
  if (noise.has(entry.message)) return false;
  return !/^(?:Running|Finished):\s/.test(entry.message);
}

export function readableActivity(entries: RunLogEntry[], count = 3) {
  const readable = entries.filter(isReadableActivity);
  return readable.slice(Math.max(0, readable.length - count));
}

export function latestReadableActivity(entries: RunLogEntry[]) {
  return readableActivity(entries, 1).at(0) ?? null;
}
