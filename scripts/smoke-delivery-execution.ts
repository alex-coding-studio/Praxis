import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createDeliveryRecord,
  updateDeliveryRecord,
  readDeliveryRecord,
} from '../lib/modules/delivery/storage.ts';
import {
  startDeliveryRun,
  waitForDeliveryRun,
  cancelDeliveryRun,
  type DeliveryDriverFactory,
} from '../lib/modules/delivery/runtime.ts';
import { deliveryGit } from '../lib/modules/delivery/workspace.ts';
import { CodexAppServerDriver } from '../lib/agents/codex/app-server-driver.ts';
import { HostJobBroker } from '../lib/agents/host-job-broker.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

const parent = await realpath(
  await mkdtemp(path.join(os.tmpdir(), 'praxis-execution-smoke-')),
);
const rootPath = path.join(parent, 'project');
const planningPath = path.join(rootPath, '.praxis');
await mkdir(planningPath, { recursive: true });
await writeFile(
  path.join(rootPath, 'package.json'),
  JSON.stringify({
    name: 'delivery-smoke',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }),
);
await writeFile(path.join(rootPath, '.gitignore'), '.praxis/\n');
await deliveryGit(rootPath, 'init', '--initial-branch=main');
await deliveryGit(rootPath, 'config', 'user.name', 'Delivery Fixture');
await deliveryGit(
  rootPath,
  'config',
  'user.email',
  'delivery-fixture@example.test',
);
await deliveryGit(rootPath, 'add', 'package.json', '.gitignore');
await deliveryGit(rootPath, 'commit', '-m', 'Local smoke baseline');
const project: RegisteredProject = {
  id: randomUUID(),
  name: 'Local execution smoke',
  rootPath,
  planningPath,
  codePath: rootPath,
  kind: 'standalone',
  description: 'Local-only provider integration fixture',
  createdAt: new Date().toISOString(),
};
const uid = randomUUID();
await createDeliveryRecord(
  project,
  {
    sourceUid: uid,
    sourceId: 'NODE-12345678',
    sourceKind: 'mvp',
    sourceModule: 'whats-next',
    title: 'Greeting function',
    summary: 'Implement greet(name) in greet.js with Node unit tests.',
    dependsOn: [],
    outputPaths: [],
    sourceFingerprint: 'smoke',
  },
  {
    orchestrator: { agent: 'codex', model: 'gpt-6-astra', effort: 'low' },
    workers: [{ agent: 'codex', model: 'gpt-5.6-luna', effort: 'high' }],
    reviewers: [{ agent: 'codex', model: 'gpt-5.6-luna', effort: 'high' }],
  },
);
await updateDeliveryRecord(project, uid, (record) => {
  record.brief = {
    revision: 1,
    outcome:
      'Export greet(name) from greet.js: return Hello, <name> for a nonempty name and Hello, stranger for an empty name.',
    included: ['Function and Node unit tests'],
    excluded: ['Remote GitHub operations', 'UI'],
    criteria: [
      {
        id: 'AC1',
        description: 'Both greeting cases pass npm test.',
        verification: 'Node unit tests at the committed HEAD',
      },
    ],
    openDecisions: [],
    confirmedAt: new Date().toISOString(),
  };
});
const factory: DeliveryDriverFactory = (_project, _profile, tools) =>
  new CodexAppServerDriver({
    brokerFactory: (thread) =>
      new HostJobBroker(
        thread.workingDirectory,
        path.join(planningPath, 'delivery/jobs'),
      ),
    hostTools: tools.filter(
      (tool) =>
        !['publish_delivery', 'submit_existing_delivery'].includes(tool.name),
    ),
  });
const timer = setTimeout(() => void cancelDeliveryRun(project, uid), 240000);
try {
  await startDeliveryRun(
    project,
    uid,
    'execution',
    'This is a local-only integration smoke. Delegate implementation to a Luna Worker, have it implement greet.js and Node unit tests and commit locally. After it passes npm test, record AC1 against the actual commit and request an independent Luna Reviewer. Do not run GitHub commands, create remotes, or attempt publication. Return the local result after review; this fixture deliberately ends before publication.',
    factory,
  );
  await waitForDeliveryRun(project, uid);
  const record = (await readDeliveryRecord(project, uid))!;
  if (record.runs.at(-1)?.status !== 'completed' || !record.workspace)
    throw new Error(record.runs.at(-1)?.error ?? 'Execution did not complete.');
  const source = await readFile(
    path.join(record.workspace.path, 'greet.js'),
    'utf8',
  );
  if (!source.includes('greet')) throw new Error('Worker output is missing.');
  if (
    !record.agents.some(
      (agent) =>
        agent.role === 'worker' && agent.profile.model === 'gpt-5.6-luna',
    )
  )
    throw new Error('No lower-cost Worker was used.');
  if (!record.review?.approved)
    throw new Error(
      `Independent review did not approve: ${record.response?.detail}`,
    );
  process.stdout.write(
    `${JSON.stringify({ status: record.runs.at(-1)?.status, agents: record.agents.map(({ role, profile, sessionId }) => ({ role, profile, sessionId })), checks: record.checks, review: record.review, publication: record.publication })}\n`,
  );
} finally {
  clearTimeout(timer);
  await cancelDeliveryRun(project, uid);
  const record = await readDeliveryRecord(project, uid);
  if (record?.workspace)
    await deliveryGit(
      rootPath,
      'worktree',
      'remove',
      '--force',
      record.workspace.path,
    );
  await rm(parent, { recursive: true, force: true });
}
