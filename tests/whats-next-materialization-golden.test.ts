import './helpers/register-redo-hooks.mjs';
import assert from 'node:assert/strict';
import {
  isReadableActivity,
  parseRunLogText,
} from '../lib/execution-observability/run-log-format.ts';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptWhatsNextCandidate,
  startWhatsNextRun,
} from '../lib/modules/product-discovery/runs.ts';
import {
  WHATS_NEXT_HARNESS_ID,
  WHATS_NEXT_HARNESS_REVISION,
} from '../lib/modules/product-discovery/harness.ts';
import {
  captureGraphState,
  createCanonicalizer,
  createGoldenProject,
  deferredLaunch,
  settledRun,
} from './helpers/graph-materialization-golden.ts';

const GOLDENS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/materialization/product-exploration',
);
const UPDATE = process.env.PRAXIS_UPDATE_GOLDENS === '1';

type StartedRun = {
  sessionId: string;
  requestId: string;
  inputFingerprint: string;
};

function envelope(
  started: StartedRun,
  sourceNodeId: string,
  candidates: Array<Record<string, unknown>>,
) {
  return {
    schemaVersion: 1,
    harness: {
      id: WHATS_NEXT_HARNESS_ID,
      revision: WHATS_NEXT_HARNESS_REVISION,
    },
    request: {
      sessionId: started.sessionId,
      requestId: started.requestId,
      inputFingerprint: started.inputFingerprint,
    },
    reflection: {
      markdown: 'The product needs one clear direction first.',
      continuationAdvice: {
        action: 'continue',
        recommendedFocus: 'concretize',
        reason: 'Turn the chosen direction into a bounded outcome.',
      },
    },
    exploration: { consideredNodeIds: [sourceNodeId], notes: [] },
    outcome: 'proposal',
    candidates,
  };
}

function candidate(
  candidateId: string,
  title: string,
  sourceNodeId: string,
  dependsOn: string[] = [],
  overrides: Record<string, unknown> = {},
) {
  return {
    candidateId,
    revision: 1,
    type: 'mvp',
    title,
    summary: `${title} stated as one bounded outcome.`,
    derivedFrom: [sourceNodeId],
    dependsOn,
    resources: [],
    typeTemplateRef: null,
    metadata: {},
    presentation: {},
    assumptions: ['The reader already has the source material.'],
    outputMarkdown: [
      `# ${title}`,
      '',
      '## Why this direction',
      '',
      '- It answers the stated need directly.',
      '- It can be judged without more evidence.',
      '',
      '## Assumptions',
      '',
      '- The reader already has the source material.',
      '',
    ].join('\n'),
    layer: 'discovery',
    artifactKind: 'mvp',
    ...overrides,
  };
}

function designCandidate(
  candidateId: string,
  title: string,
  sourceNodeId: string,
) {
  return candidate(candidateId, title, sourceNodeId, [], {
    type: 'feature',
    layer: 'product-design',
    artifactKind: 'feature',
  });
}

async function assertGolden(name: string, captured: Record<string, unknown>) {
  const file = path.join(GOLDENS, `${name}.json`);
  const serialized = `${JSON.stringify(captured, null, 2)}\n`;
  if (UPDATE) {
    await writeFile(file, serialized);
    return;
  }
  const expected = await readFile(file, 'utf8').catch(() => null);
  assert.ok(
    expected !== null,
    `missing golden ${name}; regenerate with PRAXIS_UPDATE_GOLDENS=1`,
  );
  assert.deepEqual(captured, JSON.parse(expected));
}

function request(
  sourceNodeId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    sourceNodeIds: [sourceNodeId],
    agent: 'codex' as const,
    instruction: 'Explore useful directions.',
    contextRefs: [],
    files: [],
    intention: 'mvp-exploration' as const,
    ...overrides,
  };
}

