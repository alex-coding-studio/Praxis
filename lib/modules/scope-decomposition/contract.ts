import {
  defineResultContract,
  type ResultContract,
} from '../../materialization/contract.ts';
import {
  agentGraphRecomposeEffects,
  recomposeEffectSchema,
} from '../../graph/agent/recompose.ts';
import {
  CLARIFICATION_SCHEMA,
  GRAPH_PROPOSAL_CANDIDATE_SCHEMA,
  NON_EMPTY_STRING_SCHEMA,
  STRING_ARRAY_SCHEMA,
  type GraphCandidateInput,
  type GraphCandidateRecord,
  type GraphClarification,
  type GraphProposalCandidate,
  type GraphResourceReference,
} from '../../graph/proposal/contract.ts';
import {
  CANDIDATE_REFERENCE_SCHEMA,
  PROPOSAL_REFERENCE_SCHEMA,
  type CandidateReference,
  type ProposalReference,
} from '../../graph/proposal/reference.ts';

export const SCOPE_DECOMPOSITION_RESULT_CONTRACT_ID =
  'praxis.scope-decomposition.result';
export const SCOPE_DECOMPOSITION_RESULT_CONTRACT_VERSION = 1;

export type ScopeDecompositionResourceReference = GraphResourceReference;
export type ScopeDecompositionCandidateInput = GraphCandidateInput;
export type ScopeDecompositionCandidateRecord = GraphCandidateRecord;
export type ScopeDecompositionCandidate = GraphProposalCandidate;

export type ScopeDecompositionRecomposeEffect = {
  kind: (typeof agentGraphRecomposeEffects)[number];
  from: CandidateReference[];
  to: Array<CandidateReference | ProposalReference>;
};

export type ScopeDecompositionResult =
  | {
      outcome: 'proposal';
      candidates: ScopeDecompositionCandidate[];
      recomposition?: { effects: ScopeDecompositionRecomposeEffect[] };
    }
  | { outcome: 'clarification'; clarification: GraphClarification }
  | { outcome: 'insufficient-evidence'; missingEvidence: string[] }
  | { outcome: 'no-change'; reason: string };

export const SCOPE_DECOMPOSITION_RECOMPOSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['effects'],
  properties: {
    effects: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'from', 'to'],
        properties: {
          kind: { enum: agentGraphRecomposeEffects },
          from: {
            type: 'array',
            uniqueItems: true,
            items: CANDIDATE_REFERENCE_SCHEMA,
          },
          to: {
            type: 'array',
            uniqueItems: true,
            items: {
              oneOf: [CANDIDATE_REFERENCE_SCHEMA, PROPOSAL_REFERENCE_SCHEMA],
            },
          },
        },
      },
    },
  },
} as const;

export const SCOPE_DECOMPOSITION_HARNESS_RECOMPOSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['effects'],
  properties: {
    effects: {
      type: 'array',
      minItems: 1,
      items: recomposeEffectSchema({ ...STRING_ARRAY_SCHEMA }),
    },
  },
} as const;

export const SCOPE_DECOMPOSITION_RESULT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Scope Decomposition Result',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'candidates'],
      properties: {
        outcome: { const: 'proposal' },
        candidates: {
          type: 'array',
          minItems: 0,
          items: GRAPH_PROPOSAL_CANDIDATE_SCHEMA,
        },
        recomposition: SCOPE_DECOMPOSITION_RECOMPOSITION_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'clarification'],
      properties: {
        outcome: { const: 'clarification' },
        clarification: CLARIFICATION_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'missingEvidence'],
      properties: {
        outcome: { const: 'insufficient-evidence' },
        missingEvidence: { ...STRING_ARRAY_SCHEMA, minItems: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'reason'],
      properties: {
        outcome: { const: 'no-change' },
        reason: { ...NON_EMPTY_STRING_SCHEMA, maxLength: 600 },
      },
    },
  ],
} as const;

export const SCOPE_DECOMPOSITION_RESULT_CONTRACT: ResultContract<ScopeDecompositionResult> =
  defineResultContract<ScopeDecompositionResult>({
    id: SCOPE_DECOMPOSITION_RESULT_CONTRACT_ID,
    version: SCOPE_DECOMPOSITION_RESULT_CONTRACT_VERSION,
    schema: SCOPE_DECOMPOSITION_RESULT_SCHEMA,
  });

export const SCOPE_DECOMPOSITION_MINIMAL_EXAMPLE: ScopeDecompositionResult = {
  outcome: 'proposal',
  candidates: [
    {
      localKey: 'first-module',
      type: 'module',
      title: 'Example module',
      summary: 'One sentence describing the proposed module.',
      derivedFrom: [{ kind: 'node', id: 'NODE-00000001' }],
      dependsOn: [],
      resources: [],
      typeTemplateRef: null,
      metadata: {},
      presentation: {},
      assumptions: [],
    },
  ],
};
