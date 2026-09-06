import type {
  DeliveryMapContract,
  DeliveryMapResult,
} from '../lib/modules/delivery-planning/contract.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  materializeWhatToDoDeliveryMap,
  renderWhatToDoContract,
  whatToDoCurrentMapPromptView,
} from '../lib/modules/delivery-planning/map.ts';

const userInput = { path: 'what-to-do/input.md', sha256: '2'.repeat(64) };

const sourceSnapshots = [
  {
    logicalPath: 'feature.md',
    sha256: '1'.repeat(64),
    storedPath:
      'what-to-do/runs/RUN-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/context/primary/feature.md',
  },
];

function semanticContract(
  localKey: string,
  overrides: Partial<DeliveryMapContract> = {},
): DeliveryMapContract {
  return {
    localKey,
    title: 'Foundation',
    summary: 'Establish the boundary.',
    outcome: 'The boundary exists.',
    includedScope: ['Boundary'],
    excludedScope: [],
    productRules: ['Keep it stable.'],
    domainImpact: { kind: 'reuse', reason: 'Reuse it.', evidencePaths: [] },
    requiredExperienceStates: ['Ready'],
    repositoryConstraints: [],
    dependsOn: [],
    acceptanceCriteria: [
      {
        id: 'AC-1',
        condition: 'The boundary exists.',
        passCondition: 'It is usable.',
        evidence: 'A focused check.',
      },
    ],
    validationExpectations: ['Run checks.'],
    sourceClaimIds: ['CLAIM-1'],
    openDecisions: [],
    deliveryStrategy: {
      kind: 'foundation-first',
      reason: 'Dependents require it.',
    },
    ...overrides,
  };
}

const result: Extract<DeliveryMapResult, { outcome: 'map-proposal' }> = {
  outcome: 'map-proposal',
  contracts: [
    semanticContract('foundation'),
    semanticContract('experience', {
      title: 'Experience',
      summary: 'Deliver the experience.',
      outcome: 'The experience works.',
      includedScope: ['Experience'],
      productRules: ['Keep it coherent.'],
      domainImpact: { kind: 'none', reason: 'UI only.', evidencePaths: [] },
      dependsOn: [{ kind: 'proposal', localKey: 'foundation' }],
      acceptanceCriteria: [
        {
          id: 'AC-2',
          condition: 'The experience works.',
          passCondition: 'It is usable.',
          evidence: 'A focused check.',
        },
      ],
      deliveryStrategy: {
        kind: 'vertical-slice',
        reason: 'Deliver it end to end.',
      },
    }),
  ],
  sourceClaims: [
    {
      claimId: 'CLAIM-1',
      source: { kind: 'source', path: 'feature.md' },
      anchor: 'Feature',
      summary: 'Deliver the feature.',
      disposition: 'in-scope',
      contracts: [
        { kind: 'proposal', localKey: 'foundation' },
        { kind: 'proposal', localKey: 'experience' },
      ],
      exclusionReason: null,
      exclusionAuthority: null,
    },
  ],
};

function contractReferences(ids: string[]) {
  return ids.map((id) => ({ kind: 'contract' as const, id }));
}

void test('a validated Agent result becomes one formal terminal Delivery Map', () => {
  const uids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const map = materializeWhatToDoDeliveryMap(
    {
      runId: 'RUN-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      updatedAt: '2026-09-02T00:00:00.000Z',
      sourceUids: ['feature-1', 'feature-1'],
      result,
      basis: { currentMap: null, userInput },
      sourceSnapshots,
    },
    () => uids.shift()!,
  );
  assert.deepEqual(map.sourceUids, ['feature-1']);
  assert.equal(map.contracts.length, 2);
  assert.equal(map.contracts[0]!.id, 'NODE-11111111');
  assert.deepEqual(map.contracts[1]!.dependsOn, [map.contracts[0]!.id]);
  assert.deepEqual(map.contracts[1]!.relations.dependsOn, [
    map.contracts[0]!.uid,
  ]);
  assert.equal('localKey' in map.contracts[0]!, false);
  assert.equal(map.sourceClaims[0]!.sourcePath, 'feature.md');
  assert.equal(map.sourceClaims[0]!.sourceSha256, '1'.repeat(64));
  assert.deepEqual(map.sourceClaims[0]!.contractIds, [
    map.contracts[0]!.id,
    map.contracts[1]!.id,
  ]);
  assert.deepEqual(map.contracts[0]!.sourceClaimIds, ['CLAIM-1']);
  assert.deepEqual(map.contracts[1]!.sourceClaimIds, ['CLAIM-1']);
  assert.match(
    renderWhatToDoContract(map.contracts[1]!),
    new RegExp(map.contracts[0]!.id),
  );
});

