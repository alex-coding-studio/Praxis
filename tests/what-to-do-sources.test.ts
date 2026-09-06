import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RegisteredProject } from '../lib/project-registry.ts';
import {
  deleteTaskGraphNode,
  readTaskGraphNodesSnapshot,
  type TaskGraphNode,
} from '../lib/graph/task/model.ts';
import {
  listWhatToDoFeatureSources,
  selectWhatToDoFeatureSources,
} from '../lib/modules/delivery-planning/sources.ts';
import { whatToDoFeatureWorkspaceInputs } from '../lib/modules/delivery-planning/workspace-inputs.ts';

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'what-to-do-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const planningPath = path.join(rootPath, '.praxis');
  await mkdir(path.join(planningPath, 'whats-next/nodes'), {
    recursive: true,
  });
  const project: RegisteredProject = {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'repository',
    name: 'Fixture',
    description: '',
    rootPath,
    codePath: rootPath,
    planningPath,
    createdAt: '2026-09-02T00:00:00.000Z',
  };
  return { project, planningPath };
}

async function writeNode(
  planningPath: string,
  id: string,
  overrides: Partial<TaskGraphNode> = {},
) {
  const directory = path.join(planningPath, 'whats-next/nodes', id);
  await mkdir(directory, { recursive: true });
  const node: TaskGraphNode = {
    schemaVersion: 1,
    id,
    uid: `00000000-0000-4000-8000-${id.slice(5).padStart(12, '0')}`,
    relations: { derivedFrom: [], dependsOn: [] },
    role: 'node',
    type: 'feature',
    title: `Feature ${id}`,
    summary: 'Accepted Product Design.',
    status: 'accepted',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    resources: [{ kind: 'output', path: `whats-next/nodes/${id}/output.md` }],
    derivedFrom: [],
    dependsOn: [],
    typeTemplateRef: id,
    metadata: {},
    layer: 'product-design',
    artifactKind: 'feature',
    ...overrides,
  };
  await writeFile(
    path.join(directory, 'node.json'),
    `${JSON.stringify(node, null, 2)}\n`,
  );
  await writeFile(
    path.join(directory, 'output.md'),
    `# ${node.title}\n\n${node.summary}\n`,
  );
  return node;
}

void test('What to Do exposes only accepted Product Design Features', async (t) => {
  const { project, planningPath } = await fixture(t);
  const feature = await writeNode(planningPath, 'NODE-00000001');
  const discovery = await writeNode(planningPath, 'NODE-00000002', {
    layer: 'discovery',
  });
  await writeNode(planningPath, 'NODE-00000003', { status: 'candidate' });
  await writeNode(planningPath, 'NODE-00000004', {
    artifactKind: 'direction',
  });
  await writeNode(planningPath, 'NODE-00000001', {
    resources: [
      {
        kind: 'output',
        path: 'whats-next/nodes/NODE-00000002/output.md',
      },
      {
        kind: 'output',
        path: 'whats-next/nodes/NODE-00000001/output.md',
      },
    ],
  });

  const sources = await listWhatToDoFeatureSources(project);
  assert.deepEqual(
    sources.map((source) => source.uid),
    [feature.uid],
  );
  assert.equal(
    sources[0]?.outputPath,
    'whats-next/nodes/NODE-00000001/output.md',
  );
  assert.notEqual(sources[0]?.uid, discovery.uid);
  assert.match(sources[0]?.outputSha256 ?? '', /^[0-9a-f]{64}$/);
});

void test('What to Do freezes the selected Feature output as primary Context', async (t) => {
  const { project, planningPath } = await fixture(t);
  const feature = await writeNode(planningPath, 'NODE-00000001');

  const selected = await selectWhatToDoFeatureSources(project, [
    feature.uid!,
    feature.uid!,
  ]);
  assert.equal(selected.length, 1);
  const inputs = await whatToDoFeatureWorkspaceInputs(project, selected);
  assert.deepEqual(
    inputs.map(({ role, kind, logicalPath, nodeId }) => ({
      role,
      kind,
      logicalPath,
      nodeId,
    })),
    [
      {
        role: 'primary',
        kind: 'product-design-feature',
        logicalPath: 'whats-next/nodes/NODE-00000001/output.md',
        nodeId: 'NODE-00000001',
      },
    ],
  );
  assert.equal(
    inputs[0]?.content,
    await readFile(
      path.join(planningPath, 'whats-next/nodes/NODE-00000001/output.md'),
      'utf8',
    ),
  );

  await writeFile(
    path.join(planningPath, 'whats-next/nodes/NODE-00000001/output.md'),
    '# Changed after selection\n',
  );
  await assert.rejects(
    whatToDoFeatureWorkspaceInputs(project, selected),
    /changed.*Reload/,
  );
});

void test('What to Do rejects missing or stale Feature selections', async (t) => {
  const { project } = await fixture(t);
  await assert.rejects(
    selectWhatToDoFeatureSources(project, []),
    /Select at least one accepted Product Design Feature/,
  );
  await assert.rejects(
    selectWhatToDoFeatureSources(project, [
      '00000000-0000-4000-8000-000000000099',
    ]),
    /no longer available/,
  );
});

void test('Feature metadata and output come from the same frozen snapshot', async (t) => {
  const { project, planningPath } = await fixture(t);
  const feature = await writeNode(planningPath, 'NODE-00000001');
  const selected = await selectWhatToDoFeatureSources(project, [feature.uid!]);
  const nodeFile = path.join(
    planningPath,
    'whats-next/nodes/NODE-00000001/node.json',
  );
  const node = JSON.parse(await readFile(nodeFile, 'utf8'));
  node.title = 'Changed title';
  await writeFile(nodeFile, `${JSON.stringify(node, null, 2)}\n`);
  await assert.rejects(
    whatToDoFeatureWorkspaceInputs(project, selected),
    /changed.*Reload/,
  );
});

void test('a source snapshot serializes with supported graph deletion', async (t) => {
  const { project, planningPath } = await fixture(t);
  await writeNode(planningPath, 'NODE-00000001');
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const blocked = new Promise<void>((resolve) => (release = resolve));

  const snapshot = readTaskGraphNodesSnapshot(
    project,
    'whats-next',
    async (nodes) => {
      enter();
      await blocked;
      return nodes.map((node) => node.id);
    },
  );
  await entered;
  let deleted = false;
  const deletion = deleteTaskGraphNode(
    project,
    'NODE-00000001',
    'whats-next',
  ).then(() => {
    deleted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleted, false);
  release();
  assert.deepEqual(await snapshot, ['NODE-00000001']);
  await deletion;
  assert.equal(deleted, true);
});
