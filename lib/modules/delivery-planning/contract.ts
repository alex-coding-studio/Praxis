import { defineResultContract } from '../../materialization/contract.ts';
import {
  agentGraphRecomposeEffects,
  recomposeEffectSchema,
  type AgentGraphRecomposeEffect,
} from '../../graph/agent/recompose.ts';
import {
  CANDIDATE_ALIAS_PATTERN,
  NODE_ALIAS_PATTERN,
} from '../../graph/identity.ts';
import { LOCAL_KEY_SCHEMA } from '../../graph/proposal/reference.ts';

export const DELIVERY_MAP_RESULT_CONTRACT_ID = 'praxis.delivery-map.result';
export const DELIVERY_MAP_RESULT_CONTRACT_VERSION = 1;

export type WhatToDoDomainImpact = {
  kind: 'none' | 'reuse' | 'change' | 'add' | 'uncertain';
  reason: string;
  evidencePaths: string[];
};

export type WhatToDoDeliveryStrategy = {
  kind:
    | 'foundation-first'
    | 'experience-first'
    | 'vertical-slice'
    | 'risk-first';
  reason: string;
};

export type WhatToDoAcceptanceCriterion = {
  id: string;
  condition: string;
  passCondition: string;
  evidence: string;
};

export type WhatToDoContractCandidate = {
  candidateId: string;
  revision: number;
  title: string;
  summary: string;
  outcome: string;
  includedScope: string[];
  excludedScope: string[];
  productRules: string[];
  domainImpact: WhatToDoDomainImpact;
  requiredExperienceStates: string[];
  repositoryConstraints: string[];
  dependsOn: string[];
  acceptanceCriteria: WhatToDoAcceptanceCriterion[];
  validationExpectations: string[];
  sourceClaimIds: string[];
  openDecisions: string[];
  deliveryStrategy: WhatToDoDeliveryStrategy;
};

export type WhatToDoSourceClaim = {
  claimId: string;
  sourcePath: string;
  sourceSha256: string;
  anchor: string;
  summary: string;
  disposition: 'in-scope' | 'out-of-scope';
  contractCandidateIds: string[];
  exclusionReason: string | null;
  exclusionAuthority: {
    userInputPath: string;
    userInputSha256: string;
    anchor: string;
  } | null;
};

export type WhatToDoSourceClaimUpdate = Pick<
  WhatToDoSourceClaim,
  | 'claimId'
  | 'disposition'
  | 'contractCandidateIds'
  | 'exclusionReason'
  | 'exclusionAuthority'
>;

export type WhatToDoContractDependencyUpdate = {
  candidateId: string;
  dependsOn: string[];
};

export type WhatToDoClarification = {
  question: string;
  options: Array<{
    id: string;
    label: string;
    effect: string;
    recommended: boolean;
  }>;
};

export type WhatToDoLegacyMapProposal = {
  outcome: 'map-proposal';
  candidates: WhatToDoContractCandidate[];
  sourceClaims: WhatToDoSourceClaim[];
  sourceClaimUpdates?: WhatToDoSourceClaimUpdate[];
  contractDependencyUpdates?: WhatToDoContractDependencyUpdate[];
  recomposition?: { effects: AgentGraphRecomposeEffect[] };
};

export type DeliveryContractReference =
  | { kind: 'contract'; id: string }
  | { kind: 'proposal'; localKey: string };

export type DeliverySourceReference = { kind: 'source'; path: string };

export type DeliveryMapContract = {
  localKey: string;
  title: string;
  summary: string;
  outcome: string;
  includedScope: string[];
  excludedScope: string[];
  productRules: string[];
  domainImpact: WhatToDoDomainImpact;
  requiredExperienceStates: string[];
  repositoryConstraints: string[];
  dependsOn: DeliveryContractReference[];
  acceptanceCriteria: WhatToDoAcceptanceCriterion[];
  validationExpectations: string[];
  sourceClaimIds: string[];
  openDecisions: string[];
  deliveryStrategy: WhatToDoDeliveryStrategy;
};

export type DeliveryMapSourceClaim = {
  claimId: string;
  source: DeliverySourceReference;
  anchor: string;
  summary: string;
  disposition: 'in-scope' | 'out-of-scope';
  contracts: DeliveryContractReference[];
  exclusionReason: string | null;
  exclusionAuthority: { anchor: string } | null;
};