void test('a Claim exclusion carries the Host user input as its authority', () => {
  const map = materializeWhatToDoDeliveryMap(
    {
      runId: 'RUN-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      updatedAt: '2026-09-02T00:00:00.000Z',
      sourceUids: ['feature-1'],
      result: {
        outcome: 'map-proposal',
        contracts: [semanticContract('foundation')],
        sourceClaims: [
          {
            ...result.sourceClaims[0]!,
            contracts: [],
            disposition: 'out-of-scope',
            exclusionReason: 'The user deferred it.',
            exclusionAuthority: { anchor: 'Deferred work' },
          },
        ],
      },
      basis: { currentMap: null, userInput },
      sourceSnapshots,
    },
    () => '11111111-1111-4111-8111-111111111111',
  );
  assert.deepEqual(map.sourceClaims[0]!.exclusionAuthority, {
    userInputPath: userInput.path,
    userInputSha256: userInput.sha256,
    anchor: 'Deferred work',
  });
});

void test('a retained Contract preserves formal identity across terminal Map updates', () => {
  const uids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const currentMap = materializeWhatToDoDeliveryMap(
    {
      runId: 'RUN-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      updatedAt: '2026-09-02T00:00:00.000Z',
      sourceUids: ['feature-1'],
      result,
      basis: { currentMap: null, userInput },
      sourceSnapshots,
    },
    () => uids.shift()!,
  );
  const retained = contractReferences(
    currentMap.contracts.map((contract) => contract.id),
  );
  const adjusted = materializeWhatToDoDeliveryMap(
    {
      runId: 'RUN-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      updatedAt: '2026-09-02T01:00:00.000Z',
      sourceUids: ['feature-1'],
      basis: { currentMap, userInput },
      sourceSnapshots,
      result: {
        outcome: 'map-proposal',
        contracts: [],
        sourceClaims: [{ ...result.sourceClaims[0]!, contracts: retained }],
        recomposition: {
          effects: retained.map((reference) => ({
            kind: 'retain' as const,
            from: [reference],
            to: [reference],
          })),
        },
      },
    },
    () => {
      throw new Error(
        'A retained Contract must not allocate another identity.',
      );
    },
  );
  assert.deepEqual(
    adjusted.contracts.map((contract) => [
      contract.id,
      contract.uid,
      contract.outputPath,
    ]),
    currentMap.contracts.map((contract) => [
      contract.id,
      contract.uid,
      contract.outputPath,
    ]),
  );
});

void test('a dependency-only update retains identity and republishes the Contract document', () => {
  const uids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const currentMap = materializeWhatToDoDeliveryMap(
    {
      runId: 'RUN-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      updatedAt: '2026-09-02T00:00:00.000Z',
      sourceUids: ['feature-1'],
      result,
      basis: { currentMap: null, userInput },
      sourceSnapshots,
    },
    () => uids.shift()!,
  );
  const retained = contractReferences(
    currentMap.contracts.map((contract) => contract.id),
  );
  const adjusted = materializeWhatToDoDeliveryMap({
    runId: 'RUN-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    updatedAt: '2026-09-02T01:00:00.000Z',
    sourceUids: ['feature-1'],
    basis: { currentMap, userInput },
    sourceSnapshots,
    result: {
      outcome: 'map-proposal',
      contracts: [],
      sourceClaims: [
        { ...result.sourceClaims[0]!, contracts: retained },
        {
          ...result.sourceClaims[0]!,
          claimId: 'CLAIM-CURRENT',
          summary: 'The current adjustment applies to the retained Contract.',
          contracts: [retained[1]!],
        },
      ],
      contractDependencyUpdates: [{ contract: retained[1]!, dependsOn: [] }],
      recomposition: {
        effects: retained.map((reference) => ({
          kind: 'retain' as const,
          from: [reference],
          to: [reference],
        })),
      },
    },
  });

  assert.equal(adjusted.contracts[1]!.id, currentMap.contracts[1]!.id);
  assert.equal(adjusted.contracts[1]!.uid, currentMap.contracts[1]!.uid);
  assert.deepEqual(adjusted.contracts[1]!.dependsOn, []);
  assert.deepEqual(adjusted.contracts[1]!.sourceClaimIds, [
    'CLAIM-1',
    'CLAIM-CURRENT',
  ]);
  assert.match(
    adjusted.contracts[1]!.outputPath,
    /RUN-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/,
  );
});

