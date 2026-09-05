import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WHAT_TO_DO_HARNESS_ID,
  WHAT_TO_DO_HARNESS_PROMPT,
  WHAT_TO_DO_HARNESS_REVISION,
  WhatToDoResultValidationError,
  parseWhatToDoHarnessResult,
  validateWhatToDoHarnessResult,
  type WhatToDoContractCandidate,
  type WhatToDoHarnessResult,
  type WhatToDoSourceClaim,
  type WhatToDoValidationContext,
} from '../lib/modules/delivery-planning/harness.ts';

const request = {
  sessionId: 'SESSION-1',
  requestId: 'REQUEST-1',
  inputFingerprint: 'sha256:request',
};
const sourcePath = 'whats-next/nodes/NODE-00000001/output.md';
const sourceHash = 'a'.repeat(64);
const sourceContent = '# Feature\n\n## Accepted behavior\n\nDeliver it.\n';
const evidencePath = 'repository/repository-facts.json';
const userInput = {
  path: 'input/user-input.md',
  sha256: 'b'.repeat(64),
  content: '# User Input\n\nRemove the legacy behavior from this delivery.\n',
};

function context(
  overrides: Partial<WhatToDoValidationContext> = {},
): WhatToDoValidationContext {
  return {
    request,
    operation: 'create-map',
    knownSources: {
      [sourcePath]: { sha256: sourceHash, content: sourceContent },
    },
    userInput,
    knownEvidencePaths: [sourcePath, evidencePath],
    ...overrides,
  };
}

function candidate(
  candidateId: string,
  overrides: Partial<WhatToDoContractCandidate> = {},
): WhatToDoContractCandidate {
  return {
    candidateId,
    revision: 1,
    title: `Contract ${candidateId}`,
    summary: 'One independently deliverable result.',
    outcome: 'The selected product behavior is available to the user.',
    includedScope: ['One accepted product outcome.'],
    excludedScope: [],
    productRules: ['Preserve the accepted Product Design behavior.'],
    domainImpact: {
      kind: 'none',
      reason: 'This contract changes presentation only.',
      evidencePaths: [evidencePath],
    },
    requiredExperienceStates: ['Ready', 'Loading', 'Error'],
    repositoryConstraints: ['Use the current project entry points.'],
    dependsOn: [],
    acceptanceCriteria: [
      {
        id: `AC-${candidateId}`,
        condition: 'The user can reach the result.',
        passCondition: 'The result is visible in the supported interface.',
        evidence: 'A focused behavior check.',
      },
    ],
    validationExpectations: ['Run the project-owned checks.'],
    sourceClaimIds: ['CLAIM-1'],
    openDecisions: [],
    deliveryStrategy: {
      kind: 'vertical-slice',
      reason: 'The outcome is independently usable end to end.',
    },
    ...overrides,
  };
}

function claim(
  overrides: Partial<WhatToDoSourceClaim> = {},
): WhatToDoSourceClaim {
  return {
    claimId: 'CLAIM-1',
    sourcePath,
    sourceSha256: sourceHash,
    anchor: '## Accepted behavior',
    summary: 'The accepted behavior must be delivered.',
    disposition: 'in-scope',
    contractCandidateIds: ['CANDIDATE-0001'],
    exclusionReason: null,
    exclusionAuthority: null,
    ...overrides,
  };
}

function knownCandidate(candidateId: string, dependsOn: string[] = []) {
  return { candidateId, dependsOn, sourceClaimIds: ['CLAIM-1'] };
}

function proposal(
  candidates: WhatToDoContractCandidate[] = [candidate('CANDIDATE-0001')],
  overrides: Partial<
    Extract<WhatToDoHarnessResult, { outcome: 'map-proposal' }>
  > = {},
): Extract<WhatToDoHarnessResult, { outcome: 'map-proposal' }> {
  return {
    schemaVersion: 1,
    harness: {
      id: WHAT_TO_DO_HARNESS_ID,
      revision: WHAT_TO_DO_HARNESS_REVISION,
    },
    request,
    responseMarkdown: '# Delivery Map\n\nOne bounded delivery result.',
    repositorySummary: {
      markdown: '# Repository Summary\n\nThe repository facts are bounded.',
      evidencePaths: [evidencePath],
    },
    reviewedEvidence: [
      {
        path: evidencePath,
        reason: 'Understand the current project boundary.',
      },
    ],
    outcome: 'map-proposal',
    candidates,
    sourceClaims: [
      claim({
        contractCandidateIds: candidates.map((entry) => entry.candidateId),
      }),
    ],
    ...overrides,
  };
}

