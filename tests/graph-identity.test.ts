import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  bindIdentity,
  identifyEntity,
  candidatePromptView,
  uuidAlias,
  graphCardLabel,
  type GraphIdentityIndex,
} from '../lib/graph/identity.ts';
import {
  allocateCandidateAliases,
  ensureGraphIdentities,
  identitiesFingerprint,
  readIdentifiedEntities,
  reserveNodeIdentity,
  reservedCandidateAliases,
} from '../lib/graph/identity-store.ts';
import { resolveProposalCandidates } from '../lib/graph/proposal/resolve.ts';
import { validateGraphProposal } from '../lib/graph/proposal/validate.ts';
import type { GraphProposalCandidate } from '../lib/graph/proposal/contract.ts';
import type { GraphReference } from '../lib/graph/proposal/reference.ts';
import { buildTaskGraphLayout } from '../lib/graph/task/layout.ts';
import type { TaskGraphNode } from '../lib/graph/task/model.ts';
import {} from '../lib/modules/product-discovery/harness.ts';
import {} from '../lib/modules/scope-decomposition/harness.ts';
import { buildWhatsNextContinuationPrompt } from '../lib/modules/product-discovery/prompt.ts';
import { buildTaskDecompositionContinuationPrompt } from '../lib/modules/scope-decomposition/prompt.ts';

async function save(root: string, file: string, value: unknown) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value));
}