void test('the current Map prompt keeps Claim assignments without repeating frozen excerpts', () => {
  const map = materializeWhatToDoDeliveryMap(
    {
      runId: 'RUN-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      updatedAt: '2026-09-02T00:00:00.000Z',
      sourceUids: ['feature-1'],
      result,
      basis: { currentMap: null, userInput },
      sourceSnapshots,
    },
    () => '11111111-1111-4111-8111-111111111111',
  );

  const view = whatToDoCurrentMapPromptView(map);

  assert.equal(view.sourceClaims[0]!.claimId, 'CLAIM-1');
  assert.ok(
    view.sourceClaims[0]!.contractCandidateIds.includes('CANDIDATE-11111111'),
  );
  assert.equal('anchor' in view.sourceClaims[0]!, false);
  assert.equal('sourceSha256' in view.sourceClaims[0]!, false);
});

void test('identity keying distinguishes a retained Contract from a new proposal', () => {
  const uids = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  const created = materializeWhatToDoDeliveryMap(
    {
      runId: 'RUN-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      updatedAt: '2026-09-02T00:00:00.000Z',
      sourceUids: ['feature-1'],
      result: {
        outcome: 'map-proposal',
        contracts: [semanticContract('foundation')],
        sourceClaims: [
          {
            ...result.sourceClaims[0]!,
            contracts: [{ kind: 'proposal', localKey: 'foundation' }],
          },
        ],
      },
      basis: { currentMap: null, userInput },
      sourceSnapshots,
    },
    () => uids.shift()!,
  );
  const retained = created.contracts[0]!;

  const adjusted = materializeWhatToDoDeliveryMap(
    {
      runId: 'RUN-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      updatedAt: '2026-09-02T01:00:00.000Z',
      sourceUids: ['feature-1'],
      basis: { currentMap: created, userInput },
      sourceSnapshots,
      result: {
        outcome: 'map-proposal',
        contracts: [semanticContract('added')],
        sourceClaims: [
          {
            ...result.sourceClaims[0]!,
            contracts: [
              { kind: 'contract', id: retained.id },
              { kind: 'proposal', localKey: 'added' },
            ],
          },
        ],
        recomposition: {
          effects: [
            {
              kind: 'retain',
              from: [{ kind: 'contract', id: retained.id }],
              to: [{ kind: 'contract', id: retained.id }],
            },
            {
              kind: 'add',
              from: [],
              to: [{ kind: 'proposal', localKey: 'added' }],
            },
          ],
        },
      },
    },
    () => uids.shift()!,
  );

  assert.equal(adjusted.contracts.length, 2);
  const kept = adjusted.contracts.find((entry) => entry.id === retained.id);
  assert.ok(kept, 'a retained Contract must keep its identity');
  assert.equal(kept.uid, retained.uid);
  const added = adjusted.contracts.find((entry) => entry.id !== retained.id);
  assert.ok(added, 'a new proposal must receive a fresh identity');
  assert.notEqual(added.uid, retained.uid);
  assert.deepEqual(adjusted.sourceClaims[0]!.contractIds, [
    retained.id,
    added.id,
  ]);
});

void test('a proposal localKey shaped like a Candidate label cannot capture a retained identity', () => {
  const uids = [
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
  ];
  const created = materializeWhatToDoDeliveryMap(
    {
      runId: 'RUN-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      updatedAt: '2026-09-02T00:00:00.000Z',
      sourceUids: ['feature-1'],
      result: {
        outcome: 'map-proposal',
        contracts: [semanticContract('foundation')],
        sourceClaims: [
          {
            ...result.sourceClaims[0]!,
            contracts: [{ kind: 'proposal', localKey: 'foundation' }],
          },
        ],
      },
      basis: { currentMap: null, userInput },
      sourceSnapshots,
    },
    () => uids.shift()!,
  );
  const retained = created.contracts[0]!;
  const collidingKey = `CANDIDATE-${retained.id.slice(5)}`;

  const adjusted = materializeWhatToDoDeliveryMap(
    {
      runId: 'RUN-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      updatedAt: '2026-09-02T01:00:00.000Z',
      sourceUids: ['feature-1'],
      basis: { currentMap: created, userInput },
      sourceSnapshots,
      result: {
        outcome: 'map-proposal',
        contracts: [semanticContract(collidingKey)],
        sourceClaims: [
          {
            ...result.sourceClaims[0]!,
            contracts: [{ kind: 'contract', id: retained.id }],
          },
        ],
        recomposition: {
          effects: [
            {
              kind: 'retain',
              from: [{ kind: 'contract', id: retained.id }],
              to: [{ kind: 'contract', id: retained.id }],
            },
            {
              kind: 'add',
              from: [],
              to: [{ kind: 'proposal', localKey: collidingKey }],
            },
          ],
        },
      },
    },
    () => uids.shift()!,
  );

  assert.deepEqual(adjusted.sourceClaims[0]!.contractIds, [retained.id]);
});
