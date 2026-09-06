import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStartNode } from '../lib/graph/task/model.ts';
import { prepareScopeDecompositionMaterializationBasis } from '../lib/modules/scope-decomposition/basis.ts';
import { submitScopeDecompositionResult } from '../lib/modules/scope-decomposition/publish.ts';
import { successfulRecomposeSupersededCandidateIds } from '../lib/graph/agent/recompose.ts';
import {
  listLatestTaskDecompositionRuns,
  readTaskDecompositionRun,
} from '../lib/modules/scope-decomposition/runs.ts';
import type { ScopeDecompositionResult } from '../lib/modules/scope-decomposition/contract.ts';
import { MaterializationError } from '../lib/materialization/receipt.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'sd-submit-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project: RegisteredProject = {
    id: 'submission-project',
    name: 'Submission fixture',
    kind: 'standalone',
    rootPath,
    codePath: null,
    planningPath: path.join(rootPath, '.praxis'),
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await mkdir(project.planningPath);
  const start = await createStartNode(
    project,
    {
      title: 'Build my local website',
      idea: 'Build it',
      contextRefs: [],
      files: [],
    },
    'task-graph',
  );
  return { project, sourceNodeId: start.node.id };
}

function candidate(localKey: string, sourceNodeId: string) {
  return {
    localKey,
    type: 'module',
    title: 'Capture the source',
    summary: 'One bounded unit of work.',
    derivedFrom: [{ kind: 'node' as const, id: sourceNodeId }],
    dependsOn: [],
    resources: [],
    typeTemplateRef: null,
    metadata: {},
    presentation: {},
    assumptions: ['The source already describes the intended outcome.'],
  };
}

async function basisFor(project: RegisteredProject, sourceNodeId: string) {
  return prepareScopeDecompositionMaterializationBasis(project, {
    operation: 'propose',
    intention: 'understanding',
    motion: 'unspecified',
    knownNodeIds: [sourceNodeId],
    acceptedCandidateIds: [],
    knownResourcePaths: [],
    reservedCandidateIds: [],
    currentCandidates: [],
  });
}

void test('a direct producer publishes a decomposition the graph can read', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const basis = await basisFor(project, sourceNodeId);
  const result: ScopeDecompositionResult = {
    outcome: 'proposal',
    candidates: [candidate('capture', sourceNodeId)],
  };
  const published = await submitScopeDecompositionResult(basis, result, {
    sourceNodeId,
  });

  assert.match(published.runId, /^RUN-[0-9a-f-]{36}$/);
  const [record] = published.candidates;
  assert.ok(record);
  assert.match(record.candidateId, /^CANDIDATE-[0-9a-f]{8,}$/);
  assert.equal(record.revision, 1);
  assert.deepEqual(published.candidateAliases, { capture: record.candidateId });
  assert.equal(published.effects, null);

  const document = published.candidatePaths[record.candidateId];
  assert.ok(document);
  assert.match(
    await readFile(path.join(project.planningPath, document), 'utf8'),
    /Capture the source/,
  );

  const reread = await readTaskDecompositionRun(project, published.runId);
  assert.equal(reread.status, 'proposal');
  assert.ok(reread.result?.outcome === 'proposal');
  assert.deepEqual(
    reread.result.candidates.map((entry) => entry.candidateId),
    [record.candidateId],
  );
  assert.deepEqual(
    (await listLatestTaskDecompositionRuns(project)).map(
      (entry) => entry.runId,
    ),
    [published.runId],
    'a directly submitted decomposition must be visible to the graph readers',
  );
});

void test('a direct submission that fails validation publishes nothing', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const basis = await basisFor(project, sourceNodeId);
  const before = await readFile(
    path.join(project.planningPath, 'task-graph', 'identities.json'),
    'utf8',
  );
  await assert.rejects(
    () =>
      submitScopeDecompositionResult(
        basis,
        {
          outcome: 'proposal',
          candidates: [
            {
              ...candidate('capture', sourceNodeId),
              derivedFrom: [{ kind: 'node', id: 'NODE-00000099' }],
            },
          ],
        },
        { sourceNodeId },
      ),
    MaterializationError,
  );
  assert.equal(
    await readFile(
      path.join(project.planningPath, 'task-graph', 'identities.json'),
      'utf8',
    ),
    before,
  );
});

void test('a direct insufficient-evidence outcome creates no Candidate', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const basis = await basisFor(project, sourceNodeId);
  const published = await submitScopeDecompositionResult(
    basis,
    {
      outcome: 'insufficient-evidence',
      missingEvidence: ['The source does not state the intended audience.'],
    },
    { sourceNodeId },
  );
  assert.equal(published.outcome, 'insufficient-evidence');
  assert.deepEqual(published.candidates, []);
  assert.deepEqual(published.candidatePaths, {});
});