export type DeliveryMapSourceClaimUpdate = Pick<
  DeliveryMapSourceClaim,
  | 'claimId'
  | 'disposition'
  | 'contracts'
  | 'exclusionReason'
  | 'exclusionAuthority'
>;

export type DeliveryMapContractDependencyUpdate = {
  contract: DeliveryContractReference;
  dependsOn: DeliveryContractReference[];
};

export type DeliveryMapRecomposeEffect = {
  kind: (typeof agentGraphRecomposeEffects)[number];
  from: DeliveryContractReference[];
  to: DeliveryContractReference[];
};

export type DeliveryMapResult =
  | {
      outcome: 'map-proposal';
      contracts: DeliveryMapContract[];
      sourceClaims: DeliveryMapSourceClaim[];
      sourceClaimUpdates?: DeliveryMapSourceClaimUpdate[];
      contractDependencyUpdates?: DeliveryMapContractDependencyUpdate[];
      recomposition?: { effects: DeliveryMapRecomposeEffect[] };
    }
  | { outcome: 'clarification'; clarification: WhatToDoClarification }
  | { outcome: 'insufficient-evidence'; missingEvidence: string[] }
  | { outcome: 'no-change'; reason: string };

export const whatToDoText = {
  type: 'string',
  minLength: 1,
  maxLength: 20_000,
  pattern: '\\S',
} as const;
export const whatToDoStrings = {
  type: 'array',
  maxItems: 200,
  uniqueItems: true,
  items: whatToDoText,
} as const;
export const whatToDoSha256 = {
  type: 'string',
  pattern: '^[0-9a-f]{64}$',
} as const;
export const whatToDoCandidateId = {
  type: 'string',
  pattern: CANDIDATE_ALIAS_PATTERN,
} as const;
export const whatToDoObject = <const P extends Record<string, unknown>>(
  properties: P,
) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const whatToDoDomainImpact = whatToDoObject({
  kind: { enum: ['none', 'reuse', 'change', 'add', 'uncertain'] },
  reason: whatToDoText,
  evidencePaths: whatToDoStrings,
});
export const whatToDoDeliveryStrategy = whatToDoObject({
  kind: {
    enum: [
      'foundation-first',
      'experience-first',
      'vertical-slice',
      'risk-first',
    ],
  },
  reason: whatToDoText,
});
export const whatToDoAcceptanceCriterion = whatToDoObject({
  id: whatToDoText,
  condition: whatToDoText,
  passCondition: whatToDoText,
  evidence: whatToDoText,
});
export const whatToDoAnchor = {
  ...whatToDoText,
  minLength: 8,
  maxLength: 2_000,
} as const;
export const whatToDoContractCandidate = whatToDoObject({
  candidateId: whatToDoCandidateId,
  revision: { type: 'integer', minimum: 1 },
  title: { ...whatToDoText, maxLength: 160 },
  summary: { ...whatToDoText, maxLength: 600 },
  outcome: whatToDoText,
  includedScope: { ...whatToDoStrings, minItems: 1 },
  excludedScope: whatToDoStrings,
  productRules: { ...whatToDoStrings, minItems: 1 },
  domainImpact: whatToDoDomainImpact,
  requiredExperienceStates: whatToDoStrings,
  repositoryConstraints: whatToDoStrings,
  dependsOn: { type: 'array', uniqueItems: true, items: whatToDoCandidateId },
  acceptanceCriteria: {
    type: 'array',
    minItems: 1,
    maxItems: 60,
    items: whatToDoAcceptanceCriterion,
  },
  validationExpectations: { ...whatToDoStrings, minItems: 1 },
  sourceClaimIds: { ...whatToDoStrings, minItems: 1 },
  openDecisions: whatToDoStrings,
  deliveryStrategy: whatToDoDeliveryStrategy,
});
const exclusionAuthority = {
  oneOf: [
    whatToDoObject({
      userInputPath: whatToDoText,
      userInputSha256: whatToDoSha256,
      anchor: whatToDoAnchor,
    }),
    { type: 'null' },
  ],
};
export const whatToDoSourceClaim = whatToDoObject({
  claimId: whatToDoText,
  sourcePath: whatToDoText,
  sourceSha256: whatToDoSha256,
  anchor: whatToDoAnchor,
  summary: whatToDoText,
  disposition: { enum: ['in-scope', 'out-of-scope'] },
  contractCandidateIds: {
    type: 'array',
    uniqueItems: true,
    items: whatToDoCandidateId,
  },
  exclusionReason: { oneOf: [whatToDoText, { type: 'null' }] },
  exclusionAuthority,
});
export const whatToDoSourceClaimUpdate = whatToDoObject({
  claimId: whatToDoText,
  disposition: { enum: ['in-scope', 'out-of-scope'] },
  contractCandidateIds: {
    type: 'array',
    uniqueItems: true,
    items: whatToDoCandidateId,
  },
  exclusionReason: { oneOf: [whatToDoText, { type: 'null' }] },
  exclusionAuthority,
});
export const whatToDoContractDependencyUpdate = whatToDoObject({
  candidateId: whatToDoCandidateId,
  dependsOn: { type: 'array', uniqueItems: true, items: whatToDoCandidateId },
});
export const whatToDoClarification = whatToDoObject({
  question: { ...whatToDoText, maxLength: 600 },
  options: {
    type: 'array',
    minItems: 2,
    maxItems: 3,
    items: whatToDoObject({
      id: whatToDoText,
      label: { ...whatToDoText, maxLength: 160 },
      effect: { ...whatToDoText, maxLength: 600 },
      recommended: { type: 'boolean' },
    }),
  },
});
export const whatToDoRecomposition = whatToDoObject({
  effects: {
    type: 'array',
    minItems: 1,
    maxItems: 400,
    items: recomposeEffectSchema(whatToDoStrings),
  },
});

