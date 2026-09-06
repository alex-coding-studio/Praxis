import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'mcp-scope-home-'));
process.env.PRAXIS_HOME = REGISTRY_HOME;

const registry = await import('../lib/project-registry.ts');
const { createStartNode } = await import('../lib/graph/task/model.ts');
const { prepareScopeDecompositionOperation } =
  await import('../lib/mcp/prepare-scope-decomposition.ts');
const { submitScopeDecompositionOperation } =
  await import('../lib/mcp/submit-scope-decomposition.ts');
const { findMcpOperation } = await import('../lib/mcp/operations.ts');
const { isMcpRequestError } = await import('../lib/mcp/errors.ts');
const assembly = await import('../lib/modules/scope-decomposition/assembly.ts');
const catalog = await import('../lib/mcp/catalog.ts');

test.after(() => rm(REGISTRY_HOME, { recursive: true, force: true }));

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mcp-scope-project-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project = await registry.createProject({
    kind: 'standalone',
    name: 'Scope fixture',
    description: '',
    rootPath,
  });
  const start = await createStartNode(
    project,
    {
      title: 'Ship the reading list',
      idea: 'Break it down',
      contextRefs: [],
      files: [],
    },
    'task-graph',
  );
  return { project, sourceNodeId: start.node.id };
}

function candidate(sourceNodeId: string, localKey: string, title: string) {
  return {
    localKey,
    type: 'module',
    title,
    summary: 'One bounded unit of work with a judgeable outcome.',
    derivedFrom: [{ kind: 'node' as const, id: sourceNodeId }],
    dependsOn: [],
    resources: [],
    typeTemplateRef: null,
    metadata: {},
    presentation: {},
    assumptions: [],
  };
}

function proposal(sourceNodeId: string, entries: Array<[string, string]>) {
  return {
    outcome: 'proposal',
    candidates: entries.map(([localKey, title]) =>
      candidate(sourceNodeId, localKey, title),
    ),
  };
}

async function prepareAndSubmit(
  project: never,
  sourceNodeId: string,
  request: Record<string, unknown>,
  result: unknown,
) {
  const { record } = await prepareScopeDecompositionOperation(project, {
    userInput: 'Break this down.',
    sourceNodeId,
    ...request,
  } as never);
  const outcome = await submitScopeDecompositionOperation(
    project,
    record.operationId,
    record.contract,
    result,
  );
  return { record, outcome };
}

void test('propose is the default operation and publishes readable Candidates', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { record, outcome } = await prepareAndSubmit(
    project as never,
    sourceNodeId,
    {},
    proposal(sourceNodeId, [
      ['first', 'Import the reading list'],
      ['second', 'Show the reading list'],
    ]),
  );
  assert.equal(record.request.operation, 'propose');
  assert.equal(outcome.record.status, 'completed');
  assert.equal(outcome.record.receipt?.outcome, 'candidates');
  const states = await assembly.collectLatestUnacceptedCandidateStates(project);
  assert.equal(states.length, 2);
  assert.equal(
    outcome.record.logUrlPath,
    `/projects/${project.id}/logs/task-decomposition/${record.runId}`,
  );
});

void test('append keeps the Candidates an earlier operation proposed', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  await prepareAndSubmit(
    project as never,
    sourceNodeId,
    {},
    proposal(sourceNodeId, [['first', 'Import the reading list']]),
  );
  const before = await assembly.collectLatestUnacceptedCandidateStates(project);
  assert.equal(before.length, 1);

  await prepareAndSubmit(
    project as never,
    sourceNodeId,
    { operation: 'append-candidates' },
    proposal(sourceNodeId, [['second', 'Show the reading list']]),
  );
  const after = await assembly.collectLatestUnacceptedCandidateStates(project);
  assert.equal(after.length, 2, 'appending must not drop unrelated Candidates');
  for (const candidateId of before.map((entry) => entry.candidateId))
    assert.equal(
      after.some((entry) => entry.candidateId === candidateId),
      true,
      `${candidateId} must survive an append`,
    );
});

void test('revision preserves the Candidate identity it revises', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  await prepareAndSubmit(
    project as never,
    sourceNodeId,
    {},
    proposal(sourceNodeId, [
      ['first', 'Import the reading list'],
      ['second', 'Show the reading list'],
    ]),
  );
  const open = await assembly.collectLatestUnacceptedCandidateStates(project);
  const target = open[0]!;
  const untouched = open[1]!;

  const { record } = await prepareScopeDecompositionOperation(project, {
    userInput: 'Sharpen the first unit.',
    sourceNodeId,
    operation: 'revise-candidate',
    candidateIds: [target.candidateId],
  } as never);
  const revisionTarget = record.request.revisionTarget as {
    candidateId: string;
    uid: string;
  };
  assert.equal(revisionTarget.candidateId, target.candidateId);
  assert.ok(revisionTarget.uid, 'a revision must resolve a stable identity');

  await submitScopeDecompositionOperation(
    project,
    record.operationId,
    record.contract,
    proposal(sourceNodeId, [
      [target.candidateId, 'Import the reading list, precisely'],
    ]),
  );

  const after = await assembly.collectLatestUnacceptedCandidateStates(project);
  const revised = after.find(
    (entry) => entry.candidateId === target.candidateId,
  );
  assert.ok(revised, 'the revised Candidate must keep its identity');
  assert.equal(
    revised.revision > target.revision,
    true,
    'a revision must advance the revision number',
  );
  assert.equal(
    after.some((entry) => entry.candidateId === untouched.candidateId),
    true,
    'an unrelated Candidate must survive a revision',
  );
});