void test('What to Do Harness owns delivery boundaries rather than implementation steps', () => {
  assert.match(WHAT_TO_DO_HARNESS_PROMPT, /complete Delivery Map/);
  assert.match(WHAT_TO_DO_HARNESS_PROMPT, /There is no fixed Contract count/);
  assert.match(WHAT_TO_DO_HARNESS_PROMPT, /hard prerequisites only/);
  assert.match(WHAT_TO_DO_HARNESS_PROMPT, /ordinary project onboarding/);
  assert.match(WHAT_TO_DO_HARNESS_PROMPT, /only new or replacement Candidates/);
  assert.match(WHAT_TO_DO_HARNESS_PROMPT, /sourceClaimUpdates/);
  assert.match(WHAT_TO_DO_HARNESS_PROMPT, /contractDependencyUpdates/);
  assert.match(WHAT_TO_DO_HARNESS_PROMPT, /Negative behavior/);
  assert.match(
    WHAT_TO_DO_HARNESS_PROMPT,
    /domain-model-summary\.md every time/,
  );
  assert.match(WHAT_TO_DO_HARNESS_PROMPT, /do not implement work/i);
  assert.doesNotMatch(WHAT_TO_DO_HARNESS_PROMPT, /UIKit|SwiftUI|React/);
});

void test('accepts a complete evidence-bounded Delivery Map', () => {
  const foundation = candidate('CANDIDATE-0001');
  const experience = candidate('CANDIDATE-0002', {
    dependsOn: ['CANDIDATE-0001'],
  });
  const result = proposal([foundation, experience]);
  assert.equal(
    validateWhatToDoHarnessResult(result, context()).outcome,
    'map-proposal',
  );
});

void test('terminal Maps reject unresolved decisions and Domain Impact', () => {
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        proposal([candidate('CANDIDATE-0001', { openDecisions: ['Choose.'] })]),
        context(),
      ),
    /Open Decision/,
  );
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        proposal([
          candidate('CANDIDATE-0001', {
            domainImpact: {
              kind: 'uncertain',
              reason: 'More evidence is needed.',
              evidencePaths: [evidencePath],
            },
          }),
        ]),
        context(),
      ),
    /uncertain Domain Impact/,
  );
});

void test('binds results, evidence and claims to the frozen request', () => {
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        { ...proposal(), request: { ...request, requestId: 'stale' } },
        context(),
      ),
    /current request/,
  );
  const wrongHash = proposal();
  if (wrongHash.outcome === 'map-proposal')
    wrongHash.sourceClaims[0]!.sourceSha256 = 'b'.repeat(64);
  assert.throws(
    () => validateWhatToDoHarnessResult(wrongHash, context()),
    /frozen source/,
  );
  const wrongAnchor = proposal();
  if (wrongAnchor.outcome === 'map-proposal')
    wrongAnchor.sourceClaims[0]!.anchor = '## Invented section';
  assert.throws(
    () => validateWhatToDoHarnessResult(wrongAnchor, context()),
    /exactly once/,
  );
  const ambiguousAnchor = proposal();
  if (ambiguousAnchor.outcome === 'map-proposal')
    ambiguousAnchor.sourceClaims[0]!.anchor = 'behavior';
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        ambiguousAnchor,
        context({
          knownSources: {
            [sourcePath]: {
              sha256: sourceHash,
              content: '# behavior\n\nThe behavior remains ambiguous.\n',
            },
          },
        }),
      ),
    /exactly once/,
  );
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        proposal(undefined, {
          sourceClaims: [claim({ anchor: 'aaaaaaaa' })],
        }),
        context({
          knownSources: {
            [sourcePath]: { sha256: sourceHash, content: 'aaaaaaaaa' },
          },
        }),
      ),
    /exactly once/,
  );
  const unknownEvidence = proposal();
  unknownEvidence.repositorySummary.evidencePaths = ['unknown.md'];
  assert.throws(
    () => validateWhatToDoHarnessResult(unknownEvidence, context()),
    /unknown evidence/,
  );
  const evidenceFreeSummary = proposal();
  evidenceFreeSummary.repositorySummary.evidencePaths = [];
  assert.throws(
    () => validateWhatToDoHarnessResult(evidenceFreeSummary, context()),
    WhatToDoResultValidationError,
  );
});