void test('identity scans ignore incomplete Run directories without hiding Node corruption', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graph-orphan-run-'));
  try {
    await mkdir(path.join(root, 'whats-next/runs/RUN-incomplete'), {
      recursive: true,
    });
    await ensureGraphIdentities(root, 'whats-next', true);
    assert.equal(
      JSON.parse(
        await readFile(path.join(root, 'whats-next/identities.json'), 'utf8'),
      ).schemaVersion,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function json(root: string, file: string) {
  return JSON.parse(await readFile(path.join(root, file), 'utf8'));
}

void test('card labels preserve Node and Candidate prefixes and full allocated suffixes', () => {
  assert.equal(graphCardLabel('CANDIDATE-db6d8a4e'), 'Candidate-db6d8a4e');
  assert.equal(graphCardLabel('NODE-db6d8a4e'), 'Node-db6d8a4e');
  assert.equal(
    graphCardLabel('CANDIDATE-2222abcdef12'),
    'Candidate-2222abcdef12',
  );
  assert.equal(
    graphCardLabel('RUN-f7d2edb7-8055-40b1-827b-dec0db6d8a4e'),
    'Run-db6d8a4e',
  );
});

void test('UUID suffix collisions extend only the new alias and promotion retains the suffix', () => {
  const index: GraphIdentityIndex = {
    schemaVersion: 1,
    aliases: {},
    formalAliases: [],
  };
  const first = '10000000-0000-4000-8000-1111abcdef12';
  const second = '20000000-0000-4000-8000-2222abcdef12';
  const firstAlias = uuidAlias(index, 'CANDIDATE', first);
  bindIdentity(index, firstAlias, first);
  const secondAlias = uuidAlias(index, 'CANDIDATE', second);
  bindIdentity(index, secondAlias, second);
  assert.equal(firstAlias, 'CANDIDATE-abcdef12');
  assert.equal(secondAlias, 'CANDIDATE-2222abcdef12');
  assert.equal(uuidAlias(index, 'NODE', first), 'NODE-abcdef12');
  assert.equal(uuidAlias(index, 'NODE', second), 'NODE-2222abcdef12');
});

function proposalCandidate(
  localKey: string,
  derivedFrom: string[],
  dependsOn: GraphReference[] = [],
): GraphProposalCandidate {
  return {
    localKey,
    type: 'module',
    title: 'A useful next step',
    summary: 'One bounded piece of product meaning.',
    derivedFrom: derivedFrom.map((id) => ({ kind: 'node', id })),
    dependsOn,
    resources: [],
    typeTemplateRef: null,
    metadata: {},
    presentation: {},
    assumptions: [],
  };
}

for (const scope of ['whats-next', 'task-graph'] as const) {
  void test(`${scope}: minted aliases avoid existing identities and structured links survive promotion`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graph-alias-test-'));
    try {
      await save(root, `${scope}/nodes/NODE-00000002/node.json`, {
        id: 'NODE-00000002',
      });
      const materialize = async (
        candidates: GraphProposalCandidate[],
        revisionTarget?: { candidateId: string; revision: number; uid: string },
      ) => {
        const fingerprint = await identitiesFingerprint(root, scope);
        const { aliases, index } = await allocateCandidateAliases(
          root,
          scope,
          {
            localKeys: candidates.map((candidate) => candidate.localKey),
            revisionTarget,
          },
          fingerprint,
        );
        return {
          aliases: Object.fromEntries(aliases),
          candidates: resolveProposalCandidates(candidates, {
            aliases,
            index,
            revision: revisionTarget ? revisionTarget.revision + 1 : 1,
          }),
        };
      };

      const first = await materialize([
        proposalCandidate('first-step', ['NODE-00000002']),
        proposalCandidate(
          'second-step',
          ['NODE-00000002'],
          [{ kind: 'proposal', localKey: 'first-step' }],
        ),
      ]);
      const [a, b] = first.candidates;
      assert.ok(a && b);
      assert.equal(a.candidateId, `CANDIDATE-${a.uid.slice(-8)}`);
      assert.notEqual(a.candidateId, 'NODE-00000002');
      assert.deepEqual(b.dependsOn, [a.candidateId]);
      assert.deepEqual(b.relations.dependsOn, [a.uid]);
      assert.deepEqual(first.aliases, {
        'first-step': a.candidateId,
        'second-step': b.candidateId,
      });
      const index = await json(root, `${scope}/identities.json`);
      assert.equal(index.aliases[a.candidateId], a.uid);
      assert.equal(index.nextNodeNumber, undefined);

      const later = await materialize([
        proposalCandidate(
          'third-step',
          ['NODE-00000002'],
          [
            { kind: 'candidate', id: b.candidateId },
            { kind: 'node', id: 'NODE-00000002' },
          ],
        ),
      ]);
      assert.deepEqual(later.candidates[0]!.relations.dependsOn, [
        b.uid,
        index.aliases['NODE-00000002'],
      ]);
      assert.equal(
        new Set(
          [...first.candidates, ...later.candidates].map(
            (candidate) => candidate.candidateId,
          ),
        ).size,
        3,
      );

      const beforeFailure = await readFile(
        path.join(root, scope, 'identities.json'),
        'utf8',
      );
      for (const localKeys of [
        ['duplicate-key', 'duplicate-key'],
        ['../invalid'],
      ]) {
        await assert.rejects(() =>
          materialize(
            localKeys.map((key) => proposalCandidate(key, ['NODE-00000002'])),
          ),
        );
        assert.equal(
          await readFile(path.join(root, scope, 'identities.json'), 'utf8'),
          beforeFailure,
        );
      }
      assert.throws(
        () =>
          validateGraphProposal(
            {
              knownNodeIds: ['NODE-00000002'],
              acceptedCandidateIds: [],
              knownResourcePaths: [],
              reservedCandidateIds: [],
              currentCandidates: [],
              revisionTarget: null,
            },
            [
              proposalCandidate(
                'dangling',
                ['NODE-00000002'],
                [{ kind: 'proposal', localKey: 'absent-sibling' }],
              ),
            ],
          ),
        /unknown proposal key/,
      );
      assert.equal(
        await readFile(path.join(root, scope, 'identities.json'), 'utf8'),
        beforeFailure,
      );

      const refined = await materialize(
        [proposalCandidate(a.candidateId, ['NODE-00000002'])],
        { candidateId: a.candidateId, revision: 1, uid: a.uid },
      );
      assert.equal(refined.candidates[0]!.uid, a.uid);
      assert.equal(refined.candidates[0]!.candidateId, a.candidateId);
      assert.equal(refined.candidates[0]!.revision, 2);

      const formal = await reserveNodeIdentity(root, scope, a.uid);
      assert.equal(formal.id, a.candidateId.replace('CANDIDATE-', 'NODE-'));
      assert.equal(formal.uid, a.uid);
      const [child] = await readIdentifiedEntities(root, scope, [b]);
      assert.deepEqual(child!.relations.dependsOn, [formal.uid]);
      await save(root, `${scope}/nodes/${formal.id}/node.json`, {
        ...formal,
        derivedFrom: ['NODE-00000002'],
      });
      await ensureGraphIdentities(root, scope, true);
      const [promoted] = await readIdentifiedEntities(root, scope, [b]);
      assert.deepEqual(promoted!.dependsOn, [formal.id]);

      const descendant = await materialize([
        proposalCandidate('after-promotion', [formal.id]),
      ]);
      assert.deepEqual(descendant.candidates[0]!.relations.derivedFrom, [
        formal.uid,
      ]);

      const prompt = (
        scope === 'whats-next'
          ? buildWhatsNextContinuationPrompt
          : buildTaskDecompositionContinuationPrompt
      )({ previousProposalAliases: first.aliases });
      assert.ok(prompt.includes(a.candidateId));
      assert.match(prompt, /previousProposalAliases/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const scope of ['whats-next', 'task-graph'] as const) {
  void test(`${scope}: legacy migration retains identities across history, acceptance, expansion and reload`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'graph-identity-test-'));
    try {
      const runs = scope === 'task-graph' ? 'task-decomposition' : scope;
      const source = { id: 'NODE-00000001', dependsOn: [] };
      const candidate = {
        candidateId: 'CANDIDATE-00000001',
        revision: 1,
        derivedFrom: [source.id],
        dependsOn: [],
      };
      const sibling = {
        candidateId: 'CANDIDATE-00000002',
        revision: 1,
        derivedFrom: [source.id],
        dependsOn: [candidate.candidateId],
      };
      const accepted = {
        id: 'NODE-00000002',
        derivedFrom: [source.id],
        dependsOn: [],
        provenance: {
          candidateId: candidate.candidateId,
          revision: 2,
          runId: 'RUN-second',
        },
      };
      const firstRun = {
        result: { outcome: 'proposal', candidates: [candidate, sibling] },
      };
      await save(root, `${scope}/nodes/NODE-00000001/node.json`, source);
      await save(root, `${scope}/nodes/NODE-00000002/node.json`, accepted);
      await save(root, `${runs}/runs/RUN-first/run.json`, firstRun);
      await save(root, `${runs}/runs/RUN-second/run.json`, {
        result: {
          outcome: 'proposal',
          candidates: [{ ...candidate, revision: 2 }],
        },
      });
      await writeFile(
        path.join(root, scope, 'nodes/NODE-00000002/output.md'),
        '# Preserve this Markdown\n',
      );

      await ensureGraphIdentities(root, scope);
      const start = await json(root, `${scope}/nodes/NODE-00000001/node.json`);
      const promoted = await json(
        root,
        `${scope}/nodes/NODE-00000002/node.json`,
      );
      const first = await json(root, `${runs}/runs/RUN-first/run.json`);
      const second = await json(root, `${runs}/runs/RUN-second/run.json`);
      assert.equal(promoted.uid, first.result.candidates[0].uid);
      assert.equal(promoted.uid, second.result.candidates[0].uid);
      assert.deepEqual(promoted.relations.derivedFrom, [start.uid]);
      assert.deepEqual(first.result.candidates[1].relations.dependsOn, [
        promoted.uid,
      ]);
      const [displaySibling] = await readIdentifiedEntities(root, scope, [
        first.result.candidates[1],
      ]);
      assert.deepEqual(displaySibling!.dependsOn, ['NODE-00000002']);
      assert.deepEqual(displaySibling!.relations.dependsOn, [promoted.uid]);
      assert.deepEqual(
        await json(
          root,
          `${scope}/identity-migration-backup/${runs}/runs/RUN-first/run.json`,
        ),
        firstRun,
      );
      assert.equal(
        await readFile(
          path.join(root, scope, 'nodes/NODE-00000002/output.md'),
          'utf8',
        ),
        '# Preserve this Markdown\n',
      );

      const childFingerprint = await identitiesFingerprint(root, scope);
      const childAllocation = await allocateCandidateAliases(
        root,
        scope,
        { localKeys: ['descendant'] },
        childFingerprint,
      );
      const [child] = resolveProposalCandidates(
        [
          proposalCandidate(
            'descendant',
            ['NODE-00000002'],
            [{ kind: 'candidate', id: 'CANDIDATE-00000002' }],
          ),
        ],
        {
          aliases: childAllocation.aliases,
          index: childAllocation.index,
          revision: 1,
        },
      );
      assert.notEqual(child!.uid, promoted.uid);
      assert.deepEqual(child!.relations.derivedFrom, [promoted.uid]);
      assert.deepEqual(child!.relations.dependsOn, [
        first.result.candidates[1].uid,
      ]);
      const revisionFingerprint = await identitiesFingerprint(root, scope);
      const revisionAllocation = await allocateCandidateAliases(
        root,
        scope,
        {
          localKeys: [candidate.candidateId],
          revisionTarget: {
            candidateId: candidate.candidateId,
            revision: 2,
            uid: second.result.candidates[0].uid,
          },
        },
        revisionFingerprint,
      );
      const [refined] = resolveProposalCandidates(
        [proposalCandidate(candidate.candidateId, [source.id])],
        {
          aliases: revisionAllocation.aliases,
          index: revisionAllocation.index,
          revision: 3,
        },
      );
      assert.equal(refined!.uid, promoted.uid);
      assert.deepEqual(await reserveNodeIdentity(root, scope, promoted.uid), {
        id: 'NODE-00000002',
        uid: promoted.uid,
      });

      await ensureGraphIdentities(root, scope, true);
      assert.equal(
        (await json(root, `${scope}/nodes/NODE-00000002/node.json`)).uid,
        promoted.uid,
      );
      assert.deepEqual(
        await json(
          root,
          `${scope}/identity-migration-backup/${runs}/runs/RUN-first/run.json`,
        ),
        firstRun,
      );
      await rm(path.join(root, scope, 'nodes/NODE-00000002'), {
        recursive: true,
      });
      const replacement = await reserveNodeIdentity(root, scope);
      assert.equal(replacement.id, `NODE-${replacement.uid.slice(-8)}`);
      assert.notEqual(replacement.uid, promoted.uid);
      assert.deepEqual(child!.relations.derivedFrom, [promoted.uid]);
      assert.ok(
        (await reservedCandidateAliases(root, scope)).includes(
          child!.candidateId,
        ),
      );
      await assert.rejects(
        async () =>
          allocateCandidateAliases(
            root,
            scope,
            {
              localKeys: [candidate.candidateId],
              revisionTarget: {
                candidateId: candidate.candidateId,
                revision: 2,
                uid: randomUUID(),
              },
            },
            await identitiesFingerprint(root, scope),
          ),
        /does not hold the stable identity/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

void test('conflicting legacy identity claims fail before rewriting records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graph-identity-test-'));
  try {
    const first = {
      result: {
        outcome: 'proposal',
        candidates: [{ candidateId: 'CANDIDATE-00000001', uid: randomUUID() }],
      },
    };
    const second = {
      result: {
        outcome: 'proposal',
        candidates: [{ candidateId: 'CANDIDATE-00000001', uid: randomUUID() }],
      },
    };
    await save(root, 'whats-next/runs/RUN-first/run.json', first);
    await save(root, 'whats-next/runs/RUN-second/run.json', second);
    await assert.rejects(
      () => ensureGraphIdentities(root, 'whats-next'),
      /cannot change/,
    );
    assert.deepEqual(
      await json(root, 'whats-next/runs/RUN-first/run.json'),
      first,
    );
    assert.deepEqual(
      await json(root, 'whats-next/runs/RUN-second/run.json'),
      second,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('missing legacy targets remain unresolved rather than binding to a new object', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graph-identity-test-'));
  try {
    await save(root, 'whats-next/runs/RUN-first/run.json', {
      result: {
        outcome: 'proposal',
        candidates: [
          { candidateId: 'CANDIDATE-00000001', derivedFrom: ['NODE-00000005'] },
        ],
      },
    });
    await ensureGraphIdentities(root, 'whats-next');
    const run = await json(root, 'whats-next/runs/RUN-first/run.json');
    const candidate = run.result.candidates[0];
    const fresh = await reserveNodeIdentity(root, 'whats-next');
    assert.equal(fresh.id, `NODE-${fresh.uid.slice(-8)}`);
    assert.notEqual(candidate.relations.derivedFrom[0], fresh.uid);
    const [display] = await readIdentifiedEntities(root, 'whats-next', [
      candidate,
    ]);
    assert.deepEqual(display!.derivedFrom, ['NODE-00000005']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('allocations are serialized and graph aliases are scoped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'graph-identity-test-'));
  try {
    const allocations = await Promise.all(
      Array.from({ length: 12 }, () => reserveNodeIdentity(root, 'whats-next')),
    );
    assert.equal(new Set(allocations.map((entry) => entry.id)).size, 12);
    assert.equal(new Set(allocations.map((entry) => entry.uid)).size, 12);
    const otherGraph = await reserveNodeIdentity(root, 'task-graph');
    assert.equal(otherGraph.id, `NODE-${otherGraph.uid.slice(-8)}`);
    assert.notEqual(otherGraph.uid, allocations[0]!.uid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('identity reassignment is rejected and prompt aliases remain lightweight', () => {
  const index: GraphIdentityIndex = {
    schemaVersion: 1,
    aliases: {},
    formalAliases: [],
  };
  const uid = randomUUID();
  bindIdentity(index, 'CANDIDATE-00000001', uid);
  assert.throws(
    () => bindIdentity(index, 'CANDIDATE-00000001', randomUUID()),
    /cannot change/,
  );
  const candidate = identifyEntity(
    { candidateId: 'CANDIDATE-00000001' },
    index,
  );
  assert.equal(candidatePromptView(candidate).uid, undefined);
  assert.equal(candidatePromptView(candidate).relations, undefined);
  assert.equal(
    candidatePromptView(candidate).candidateId,
    'CANDIDATE-00000001',
  );
});

void test('stable relation endpoints and layout survive promotion even with stale display aliases', () => {
  const rootUid = randomUUID();
  const firstUid = randomUUID();
  const secondUid = randomUUID();
  const root = {
    id: 'NODE-00000001',
    uid: rootUid,
    dependsOn: [],
  } as unknown as TaskGraphNode;
  const first = {
    id: 'CANDIDATE-00000001',
    uid: firstUid,
    sourceNodeId: root.id,
    instruction: '',
    inheritedResourceCount: 0,
    additionalResourceCount: 0,
    relations: { derivedFrom: [rootUid], dependsOn: [] },
  };
  const second = {
    ...first,
    id: 'CANDIDATE-00000002',
    uid: secondUid,
    relations: { derivedFrom: [rootUid], dependsOn: [firstUid] },
  };
  const before = buildTaskGraphLayout([root], [first, second]);
  const formal = {
    id: 'NODE-00009999',
    uid: firstUid,
    relations: first.relations,
    derivedFrom: ['OUTDATED-ALIAS'],
    dependsOn: [],
  } as unknown as TaskGraphNode;
  const after = buildTaskGraphLayout([formal, root], [second]);
  for (const original of before.nodes) {
    const updated = after.nodes.find((node) => node.uid === original.uid)!;
    assert.deepEqual([updated.x, updated.y], [original.x, original.y]);
  }
  assert.ok(
    after.edges.some(
      (edge) =>
        edge.source === second.id &&
        edge.target === formal.id &&
        edge.relation === 'dependency',
    ),
  );
  assert.ok(
    after.edges.some(
      (edge) => edge.source === root.id && edge.target === formal.id,
    ),
  );
});
