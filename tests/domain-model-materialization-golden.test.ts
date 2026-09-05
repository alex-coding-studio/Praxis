import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readDomainModelRun,
  startDomainModelRun,
} from '../lib/modules/domain-modeling/runs.ts';
import { readDomainModel } from '../lib/modules/domain-modeling/model.ts';
import type { DomainModelRequest } from '../lib/modules/domain-modeling/harness.ts';
import type { ProposedDomainModel } from '../lib/modules/domain-modeling/model.ts';
import { captureDomainModelState } from './helpers/graph-materialization-golden.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';
import type { startLocalAgentRun } from '../lib/agents/transport.ts';

const GOLDENS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/materialization/domain-model',
);
const UPDATE = process.env.PRAXIS_UPDATE_GOLDENS === '1';

const profile = {
  agent: 'codex' as const,
  model: 'gpt-5.6-sol',
  effort: 'high' as const,
};

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'domain-golden-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project: RegisteredProject = {
    id: 'domain-golden',
    kind: 'standalone',
    name: 'Domain golden fixture',
    description: '',
    rootPath,
    codePath: null,
    planningPath: path.join(rootPath, '.praxis'),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await mkdir(project.planningPath);
  return project;
}

function initialProposal(): ProposedDomainModel {
  return {
    entities: [
      {
        id: 'NEW_ENTITY_ITEM',
        name: 'Item',
        meaning: 'A physical thing the user wants to locate.',
        provenance: 'explicit',
        fields: [
          {
            id: 'NEW_FIELD_TITLE',
            name: 'title',
            meaning: 'The name shown to the user.',
            valueType: 'text',
            required: true,
            multiple: false,
            display: 'primary',
            provenance: 'explicit',
          },
        ],
      },
      {
        id: 'NEW_ENTITY_CONTAINER',
        name: 'Container',
        meaning: 'An Item that can manage child Items.',
        provenance: 'explicit',
        fields: [],
      },
    ],
    relationships: [
      {
        id: 'NEW_RELATIONSHIP_CONTAINS',
        sourceEntityId: 'NEW_ENTITY_CONTAINER',
        targetEntityId: 'NEW_ENTITY_ITEM',
        label: 'contains',
        meaning: 'A Container manages zero or more Items.',
        semanticRole: 'containment',
        direction: 'directed',
        sourceCardinality: '1',
        targetCardinality: '0..*',
        provenance: 'explicit',
      },
    ],
    constraints: [
      {
        id: 'NEW_CONSTRAINT_PARENT',
        target: { kind: 'model', id: null },
        text: 'An Item has at most one parent Container.',
        provenance: 'inferred',
      },
    ],
  };
}

function respondWith(
  outputs: Array<(request: DomainModelRequest) => Record<string, unknown>>,
) {
  const calls: Array<Parameters<typeof startLocalAgentRun>[1]> = [];
  const transport: typeof startLocalAgentRun = (_agent, options) => {
    calls.push(options);
    const request = JSON.parse(
      options.prompt.split('\nREQUEST:\n')[1] ?? '{}',
    ) as DomainModelRequest;
    const build = outputs[calls.length - 1] ?? outputs.at(-1)!;
    return {
      completion: Promise.resolve({
        agentSessionId: `fixture-session-${calls.length}`,
        usage: null,
        finalOutput: JSON.stringify(build(request)),
      }),
      cancel: () => {},
    };
  };
  return { calls, transport };
}

function envelope(request: DomainModelRequest, body: Record<string, unknown>) {
  return {
    harnessVersion: 2,
    requestId: request.requestId,
    baseVersion: request.baseVersion,
    inputFingerprint: request.inputFingerprint,
    ...body,
  };
}

async function settled(project: RegisteredProject, runId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const run = await readDomainModelRun(project, runId);
    if (run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The fixture Run did not settle.');
}

async function assertGolden(name: string, captured: Record<string, unknown>) {
  const file = path.join(GOLDENS, `${name}.json`);
  const serialized = `${JSON.stringify(captured, null, 2)}\n`;
  if (UPDATE) {
    await mkdir(GOLDENS, { recursive: true });
    await writeFile(file, serialized);
    return;
  }
  const expected = await readFile(file, 'utf8').catch(() => null);
  assert.ok(
    expected !== null,
    `missing golden ${name}; regenerate with PRAXIS_UPDATE_GOLDENS=1`,
  );
  assert.deepEqual(captured, JSON.parse(expected));
}

async function createModel(project: RegisteredProject) {
  const { transport } = respondWith([
    (request) =>
      envelope(request, {
        outcome: 'applied',
        summary: 'Created Item and Container.',
        model: initialProposal(),
      }),
  ]);
  const run = await startDomainModelRun(
    project,
    { instruction: 'Create the model.', selectedIds: [], profile },
    transport,
  );
  const terminal = await settled(project, run.id);
  assert.equal(terminal.status, 'succeeded', terminal.error ?? undefined);
  return readDomainModel(project);
}

void test('a created model materializes stable identities and a commit receipt', async (t) => {
  const project = await fixture(t);
  const model = await createModel(project);
  assert.equal(model.entities.length, 2);
  assert.equal(model.stateVersion, 1);
  await assertGolden('create', await captureDomainModelState(project));
});

void test('an incremental patch keeps entity identity and advances the state version', async (t) => {
  const project = await fixture(t);
  const created = await createModel(project);
  const item = created.entities[0]!;
  const { transport } = respondWith([
    (request) =>
      envelope(request, {
        outcome: 'applied',
        summary: 'Sharpened the Item meaning.',
        patch: {
          upsertEntities: [
            {
              ...structuredClone(item),
              meaning: 'A physical thing with a durable identity.',
            },
          ],
          removeEntityIds: [],
          removeFieldIds: [],
          upsertRelationships: [],
          removeRelationshipIds: [],
          upsertConstraints: [],
          removeConstraintIds: [],
        },
      }),
  ]);
  const run = await startDomainModelRun(
    project,
    {
      instruction: 'Sharpen the Item meaning.',
      selectedIds: [item.id],
      profile,
    },
    transport,
  );
  const terminal = await settled(project, run.id);
  assert.equal(terminal.status, 'succeeded', terminal.error ?? undefined);
  const changed = await readDomainModel(project);
  assert.equal(changed.entities[0]!.id, item.id);
  assert.equal(
    changed.entities[0]!.meaning,
    'A physical thing with a durable identity.',
  );
  assert.equal(changed.stateVersion, created.stateVersion + 1);
  await assertGolden('patch', await captureDomainModelState(project));
});

void test('a no-change result leaves the model untouched', async (t) => {
  const project = await fixture(t);
  const created = await createModel(project);
  const { transport } = respondWith([
    (request) =>
      envelope(request, {
        outcome: 'no-change',
        summary: 'The model already contains this meaning.',
        reason: 'No model change is required.',
      }),
  ]);
  const run = await startDomainModelRun(
    project,
    { instruction: 'Keep the current meaning.', selectedIds: [], profile },
    transport,
  );
  const terminal = await settled(project, run.id);
  assert.equal(terminal.status, 'succeeded', terminal.error ?? undefined);
  const after = await readDomainModel(project);
  assert.equal(after.stateVersion, created.stateVersion);
  await assertGolden('no-change', await captureDomainModelState(project));
});