void test('rejects missing and unauthorized source coverage', () => {
  const missing = proposal();
  if (missing.outcome === 'map-proposal') missing.sourceClaims = [];
  assert.throws(
    () => validateWhatToDoHarnessResult(missing, context()),
    WhatToDoResultValidationError,
  );

  const excluded = proposal(
    [candidate('CANDIDATE-0001', { sourceClaimIds: ['CLAIM-KEEP'] })],
    {
      sourceClaims: [
        claim({
          claimId: 'CLAIM-KEEP',
          anchor: 'Deliver it.',
          summary: 'The remaining behavior stays in scope.',
          contractCandidateIds: ['CANDIDATE-0001'],
        }),
        claim({
          summary: 'Explicitly removed by current User Input.',
          disposition: 'out-of-scope',
          contractCandidateIds: [],
          exclusionReason: 'Current User Input removes this behavior.',
          exclusionAuthority: null,
        }),
      ],
    },
  );
  assert.throws(
    () => validateWhatToDoHarnessResult(excluded, context()),
    /current User Input authority/,
  );
  excluded.sourceClaims[1]!.exclusionAuthority = {
    userInputPath: userInput.path,
    userInputSha256: userInput.sha256,
    anchor: 'Remove the legacy behavior from this delivery.',
  };
  assert.equal(
    validateWhatToDoHarnessResult(excluded, context()).outcome,
    'map-proposal',
  );
});

void test('normalizes a valid one-sided Source Claim assignment', () => {
  const result = proposal();
  result.sourceClaims[0]!.contractCandidateIds = [];

  const validated = validateWhatToDoHarnessResult(result, context());

  assert.equal(validated.outcome, 'map-proposal');
  if (validated.outcome === 'map-proposal')
    assert.deepEqual(validated.sourceClaims[0]!.contractCandidateIds, [
      'CANDIDATE-0001',
    ]);
});

void test('rejects fabricated dependencies and cycles', () => {
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        proposal([
          candidate('CANDIDATE-0001', {
            dependsOn: ['CANDIDATE-9999'],
          }),
        ]),
        context(),
      ),
    /unknown Contract Candidate/,
  );
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        proposal([
          candidate('CANDIDATE-0001', {
            dependsOn: ['CANDIDATE-0002'],
          }),
          candidate('CANDIDATE-0002', {
            dependsOn: ['CANDIDATE-0001'],
          }),
        ]),
        context(),
      ),
    /cycle/,
  );
});

void test('adjustment covers the complete existing Map while focus stays advisory', () => {
  const knownCandidates = [
    knownCandidate('CANDIDATE-0001'),
    knownCandidate('CANDIDATE-0002', ['CANDIDATE-0001']),
  ];
  const knownSourceClaims = proposal().sourceClaims;
  const replacement = candidate('CANDIDATE-0003');
  const adjusted = proposal([replacement], {
    recomposition: {
      effects: [
        {
          kind: 'merge',
          from: ['CANDIDATE-0001', 'CANDIDATE-0002'],
          to: ['CANDIDATE-0003'],
        },
      ],
    },
  });
  assert.equal(
    validateWhatToDoHarnessResult(
      adjusted,
      context({
        operation: 'adjust-map',
        knownCandidates,
        knownSourceClaims,
        focusCandidateIds: ['CANDIDATE-0002'],
      }),
    ).outcome,
    'map-proposal',
  );
  const assignedToRemoved = proposal([replacement], {
    recomposition: adjusted.recomposition,
    sourceClaims: [claim({ contractCandidateIds: ['CANDIDATE-0001'] })],
  });
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        assignedToRemoved,
        context({
          operation: 'adjust-map',
          knownCandidates,
          knownSourceClaims,
        }),
      ),
    /bidirectional|unknown Contract Candidate/,
  );
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        adjusted,
        context({
          operation: 'adjust-map',
          knownCandidates,
          knownSourceClaims,
          focusCandidateIds: ['CANDIDATE-9999'],
        }),
      ),
    /focuses an unknown/,
  );
});

