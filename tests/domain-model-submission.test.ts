import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareDomainModelBasis } from '../lib/modules/domain-modeling/basis.ts';
import { publishDomainModelResult } from '../lib/modules/domain-modeling/publish.ts';
import { readDomainModel } from '../lib/modules/domain-modeling/model.ts';
import type { DomainModelResult } from '../lib/modules/domain-modeling/contract.ts';
import type { ProposedDomainModel } from '../lib/modules/domain-modeling/model.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

const RUN_ID = 'RUN-11111111-1111-4111-8111-111111111111';

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'dm-submit-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project: RegisteredProject = {
    id: 'domain-submission',
    kind: 'standalone',
    name: 'Domain submission fixture',
    description: '',
    rootPath,
    codePath: null,
    planningPath: path.join(rootPath, '.praxis'),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await mkdir(project.planningPath);
  return project;
}

function proposal(): ProposedDomainModel {
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
    ],
    relationships: [],
    constraints: [],
  };
}

void test('a direct producer applies a Domain Model without a Harness result', async (t) => {
  const project = await fixture(t);
  const basis = prepareDomainModelBasis(project, {
    model: await readDomainModel(project),
    selectedIds: [],
  });
  const result: DomainModelResult = {
    outcome: 'model-change',
    summary: 'Created the Item entity.',
    change: { kind: 'model', model: proposal() },
  };
  const published = await publishDomainModelResult(project, basis, result, {
    runId: RUN_ID,
    userInputPath: null,
  });

  assert.equal(published.outcome, 'model-change');
  assert.ok(published.change);
  assert.equal(published.stateVersion, basis.stateVersion + 1);

  const stored = await readDomainModel(project);
  assert.equal(stored.stateVersion, published.stateVersion);
  assert.equal(stored.entities.length, 1);
  assert.equal(stored.entities[0]!.name, 'Item');
  assert.match(stored.entities[0]!.id, /^ENTITY-/);
  assert.equal(stored.lastRunId, RUN_ID);
});

void test('a direct submission that changes nothing reports no change', async (t) => {
  const project = await fixture(t);
  const first = prepareDomainModelBasis(project, {
    model: await readDomainModel(project),
    selectedIds: [],
  });
  await publishDomainModelResult(
    project,
    first,
    {
      outcome: 'model-change',
      summary: 'Created the Item entity.',
      change: { kind: 'model', model: proposal() },
    },
    { runId: RUN_ID, userInputPath: null },
  );
  const created = await readDomainModel(project);

  const second = prepareDomainModelBasis(project, {
    model: created,
    selectedIds: [],
  });
  const republished = await publishDomainModelResult(
    project,
    second,
    {
      outcome: 'model-change',
      summary: 'Restated the same meaning.',
      change: {
        kind: 'patch',
        patch: {
          upsertEntities: [structuredClone(created.entities[0]!)],
          removeEntityIds: [],
          removeFieldIds: [],
          upsertRelationships: [],
          removeRelationshipIds: [],
          upsertConstraints: [],
          removeConstraintIds: [],
        },
      },
    },
    { runId: 'RUN-22222222-2222-4222-8222-222222222222', userInputPath: null },
  );

  assert.equal(republished.outcome, 'no-change');
  assert.equal(republished.change, null);
  assert.equal(republished.model, null);
  assert.equal(
    (await readDomainModel(project)).stateVersion,
    created.stateVersion,
  );
});

void test('a direct clarification changes no state', async (t) => {
  const project = await fixture(t);
  const basis = prepareDomainModelBasis(project, {
    model: await readDomainModel(project),
    selectedIds: [],
  });
  const published = await publishDomainModelResult(
    project,
    basis,
    {
      outcome: 'clarification',
      summary: 'One decision is missing.',
      question: 'Should a Container be an Item?',
    },
    { runId: RUN_ID, userInputPath: null },
  );
  assert.equal(published.outcome, 'clarification');
  assert.equal(published.model, null);
  assert.equal(
    (await readDomainModel(project)).stateVersion,
    basis.stateVersion,
  );
});
