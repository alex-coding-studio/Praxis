import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareDeliveryMapBasis } from '../lib/modules/delivery-planning/basis.ts';
import {
  submitDeliveryMapResult,
  type DeliveryPublicationHost,
} from '../lib/modules/delivery-planning/publish.ts';
import { deliveryPublicationHost } from '../lib/modules/delivery-planning/publication-host.ts';
import { readWhatToDoCurrentMapWithFingerprint } from '../lib/modules/delivery-planning/storage.ts';
import {
  DELIVERY_MAP_MINIMAL_EXAMPLE,
  type DeliveryMapResult,
} from '../lib/modules/delivery-planning/contract.ts';
import { MaterializationError } from '../lib/materialization/receipt.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

const RUN_ID = 'RUN-11111111-1111-4111-8111-111111111111';

const example = DELIVERY_MAP_MINIMAL_EXAMPLE as Extract<
  DeliveryMapResult,
  { outcome: 'map-proposal' }
>;

const store: DeliveryPublicationHost = {
  ...deliveryPublicationHost,
  list: async () => [],
};

const evidence = {
  sourceUids: ['feature-1'],
  userInput: { path: 'what-to-do/input.md', sha256: '2'.repeat(64) },
  sourceSnapshots: [
    {
      logicalPath: 'docs/example.md',
      sha256: '1'.repeat(64),
      storedPath: `what-to-do/runs/${RUN_ID}/context/primary/example.md`,
    },
  ],
};

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'delivery-submit-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project: RegisteredProject = {
    id: 'delivery-submission',
    kind: 'standalone',
    name: 'Delivery submission fixture',
    description: '',
    rootPath,
    codePath: null,
    planningPath: path.join(rootPath, '.praxis'),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await mkdir(project.planningPath);
  return project;
}

async function emptyBasis(project: RegisteredProject) {
  const current = await readWhatToDoCurrentMapWithFingerprint(project);
  return prepareDeliveryMapBasis(project, {
    currentMap: current.map,
    currentMapFingerprint: current.fingerprint,
  });
}

void test('a direct producer publishes a Delivery Map without an Agent Run', async (t) => {
  const project = await fixture(t);
  const basis = await emptyBasis(project);
  assert.equal(basis.operation, 'create-map');

  const published = await submitDeliveryMapResult(
    project,
    basis,
    example,
    { runId: RUN_ID, updatedAt: '2026-09-02T00:00:00.000Z', ...evidence },
    store,
  );

  assert.equal(published.outcome, 'map-proposal');
  const contract = published.map!.contracts[0]!;
  assert.match(contract.id, /^NODE-[0-9a-f]{8}$/);
  assert.deepEqual(published.contractPaths, {
    [contract.id]: contract.outputPath,
  });

  const canonical = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.deepEqual(canonical.map, published.map);
  assert.deepEqual(canonical.map!.sourceClaims[0]!.contractIds, [contract.id]);
  assert.notEqual(canonical.fingerprint, 'absent');

  const document = await readFile(
    path.join(project.planningPath, contract.outputPath),
    'utf8',
  );
  assert.match(document, /# Example contract/);
});

void test('a non-proposal outcome publishes no canonical Delivery Map', async (t) => {
  const project = await fixture(t);
  const published = await submitDeliveryMapResult(
    project,
    await emptyBasis(project),
    { outcome: 'no-change', reason: 'The current Map already covers this.' },
    { runId: RUN_ID, ...evidence },
    store,
  );

  assert.equal(published.map, null);
  assert.deepEqual(published.contractPaths, {});
  const canonical = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(canonical.map, null);
  assert.equal(canonical.fingerprint, 'absent');
});

void test('a structurally invalid result fails at the validation boundary', async (t) => {
  const project = await fixture(t);
  const invalid: DeliveryMapResult = {
    ...example,
    contracts: [{ ...example.contracts[0]!, acceptanceCriteria: [] }],
  };

  await assert.rejects(
    submitDeliveryMapResult(
      project,
      await emptyBasis(project),
      invalid,
      { runId: RUN_ID, ...evidence },
      store,
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.boundary === 'validation' &&
      error.status === 400,
  );
  const canonical = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(canonical.fingerprint, 'absent');
});