void test('new Maps reject Recompose and adjusted Maps require it', () => {
  const withEffects = proposal(undefined, {
    recomposition: {
      effects: [
        {
          kind: 'replace',
          from: ['CANDIDATE-0002'],
          to: ['CANDIDATE-0001'],
        },
      ],
    },
  });
  assert.throws(
    () => validateWhatToDoHarnessResult(withEffects, context()),
    /cannot include Recompose/,
  );
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        proposal([candidate('CANDIDATE-0002')]),
        context({
          operation: 'adjust-map',
          knownCandidates: [knownCandidate('CANDIDATE-0001')],
        }),
      ),
    /requires Recompose/,
  );
});

void test('new Maps discard a redundant add-only Recompose envelope', () => {
  const result = proposal(undefined, {
    recomposition: {
      effects: [
        {
          kind: 'add',
          from: [],
          to: ['CANDIDATE-0001'],
        },
      ],
    },
  });

  const validated = validateWhatToDoHarnessResult(result, context());

  assert.equal(validated.outcome, 'map-proposal');
  if (validated.outcome === 'map-proposal')
    assert.equal(validated.recomposition, undefined);
});

void test('adjusted Maps discard redundant copies of retained Contracts', () => {
  const retained = candidate('CANDIDATE-0001');
  const result = proposal([retained], {
    recomposition: {
      effects: [
        {
          kind: 'retain',
          from: ['CANDIDATE-0001'],
          to: ['CANDIDATE-0001'],
        },
      ],
    },
  });

  const validated = validateWhatToDoHarnessResult(
    result,
    context({
      operation: 'adjust-map',
      knownCandidates: [knownCandidate('CANDIDATE-0001')],
      knownSourceClaims: proposal().sourceClaims,
    }),
  );

  assert.equal(validated.outcome, 'map-proposal');
  if (validated.outcome === 'map-proposal')
    assert.deepEqual(validated.candidates, []);
});

void test('a retained Contract can update only its hard dependencies', () => {
  const knownCandidates = [knownCandidate('CANDIDATE-0001')];
  const knownSourceClaims = proposal().sourceClaims;
  const added = candidate('CANDIDATE-0002');
  const adjusted = proposal([added], {
    sourceClaims: [],
    sourceClaimUpdates: [
      {
        claimId: 'CLAIM-1',
        disposition: 'in-scope',
        contractCandidateIds: ['CANDIDATE-0001', 'CANDIDATE-0002'],
        exclusionReason: null,
        exclusionAuthority: null,
      },
    ],
    contractDependencyUpdates: [
      {
        candidateId: 'CANDIDATE-0001',
        dependsOn: ['CANDIDATE-0002'],
      },
    ],
    recomposition: {
      effects: [
        {
          kind: 'retain',
          from: ['CANDIDATE-0001'],
          to: ['CANDIDATE-0001'],
        },
        { kind: 'add', from: [], to: ['CANDIDATE-0002'] },
      ],
    },
  });

  const validated = validateWhatToDoHarnessResult(
    adjusted,
    context({
      operation: 'adjust-map',
      knownCandidates,
      knownSourceClaims,
    }),
  );

  assert.equal(validated.outcome, 'map-proposal');
  if (validated.outcome === 'map-proposal') {
    assert.equal(validated.candidates.length, 1);
    assert.deepEqual(validated.contractDependencyUpdates, [
      {
        candidateId: 'CANDIDATE-0001',
        dependsOn: ['CANDIDATE-0002'],
      },
    ]);
  }
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        {
          ...structuredClone(adjusted),
          contractDependencyUpdates: [
            { candidateId: 'CANDIDATE-0002', dependsOn: [] },
          ],
        },
        context({
          operation: 'adjust-map',
          knownCandidates,
          knownSourceClaims,
        }),
      ),
    /must target a retained Contract/,
  );
});

