import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'mcp-op-home-'));
process.env.PRAXIS_HOME = REGISTRY_HOME;

const registry = await import('../lib/project-registry.ts');
const { createStartNode } = await import('../lib/graph/task/model.ts');
const { prepareProductExplorationOperation } =
  await import('../lib/mcp/prepare.ts');
const { submitProductExplorationResult } = await import('../lib/mcp/submit.ts');
const { findMcpOperation, writeMcpOperation } =
  await import('../lib/mcp/operations.ts');
const { isMcpRequestError } = await import('../lib/mcp/errors.ts');
const catalog = await import('../lib/mcp/catalog.ts');
const assembly = await import('../lib/modules/product-discovery/assembly.ts');
const { beginRun, releaseRun } =
  await import('../lib/execution-observability/active-runs.ts');
const { moduleOwner } =
  await import('../lib/execution-observability/module-run.ts');
const { listTaskGraphNodes } = await import('../lib/graph/task/nodes.ts');

test.after(() => rm(REGISTRY_HOME, { recursive: true, force: true }));

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mcp-op-project-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project = await registry.createProject({
    kind: 'standalone',
    name: 'Operation fixture',
    description: '',
    rootPath,
  });
  const start = await createStartNode(
    project,
    {
      title: 'Build my local website',
      idea: 'Build it',
      contextRefs: [],
      files: [],
    },
    'whats-next',
  );
  return { project, sourceNodeId: start.node.id };
}

function candidate(sourceNodeId: string, title = 'Capture the item') {
  return {
    localKey: 'capture',
    type: 'mvp',
    title,
    summary: 'One bounded outcome the reader asked for.',
    derivedFrom: [{ kind: 'node' as const, id: sourceNodeId }],
    dependsOn: [],
    resources: [],
    typeTemplateRef: null,
    metadata: {},
    presentation: {},
    assumptions: ['The reader already has the source material.'],
    outputMarkdown:
      '# Capture the item\n\n## Why this direction\n\n- It answers the stated need directly.\n- It can be judged without more evidence.\n\n## Assumptions\n\n- The reader already has the source material.',
    layer: 'discovery' as const,
    artifactKind: 'mvp' as const,
  };
}

function proposal(sourceNodeId: string, title?: string) {
  return { outcome: 'proposal', candidates: [candidate(sourceNodeId, title)] };
}

async function prepared(project: never, sourceNodeId: string) {
  return prepareProductExplorationOperation(
    project,
    {
      userInput: 'Explore one bounded MVP.',
      layer: 'discovery',
      sourceNodeIds: [sourceNodeId],
    },
    { name: 'probe', version: '1.0.0' },
  );
}

void test('preparation freezes evidence without creating a graph entity or a Run', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { record } = await prepared(project as never, sourceNodeId);
  assert.equal(record.status, 'prepared');
  assert.match(record.operationId, /^MCPOP-[0-9a-f-]{36}$/);
  assert.match(record.runId, /^RUN-[0-9a-f-]{36}$/);
  assert.equal(record.admittedAt, null);
  assert.equal(record.semanticResultHash, null);
  assert.equal(record.transport, 'mcp');
  assert.deepEqual(record.clientInfo, { name: 'probe', version: '1.0.0' });
  assert.match(
    await readFile(
      path.join(project.planningPath, record.userInputPath),
      'utf8',
    ),
    /Explore one bounded MVP/,
  );
  assert.deepEqual(
    await assembly.collectLatestUnacceptedCandidateStates(project),
    [],
    'preparation must not create a Candidate',
  );
  const nodesBefore = await listTaskGraphNodes(project, 'whats-next');
  assert.equal(nodesBefore.length, 1);
});

void test('two preparations may coexist because only publication is exclusive', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const first = await prepared(project as never, sourceNodeId);
  const second = await prepared(project as never, sourceNodeId);
  assert.notEqual(first.record.operationId, second.record.operationId);
  assert.notEqual(first.record.runId, second.record.runId);
  assert.equal(
    (await findMcpOperation(project, first.record.operationId))?.status,
    'prepared',
  );
});