void test('an explored proposal materializes the same Candidates and identities', async (t) => {
  const { project, source } = await createGoldenProject(t);
  const first = candidate('CANDIDATE-0001', 'Capture the item', source.id);
  const second = candidate('CANDIDATE-0002', 'Find the item', source.id, [
    'CANDIDATE-0001',
  ]);
  const third = candidate('CANDIDATE-0003', 'Share the item', source.id);
  const agent = deferredLaunch();
  const started = await startWhatsNextRun(
    project,
    request(source.id),
    agent.launch,
  );
  agent.respond(
    JSON.stringify(envelope(started, source.id, [first, second, third])),
  );
  const settled = await settledRun(project, started.runId);
  assert.equal(settled.status, 'proposal', settled.error ?? undefined);
  await assertGolden('explore', await captureGraphState(project));

  const log = parseRunLogText(
    await readFile(
      path.join(
        project.planningPath,
        'whats-next',
        'runs',
        started.runId,
        'run.log',
      ),
      'utf8',
    ),
  );
  const materialization = log.filter((entry) =>
    entry.event.startsWith('materialization.'),
  );
  assert.deepEqual(
    materialization.map((entry) => entry.event),
    [
      'materialization.basis.prepared',
      'materialization.validated',
      'materialization.identities.allocated',
      'materialization.staged',
      'materialization.published',
    ],
  );
  assert.deepEqual(
    [...new Set(materialization.map((entry) => entry.actor))],
    ['HOST'],
  );
  assert.deepEqual(materialization.filter(isReadableActivity), []);
});

void test('dependency-ordered acceptance promotes Candidates to formal Nodes', async (t) => {
  const { project, source } = await createGoldenProject(t);
  const first = candidate('CANDIDATE-0001', 'Capture the item', source.id);
  const second = candidate('CANDIDATE-0002', 'Find the item', source.id, [
    'CANDIDATE-0001',
  ]);
  const agent = deferredLaunch();
  const started = await startWhatsNextRun(
    project,
    request(source.id),
    agent.launch,
  );
  agent.respond(JSON.stringify(envelope(started, source.id, [first, second])));
  const settled = await settledRun(project, started.runId);
  assert.equal(settled.status, 'proposal', settled.error ?? undefined);
  const result = settled.result;
  assert.ok(result && result.outcome === 'proposal');
  const proposed = result.candidates;
  assert.equal(proposed.length, 2);
  const dependent = proposed[1]!.candidateId;
  const prerequisite = proposed[0]!.candidateId;
  await assert.rejects(
    () => acceptWhatsNextCandidate(project, started.runId, dependent),
    /Accept/,
  );
  await acceptWhatsNextCandidate(project, started.runId, prerequisite);
  await acceptWhatsNextCandidate(project, started.runId, dependent);
  await assertGolden('accept', await captureGraphState(project));
});

void test('a no-change response leaves the graph untouched', async (t) => {
  const { project, source } = await createGoldenProject(t);
  const agent = deferredLaunch();
  const started = await startWhatsNextRun(
    project,
    request(source.id),
    agent.launch,
  );
  agent.respond(
    JSON.stringify({
      ...envelope(started, source.id, []),
      outcome: 'no-change',
      reflection: {
        markdown: 'The current direction already covers this request.',
        continuationAdvice: {
          action: 'consider-closing',
          recommendedFocus: 'close',
          reason: 'Nothing further is needed here.',
        },
      },
      candidates: undefined,
      reason: 'The current direction already covers this request.',
    }),
  );
  const settled = await settledRun(project, started.runId);
  assert.equal(settled.status, 'no-change', settled.error ?? undefined);
  await assertGolden('no-change', await captureGraphState(project));
});

void test('a clarification response creates no Candidate', async (t) => {
  const { project, source } = await createGoldenProject(t);
  const agent = deferredLaunch();
  const started = await startWhatsNextRun(
    project,
    request(source.id),
    agent.launch,
  );
  agent.respond(
    JSON.stringify({
      ...envelope(started, source.id, []),
      outcome: 'clarification',
      candidates: undefined,
      reflection: {
        markdown: 'The audience decides which direction is worth stating.',
        continuationAdvice: {
          action: 'continue',
          recommendedFocus: 'clarify',
          reason: 'The audience is not stated in the source material.',
        },
      },
      clarification: {
        question: 'Which audience should the first direction serve?',
        options: [
          {
            id: 'owner',
            label: 'The owner',
            effect: 'Optimize for a single person.',
            recommended: true,
          },
          {
            id: 'team',
            label: 'A small team',
            effect: 'Optimize for shared use.',
            recommended: false,
          },
        ],
      },
    }),
  );
  const settled = await settledRun(project, started.runId);
  assert.equal(settled.status, 'clarification', settled.error ?? undefined);
  await assertGolden('clarification', await captureGraphState(project));
});

void test('the canonicalizer removes every volatile identifier', () => {
  const canonicalize = createCanonicalizer();
  const uid = '2f1c8a44-7b6e-4d21-9f03-5c8a1b2d3e4f';
  const text = canonicalize(
    `${uid} NODE-5c8a1b2d3e4f CANDIDATE-5c8a1b2d3e4f 2026-09-05T12:34:56.789Z ${'a'.repeat(64)} NODE-00000001`,
  );
  assert.equal(text, 'U0 NODE-U0 CANDIDATE-U0 T H0 NODE-X0');
  assert.equal(canonicalize(uid), 'U0');
});