export const whatToDoMapProposalOptionalProperties = {
  recomposition: whatToDoRecomposition,
  sourceClaimUpdates: {
    type: 'array',
    maxItems: 1_000,
    uniqueItems: true,
    items: whatToDoSourceClaimUpdate,
  },
  contractDependencyUpdates: {
    type: 'array',
    maxItems: 200,
    uniqueItems: true,
    items: whatToDoContractDependencyUpdate,
  },
};

const deliveryContractId = {
  type: 'string',
  pattern: NODE_ALIAS_PATTERN,
} as const;

const contractReference = {
  oneOf: [
    whatToDoObject({
      kind: { const: 'contract' },
      id: deliveryContractId,
    }),
    whatToDoObject({
      kind: { const: 'proposal' },
      localKey: LOCAL_KEY_SCHEMA,
    }),
  ],
};

const contractReferenceArray = {
  type: 'array',
  uniqueItems: true,
  items: contractReference,
};

const sourceReference = whatToDoObject({
  kind: { const: 'source' },
  path: whatToDoText,
});

const deliveryMapContract = whatToDoObject({
  localKey: LOCAL_KEY_SCHEMA,
  title: { ...whatToDoText, maxLength: 160 },
  summary: { ...whatToDoText, maxLength: 600 },
  outcome: whatToDoText,
  includedScope: { ...whatToDoStrings, minItems: 1 },
  excludedScope: whatToDoStrings,
  productRules: { ...whatToDoStrings, minItems: 1 },
  domainImpact: whatToDoDomainImpact,
  requiredExperienceStates: whatToDoStrings,
  repositoryConstraints: whatToDoStrings,
  dependsOn: contractReferenceArray,
  acceptanceCriteria: {
    type: 'array',
    minItems: 1,
    maxItems: 60,
    items: whatToDoAcceptanceCriterion,
  },
  validationExpectations: { ...whatToDoStrings, minItems: 1 },
  sourceClaimIds: { ...whatToDoStrings, minItems: 1 },
  openDecisions: whatToDoStrings,
  deliveryStrategy: whatToDoDeliveryStrategy,
});

const deliveryMapExclusionAuthority = {
  oneOf: [whatToDoObject({ anchor: whatToDoAnchor }), { type: 'null' }],
};

const deliveryMapSourceClaim = whatToDoObject({
  claimId: whatToDoText,
  source: sourceReference,
  anchor: whatToDoAnchor,
  summary: whatToDoText,
  disposition: { enum: ['in-scope', 'out-of-scope'] },
  contracts: contractReferenceArray,
  exclusionReason: { oneOf: [whatToDoText, { type: 'null' }] },
  exclusionAuthority: deliveryMapExclusionAuthority,
});