void test('a fixture submission publishes readable Candidates without a model', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { record } = await prepared(project as never, sourceNodeId);
  const outcome = await submitProductExplorationResult(
    project,
    record.operationId,
    record.contract,
    proposal(sourceNodeId),
  );
  assert.equal(outcome.record.status, 'completed');
  assert.equal(outcome.replayed, false);
  assert.equal(outcome.record.outcome?.kind, 'proposal');
  assert.equal(outcome.record.receipt?.outcome, 'candidates');
  assert.equal(
    outcome.record.logUrlPath,
    `/projects/${project.id}/logs/whats-next/${record.runId}`,
  );
  const states = await assembly.collectLatestUnacceptedCandidateStates(project);
  assert.equal(states.length, 1);
  assert.match(states[0]!.candidateId, /^CANDIDATE-/);
});

void test('submission publishes Candidates without accepting them', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { record } = await prepared(project as never, sourceNodeId);
  await submitProductExplorationResult(
    project,
    record.operationId,
    record.contract,
    proposal(sourceNodeId),
  );
  const accepted = await assembly.collectAcceptedCandidateIds(project);
  assert.deepEqual(accepted, [], 'submission must not accept a Candidate');
  const nodes = await listTaskGraphNodes(project, 'whats-next');
  assert.equal(nodes.length, 1, 'no node may be promoted by a submission');
});

void test('an exact retry replays the original outcome and a changed result conflicts', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { record } = await prepared(project as never, sourceNodeId);
  const first = await submitProductExplorationResult(
    project,
    record.operationId,
    record.contract,
    proposal(sourceNodeId),
  );
  const retry = await submitProductExplorationResult(
    project,
    record.operationId,
    record.contract,
    proposal(sourceNodeId),
  );
  assert.equal(retry.replayed, true);
  assert.equal(retry.record.settledAt, first.record.settledAt);
  assert.equal(
    (await assembly.collectLatestUnacceptedCandidateStates(project)).length,
    1,
    'a retry must not publish a second Candidate',
  );
  await assert.rejects(
    () =>
      submitProductExplorationResult(
        project,
        record.operationId,
        record.contract,
        proposal(sourceNodeId, 'A different direction'),
      ),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'SUBMISSION_CONFLICT',
  );
});

void test('a malformed result is refused before the operation is admitted', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { record } = await prepared(project as never, sourceNodeId);
  await assert.rejects(
    () =>
      submitProductExplorationResult(
        project,
        record.operationId,
        record.contract,
        { outcome: 'proposal', candidates: [{ localKey: 'broken' }] },
      ),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'INVALID_RESULT',
  );
  const after = await findMcpOperation(project, record.operationId);
  assert.equal(after?.status, 'prepared');
  assert.equal(after?.admittedAt, null);
  assert.equal(after?.semanticResultHash, null);
});

void test('a mismatched contract identity is refused', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { record } = await prepared(project as never, sourceNodeId);
  await assert.rejects(
    () =>
      submitProductExplorationResult(
        project,
        record.operationId,
        { ...record.contract, hash: 'not-the-hash' },
        proposal(sourceNodeId),
      ),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'CONTRACT_MISMATCH',
  );
});

void test('state that changed after preparation is refused as a stale Basis', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const stale = await prepared(project as never, sourceNodeId);
  const fresh = await prepared(project as never, sourceNodeId);
  await submitProductExplorationResult(
    project,
    fresh.record.operationId,
    fresh.record.contract,
    proposal(sourceNodeId),
  );
  await assert.rejects(
    () =>
      submitProductExplorationResult(
        project,
        stale.record.operationId,
        stale.record.contract,
        proposal(sourceNodeId, 'Another direction'),
      ),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'STALE_BASIS',
  );
  const after = await findMcpOperation(project, stale.record.operationId);
  assert.equal(after?.status, 'prepared', 'a stale refusal keeps the record');
});