void test('a refined Candidate keeps its identity and advances one revision', async (t) => {
  const { project, source } = await createGoldenProject(t);
  const first = candidate('CANDIDATE-0001', 'Capture the item', source.id);
  const explore = deferredLaunch();
  const started = await startWhatsNextRun(
    project,
    request(source.id),
    explore.launch,
  );
  explore.respond(JSON.stringify(envelope(started, source.id, [first])));
  const proposal = await settledRun(project, started.runId);
  assert.equal(proposal.status, 'proposal', proposal.error ?? undefined);
  const original = proposal.result;
  assert.ok(original && original.outcome === 'proposal');
  const target = original.candidates[0]!;

  const refine = deferredLaunch();
  const refined = await startWhatsNextRun(
    project,
    request(source.id, {
      instruction: 'Sharpen the outcome statement.',
      revisionRunId: started.runId,
      revisionCandidateId: target.candidateId,
    }),
    refine.launch,
  );
  refine.respond(
    JSON.stringify(
      envelope(refined, source.id, [
        {
          ...first,
          candidateId: target.candidateId,
          revision: 2,
          summary: 'Capture the item with one stated outcome.',
          outputMarkdown: [
            '# Capture the item',
            '',
            '## Why this direction',
            '',
            '- It states the outcome the reader asked for.',
            '- It remains judgeable without more evidence.',
            '',
            '## Assumptions',
            '',
            '- The reader already has the source material.',
            '',
          ].join('\n'),
        },
      ]),
    ),
  );
  const settled = await settledRun(project, refined.runId);
  assert.equal(settled.status, 'proposal', settled.error ?? undefined);
  const result = settled.result;
  assert.ok(result && result.outcome === 'proposal');
  assert.equal(result.candidates[0]!.candidateId, target.candidateId);
  assert.equal(result.candidates[0]!.uid, target.uid);
  assert.equal(result.candidates[0]!.revision, 2);
  await assertGolden('refine', await captureGraphState(project));
});

void test('a Product Design Candidate keeps its Layer and artifact kind through acceptance', async (t) => {
  const { project, source } = await createGoldenProject(t);
  const agent = deferredLaunch();
  const started = await startWhatsNextRun(
    project,
    request(source.id, { intention: 'product-design-completion' }),
    agent.launch,
  );
  agent.respond(
    JSON.stringify(
      envelope(started, source.id, [
        designCandidate('CANDIDATE-0001', 'Capture the item', source.id),
      ]),
    ),
  );
  const settled = await settledRun(project, started.runId);
  assert.equal(settled.status, 'proposal', settled.error ?? undefined);
  const result = settled.result;
  assert.ok(result && result.outcome === 'proposal');
  const accepted = await acceptWhatsNextCandidate(
    project,
    started.runId,
    result.candidates[0]!.candidateId,
  );
  assert.equal(accepted.node.layer, 'product-design');
  assert.equal(accepted.node.artifactKind, 'feature');
  assert.equal(accepted.node.uid, result.candidates[0]!.uid);
  await assertGolden('product-design', await captureGraphState(project));
});

void test('a redone proposal supersedes the unaccepted Candidates and publishes new identities', async (t) => {
  const { project, source } = await createGoldenProject(t);
  process.env.REDO_TEST_ROOT = project.rootPath;
  t.after(() => {
    delete process.env.REDO_TEST_ROOT;
  });
  const explore = deferredLaunch();
  const started = await startWhatsNextRun(
    project,
    request(source.id),
    explore.launch,
  );
  explore.respond(
    JSON.stringify(
      envelope(started, source.id, [
        candidate('CANDIDATE-0001', 'Capture the item', source.id),
      ]),
    ),
  );
  const proposal = await settledRun(project, started.runId);
  assert.equal(proposal.status, 'proposal', proposal.error ?? undefined);

  const redo = deferredLaunch();
  const replaced = await startWhatsNextRun(
    project,
    request(source.id, {
      instruction: 'Explore a different direction.',
      redoProposal: true,
    }),
    redo.launch,
  );
  redo.respond(
    JSON.stringify(
      envelope(replaced, source.id, [
        candidate('CANDIDATE-0001', 'Share the item', source.id),
      ]),
    ),
  );
  const settled = await settledRun(project, replaced.runId);
  assert.equal(settled.status, 'proposal', settled.error ?? undefined);
  await assertGolden('redo', await captureGraphState(project));
});
