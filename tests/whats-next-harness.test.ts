import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  WHATS_NEXT_HARNESS_ID,
  WHATS_NEXT_HARNESS_OUTPUT_SCHEMA,
  WHATS_NEXT_HARNESS_PROMPT,
  WHATS_NEXT_HARNESS_REVISION,
  WhatsNextResultValidationError,
  canReuseWhatsNextSession,
  createWhatsNextRevisionTarget,
  parseWhatsNextHarnessResult,
  validateWhatsNextHarnessResult,
  whatsNextHarnessPrompt,
  type WhatsNextCandidate,
} from '../lib/modules/product-discovery/harness.ts';
import { renderWhatsNextResponseMarkdown } from '../lib/modules/product-discovery/response.ts';

void test('ships the settled Reflection and Markdown Harness contract', () => {
  assert.match(WHATS_NEXT_HARNESS_PROMPT, /user-facing Reflection/);
  assert.match(WHATS_NEXT_HARNESS_PROMPT, /Why this direction/);
  assert.match(WHATS_NEXT_HARNESS_PROMPT, /For refine-candidate/);
  assert.match(WHATS_NEXT_HARNESS_PROMPT, /requiredRevision/);
  assert.match(WHATS_NEXT_HARNESS_PROMPT, /Intention owns the destination/);
  assert.match(WHATS_NEXT_HARNESS_PROMPT, /protected comparison Context/);
  assert.match(WHATS_NEXT_HARNESS_PROMPT, /content\.input first/);
  assert.match(WHATS_NEXT_HARNESS_PROMPT, /content\.references/);
  assert.match(WHATS_NEXT_HARNESS_PROMPT, /content\.external/);
  assert.match(
    WHATS_NEXT_HARNESS_PROMPT,
    /When no material uncertainty remains.*- None/,
  );
  assert.doesNotMatch(WHATS_NEXT_HARNESS_PROMPT, /placeholder/);
});

const request = {
  sessionId: 'SESSION-0001',
  requestId: 'REQUEST-0001',
  inputFingerprint: 'sha256:example',
};

const context = {
  request,
  knownNodeIds: ['NODE-00000001', 'NODE-00000002'],
  knownResourcePaths: ['task-graph/nodes/NODE-00000001/resources/idea.md'],
};

function baseResult() {
  return {
    schemaVersion: 1,
    harness: {
      id: WHATS_NEXT_HARNESS_ID,
      revision: WHATS_NEXT_HARNESS_REVISION,
    },
    request,
    reflection: {
      markdown:
        '# Reflection\n\nThe user most needs a bounded way to make the idea concrete.',
      continuationAdvice: {
        action: 'continue',
        recommendedFocus: 'concretize',
        reason: 'Several useful starting directions remain unexplored.',
      },
    },
    exploration: {
      consideredNodeIds: ['NODE-00000001'],
      notes: ['The Start carries only the stated idea.'],
    },
  };
}

function candidate(
  id: string,
  overrides: Partial<WhatsNextCandidate> = {},
): WhatsNextCandidate {
  const title = `Direction ${id}`;
  return {
    candidateId: id,
    revision: 1,
    type: 'module',
    layer: 'discovery',
    artifactKind: 'mvp',
    title,
    summary: 'One possible next step grown from the Start.',
    derivedFrom: ['NODE-00000001'],
    dependsOn: [],
    resources: [],
    typeTemplateRef: null,
    metadata: {},
    presentation: {},
    assumptions: [],
    outputMarkdown: `# ${title}

One possible next step grown from the Start.

## Why this direction

- The origin describes a broad product idea that still needs a concrete entry point.
- This direction provides one bounded possibility the user can inspect.

## Assumptions

- None`,
    ...overrides,
  };
}

function proposal(candidates: unknown[]) {
  return { ...baseResult(), outcome: 'proposal', candidates };
}

void test('accepts a proposal of distinct directions', () => {
  const result = validateWhatsNextHarnessResult(
    proposal([candidate('CANDIDATE-0001'), candidate('CANDIDATE-0002')]),
    context,
  );
  assert.equal(result.outcome, 'proposal');
});

void test('composes the selected Intention and Motion profiles', () => {
  const prompt = whatsNextHarnessPrompt('feature-synthesis', 'converge');
  assert.match(prompt, /Product Design Feature candidates/);
  assert.match(prompt, /exactly one aggregate Candidate/);
  assert.match(prompt, /Do not create an intermediate Discovery Feature/);
});

