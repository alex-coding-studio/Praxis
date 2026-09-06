import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createDeliveryRecord,
  readDeliveryRecord,
} from '../lib/modules/delivery/storage.ts';
import {
  startDeliveryRun,
  waitForDeliveryRun,
  cancelDeliveryRun,
} from '../lib/modules/delivery/runtime.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

const rootPath = await mkdtemp(
  path.join(os.tmpdir(), 'praxis-delivery-smoke-'),
);
const planningPath = path.join(rootPath, '.praxis');
await mkdir(planningPath);
await writeFile(
  path.join(rootPath, 'README.md'),
  'Isolated smoke fixture. No implementation is requested.\n',
);
await writeFile(
  path.join(planningPath, 'source.md'),
  'Outcome: later implement a pure TypeScript greet(name) function returning Hello, followed by the name. This run only prepares the delivery brief. No dependencies or product decisions are missing.\n',
);
const project: RegisteredProject = {
  id: randomUUID(),
  name: 'Delivery smoke',
  kind: 'standalone',
  rootPath,
  planningPath,
  codePath: rootPath,
  description: 'Isolated provider verification',
  createdAt: new Date().toISOString(),
};
const uid = randomUUID();
await createDeliveryRecord(
  project,
  {
    sourceKind: 'mvp',
    sourceModule: 'whats-next',
    sourceId: 'NODE-12345678',
    sourceUid: uid,
    title: 'Greeting function',
    summary: 'Prepare a bounded greeting-function delivery brief.',
    dependsOn: [],
    outputPaths: ['source.md'],
    sourceFingerprint: 'smoke',
  },
  {
    orchestrator: {
      agent: 'codex',
      model: process.argv[2] ?? 'gpt-6-astra',
      effort: 'low',
    },
    workers: [{ agent: 'codex', model: 'gpt-5.6-luna', effort: 'high' }],
    reviewers: [{ agent: 'codex', model: 'gpt-5.6-luna', effort: 'high' }],
  },
);
const timeout = setTimeout(() => void cancelDeliveryRun(project, uid), 180000);
try {
  for (const instruction of [
    'Prepare and save a concise delivery brief with one technical criterion. No implementation or remote operations. No open product decisions.',
    'Keep the outcome and criterion, but mention that an empty name returns Hello, stranger. Save the revised brief. This is still briefing only.',
  ]) {
    await startDeliveryRun(project, uid, 'brief', instruction);
    await waitForDeliveryRun(project, uid);
    const record = (await readDeliveryRecord(project, uid))!;
    if (!record.brief || record.runs.at(-1)?.status !== 'completed')
      throw new Error(
        record.runs.at(-1)?.error ?? 'No delivery brief was saved.',
      );
    process.stdout.write(
      `${JSON.stringify({ sessionId: record.orchestratorSessionId, briefRevision: record.brief.revision, criteria: record.brief.criteria.length, outcome: record.brief.outcome, status: record.status })}\n`,
    );
  }
  if (
    (await readFile(path.join(rootPath, 'README.md'), 'utf8')) !==
    'Isolated smoke fixture. No implementation is requested.\n'
  )
    throw new Error('Briefing changed product code.');
} finally {
  clearTimeout(timeout);
  await cancelDeliveryRun(project, uid);
  await rm(rootPath, { recursive: true, force: true });
}
