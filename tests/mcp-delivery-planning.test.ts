import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'mcp-delivery-home-'));
process.env.PRAXIS_HOME = REGISTRY_HOME;

const registry = await import('../lib/project-registry.ts');
const { prepareDeliveryMapOperation } =
  await import('../lib/mcp/prepare-delivery-map.ts');
const { submitDeliveryMapOperation } =
  await import('../lib/mcp/submit-delivery-map.ts');
const { findMcpOperation, writeMcpOperation } =
  await import('../lib/mcp/operations.ts');
const { isMcpRequestError } = await import('../lib/mcp/errors.ts');
const catalog = await import('../lib/mcp/catalog.ts');
const { readWhatToDoCurrentMapWithFingerprint } =
  await import('../lib/modules/delivery-planning/storage.ts');
const { publicationBoundary } =
  await import('../lib/mcp/publication-boundary.ts');
const { PublicApiError } = await import('../lib/api-errors.ts');
const { MaterializationError } =
  await import('../lib/materialization/receipt.ts');

const NODE_ID = 'NODE-00000001';
const FEATURE_UID = '00000000-0000-4000-8000-000000000002';
const FEATURE_PATH = `whats-next/nodes/${NODE_ID}/output.md`;
const FEATURE_ANCHOR = 'Deliver this behavior.';

test.after(() => rm(REGISTRY_HOME, { recursive: true, force: true }));

async function fixture(t: test.TestContext, withFeature = true) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mcp-delivery-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  await writeFile(path.join(rootPath, 'README.md'), '# Fixture\n');
  const project = await registry.createProject({
    kind: 'repository',
    name: 'Delivery fixture',
    description: '',
    rootPath,
  });
  if (!withFeature) return project;
  const nodePath = path.join(project.planningPath, 'whats-next/nodes', NODE_ID);
  await mkdir(nodePath, { recursive: true });
  await writeFile(
    path.join(nodePath, 'node.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: NODE_ID,
        uid: FEATURE_UID,
        relations: { derivedFrom: [], dependsOn: [] },
        role: 'node',
        type: 'feature',
        title: 'Accepted Feature',
        summary: 'Accepted behavior.',
        status: 'accepted',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
        resources: [{ kind: 'output', path: FEATURE_PATH }],
        derivedFrom: [],
        dependsOn: [],
        typeTemplateRef: NODE_ID,
        metadata: {},
        layer: 'product-design',
        artifactKind: 'feature',
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(nodePath, 'output.md'),
    `# Accepted Feature\n\n## Behavior\n\n${FEATURE_ANCHOR}\n`,
  );
  return project;
}

function mapProposal(title = 'First delivery contract') {
  return {
    outcome: 'map-proposal',
    contracts: [
      {
        localKey: 'first-contract',
        title,
        summary: 'Delivers the accepted behavior.',
        outcome: 'The accepted behavior exists.',
        includedScope: ['The accepted behavior'],
        excludedScope: [],
        productRules: ['The behavior is available to the reader.'],
        domainImpact: {
          kind: 'none',
          reason: 'No model change.',
          evidencePaths: [],
        },
        requiredExperienceStates: [],
        repositoryConstraints: [],
        dependsOn: [],
        acceptanceCriteria: [
          {
            id: 'AC-1',
            condition: 'The reader uses the behavior.',
            passCondition: 'The expected result appears.',
            evidence: 'Automated test.',
          },
        ],
        validationExpectations: ['An automated test covers it.'],
        sourceClaimIds: ['claim-1'],
        openDecisions: [],
        deliveryStrategy: {
          kind: 'vertical-slice',
          reason: 'Smallest end-to-end slice.',
        },
      },
    ],
    sourceClaims: [
      {
        claimId: 'claim-1',
        source: { kind: 'source', path: FEATURE_PATH },
        anchor: FEATURE_ANCHOR,
        summary: 'The Feature asks for the behavior.',
        disposition: 'in-scope',
        contracts: [{ kind: 'proposal', localKey: 'first-contract' }],
        exclusionReason: null,
        exclusionAuthority: null,
      },
    ],
  };
}

void test('a first Delivery Map prepares as create-map and freezes the Feature it plans from', async (t) => {
  const project = await fixture(t);
  const { record, basis } = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  assert.equal(basis.operation, 'create-map');
  assert.equal(record.module, 'delivery-planning');
  assert.equal(record.request.operation, 'create-map');
  assert.deepEqual(record.request.sourceUids, [FEATURE_UID]);
  assert.equal(
    record.sources.some((source) => source.logicalPath === FEATURE_PATH),
    true,
    'the Feature document must be frozen as evidence',
  );
  assert.equal(
    record.sources.some(
      (source) =>
        source.logicalPath ===
        `what-to-do/runs/${record.runId}/context/input/user-input.md`,
    ),
    true,
    'the User Input must be frozen alongside the evidence it was written against',
  );
});

