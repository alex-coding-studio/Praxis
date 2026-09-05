import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertDomainModelSelection,
  prepareDomainModelBasis,
} from '../lib/modules/domain-modeling/basis.ts';
import { composeDomainModel } from '../lib/modules/domain-modeling/materializer.ts';
import {
  DOMAIN_MODEL_RESULT_CONTRACT,
  type DomainModelResult,
} from '../lib/modules/domain-modeling/contract.ts';
import type { DomainModel } from '../lib/modules/domain-modeling/model.ts';
import { MaterializationError } from '../lib/materialization/receipt.ts';
import { apiErrorResponse } from '../lib/api-errors.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

async function project(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'domain-basis-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const registered: RegisteredProject = {
    id: 'domain-basis',
    kind: 'standalone',
    name: 'Domain basis fixture',
    description: '',
    rootPath,
    codePath: null,
    planningPath: path.join(rootPath, '.praxis'),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await mkdir(registered.planningPath);
  return registered;
}

function model(): DomainModel {
  return {
    schemaVersion: 1,
    stateVersion: 3,
    entities: [
      {
        id: 'ENTITY-00000001',
        name: 'Item',
        meaning: 'A physical thing the user wants to locate.',
        provenance: 'explicit',
        fields: [
          {
            id: 'FIELD-00000001',
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
    lastRunId: 'RUN-00000000-0000-4000-8000-000000000001',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function emptyPatch() {
  return {
    upsertEntities: [],
    removeEntityIds: [],
    removeFieldIds: [],
    upsertRelationships: [],
    removeRelationshipIds: [],
    upsertConstraints: [],
    removeConstraintIds: [],
  };
}

void test('the basis carries Contract identity, the state version and a frozen model', async (t) => {
  const registered = await project(t);
  const current = model();
  const basis = prepareDomainModelBasis(
    registered,
    { model: current, selectedIds: ['ENTITY-00000001', 'ENTITY-00000001'] },
    () => '2026-09-05T00:00:00.000Z',
  );
  assert.deepEqual(basis.contract, {
    id: DOMAIN_MODEL_RESULT_CONTRACT.id,
    version: DOMAIN_MODEL_RESULT_CONTRACT.version,
    hash: DOMAIN_MODEL_RESULT_CONTRACT.hash,
  });
  assert.equal(basis.module, 'domain-model');
  assert.equal(basis.stateVersion, 3);
  assert.equal(basis.preparedAt, '2026-09-05T00:00:00.000Z');
  assert.deepEqual(basis.selectedIds, ['ENTITY-00000001']);
  assert.match(basis.fingerprint, /^[0-9a-f]{64}$/);
  current.entities[0]!.meaning = 'Changed by the caller afterwards.';
  assert.equal(
    basis.model.entities[0]!.meaning,
    'A physical thing the user wants to locate.',
  );
  assert.throws(() => {
    (basis.model.entities as unknown[]).push({});
  });
});

void test('a selection the model no longer holds is a 409 the API can surface', async (t) => {
  const registered = await project(t);
  const rejects = (work: () => unknown) => {
    try {
      work();
    } catch (error) {
      assert.ok(error instanceof MaterializationError);
      return error;
    }
    assert.fail('expected a MaterializationError');
  };
  const direct = rejects(() =>
    assertDomainModelSelection(model(), ['ENTITY-00000099']),
  );
  assert.equal(direct.boundary, 'stale-basis');
  assert.equal(direct.status, 409);
  assert.equal(
    direct.message,
    'A selected Domain element is no longer available.',
  );
  const throughBasis = rejects(() =>
    prepareDomainModelBasis(registered, {
      model: model(),
      selectedIds: ['RELATIONSHIP-00000099'],
    }),
  );
  assert.equal(throughBasis.status, 409);
  const response = apiErrorResponse(direct, 'fallback', '/api/domain-model');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'A selected Domain element is no longer available.',
  });
});

void test('composition applies a patch and rejects one that drops a retained Field', async (t) => {
  const registered = await project(t);
  const basis = prepareDomainModelBasis(registered, {
    model: model(),
    selectedIds: [],
  });
  const sharpened: DomainModelResult = {
    outcome: 'model-change',
    summary: 'Sharpened the Item meaning.',
    change: {
      kind: 'patch',
      patch: {
        ...emptyPatch(),
        upsertEntities: [
          {
            ...structuredClone(basis.model.entities[0]!),
            meaning: 'A physical thing with a durable identity.',
          },
        ],
      },
    },
  };
  assert.ok(sharpened.outcome === 'model-change');
  const composed = composeDomainModel(basis.model, sharpened);
  assert.equal(composed.entities.length, 1);
  assert.equal(
    composed.entities[0]!.meaning,
    'A physical thing with a durable identity.',
  );
  assert.equal(composed.entities[0]!.fields.length, 1);
  const dropped: DomainModelResult = {
    outcome: 'model-change',
    summary: 'Dropped a Field.',
    change: {
      kind: 'patch',
      patch: {
        ...emptyPatch(),
        upsertEntities: [
          { ...structuredClone(basis.model.entities[0]!), fields: [] },
        ],
      },
    },
  };
  assert.ok(dropped.outcome === 'model-change');
  assert.throws(() => composeDomainModel(basis.model, dropped));
});

void test('composition of a whole model still requires it to cover the current one', async (t) => {
  const registered = await project(t);
  const basis = prepareDomainModelBasis(registered, {
    model: model(),
    selectedIds: [],
  });
  const covered: DomainModelResult = {
    outcome: 'model-change',
    summary: 'Restated the whole model.',
    change: {
      kind: 'model',
      model: {
        entities: [structuredClone(basis.model.entities[0]!)],
        relationships: [],
        constraints: [],
      },
    },
  };
  assert.ok(covered.outcome === 'model-change');
  assert.equal(composeDomainModel(basis.model, covered).entities.length, 1);
  const uncovered: DomainModelResult = {
    outcome: 'model-change',
    summary: 'Silently dropped the Item.',
    change: {
      kind: 'model',
      model: { entities: [], relationships: [], constraints: [] },
    },
  };
  assert.ok(uncovered.outcome === 'model-change');
  assert.throws(() => composeDomainModel(basis.model, uncovered));
});
