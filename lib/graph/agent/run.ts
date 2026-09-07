import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import {
  redactActivity,
  redactRecord,
  type LocalAgentActivity,
} from '../../agents/activity.ts';
import {
  runActivityJsonl,
  writeRunEvidence,
  writeRunEvidenceText,
  type RunActivityEntry,
} from '../run-evidence.ts';

export type AgentGraphActivity = RunActivityEntry;

export { writeRunEvidence as writeAgentGraphRunEvidence };

export type AgentGraphActivityRecorder = {
  onActivity: (event: LocalAgentActivity) => void;
  flush: () => Promise<void>;
};

export function agentGraphErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return redactRecord(message).slice(0, 2_000) || fallback;
}

export function initialAgentGraphActivity(
  summary: string,
  at = new Date().toISOString(),
): AgentGraphActivity[] {
  return [{ at, summary: redactActivity(summary) }];
}

export async function initializeAgentGraphActivity(
  runPath: string,
  activity: AgentGraphActivity[],
) {
  await writeRunEvidenceText(
    path.join(runPath, 'activity.jsonl'),
    runActivityJsonl(activity),
  );
}

export function createAgentGraphActivityRecorder(
  runPath: string,
  activity: AgentGraphActivity[],
  onRecord?: (item: AgentGraphActivity) => void,
): AgentGraphActivityRecorder {
  let pending = Promise.resolve();
  return {
    onActivity(event) {
      const summary = redactActivity(event.summary);
      if (!summary) return;
      const item = { at: new Date().toISOString(), summary };
      activity.push(item);
      if (activity.length > 300) activity.splice(0, activity.length - 300);
      onRecord?.(item);
      pending = pending
        .then(() =>
          appendFile(
            path.join(runPath, 'activity.jsonl'),
            `${JSON.stringify(item)}\n`,
          ),
        )
        .catch(() => undefined);
    },
    async flush() {
      await pending;
    },
  };
}