void test('a first Delivery Map without a named Feature names the Features it could use', async (t) => {
  const project = await fixture(t);
  await assert.rejects(
    () => prepareDeliveryMapOperation(project, { userInput: 'Plan it.' }),
    (error: unknown) =>
      isMcpRequestError(error) &&
      error.envelope.code === 'INVALID_ARGUMENT' &&
      error.envelope.detail.includes(FEATURE_UID),
  );
});

void test('a project with no accepted Feature says so instead of naming an empty list', async (t) => {
  const project = await fixture(t, false);
  await assert.rejects(
    () => prepareDeliveryMapOperation(project, { userInput: 'Plan it.' }),
    (error: unknown) =>
      isMcpRequestError(error) &&
      error.envelope.code === 'INVALID_ARGUMENT' &&
      /no accepted Product Design Feature/.test(error.envelope.detail),
  );
});

void test('a Delivery Map submission publishes through the canonical service', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  const outcome = await submitDeliveryMapOperation(
    project,
    record.operationId,
    record.contract,
    mapProposal(),
  );
  assert.equal(outcome.record.status, 'completed');
  assert.equal(outcome.record.outcome?.kind, 'map-proposal');
  const canonical = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(canonical.map?.runId, record.runId);
  assert.equal(canonical.map?.contracts.length, 1);
  assert.match(
    await readFile(
      path.join(project.planningPath, canonical.map!.contracts[0]!.outputPath),
      'utf8',
    ),
    /First delivery contract/,
  );
  assert.equal(
    outcome.record.logUrlPath,
    `/projects/${project.id}/logs/what-to-do/${record.runId}`,
  );
});

void test('an exact Delivery retry replays without a second Map publication', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  const result = mapProposal();
  const first = await submitDeliveryMapOperation(
    project,
    record.operationId,
    record.contract,
    result,
  );
  const before = await readWhatToDoCurrentMapWithFingerprint(project);
  const retry = await submitDeliveryMapOperation(
    project,
    record.operationId,
    record.contract,
    result,
  );
  assert.equal(retry.replayed, true);
  assert.equal(retry.record.settledAt, first.record.settledAt);
  const after = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(after.fingerprint, before.fingerprint);
});

void test('a changed Delivery result on an admitted operation conflicts', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  await submitDeliveryMapOperation(
    project,
    record.operationId,
    record.contract,
    mapProposal(),
  );
  await assert.rejects(
    () =>
      submitDeliveryMapOperation(
        project,
        record.operationId,
        record.contract,
        mapProposal('A different contract'),
      ),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'SUBMISSION_CONFLICT',
  );
});

void test('a Feature edited after preparation refuses the submission as a stale Basis', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  await writeFile(
    path.join(project.planningPath, FEATURE_PATH),
    `# Accepted Feature\n\n## Behavior\n\n${FEATURE_ANCHOR}\n\nAnd one more sentence.\n`,
  );
  await assert.rejects(
    () =>
      submitDeliveryMapOperation(
        project,
        record.operationId,
        record.contract,
        mapProposal(),
      ),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'STALE_BASIS',
  );
  assert.equal(
    (await findMcpOperation(project, record.operationId))?.status,
    'prepared',
    'a refused submission must leave the operation preparable',
  );
  assert.equal(
    (await readWhatToDoCurrentMapWithFingerprint(project)).map,
    null,
  );
});

void test('a Delivery operation cannot be submitted through another module tool', async (t) => {
  const project = await fixture(t);
  const { submitDomainModelOperation } =
    await import('../lib/mcp/submit-domain-model.ts');
  const { record } = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  await assert.rejects(
    () =>
      submitDomainModelOperation(project, record.operationId, record.contract, {
        outcome: 'no-change',
      }),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'CONTRACT_MISMATCH',
  );
});

void test('a committed Delivery receipt settles an operation whose status write was lost', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  await submitDeliveryMapOperation(
    project,
    record.operationId,
    record.contract,
    mapProposal(),
  );
  const published = (await findMcpOperation(project, record.operationId))!;
  await writeMcpOperation(project, {
    ...published,
    status: 'running',
    settledAt: null,
    outcome: null,
    receipt: null,
  });
  const recovered = JSON.parse(
    (await catalog.readOperationResource(project.id, record.operationId)).text,
  ) as Record<string, unknown>;
  assert.equal(recovered.status, 'completed');
  assert.equal((recovered.receipt as { outcome: string }).outcome, 'canonical');
});