void test('a new current-input Claim can be assigned to retained Contracts without repeating their payloads', () => {
  const knownCandidates = [knownCandidate('CANDIDATE-0001')];
  const knownSourceClaims = proposal().sourceClaims;
  const currentClaim = {
    ...structuredClone(knownSourceClaims[0]!),
    claimId: 'CLAIM-CURRENT',
    sourcePath: userInput.path,
    sourceSha256: userInput.sha256,
    anchor: 'Remove the legacy behavior from this delivery.',
    summary: 'Current input updates the retained Contract.',
    contractCandidateIds: ['CANDIDATE-0001'],
  };
  const adjusted = proposal([], {
    sourceClaims: [currentClaim],
    recomposition: {
      effects: [
        {
          kind: 'retain',
          from: ['CANDIDATE-0001'],
          to: ['CANDIDATE-0001'],
        },
      ],
    },
  });
  const validationContext = context({
    operation: 'adjust-map',
    knownCandidates,
    knownSourceClaims,
    knownSources: {
      [sourcePath]: { sha256: sourceHash, content: sourceContent },
      [userInput.path]: {
        sha256: userInput.sha256,
        content: userInput.content,
      },
    },
  });
  const validated = validateWhatToDoHarnessResult(adjusted, validationContext);
  assert.equal(validated.outcome, 'map-proposal');
  if (validated.outcome === 'map-proposal') {
    const completeClaim = validated.sourceClaims.find(
      (item) => item.claimId === 'CLAIM-CURRENT',
    );
    assert.deepEqual(completeClaim?.contractCandidateIds, ['CANDIDATE-0001']);
  }
});

void test('adjustment preserves prior claims and reserves old identity for retain only', () => {
  const knownCandidates = [knownCandidate('CANDIDATE-0001')];
  const knownSourceClaims = proposal().sourceClaims;
  const replacedWithSameId = proposal([candidate('CANDIDATE-0001')], {
    recomposition: {
      effects: [
        {
          kind: 'replace',
          from: ['CANDIDATE-0001'],
          to: ['CANDIDATE-0001'],
        },
      ],
    },
  });
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        replacedWithSameId,
        context({
          operation: 'adjust-map',
          knownCandidates,
          knownSourceClaims,
        }),
      ),
    /already exists/,
  );

  const replacement = candidate('CANDIDATE-0002', {
    sourceClaimIds: ['CLAIM-2'],
  });
  const droppedClaim = proposal([replacement], {
    recomposition: {
      effects: [
        {
          kind: 'replace',
          from: ['CANDIDATE-0001'],
          to: ['CANDIDATE-0002'],
        },
      ],
    },
    sourceClaims: [
      {
        ...structuredClone(knownSourceClaims[0]!),
        claimId: 'CLAIM-2',
        contractCandidateIds: ['CANDIDATE-0002'],
      },
    ],
  });
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        droppedClaim,
        context({
          operation: 'adjust-map',
          knownCandidates,
          knownSourceClaims,
        }),
      ),
    /unknown Contract Candidate/,
  );
});

void test('adjustment carries old claims forward and applies compact assignment updates', () => {
  const knownCandidates = [knownCandidate('CANDIDATE-0001')];
  const knownSourceClaims = proposal().sourceClaims;
  const replacement = candidate('CANDIDATE-0002');
  const adjusted = proposal([replacement], {
    sourceClaims: [],
    sourceClaimUpdates: [
      {
        claimId: 'CLAIM-1',
        disposition: 'in-scope',
        contractCandidateIds: ['CANDIDATE-0002'],
        exclusionReason: null,
        exclusionAuthority: null,
      },
    ],
    recomposition: {
      effects: [
        {
          kind: 'replace',
          from: ['CANDIDATE-0001'],
          to: ['CANDIDATE-0002'],
        },
      ],
    },
  });

  const validated = validateWhatToDoHarnessResult(
    adjusted,
    context({
      operation: 'adjust-map',
      knownCandidates,
      knownSourceClaims,
    }),
  );

  assert.equal(validated.outcome, 'map-proposal');
  if (validated.outcome === 'map-proposal') {
    assert.equal(validated.sourceClaimUpdates, undefined);
    assert.equal(validated.sourceClaims[0]!.anchor, '## Accepted behavior');
    assert.deepEqual(validated.sourceClaims[0]!.contractCandidateIds, [
      'CANDIDATE-0002',
    ]);
  }
});

