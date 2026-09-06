import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareDomainModelBasis } from '../lib/modules/domain-modeling/basis.ts';
import { publishDomainModelResult } from '../lib/modules/domain-modeling/publish.ts';
import { readDomainModel } from '../lib/modules/domain-modeling/model.ts';
import {
  DOMAIN_MODEL_RESULT_CONTRACT,
  type DomainModelResult,
} from '../lib/modules/domain-modeling/contract.ts';
import { semanticResultHash } from '../lib/materialization/hash.ts';
import {
  rejectionReceipt,
  type MaterializationReceipt,
} from '../lib/materialization/receipt.ts';
import { PublicApiError } from '../lib/api-errors.ts';
import { moduleRunFailureKind } from '../lib/execution-observability/module-run.ts';
import type { ProposedDomainModel } from '../lib/modules/domain-modeling/model.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

const RUN_ID = 'RUN-11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = 'RUN-22222222-2222-4222-8222-222222222222';

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

void test('a direct publication records a Receipt bound to the canonical state', async (t) => {
  const project = await fixture(t);
  const basis = prepareDomainModelBasis(project, {
    model: await readDomainModel(project),
    selectedIds: [],
  });
  const result: DomainModelResult = {
    outcome: 'model-change',
    summary: 'Created Item.',
    change: { kind: 'model', model: proposal() },
  };
  const events: string[] = [];
  const published = await publishDomainModelResult(
    project,
    basis,
    result,
    { kind: 'direct', runId: RUN_ID, userInputPath: null },
    () => '2026-09-06T00:00:00.000Z',
    (entry) => {
      assert.equal(entry.actor, 'HOST');
      events.push(entry.event);
    },
  );

  assert.deepEqual(events, [
    'materialization.validated',
    'materialization.published',
  ]);
  const receipt = published.receipt;
  assert.deepEqual(receipt.contract, {
    id: DOMAIN_MODEL_RESULT_CONTRACT.id,
    version: DOMAIN_MODEL_RESULT_CONTRACT.version,
    hash: DOMAIN_MODEL_RESULT_CONTRACT.hash,
  });
  assert.deepEqual(receipt.producer, { kind: 'direct', runId: RUN_ID });
  assert.equal(receipt.semanticResultHash, semanticResultHash(result));
  assert.equal(receipt.outcome, 'canonical');
  assert.deepEqual(receipt.publication, {
    target: 'domain-state',
    at: '2026-09-06T00:00:00.000Z',
    revision: published.stateVersion,
  });
  assert.ok(receipt.affected.domainIds.length > 0);
  assert.deepEqual(
    [...receipt.affected.domainIds].sort(),
    [
      ...published.change!.added,
      ...published.change!.updated,
      ...published.change!.removed,
    ].sort(),
  );

  const semantic = JSON.parse(
    await readFile(
      path.join(
        project.planningPath,
        'domain-model',
        'runs',
        RUN_ID,
        'semantic-result.json',
      ),
      'utf8',
    ),
  ) as { semanticResultHash: string; result: DomainModelResult };
  assert.equal(semantic.semanticResultHash, receipt.semanticResultHash);
  assert.deepEqual(semantic.result, result);
});

void test('a clarification Receipt claims no canonical publication', async (t) => {
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
      summary: 'The request is ambiguous.',
      question: 'Which item did you mean?',
    },
    { kind: 'direct', runId: RUN_ID, userInputPath: null },
  );
  assert.equal(published.receipt.outcome, 'clarification');
  assert.equal(published.receipt.publication, null);
  assert.deepEqual(published.receipt.affected.domainIds, []);
});

void test('a stale Domain basis stays a 409 persistence conflict', async (t) => {
  const project = await fixture(t);
  const basis = prepareDomainModelBasis(project, {
    model: await readDomainModel(project),
    selectedIds: [],
  });
  const result: DomainModelResult = {
    outcome: 'model-change',
    summary: 'Created Item.',
    change: { kind: 'model', model: proposal() },
  };
  await publishDomainModelResult(project, basis, result, {
    kind: 'direct',
    runId: RUN_ID,
    userInputPath: null,
  });

  const events: string[] = [];
  await assert.rejects(
    publishDomainModelResult(
      project,
      basis,
      result,
      { kind: 'direct', runId: OTHER_RUN_ID, userInputPath: null },
      undefined,
      (entry) => events.push(entry.event),
    ),
    (error: unknown) => {
      assert.ok(error instanceof PublicApiError);
      assert.equal(error.status, 409);
      assert.equal(moduleRunFailureKind(error, 'output'), 'persistence');
      assert.equal(rejectionReceipt(error)?.outcome, 'rejected');
      assert.equal(rejectionReceipt(error)?.failure?.boundary, 'stale-basis');
      return true;
    },
  );
  assert.deepEqual(events, [
    'materialization.validated',
    'materialization.stale',
  ]);

  const stored = JSON.parse(
    await readFile(
      path.join(
        project.planningPath,
        'domain-model',
        'runs',
        OTHER_RUN_ID,
        'materialization.json',
      ),
      'utf8',
    ),
  ) as MaterializationReceipt;
  assert.equal(stored.outcome, 'rejected');
  assert.equal(stored.publication, null);
});

void test('an unusable composed model is rejected with a Receipt', async (t) => {
  const project = await fixture(t);
  const basis = prepareDomainModelBasis(project, {
    model: await readDomainModel(project),
    selectedIds: [],
  });
  const events: string[] = [];
  await assert.rejects(
    publishDomainModelResult(
      project,
      basis,
      {
        outcome: 'model-change',
        summary: 'Patch a model that has no entity.',
        change: {
          kind: 'patch',
          patch: {
            upsertEntities: [],
            removeEntityIds: ['ENTITY-MISSING'],
            removeFieldIds: [],
            upsertRelationships: [],
            removeRelationshipIds: [],
            upsertConstraints: [],
            removeConstraintIds: [],
          },
        },
      },
      { kind: 'direct', runId: RUN_ID, userInputPath: null },
      undefined,
      (entry) => events.push(entry.event),
    ),
    (error: unknown) =>
      rejectionReceipt(error)?.outcome === 'rejected' &&
      rejectionReceipt(error)?.failure?.boundary === 'validation',
  );
  assert.deepEqual(events, ['materialization.rejected']);
  assert.equal((await readDomainModel(project)).entities.length, 0);
});