void test('a lost Delivery receipt still recovers from the committed Map', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  await submitDeliveryMapOperation(
    project,
    record.operationId,
    record.contract,
    mapProposal(),
  );
  const published = (await findMcpOperation(project, record.operationId))!;
  await rm(
    path.join(
      project.planningPath,
      'what-to-do',
      'runs',
      record.runId,
      'materialization.json',
    ),
    { force: true },
  );
  await writeMcpOperation(project, {
    ...published,
    status: 'running',
    settledAt: null,
    outcome: null,
    receipt: null,
  });
  const recovered = JSON.parse(
    (await catalog.readOperationResource(project.id, record.operationId)).text,
  ) as Record<string, unknown>;
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.receipt, null);
  assert.match(
    (recovered.outcome as { summary: string }).summary,
    /recovered from the committed Map/,
  );
});

void test('an interrupted Delivery operation whose Run never committed stays unsettled', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  await writeMcpOperation(project, {
    ...record,
    status: 'running',
    admittedAt: new Date().toISOString(),
    admittedHostPid: 2 ** 22,
    semanticResultHash: 'never-committed',
  });
  const projection = JSON.parse(
    (await catalog.readOperationResource(project.id, record.operationId)).text,
  ) as Record<string, unknown>;
  assert.equal(projection.status, 'interrupted');
  assert.equal(projection.receipt, null);
});

void test('an adjustment prepares as adjust-map and preserves the published Contract', async (t) => {
  const project = await fixture(t);
  const first = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  await submitDeliveryMapOperation(
    project,
    first.record.operationId,
    first.record.contract,
    mapProposal(),
  );
  const created = await readWhatToDoCurrentMapWithFingerprint(project);
  const retainedId = created.map!.contracts[0]!.id;

  const second = await prepareDeliveryMapOperation(project, {
    userInput: 'Keep the contract as it is.',
    selectionIds: [retainedId],
  });
  assert.equal(second.basis.operation, 'adjust-map');
  assert.equal(second.record.request.operation, 'adjust-map');
  assert.deepEqual(second.record.request.sourcePaths, []);

  const adjusted = await submitDeliveryMapOperation(
    project,
    second.record.operationId,
    second.record.contract,
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
  );
  assert.equal(adjusted.record.status, 'completed');
  const after = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(after.map?.runId, second.record.runId);
  assert.deepEqual(
    after.map!.contracts.map((contract) => contract.id),
    [retainedId],
    'an adjustment that retains a Contract must not discard it',
  );
});

void test('an adjustment cannot focus on a Contract the Map no longer has', async (t) => {
  const project = await fixture(t);
  const first = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  await submitDeliveryMapOperation(
    project,
    first.record.operationId,
    first.record.contract,
    mapProposal(),
  );
  await assert.rejects(
    () =>
      prepareDeliveryMapOperation(project, {
        userInput: 'Adjust it.',
        selectionIds: ['NODE-deadbeef'],
      }),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'INVALID_ARGUMENT',
  );
});

void test('a Feature already in the Delivery Map is refused instead of planned twice', async (t) => {
  const project = await fixture(t);
  const first = await prepareDeliveryMapOperation(project, {
    userInput: 'Plan the first delivery.',
    sourceUids: [FEATURE_UID],
  });
  await submitDeliveryMapOperation(
    project,
    first.record.operationId,
    first.record.contract,
    mapProposal(),
  );
  await assert.rejects(
    () =>
      prepareDeliveryMapOperation(project, {
        userInput: 'Plan it again.',
        sourceUids: [FEATURE_UID],
      }),
    (error: unknown) =>
      isMcpRequestError(error) &&
      error.envelope.code === 'INVALID_ARGUMENT' &&
      /already part of the current Delivery Map/.test(error.envelope.detail),
  );
});

void test('a publication conflict is classified as a stale Basis, not a failure', () => {
  assert.equal(
    publicationBoundary(new PublicApiError('conflict', 409)),
    'stale-basis',
  );
  assert.equal(
    publicationBoundary(new PublicApiError('bad request', 400)),
    'publication',
  );
  assert.equal(
    publicationBoundary(new MaterializationError('validation', 'invalid')),
    'validation',
  );
  assert.equal(publicationBoundary(new Error('anything')), 'publication');
});