void test('Product Design Completion judges whether a new Feature is warranted', () => {
  const prompt = whatsNextHarnessPrompt(
    'product-design-completion',
    'converge',
  );
  assert.match(prompt, /Product Source, every current Product Design Feature/);
  assert.match(prompt, /selected Product Source is the trigger/);
  assert.match(prompt, /zero current Product Design Features/);
  assert.match(prompt, /first Product Design pass/);
  assert.match(prompt, /available input establishes a coherent product goal/);
  assert.match(
    prompt,
    /complete Product Design document may justify many Feature Candidates/,
  );
  assert.match(
    prompt,
    /First judge whether the concern deserves an independent Feature/,
  );
  assert.match(prompt, /If the concern is already covered, return no-change/);
  assert.match(
    prompt,
    /only a missing rule or edge case inside an existing Feature/,
  );
  assert.match(prompt, /Never manufacture a duplicate or nominal Feature/);
  assert.match(prompt, /Product Design has one primary lineage level/);
  assert.match(
    prompt,
    /do not require an MVP or prototype detour when the product goal is already clear/,
  );
});

void test('Converge accepts one aggregate Candidate and rejects siblings', () => {
  const convergeContext = { ...context, motion: 'converge' as const };
  assert.equal(
    validateWhatsNextHarnessResult(
      proposal([candidate('CANDIDATE-0001')]),
      convergeContext,
    ).outcome,
    'proposal',
  );
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        proposal([candidate('CANDIDATE-0001'), candidate('CANDIDATE-0002')]),
        convergeContext,
      ),
    WhatsNextResultValidationError,
  );
});

void test('Unspecified follows every clear boundary without a five-Card product limit', () => {
  const unspecifiedContext = { ...context, motion: 'unspecified' as const };
  assert.equal(
    validateWhatsNextHarnessResult(
      proposal([candidate('CANDIDATE-0001')]),
      unspecifiedContext,
    ).outcome,
    'proposal',
  );
  const many = Array.from({ length: 8 }, (_, index) =>
    candidate(`CANDIDATE-${String(index + 1).padStart(4, '0')}`),
  );
  assert.equal(
    validateWhatsNextHarnessResult(proposal(many), unspecifiedContext).outcome,
    'proposal',
  );
  const prompt = whatsNextHarnessPrompt(
    'product-design-completion',
    'unspecified',
  );
  assert.match(prompt, /exactly as many Candidates as.*boundaries require/);
  assert.match(prompt, /Do not split one module to increase count/);
  assert.match(prompt, /truncate a clear design to an arbitrary limit/);
});

void test('Feature Synthesis requires a Product Design Feature', () => {
  const featureContext = {
    ...context,
    intention: 'feature-synthesis' as const,
    motion: 'converge' as const,
  };
  const feature = candidate('CANDIDATE-0001', {
    type: 'feature',
    layer: 'product-design',
    artifactKind: 'feature',
  });
  assert.equal(
    validateWhatsNextHarnessResult(proposal([feature]), featureContext).outcome,
    'proposal',
  );
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        proposal([candidate('CANDIDATE-0001')]),
        featureContext,
      ),
    WhatsNextResultValidationError,
  );
});

void test('Product Design Completion shares the Product Design destination contract', () => {
  const completionContext = {
    ...context,
    intention: 'product-design-completion' as const,
    motion: 'converge' as const,
    productSourceNodeId: 'NODE-00000001',
  };
  const feature = candidate('CANDIDATE-0001', {
    type: 'feature',
    layer: 'product-design',
    artifactKind: 'feature',
  });
  assert.equal(
    validateWhatsNextHarnessResult(proposal([feature]), completionContext)
      .outcome,
    'proposal',
  );
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        proposal([
          candidate('CANDIDATE-0001', {
            type: 'feature',
            layer: 'product-design',
            artifactKind: 'feature',
            derivedFrom: ['NODE-00000002'],
          }),
        ]),
        completionContext,
      ),
    /Product Source as its only lineage parent/,
  );
  const value = baseResult();
  value.reflection.continuationAdvice = {
    action: 'consider-closing',
    recommendedFocus: 'close',
    reason: 'The concern is already covered by the current Product Design.',
  };
  assert.equal(
    validateWhatsNextHarnessResult(
      {
        ...value,
        outcome: 'no-change',
        reason: 'Refine the existing Feature.',
      },
      completionContext,
    ).outcome,
    'no-change',
  );
});