const deliveryMapSourceClaimUpdate = whatToDoObject({
  claimId: whatToDoText,
  disposition: { enum: ['in-scope', 'out-of-scope'] },
  contracts: contractReferenceArray,
  exclusionReason: { oneOf: [whatToDoText, { type: 'null' }] },
  exclusionAuthority: deliveryMapExclusionAuthority,
});

const deliveryMapContractDependencyUpdate = whatToDoObject({
  contract: contractReference,
  dependsOn: contractReferenceArray,
});

const deliveryMapRecomposition = whatToDoObject({
  effects: {
    type: 'array',
    minItems: 1,
    maxItems: 400,
    items: recomposeEffectSchema(contractReferenceArray),
  },
});

const deliveryMapProposal = whatToDoObject({
  outcome: { const: 'map-proposal' },
  contracts: { type: 'array', maxItems: 200, items: deliveryMapContract },
  sourceClaims: {
    type: 'array',
    maxItems: 1_000,
    items: deliveryMapSourceClaim,
  },
});

export const DELIVERY_MAP_RESULT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Delivery Map Result',
  oneOf: [
    {
      ...deliveryMapProposal,
      properties: {
        ...deliveryMapProposal.properties,
        recomposition: deliveryMapRecomposition,
        sourceClaimUpdates: {
          type: 'array',
          maxItems: 1_000,
          uniqueItems: true,
          items: deliveryMapSourceClaimUpdate,
        },
        contractDependencyUpdates: {
          type: 'array',
          maxItems: 200,
          uniqueItems: true,
          items: deliveryMapContractDependencyUpdate,
        },
      },
    },
    whatToDoObject({
      outcome: { const: 'clarification' },
      clarification: whatToDoClarification,
    }),
    whatToDoObject({
      outcome: { const: 'insufficient-evidence' },
      missingEvidence: { ...whatToDoStrings, minItems: 1 },
    }),
    whatToDoObject({
      outcome: { const: 'no-change' },
      reason: { ...whatToDoText, maxLength: 600 },
    }),
  ],
} as const;

export const DELIVERY_MAP_RESULT_CONTRACT =
  defineResultContract<DeliveryMapResult>({
    id: DELIVERY_MAP_RESULT_CONTRACT_ID,
    version: DELIVERY_MAP_RESULT_CONTRACT_VERSION,
    schema: DELIVERY_MAP_RESULT_SCHEMA,
  });

export const DELIVERY_MAP_MINIMAL_EXAMPLE: DeliveryMapResult = {
  outcome: 'map-proposal',
  contracts: [
    {
      localKey: 'example-contract',
      title: 'Example contract',
      summary: 'One sentence describing the delivery contract.',
      outcome: 'The example capability exists.',
      includedScope: ['Example capability'],
      excludedScope: [],
      productRules: ['Example rule'],
      domainImpact: {
        kind: 'none',
        reason: 'No model change.',
        evidencePaths: [],
      },
      requiredExperienceStates: [],
      repositoryConstraints: [],
      dependsOn: [],
      acceptanceCriteria: [
        {
          id: 'AC-1',
          condition: 'The example capability is used.',
          passCondition: 'The expected result appears.',
          evidence: 'Automated test.',
        },
      ],
      validationExpectations: ['Example validation'],
      sourceClaimIds: ['claim-1'],
      openDecisions: [],
      deliveryStrategy: {
        kind: 'vertical-slice',
        reason: 'Smallest end-to-end slice.',
      },
    },
  ],
  sourceClaims: [
    {
      claimId: 'claim-1',
      source: { kind: 'source', path: 'docs/example.md' },
      anchor: 'Example anchor text',
      summary: 'The source asks for the example capability.',
      disposition: 'in-scope',
      contracts: [{ kind: 'proposal', localKey: 'example-contract' }],
      exclusionReason: null,
      exclusionAuthority: null,
    },
  ],
};

export type WhatToDoMapProposal = {
  outcome: 'map-proposal';
  candidates: WhatToDoContractCandidate[];
  sourceClaims: WhatToDoSourceClaim[];
  sourceClaimUpdates?: WhatToDoSourceClaimUpdate[];
  contractDependencyUpdates?: WhatToDoContractDependencyUpdate[];
  recomposition?: { effects: AgentGraphRecomposeEffect[] };
};
