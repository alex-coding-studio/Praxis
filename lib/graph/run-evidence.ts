import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactRecord } from '../agents/activity.ts';

export type RunActivityEntry = {
  at: string;
  summary: string;
};

export async function writeRunEvidenceText(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  if ((await readFile(file, 'utf8').catch(() => '')) === normalized) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, normalized, { flag: 'wx' });
  await rename(temporary, file);
}

export function runActivityJsonl(activity: RunActivityEntry[]) {
  return activity.map((item) => JSON.stringify(item)).join('\n') + '\n';
}

export async function writeRunEvidence(
  runPath: string,
  input: {
    activity: RunActivityEntry[];
    agentOutput?: string | null;
    summary?: string | null;
    response?: string | null;
  },
) {
  await mkdir(runPath, { recursive: true });
  await writeRunEvidenceText(
    path.join(runPath, 'activity.jsonl'),
    runActivityJsonl(input.activity),
  );
  if (input.agentOutput)
    await writeRunEvidenceText(
      path.join(runPath, 'agent-output.txt'),
      `${redactRecord(input.agentOutput).slice(0, 1_500_000)}\n`,
    );
  if (input.summary)
    await writeRunEvidenceText(path.join(runPath, 'summary.md'), input.summary);
  if (input.response)
    await writeRunEvidenceText(
      path.join(runPath, 'response.md'),
      input.response,
    );
}