void test('requires a machine-readable progressive continuation focus', () => {
  const value = proposal([
    candidate('CANDIDATE-0001'),
    candidate('CANDIDATE-0002'),
  ]);
  delete (value.reflection.continuationAdvice as { recommendedFocus?: string })
    .recommendedFocus;
  assert.throws(
    () => validateWhatsNextHarnessResult(value, context),
    WhatsNextResultValidationError,
  );
});

void test('does not resume a provider Session across Harness revisions', () => {
  const run = {
    agentSessionMode: 'persistent' as const,
    transport: 'codex-cli' as const,
    harness: { revision: WHATS_NEXT_HARNESS_REVISION - 1 },
  };
  assert.equal(canReuseWhatsNextSession(run, 'codex-cli'), false);
  assert.equal(
    canReuseWhatsNextSession(
      {
        ...run,
        harness: { revision: WHATS_NEXT_HARNESS_REVISION },
      },
      'codex-cli',
    ),
    true,
  );
});

void test('provides the exact required Candidate revision', () => {
  assert.equal(
    createWhatsNextRevisionTarget(candidate('CANDIDATE-0001')).requiredRevision,
    2,
  );
});

void test('rejects contradictory continuation advice', () => {
  const value = proposal([
    candidate('CANDIDATE-0001'),
    candidate('CANDIDATE-0002'),
  ]);
  value.reflection.continuationAdvice = {
    action: 'consider-closing',
    recommendedFocus: 'concretize',
    reason: 'The meaning is abstract but the Session should close.',
  };
  assert.throws(
    () => validateWhatsNextHarnessResult(value, context),
    WhatsNextResultValidationError,
  );
});

void test('renders one readable Response from Reflection and Candidates', () => {
  const result = validateWhatsNextHarnessResult(
    proposal([candidate('CANDIDATE-0001'), candidate('CANDIDATE-0002')]),
    context,
  );
  const markdown = renderWhatsNextResponseMarkdown(result);
  assert.match(markdown, /# Reflection/);
  assert.match(markdown, /## Suggested next step/);
  assert.match(markdown, /Make this direction one level more concrete/);
  assert.match(markdown, /# Candidate Proposals/);
  assert.match(markdown, /## Direction CANDIDATE-0001/);
});

void test('accepts a heading-free Reflection and ordered rationale', () => {
  const value = proposal([
    candidate('CANDIDATE-0001', {
      outputMarkdown: `# Direction CANDIDATE-0001

One possible next step grown from the Start.

## Why this direction

1. The origin still needs a concrete entry point.
2. The user can inspect this direction independently.

## Assumptions

- None`,
    }),
    candidate('CANDIDATE-0002'),
  ]);
  value.reflection.markdown =
    'The current idea contains several connected but unsettled values.';
  assert.equal(
    validateWhatsNextHarnessResult(value, context).outcome,
    'proposal',
  );
});

void test('rejects a single-direction proposal', () => {
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(proposal([candidate('CANDIDATE-0001')]), {
        ...context,
        motion: 'diverge',
      }),
    WhatsNextResultValidationError,
  );
});

void test('rejects more than five directions', () => {
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        proposal(
          Array.from({ length: 6 }, (_, index) =>
            candidate(`CANDIDATE-000${index + 1}`),
          ),
        ),
        { ...context, motion: 'diverge' },
      ),
    WhatsNextResultValidationError,
  );
});

void test('rejects an unknown origin Node', () => {
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        proposal([
          candidate('CANDIDATE-0001', { derivedFrom: ['NODE-00009999'] }),
          candidate('CANDIDATE-0002'),
        ]),
        context,
      ),
    WhatsNextResultValidationError,
  );
});

void test('accepts several origins on one direction', () => {
  const result = validateWhatsNextHarnessResult(
    proposal([
      candidate('CANDIDATE-0001', {
        derivedFrom: ['NODE-00000001', 'NODE-00000002'],
      }),
      candidate('CANDIDATE-0002'),
    ]),
    context,
  );
  assert.equal(result.outcome, 'proposal');
});