void test('revision requires exactly one Candidate and recomposition a nonempty selection', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  await prepareAndSubmit(
    project as never,
    sourceNodeId,
    {},
    proposal(sourceNodeId, [
      ['first', 'Import the reading list'],
      ['second', 'Show the reading list'],
    ]),
  );
  const open = await assembly.collectLatestUnacceptedCandidateStates(project);
  for (const candidateIds of [[], open.map((entry) => entry.candidateId)])
    await assert.rejects(
      () =>
        prepareScopeDecompositionOperation(project, {
          userInput: 'Revise.',
          sourceNodeId,
          operation: 'revise-candidate',
          candidateIds,
        } as never),
      (error: unknown) =>
        isMcpRequestError(error) && error.envelope.code === 'INVALID_ARGUMENT',
    );
  await assert.rejects(
    () =>
      prepareScopeDecompositionOperation(project, {
        userInput: 'Recompose.',
        sourceNodeId,
        operation: 'recompose-candidates',
        candidateIds: [],
      } as never),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'INVALID_ARGUMENT',
  );
});

void test('preparation refuses a Candidate that is not open in this module', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  await assert.rejects(
    () =>
      prepareScopeDecompositionOperation(project, {
        userInput: 'Revise.',
        sourceNodeId,
        operation: 'revise-candidate',
        candidateIds: ['CANDIDATE-deadbeef'],
      } as never),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'INVALID_ARGUMENT',
  );
});

void test('preparation refuses a source node outside this project graph', async (t) => {
  const { project } = await fixture(t);
  await assert.rejects(
    () =>
      prepareScopeDecompositionOperation(project, {
        userInput: 'Break it down.',
        sourceNodeId: 'NODE-deadbeefdeadbeef',
      } as never),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'INVALID_ARGUMENT',
  );
});

void test('the frozen Basis records the recomposition selection it was prepared with', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  await prepareAndSubmit(
    project as never,
    sourceNodeId,
    {},
    proposal(sourceNodeId, [
      ['first', 'Import the reading list'],
      ['second', 'Show the reading list'],
    ]),
  );
  const open = await assembly.collectLatestUnacceptedCandidateStates(project);
  const selection = open.map((entry) => entry.candidateId);
  const { basis, record } = await prepareScopeDecompositionOperation(project, {
    userInput: 'Merge these two units.',
    sourceNodeId,
    operation: 'recompose-candidates',
    candidateIds: selection,
  } as never);
  assert.deepEqual(
    [...basis.recomposeCandidateIds].sort(),
    [...selection].sort(),
  );
  assert.equal(basis.operation, 'recompose-candidates');
  assert.deepEqual(record.request.candidateIds, selection);
});

void test('a Scope Decomposition submission does not accept its Candidates', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  await prepareAndSubmit(
    project as never,
    sourceNodeId,
    {},
    proposal(sourceNodeId, [['first', 'Import the reading list']]),
  );
  assert.deepEqual(
    await assembly.collectAcceptedCandidateIds(project),
    [],
    'submission must not accept a Candidate',
  );
});

void test('an exact retry replays and a changed result conflicts', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const result = proposal(sourceNodeId, [['first', 'Import the reading list']]);
  const { record } = await prepareScopeDecompositionOperation(project, {
    userInput: 'Break this down.',
    sourceNodeId,
  } as never);
  await submitScopeDecompositionOperation(
    project,
    record.operationId,
    record.contract,
    result,
  );
  const retry = await submitScopeDecompositionOperation(
    project,
    record.operationId,
    record.contract,
    result,
  );
  assert.equal(retry.replayed, true);
  assert.equal(
    (await assembly.collectLatestUnacceptedCandidateStates(project)).length,
    1,
    'a retry must not publish a second Candidate',
  );
  await assert.rejects(
    () =>
      submitScopeDecompositionOperation(
        project,
        record.operationId,
        record.contract,
        proposal(sourceNodeId, [['first', 'A different unit']]),
      ),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'SUBMISSION_CONFLICT',
  );
});

void test('a Product Exploration operation cannot be submitted through the Scope tool', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { prepareProductExplorationOperation } =
    await import('../lib/mcp/prepare.ts');
  const start = await createStartNode(
    project,
    { title: 'Explore', idea: 'Explore', contextRefs: [], files: [] },
    'whats-next',
  );
  const { record } = await prepareProductExplorationOperation(project, {
    userInput: 'Explore.',
    layer: 'discovery',
    sourceNodeIds: [start.node.id],
  });
  await assert.rejects(
    () =>
      submitScopeDecompositionOperation(
        project,
        record.operationId,
        record.contract,
        proposal(sourceNodeId, [['first', 'Import the reading list']]),
      ),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'CONTRACT_MISMATCH',
  );
});

void test('the operation log records HOST steps and no invented Agent activity', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const { record } = await prepareAndSubmit(
    project as never,
    sourceNodeId,
    {},
    proposal(sourceNodeId, [['first', 'Import the reading list']]),
  );
  const log = await catalog.readOperationLog(
    project.id,
    record.operationId,
    {},
  );
  assert.match(log.text, /HOST/);
  assert.equal(/"actor":"AGENT"/.test(log.text), false);
  const settled = await findMcpOperation(project, record.operationId);
  assert.equal(settled?.status, 'completed');
});
