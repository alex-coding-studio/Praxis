import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStartNode } from '../lib/graph/task/model.ts';
import { prepareProductExplorationMaterializationBasis } from '../lib/modules/product-discovery/basis.ts';
import { publishProductExplorationResult } from '../lib/modules/product-discovery/publish.ts';
import {
  listLatestWhatsNextRuns,
  readWhatsNextRun,
} from '../lib/modules/product-discovery/runs.ts';
import {
  PRODUCT_EXPLORATION_RESULT_CONTRACT,
  type ProductExplorationResult,
} from '../lib/modules/product-discovery/contract.ts';
import { semanticResultHash } from '../lib/materialization/hash.ts';
import { MaterializationError } from '../lib/materialization/receipt.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'pe-submit-'));
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
    'whats-next',
  );
  return { project, sourceNodeId: start.node.id };
}

function candidate(localKey: string, sourceNodeId: string) {
  return {
    localKey,
    type: 'mvp',
    title: 'Capture the item',
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

async function basisFor(project: RegisteredProject, sourceNodeId: string) {
  return prepareProductExplorationMaterializationBasis(project, {
    operation: 'explore',
    intention: 'mvp-exploration',
    motion: 'unspecified',
    sourceNodeIds: [sourceNodeId],
    knownNodeIds: [sourceNodeId],
    acceptedCandidateIds: [],
    knownResourcePaths: [],
    reservedCandidateIds: [],
    currentCandidates: [],
  });
}

void test('a direct producer publishes Candidates without a provider, envelope or Session', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const basis = await basisFor(project, sourceNodeId);
  const result: ProductExplorationResult = {
    outcome: 'proposal',
    candidates: [candidate('capture', sourceNodeId)],
  };
  const published = await publishProductExplorationResult(basis, result, {
    kind: 'direct',
    sourceNodeIds: [sourceNodeId],
  });

  assert.match(published.runId, /^RUN-[0-9a-f-]{36}$/);
  assert.equal(published.outcome, 'proposal');
  const [record] = published.candidates;
  assert.ok(record);
  assert.match(record.candidateId, /^CANDIDATE-[0-9a-f]{8,}$/);
  assert.equal(record.revision, 1);
  assert.deepEqual(record.derivedFrom, [sourceNodeId]);
  assert.deepEqual(published.candidateAliases, { capture: record.candidateId });

  const document = published.candidatePaths[record.candidateId];
  assert.ok(document);
  assert.match(
    await readFile(path.join(project.planningPath, document), 'utf8'),
    /^# Capture the item\n/,
  );

  const stored = JSON.parse(
    await readFile(
      path.join(
        project.planningPath,
        'whats-next',
        'runs',
        published.runId,
        'run.json',
      ),
      'utf8',
    ),
  ) as {
    status: string;
    result: { candidates: Array<{ candidateId: string }> };
  };
  assert.equal(stored.status, 'proposal');
  assert.deepEqual(
    stored.result.candidates.map((entry) => entry.candidateId),
    [record.candidateId],
  );

  const reread = await readWhatsNextRun(project, published.runId);
  assert.equal(reread.status, 'proposal');
  assert.ok(reread.result?.outcome === 'proposal');
  assert.deepEqual(
    reread.result.candidates.map((entry) => entry.candidateId),
    [record.candidateId],
  );
  assert.deepEqual(
    (await listLatestWhatsNextRuns(project)).map((entry) => entry.runId),
    [published.runId],
    'a directly submitted proposal must be visible to the graph readers',
  );
});

void test('a direct submission that fails validation publishes nothing', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const basis = await basisFor(project, sourceNodeId);
  const before = await readFile(
    path.join(project.planningPath, 'whats-next', 'identities.json'),
    'utf8',
  );
  await assert.rejects(
    () =>
      publishProductExplorationResult(
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
        { kind: 'direct', sourceNodeIds: [sourceNodeId] },
      ),
    MaterializationError,
  );
  assert.equal(
    await readFile(
      path.join(project.planningPath, 'whats-next', 'identities.json'),
      'utf8',
    ),
    before,
  );
});

void test('a direct non-proposal outcome creates no Candidate', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const basis = await basisFor(project, sourceNodeId);
  const published = await publishProductExplorationResult(
    basis,
    {
      outcome: 'no-change',
      reason: 'The current direction already answers the question.',
    },
    { kind: 'direct', sourceNodeIds: [sourceNodeId] },
  );
  assert.equal(published.outcome, 'no-change');
  assert.deepEqual(published.candidates, []);
  assert.deepEqual(published.candidatePaths, {});
});

void test('a direct publication records a Receipt and its semantic result', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const basis = await basisFor(project, sourceNodeId);
  const result: ProductExplorationResult = {
    outcome: 'proposal',
    candidates: [candidate('capture', sourceNodeId)],
  };
  const events: string[] = [];
  const published = await publishProductExplorationResult(
    basis,
    result,
    { kind: 'direct', sourceNodeIds: [sourceNodeId] },
    () => '2026-09-06T00:00:00.000Z',
    (entry) => {
      assert.equal(entry.actor, 'HOST');
      events.push(entry.event);
    },
  );

  assert.deepEqual(events, [
    'materialization.validated',
    'materialization.identities.allocated',
    'materialization.staged',
    'materialization.published',
  ]);

  const receipt = published.record.materialization;
  assert.ok(receipt);
  assert.deepEqual(receipt.contract, {
    id: PRODUCT_EXPLORATION_RESULT_CONTRACT.id,
    version: PRODUCT_EXPLORATION_RESULT_CONTRACT.version,
    hash: PRODUCT_EXPLORATION_RESULT_CONTRACT.hash,
  });
  assert.deepEqual(receipt.producer, {
    kind: 'direct',
    runId: published.runId,
  });
  assert.deepEqual(receipt.basis, {
    fingerprint: basis.fingerprint,
    preparedAt: basis.preparedAt,
  });
  assert.equal(receipt.semanticResultHash, semanticResultHash(result));
  assert.equal(receipt.outcome, 'candidates');
  assert.deepEqual(receipt.affected.candidateIds, [
    published.candidates[0]!.candidateId,
  ]);
  assert.deepEqual(receipt.publication, {
    target: 'run-record',
    at: '2026-09-06T00:00:00.000Z',
    revision: null,
  });
  assert.equal(receipt.failure, null);

  const semantic = JSON.parse(
    await readFile(
      path.join(
        project.planningPath,
        'whats-next',
        'runs',
        published.runId,
        'semantic-result.json',
      ),
      'utf8',
    ),
  ) as { semanticResultHash: string; result: ProductExplorationResult };
  assert.equal(semantic.semanticResultHash, receipt.semanticResultHash);
  assert.deepEqual(semantic.result, result);
});

void test('a rejected direct submission reports the failing boundary', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const basis = await basisFor(project, sourceNodeId);
  const events: Array<{ event: string; level: string }> = [];
  await assert.rejects(
    publishProductExplorationResult(
      basis,
      {
        outcome: 'proposal',
        candidates: [candidate('capture', 'NODE-deadbeef')],
      },
      { kind: 'direct', sourceNodeIds: [sourceNodeId] },
      undefined,
      (entry) => events.push({ event: entry.event, level: entry.level }),
    ),
    (error: unknown) => error instanceof MaterializationError,
  );
  assert.deepEqual(events, [
    { event: 'materialization.rejected', level: 'ERROR' },
  ]);
});