void test('the complete adjusted Map rejects cycles among retained Contracts', () => {
  const knownCandidates = [
    knownCandidate('CANDIDATE-0001', ['CANDIDATE-0002']),
    knownCandidate('CANDIDATE-0002', ['CANDIDATE-0001']),
  ];
  const claim = structuredClone(proposal().sourceClaims[0]!);
  claim.contractCandidateIds = ['CANDIDATE-0001', 'CANDIDATE-0002'];
  const retained = proposal([], {
    sourceClaims: [claim],
    recomposition: {
      effects: [
        {
          kind: 'retain',
          from: ['CANDIDATE-0001'],
          to: ['CANDIDATE-0001'],
        },
        {
          kind: 'retain',
          from: ['CANDIDATE-0002'],
          to: ['CANDIDATE-0002'],
        },
      ],
    },
  });
  assert.throws(
    () =>
      validateWhatToDoHarnessResult(
        retained,
        context({
          operation: 'adjust-map',
          knownCandidates,
          knownSourceClaims: [claim],
        }),
      ),
    /cycle/,
  );
});

void test('parsing rejects oversized model output before JSON decoding', () => {
  assert.throws(
    () =>
      parseWhatToDoHarnessResult(
        `{"value":"${'x'.repeat(1_500_000)}"}`,
        context(),
      ),
    /too large/,
  );
});

void test('clarification recommends one option and parsing rejects prose', () => {
  const base = proposal();
  const clarification: WhatToDoHarnessResult = {
    schemaVersion: base.schemaVersion,
    harness: base.harness,
    request: base.request,
    responseMarkdown: base.responseMarkdown,
    repositorySummary: base.repositorySummary,
    reviewedEvidence: base.reviewedEvidence,
    outcome: 'clarification',
    clarification: {
      question: 'Which accepted behavior owns this boundary?',
      options: [
        {
          id: 'one',
          label: 'One',
          effect: 'Keep one boundary.',
          recommended: true,
        },
        {
          id: 'two',
          label: 'Two',
          effect: 'Split the boundary.',
          recommended: false,
        },
      ],
    },
  };
  assert.equal(
    validateWhatToDoHarnessResult(clarification, context()).outcome,
    'clarification',
  );
  clarification.clarification.options[1]!.recommended = true;
  assert.throws(
    () => validateWhatToDoHarnessResult(clarification, context()),
    /exactly one option/,
  );
  assert.throws(
    () => parseWhatToDoHarnessResult('Here is the map', context()),
    /valid JSON/,
  );
});

void test('normalizes packet workspace paths before validating evidence', () => {
  const result = proposal();
  result.repositorySummary.evidencePaths = ['related/resources/facts.json'];
  result.reviewedEvidence = [
    { path: 'primary/002-output.md', reason: 'Reviewed the selected Feature.' },
  ];
  if (result.outcome === 'map-proposal') {
    result.candidates[0]!.domainImpact.evidencePaths = [
      'related/resources/facts.json',
    ];
    result.sourceClaims[0]!.sourcePath = 'primary/002-output.md';
  }

  const validated = validateWhatToDoHarnessResult(
    result,
    context({
      evidencePathAliases: {
        'primary/002-output.md': sourcePath,
        'related/resources/facts.json': evidencePath,
      },
    }),
  );

  assert.deepEqual(validated.repositorySummary.evidencePaths, [evidencePath]);
  assert.deepEqual(
    validated.reviewedEvidence.map((entry) => entry.path),
    [sourcePath],
  );
  if (validated.outcome === 'map-proposal') {
    assert.deepEqual(validated.candidates[0]!.domainImpact.evidencePaths, [
      evidencePath,
    ]);
    assert.equal(validated.sourceClaims[0]!.sourcePath, sourcePath);
  }
});

void test('accepts the bounded Context root as reviewed evidence', () => {
  const result = proposal();
  result.reviewedEvidence.push({
    path: '.',
    reason: 'Inspected the bounded Context root during project onboarding.',
  });

  assert.equal(
    validateWhatToDoHarnessResult(
      result,
      context({ knownEvidencePaths: [sourcePath, evidencePath, '.'] }),
    ).outcome,
    'map-proposal',
  );
});
