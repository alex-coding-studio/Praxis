import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
  DELIVERY_MAP_RESULT_CONTRACT,
  type DeliveryMapResult,
} from '../lib/modules/delivery-planning/contract.ts';
import { semanticResultHash } from '../lib/materialization/hash.ts';
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

const SOURCE_CONTENT =
  '# Example\n\nExample anchor text is stated once.\nA deferred sentence sits here.\n';
const USER_INPUT_CONTENT =
  'Implement all requested behavior. Defer this requirement.\n';

const evidence = {
  sourceUids: ['feature-1'],
  userInput: {
    path: 'what-to-do/input.md',
    sha256: '2'.repeat(64),
    content: USER_INPUT_CONTENT,
  },
  sourceSnapshots: [
    {
      logicalPath: 'docs/example.md',
      sha256: '1'.repeat(64),
      storedPath: `what-to-do/runs/${RUN_ID}/context/primary/example.md`,
    },
  ],
  knownSources: {
    'docs/example.md': { sha256: '1'.repeat(64), content: SOURCE_CONTENT },
  },
  knownEvidencePaths: ['docs/example.md'],
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

void test('a self-dependent Contract is rejected without touching canonical state', async (t) => {
  const project = await fixture(t);
  await assert.rejects(
    submitDeliveryMapResult(
      project,
      await emptyBasis(project),
      {
        ...example,
        contracts: [
          {
            ...example.contracts[0]!,
            dependsOn: [{ kind: 'proposal', localKey: 'example-contract' }],
          },
        ],
      },
      { runId: RUN_ID, ...evidence },
      store,
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.boundary === 'validation' &&
      error.message === 'A Contract Candidate cannot depend on itself.',
  );
  const canonical = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(canonical.fingerprint, 'absent');
  assert.deepEqual(
    await readdir(
      path.join(project.planningPath, 'what-to-do', 'runs', RUN_ID),
    ),
    ['semantic-result.json'],
    'a rejected submission keeps its semantic result and creates nothing else',
  );
});

void test('an unresolvable Contract reference is rejected', async (t) => {
  const project = await fixture(t);
  await assert.rejects(
    submitDeliveryMapResult(
      project,
      await emptyBasis(project),
      {
        ...example,
        sourceClaims: [
          {
            ...example.sourceClaims[0]!,
            contracts: [{ kind: 'proposal', localKey: 'missing-contract' }],
          },
        ],
      },
      { runId: RUN_ID, ...evidence },
      store,
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.message ===
        'The Delivery Map references an unknown Contract: proposal:missing-contract.',
  );
  const canonical = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(canonical.fingerprint, 'absent');
});

void test('a new Delivery Map without a Contract is rejected', async (t) => {
  const project = await fixture(t);
  await assert.rejects(
    submitDeliveryMapResult(
      project,
      await emptyBasis(project),
      { ...example, contracts: [], sourceClaims: [] },
      { runId: RUN_ID, ...evidence },
      store,
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.message ===
        'A new Delivery Map requires at least one Contract Candidate.',
  );
  const canonical = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(canonical.fingerprint, 'absent');
});

void test('an adjusted Map that leaves an existing Contract unaccounted for is rejected', async (t) => {
  const project = await fixture(t);
  const created = await submitDeliveryMapResult(
    project,
    await emptyBasis(project),
    {
      ...example,
      contracts: [
        { ...example.contracts[0]!, localKey: 'first' },
        { ...example.contracts[0]!, localKey: 'second' },
      ],
      sourceClaims: [
        {
          ...example.sourceClaims[0]!,
          contracts: [
            { kind: 'proposal', localKey: 'first' },
            { kind: 'proposal', localKey: 'second' },
          ],
        },
      ],
    },
    { runId: RUN_ID, ...evidence },
    store,
  );
  assert.equal(created.map!.contracts.length, 2);
  const published = await readWhatToDoCurrentMapWithFingerprint(project);
  const retainedId = created.map!.contracts[0]!.id;

  await assert.rejects(
    submitDeliveryMapResult(
      project,
      await emptyBasis(project),
      {
        outcome: 'map-proposal',
        contracts: [],
        sourceClaims: [
          {
            ...example.sourceClaims[0]!,
            contracts: [{ kind: 'contract', id: retainedId }],
          },
        ],
        recomposition: {
          effects: [
            {
              kind: 'retain',
              from: [{ kind: 'contract', id: retainedId }],
              to: [{ kind: 'contract', id: retainedId }],
            },
          ],
        },
      },
      { runId: RUN_ID, ...evidence },
      store,
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.boundary === 'validation' &&
      /must have exactly one effect/.test(error.message),
  );

  const after = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(after.fingerprint, published.fingerprint);
  assert.equal(after.map!.contracts.length, 2);
});

void test('a Contract carrying an Open Decision or uncertain impact is rejected', async (t) => {
  const project = await fixture(t);
  const basis = await emptyBasis(project);
  await assert.rejects(
    submitDeliveryMapResult(
      project,
      basis,
      {
        ...example,
        contracts: [{ ...example.contracts[0]!, openDecisions: ['Undecided'] }],
      },
      { runId: RUN_ID, ...evidence },
      store,
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.message ===
        'A formal Delivery Map cannot contain an Open Decision.',
  );
  await assert.rejects(
    submitDeliveryMapResult(
      project,
      basis,
      {
        ...example,
        contracts: [
          {
            ...example.contracts[0]!,
            domainImpact: {
              kind: 'uncertain',
              reason: 'Unknown.',
              evidencePaths: [],
            },
          },
        ],
      },
      { runId: RUN_ID, ...evidence },
      store,
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.message ===
        'A formal Delivery Map cannot contain uncertain Domain Impact.',
  );
  const canonical = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(canonical.fingerprint, 'absent');
});

void test('an adjustment that omits Source Claims preserves the published ones', async (t) => {
  const project = await fixture(t);
  const created = await submitDeliveryMapResult(
    project,
    await emptyBasis(project),
    example,
    { runId: RUN_ID, ...evidence },
    store,
  );
  const retainedId = created.map!.contracts[0]!.id;

  const adjusted = await submitDeliveryMapResult(
    project,
    await emptyBasis(project),
    {
      outcome: 'map-proposal',
      contracts: [],
      sourceClaims: [],
      recomposition: {
        effects: [
          {
            kind: 'retain',
            from: [{ kind: 'contract', id: retainedId }],
            to: [{ kind: 'contract', id: retainedId }],
          },
        ],
      },
    },
    { runId: RUN_ID, ...evidence },
    store,
  );

  assert.deepEqual(
    adjusted.map!.sourceClaims,
    created.map!.sourceClaims.map((claim) => ({
      ...claim,
      contractIds: [retainedId],
    })),
  );
  assert.deepEqual(adjusted.map!.sourceSnapshots, created.map!.sourceSnapshots);
  assert.deepEqual(adjusted.map!.contracts[0]!.sourceClaimIds, ['claim-1']);
});

void test('an adjustment applies a Source Claim update to the preserved Claim', async (t) => {
  const project = await fixture(t);
  const created = await submitDeliveryMapResult(
    project,
    await emptyBasis(project),
    example,
    { runId: RUN_ID, ...evidence },
    store,
  );
  const retainedId = created.map!.contracts[0]!.id;

  await assert.rejects(
    submitDeliveryMapResult(
      project,
      await emptyBasis(project),
      {
        outcome: 'map-proposal',
        contracts: [],
        sourceClaims: [],
        sourceClaimUpdates: [
          {
            claimId: 'missing-claim',
            disposition: 'in-scope',
            contracts: [{ kind: 'contract', id: retainedId }],
            exclusionReason: null,
            exclusionAuthority: null,
          },
        ],
        recomposition: {
          effects: [
            {
              kind: 'retain',
              from: [{ kind: 'contract', id: retainedId }],
              to: [{ kind: 'contract', id: retainedId }],
            },
          ],
        },
      },
      { runId: RUN_ID, ...evidence },
      store,
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.message === 'Source Claim update missing-claim does not exist.',
  );
});

function excludedClaim(anchor: string) {
  return {
    claimId: 'claim-2',
    source: { kind: 'source' as const, path: 'docs/example.md' },
    anchor: 'A deferred sentence sits here.',
    summary: 'The source asks for something the user deferred.',
    disposition: 'out-of-scope' as const,
    contracts: [],
    exclusionReason: 'User deferred it',
    exclusionAuthority: { anchor },
  };
}

void test('an exclusion anchor absent from the User Input is rejected', async (t) => {
  const project = await fixture(t);
  await assert.rejects(
    submitDeliveryMapResult(
      project,
      await emptyBasis(project),
      {
        ...example,
        sourceClaims: [
          ...example.sourceClaims,
          excludedClaim('Skip the authentication work'),
        ],
      },
      { runId: RUN_ID, ...evidence },
      store,
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.message ===
        'Source Claim exclusion authority must occur exactly once in current User Input.',
  );
  const canonical = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(canonical.fingerprint, 'absent');
});

void test('an exclusion anchor quoted from the User Input is published', async (t) => {
  const project = await fixture(t);
  const published = await submitDeliveryMapResult(
    project,
    await emptyBasis(project),
    {
      ...example,
      sourceClaims: [
        ...example.sourceClaims,
        excludedClaim('Defer this requirement.'),
      ],
    },
    { runId: RUN_ID, ...evidence },
    store,
  );
  assert.deepEqual(published.map!.sourceClaims[1]!.exclusionAuthority, {
    userInputPath: evidence.userInput.path,
    userInputSha256: evidence.userInput.sha256,
    anchor: 'Defer this requirement.',
  });
});

void test('a Claim anchor absent from its frozen source is rejected', async (t) => {
  const project = await fixture(t);
  await assert.rejects(
    submitDeliveryMapResult(
      project,
      await emptyBasis(project),
      {
        ...example,
        sourceClaims: [
          { ...example.sourceClaims[0]!, anchor: 'Never written anywhere' },
        ],
      },
      { runId: RUN_ID, ...evidence },
      store,
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.message ===
        'A Source Claim anchor must occur exactly once in its frozen source.',
  );
});

void test('a Contract citing unknown evidence is rejected', async (t) => {
  const project = await fixture(t);
  await assert.rejects(
    submitDeliveryMapResult(
      project,
      await emptyBasis(project),
      {
        ...example,
        contracts: [
          {
            ...example.contracts[0]!,
            domainImpact: {
              kind: 'reuse',
              reason: 'Reuse it.',
              evidencePaths: ['docs/absent.md'],
            },
          },
        ],
      },
      { runId: RUN_ID, ...evidence },
      store,
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.message === 'The What to Do result references unknown evidence.',
  );
});

void test('a direct publication records a Receipt and its semantic result', async (t) => {
  const project = await fixture(t);
  const basis = await emptyBasis(project);
  const events: string[] = [];
  const published = await submitDeliveryMapResult(
    project,
    basis,
    example,
    { runId: RUN_ID, updatedAt: '2026-09-06T00:00:00.000Z', ...evidence },
    store,
    (entry) => {
      assert.equal(entry.actor, 'HOST');
      events.push(entry.event);
    },
  );

  assert.deepEqual(events, [
    'materialization.validated',
    'materialization.staged',
    'materialization.published',
  ]);
  const receipt = published.receipt;
  assert.deepEqual(receipt.contract, {
    id: DELIVERY_MAP_RESULT_CONTRACT.id,
    version: DELIVERY_MAP_RESULT_CONTRACT.version,
    hash: DELIVERY_MAP_RESULT_CONTRACT.hash,
  });
  assert.deepEqual(receipt.producer, { kind: 'direct', runId: RUN_ID });
  assert.equal(receipt.semanticResultHash, semanticResultHash(example));
  assert.equal(receipt.outcome, 'canonical');
  assert.deepEqual(receipt.affected.contractIds, [
    published.map!.contracts[0]!.id,
  ]);
  assert.deepEqual(receipt.publication, {
    target: 'current-map',
    at: '2026-09-06T00:00:00.000Z',
    revision: RUN_ID,
  });

  const semantic = JSON.parse(
    await readFile(
      path.join(
        project.planningPath,
        'what-to-do',
        'runs',
        RUN_ID,
        'semantic-result.json',
      ),
      'utf8',
    ),
  ) as { semanticResultHash: string; result: DeliveryMapResult };
  assert.equal(semantic.semanticResultHash, receipt.semanticResultHash);
  assert.deepEqual(semantic.result, example);
});

void test('a rejected submission carries its boundary on the Receipt', async (t) => {
  const project = await fixture(t);
  const events: string[] = [];
  await assert.rejects(
    submitDeliveryMapResult(
      project,
      await emptyBasis(project),
      {
        ...example,
        contracts: [
          {
            ...example.contracts[0]!,
            dependsOn: [{ kind: 'proposal', localKey: 'example-contract' }],
          },
        ],
      },
      { runId: RUN_ID, ...evidence },
      store,
      (entry) => events.push(entry.event),
    ),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.receipt?.outcome === 'rejected' &&
      error.receipt.publication === null &&
      error.receipt.failure?.boundary === 'validation',
  );
  assert.deepEqual(events, ['materialization.rejected']);
  const canonical = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(canonical.fingerprint, 'absent');
});