void test('a direct Recompose supersedes the Candidates it selected', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const first = await submitScopeDecompositionResult(
    await basisFor(project, sourceNodeId),
    { outcome: 'proposal', candidates: [candidate('capture', sourceNodeId)] },
    { sourceNodeId },
  );
  const superseded = first.candidates[0]!.candidateId;

  const recomposeBasis = await prepareScopeDecompositionMaterializationBasis(
    project,
    {
      operation: 'recompose-candidates',
      recomposeCandidateIds: [superseded],
      intention: 'understanding',
      motion: 'unspecified',
      knownNodeIds: [sourceNodeId],
      acceptedCandidateIds: [],
      knownResourcePaths: [],
      reservedCandidateIds: [],
      currentCandidates: [
        { candidateId: superseded, revision: 1, dependsOn: [] },
      ],
    },
  );
  const recomposed = await submitScopeDecompositionResult(
    recomposeBasis,
    {
      outcome: 'proposal',
      candidates: [candidate('replacement', sourceNodeId)],
      recomposition: {
        effects: [
          {
            kind: 'replace',
            from: [{ kind: 'candidate', id: superseded }],
            to: [{ kind: 'proposal', localKey: 'replacement' }],
          },
        ],
      },
    },
    { sourceNodeId },
  );

  const stored = await readTaskDecompositionRun(project, recomposed.runId);
  assert.deepEqual(
    stored.recomposeCandidateIds,
    [superseded],
    'a direct Recompose must persist the working set the readers use',
  );
  assert.deepEqual(
    [
      ...successfulRecomposeSupersededCandidateIds(
        await listLatestTaskDecompositionRuns(project),
      ),
    ],
    [superseded],
    'the replaced Candidate must leave the current working set',
  );
});

void test('a direct append keeps the earlier Candidates alongside the new one', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const first = await submitScopeDecompositionResult(
    await basisFor(project, sourceNodeId),
    { outcome: 'proposal', candidates: [candidate('capture', sourceNodeId)] },
    { sourceNodeId },
  );
  const existing = first.candidates[0]!.candidateId;

  const appended = await submitScopeDecompositionResult(
    await prepareScopeDecompositionMaterializationBasis(project, {
      operation: 'append-candidates',
      intention: 'understanding',
      motion: 'unspecified',
      knownNodeIds: [sourceNodeId],
      acceptedCandidateIds: [],
      knownResourcePaths: [],
      reservedCandidateIds: [existing],
      currentCandidates: [
        { candidateId: existing, revision: 1, dependsOn: [] },
      ],
    }),
    { outcome: 'proposal', candidates: [candidate('render', sourceNodeId)] },
    { sourceNodeId },
  );

  const added = appended.candidates[0]!.candidateId;
  assert.notEqual(added, existing);
  const runs = await listLatestTaskDecompositionRuns(project);
  assert.deepEqual(
    runs
      .flatMap((run) =>
        run.result?.outcome === 'proposal' ? run.result.candidates : [],
      )
      .map((entry) => entry.candidateId)
      .sort(),
    [existing, added].sort(),
    'an appended submission must not displace the earlier Candidates',
  );
});

void test('a direct revision keeps the Candidate identity and advances its revision', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const first = await submitScopeDecompositionResult(
    await basisFor(project, sourceNodeId),
    { outcome: 'proposal', candidates: [candidate('capture', sourceNodeId)] },
    { sourceNodeId },
  );
  const original = first.candidates[0]!;

  const revised = await submitScopeDecompositionResult(
    await prepareScopeDecompositionMaterializationBasis(project, {
      operation: 'revise-candidate',
      revisionTarget: {
        candidateId: original.candidateId,
        revision: original.revision,
        uid: original.uid,
      },
      intention: 'understanding',
      motion: 'unspecified',
      knownNodeIds: [sourceNodeId],
      acceptedCandidateIds: [],
      knownResourcePaths: [],
      reservedCandidateIds: [],
      currentCandidates: [
        {
          candidateId: original.candidateId,
          revision: original.revision,
          dependsOn: [],
        },
      ],
    }),
    {
      outcome: 'proposal',
      candidates: [
        {
          ...candidate(original.candidateId, sourceNodeId),
          title: 'Capture the source precisely',
        },
      ],
    },
    { sourceNodeId },
  );

  const record = revised.candidates[0]!;
  assert.equal(record.candidateId, original.candidateId);
  assert.equal(record.uid, original.uid);
  assert.equal(record.revision, original.revision + 1);
  assert.equal(revised.candidateAliases, null);
});