void test('a concurrent owner refuses admission and leaves the operation preparable', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { record } = await prepared(project as never, sourceNodeId);
  const owner = moduleOwner(project, 'whats-next');
  const logFile = path.join(project.planningPath, 'concurrent-owner.log');
  t.after(() => rm(logFile, { force: true }));
  const { reservation } = await beginRun({
    owner,
    runId: 'RUN-77777777-7777-4777-8777-777777777777',
    logFile,
    logRef: logFile,
    subject: { kind: 'module', label: 'Product Exploration and Design' },
    startMessage: 'A UI Run owns the module',
    validate: async () => null,
    persist: async () => async () => undefined,
  });
  try {
    await assert.rejects(
      () =>
        submitProductExplorationResult(
          project,
          record.operationId,
          record.contract,
          proposal(sourceNodeId),
        ),
      (error: unknown) =>
        isMcpRequestError(error) &&
        error.envelope.code === 'ACTIVE_RUN_CONFLICT',
    );
  } finally {
    await reservation.log.close();
    releaseRun(reservation);
  }
  const after = await findMcpOperation(project, record.operationId);
  assert.equal(after?.status, 'prepared');
  assert.equal(after?.admittedAt, null);
  assert.deepEqual(
    await assembly.collectLatestUnacceptedCandidateStates(project),
    [],
    'a refused admission must publish nothing',
  );
  const retry = await submitProductExplorationResult(
    project,
    record.operationId,
    record.contract,
    proposal(sourceNodeId),
  );
  assert.equal(retry.record.status, 'completed');
});

void test('an operation admitted but never settled is reported as interrupted, not successful', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { record } = await prepared(project as never, sourceNodeId);
  await writeMcpOperation(project, {
    ...record,
    status: 'interrupted',
    admittedAt: new Date().toISOString(),
    semanticResultHash: 'a-hash-with-no-committed-outcome',
    error: {
      code: 'PUBLICATION_FAILED',
      title: 'The Host stopped before the outcome was provable',
      detail: 'Recovered on restart with no committed receipt.',
      boundary: 'publication',
      retryAction: 'inspect-operation',
    },
  });
  const projection = JSON.parse(
    (await catalog.readOperationResource(project.id, record.operationId)).text,
  ) as Record<string, unknown>;
  assert.equal(projection.status, 'interrupted');
  assert.equal(projection.receipt, null);
  assert.equal(projection.outcome, null);
  assert.equal(projection.retryAction, 'inspect-operation');
  assert.deepEqual(
    await assembly.collectLatestUnacceptedCandidateStates(project),
    [],
    'an interrupted operation must not look like a publication',
  );
});

void test('the operation resource and its log are readable after a submission', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { record } = await prepared(project as never, sourceNodeId);
  await submitProductExplorationResult(
    project,
    record.operationId,
    record.contract,
    proposal(sourceNodeId),
  );
  const projection = JSON.parse(
    (
      await catalog.resolveMcpResource(
        `praxis://projects/${project.id}/operations/${record.operationId}`,
      )
    ).text,
  ) as Record<string, unknown>;
  assert.equal(projection.status, 'completed');
  assert.equal(
    (projection.receipt as { outcome: string }).outcome,
    'candidates',
  );
  const log = await catalog.resolveMcpResource(
    `praxis://projects/${project.id}/operations/${record.operationId}/log`,
  );
  assert.equal(log.mimeType, 'text/plain');
  assert.match(log.text, /HOST/);
  assert.equal(
    /AGENT/.test(log.text),
    false,
    'an external submission must not invent Agent steps',
  );
});

void test('preparation refuses to guess when a layer allows more than one intention', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  await assert.rejects(
    () =>
      prepareProductExplorationOperation(project, {
        userInput: 'Complete the product.',
        layer: 'product-design',
        sourceNodeIds: [sourceNodeId],
      }),
    (error: unknown) =>
      isMcpRequestError(error) &&
      error.envelope.code === 'INVALID_ARGUMENT' &&
      /feature-synthesis/.test(error.envelope.detail),
  );
});

void test('preparation refuses a source node that is not in this project graph', async (t) => {
  const { project } = await fixture(t);
  await assert.rejects(
    () =>
      prepareProductExplorationOperation(project, {
        userInput: 'Explore.',
        layer: 'discovery',
        sourceNodeIds: ['NODE-deadbeefdeadbeef'],
      }),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'INVALID_ARGUMENT',
  );
});
