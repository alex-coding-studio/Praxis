import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStartNode } from '../lib/graph/task/model.ts';
import { prepareScopeDecompositionMaterializationBasis } from '../lib/modules/scope-decomposition/basis.ts';
import { materializeScopeDecompositionResult } from '../lib/modules/scope-decomposition/materializer.ts';
import type {
  ScopeDecompositionCandidate,
  ScopeDecompositionResult,
} from '../lib/modules/scope-decomposition/contract.ts';
import type { GraphReference } from '../lib/graph/proposal/reference.ts';
import type { GraphProposalCurrentCandidate } from '../lib/graph/proposal/basis.ts';
import type { TaskDecompositionIntention } from '../lib/modules/scope-decomposition/intention.ts';
import type { TaskDecompositionMotion } from '../lib/modules/scope-decomposition/motion.ts';
import { MaterializationError } from '../lib/materialization/receipt.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'sd-materialize-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project: RegisteredProject = {
    id: 'scope-project',
    name: 'Scope fixture',
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

function candidate(
  localKey: string,
  sourceNodeId: string,
  dependsOn: GraphReference[] = [],
  metadata: Record<string, unknown> = {},
): ScopeDecompositionCandidate {
  return {
    localKey,
    type: 'module',
    title: 'A bounded unit of work',
    summary: 'One bounded unit of work.',
    derivedFrom: [{ kind: 'node' as const, id: sourceNodeId }],
    dependsOn,
    resources: [],
    typeTemplateRef: null,
    metadata,
    presentation: {},
    assumptions: [],
  };
}

function subject(sourceNodeId: string) {
  return {
    intention: 'understanding' as TaskDecompositionIntention,
    motion: 'unspecified' as TaskDecompositionMotion,
    knownNodeIds: [sourceNodeId],
    acceptedCandidateIds: [],
    knownResourcePaths: [],
    reservedCandidateIds: [],
    currentCandidates: [] as GraphProposalCurrentCandidate[],
  };
}

async function proposeBasis(
  project: RegisteredProject,
  sourceNodeId: string,
  overrides: Partial<ReturnType<typeof subject>> = {},
) {
  return prepareScopeDecompositionMaterializationBasis(project, {
    ...subject(sourceNodeId),
    ...overrides,
    operation: 'propose',
  });
}

async function recomposeBasis(
  project: RegisteredProject,
  sourceNodeId: string,
  recomposeCandidateIds: string[],
  currentCandidates: GraphProposalCurrentCandidate[],
) {
  return prepareScopeDecompositionMaterializationBasis(project, {
    ...subject(sourceNodeId),
    currentCandidates,
    operation: 'recompose-candidates',
    recomposeCandidateIds,
  });
}

async function identityIndex(project: RegisteredProject) {
  return JSON.parse(
    await readFile(
      path.join(project.planningPath, 'task-graph', 'identities.json'),
      'utf8',
    ),
  ) as { aliases: Record<string, string> };
}

void test('a semantic result with no Harness anywhere materializes into identified Candidates', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const basis = await proposeBasis(project, sourceNodeId);
  const materialized = await materializeScopeDecompositionResult(basis, {
    outcome: 'proposal',
    candidates: [
      candidate('capture', sourceNodeId),
      candidate('render', sourceNodeId, [
        { kind: 'proposal', localKey: 'capture' },
      ]),
    ],
  });
  assert.ok(materialized);
  const [first, second] = materialized.candidates;
  assert.ok(first && second);
  assert.match(first.candidateId, /^CANDIDATE-[0-9a-f]{8,}$/);
  assert.equal(first.revision, 1);
  assert.deepEqual(second.dependsOn, [first.candidateId]);
  assert.deepEqual(second.relations.dependsOn, [first.uid]);
  assert.deepEqual(materialized.candidateAliases, {
    capture: first.candidateId,
    render: second.candidateId,
  });
  assert.equal(materialized.effects, null);
});

void test('the Materializer validates a direct semantic result rather than trusting it', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const before = await identityIndex(project);
  const cases: Array<
    [Partial<ReturnType<typeof subject>>, ScopeDecompositionResult]
  > = [
    [
      { intention: 'delivery' },
      {
        outcome: 'proposal',
        candidates: [candidate('capture', sourceNodeId)],
      },
    ],
    [
      { motion: 'converge' },
      {
        outcome: 'proposal',
        candidates: [
          candidate('capture', sourceNodeId),
          candidate('render', sourceNodeId),
        ],
      },
    ],
    [
      {},
      {
        outcome: 'proposal',
        candidates: [
          candidate('capture', sourceNodeId, [
            { kind: 'node', id: 'NODE-00000099' },
          ]),
        ],
      },
    ],
  ];
  for (const [overrides, result] of cases) {
    const basis = await proposeBasis(project, sourceNodeId, overrides);
    await assert.rejects(
      () => materializeScopeDecompositionResult(basis, result),
      MaterializationError,
    );
    assert.deepEqual(await identityIndex(project), before);
  }
});

void test('a recomposition resolves its effects and refuses an incomplete plan', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const selected = ['CANDIDATE-aaaaaaaa', 'CANDIDATE-bbbbbbbb'];
  const currentCandidates = selected.map((candidateId) => ({
    candidateId,
    revision: 1,
    dependsOn: [],
  }));
  const incomplete = await recomposeBasis(
    project,
    sourceNodeId,
    selected,
    currentCandidates,
  );
  const before = await identityIndex(project);
  await assert.rejects(
    () =>
      materializeScopeDecompositionResult(incomplete, {
        outcome: 'proposal',
        candidates: [candidate('merged', sourceNodeId)],
        recomposition: {
          effects: [
            {
              kind: 'replace',
              from: [{ kind: 'candidate', id: selected[0]! }],
              to: [{ kind: 'proposal', localKey: 'merged' }],
            },
          ],
        },
      }),
    (error: unknown) =>
      error instanceof MaterializationError &&
      /must have exactly one effect/.test(error.message),
  );
  assert.deepEqual(await identityIndex(project), before);

  const basis = await recomposeBasis(
    project,
    sourceNodeId,
    selected,
    currentCandidates,
  );
  const materialized = await materializeScopeDecompositionResult(basis, {
    outcome: 'proposal',
    candidates: [candidate('merged', sourceNodeId)],
    recomposition: {
      effects: [
        {
          kind: 'merge',
          from: selected.map((id) => ({ kind: 'candidate' as const, id })),
          to: [{ kind: 'proposal', localKey: 'merged' }],
        },
      ],
    },
  });
  assert.ok(materialized);
  const merged = materialized.candidates[0]!.candidateId;
  assert.deepEqual(materialized.effects, [
    { kind: 'merge', from: selected, to: [merged] },
  ]);
});

void test('a non-proposal outcome materializes nothing', async (t) => {
  const { project, sourceNodeId } = await fixture(t);
  const basis = await proposeBasis(project, sourceNodeId);
  const before = await identityIndex(project);
  assert.equal(
    await materializeScopeDecompositionResult(basis, {
      outcome: 'insufficient-evidence',
      missingEvidence: ['The source does not state the intended audience.'],
    }),
    null,
  );
  assert.deepEqual(await identityIndex(project), before);
});