void test('rejects a dependency cycle between directions', () => {
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        proposal([
          candidate('CANDIDATE-0001', { dependsOn: ['CANDIDATE-0002'] }),
          candidate('CANDIDATE-0002', { dependsOn: ['CANDIDATE-0001'] }),
        ]),
        context,
      ),
    WhatsNextResultValidationError,
  );
});

void test('rejects an unknown Resource reference', () => {
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        proposal([
          candidate('CANDIDATE-0001', {
            resources: [{ kind: 'context', path: 'context/product/absent.md' }],
          }),
          candidate('CANDIDATE-0002'),
        ]),
        context,
      ),
    WhatsNextResultValidationError,
  );
});

void test('rejects a response for a different request', () => {
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        {
          ...proposal([
            candidate('CANDIDATE-0001'),
            candidate('CANDIDATE-0002'),
          ]),
          request: { ...request, requestId: 'REQUEST-0002' },
        },
        context,
      ),
    WhatsNextResultValidationError,
  );
});

void test('requires the next revision when revising one direction', () => {
  const revising = {
    ...context,
    operation: 'refine-candidate' as const,
    revisionCandidateId: 'CANDIDATE-0001',
    revisionTarget: candidate('CANDIDATE-0001'),
    previousCandidateRevisions: { 'CANDIDATE-0001': 1 },
  };
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        proposal([candidate('CANDIDATE-0001'), candidate('CANDIDATE-0002')]),
        revising,
      ),
    WhatsNextResultValidationError,
  );
  const result = validateWhatsNextHarnessResult(
    proposal([candidate('CANDIDATE-0001', { revision: 2 })]),
    revising,
  );
  assert.equal(result.outcome, 'proposal');
});

void test('rejects Candidate Markdown without a bounded rationale', () => {
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        proposal([
          candidate('CANDIDATE-0001', {
            outputMarkdown: '# Direction CANDIDATE-0001\n\nNo rationale.',
          }),
          candidate('CANDIDATE-0002'),
        ]),
        context,
      ),
    WhatsNextResultValidationError,
  );
});

void test('rejects assumptions that drift from Candidate Markdown', () => {
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        proposal([
          candidate('CANDIDATE-0001', {
            assumptions: ['A hidden assumption.'],
          }),
          candidate('CANDIDATE-0002'),
        ]),
        context,
      ),
    WhatsNextResultValidationError,
  );
});

void test('rejects graph changes during one-to-one Refine', () => {
  const original = candidate('CANDIDATE-0001');
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        proposal([
          candidate('CANDIDATE-0001', {
            revision: 2,
            dependsOn: ['NODE-00000002'],
          }),
        ]),
        {
          ...context,
          operation: 'refine-candidate',
          revisionCandidateId: 'CANDIDATE-0001',
          revisionTarget: original,
          previousCandidateRevisions: { 'CANDIDATE-0001': 1 },
        },
      ),
    WhatsNextResultValidationError,
  );
});

void test('does not offer an insufficient-evidence outcome', () => {
  assert.throws(
    () =>
      validateWhatsNextHarnessResult(
        {
          ...baseResult(),
          outcome: 'insufficient-evidence',
          missingEvidence: ['Nothing to go on.'],
        },
        context,
      ),
    WhatsNextResultValidationError,
  );
});

void test('accepts a no-change outcome', () => {
  const value = baseResult();
  value.reflection.continuationAdvice = {
    action: 'consider-closing',
    recommendedFocus: 'close',
    reason: 'Another round would only repeat accepted meaning.',
  };
  const result = validateWhatsNextHarnessResult(
    {
      ...value,
      outcome: 'no-change',
      reason: 'The origin is exhausted.',
    },
    context,
  );
  assert.equal(result.outcome, 'no-change');
});

void test('rejects a non-JSON result', () => {
  assert.throws(
    () => parseWhatsNextHarnessResult('not json', context),
    WhatsNextResultValidationError,
  );
});

void test('the composed Harness output schema matches the approved contract baseline', () => {
  const fixture = readFileSync(
    new URL('./fixtures/harness-schemas/whats-next.json', import.meta.url),
    'utf8',
  );
  assert.deepEqual(WHATS_NEXT_HARNESS_OUTPUT_SCHEMA, JSON.parse(fixture));
  assert.equal(
    JSON.stringify(WHATS_NEXT_HARNESS_OUTPUT_SCHEMA),
    JSON.stringify(JSON.parse(fixture)),
  );
});
