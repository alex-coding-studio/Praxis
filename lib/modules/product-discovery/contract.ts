import {
  defineResultContract,
  type ResultContract,
} from '../../materialization/contract.ts';
import {
  CLARIFICATION_SCHEMA,
  GRAPH_PROPOSAL_CANDIDATE_PROPERTIES,
  GRAPH_PROPOSAL_CANDIDATE_REQUIRED,
  NON_EMPTY_STRING_SCHEMA,
  type GraphCandidateInput,
  type GraphCandidateRecord,
  type GraphClarification,
  type GraphProposalCandidate,
  type GraphResourceReference,
} from '../../graph/proposal/contract.ts';
import { whatsNextLayers, type WhatsNextLayer } from './intention.ts';

export const PRODUCT_EXPLORATION_RESULT_CONTRACT_ID =
  'praxis.product-exploration.result';
export const PRODUCT_EXPLORATION_RESULT_CONTRACT_VERSION = 1;

export const productExplorationArtifactKinds = [
  'direction',
  'mvp',
  'feature',
] as const;
export type ProductExplorationArtifactKind =
  (typeof productExplorationArtifactKinds)[number];

export type ProductExplorationResourceReference = GraphResourceReference;

type ProductExplorationCandidateExtension = {
  outputMarkdown: string;
  layer: WhatsNextLayer;
  artifactKind: ProductExplorationArtifactKind;
};

export type ProductExplorationCandidateInput = GraphCandidateInput &
  ProductExplorationCandidateExtension;

export type ProductExplorationCandidateRecord = GraphCandidateRecord &
  ProductExplorationCandidateExtension;

export type ProductExplorationCandidate = GraphProposalCandidate &
  ProductExplorationCandidateExtension;

export type ProductExplorationResult =
  | { outcome: 'proposal'; candidates: ProductExplorationCandidate[] }
  | { outcome: 'clarification'; clarification: GraphClarification }
  | { outcome: 'no-change'; reason: string };

export const PRODUCT_EXPLORATION_CANDIDATE_EXTENSION_REQUIRED = [
  'outputMarkdown',
  'layer',
  'artifactKind',
] as const;

export const PRODUCT_EXPLORATION_CANDIDATE_EXTENSION_PROPERTIES = {
  outputMarkdown: { ...NON_EMPTY_STRING_SCHEMA, maxLength: 4_000 },
  layer: { enum: whatsNextLayers },
  artifactKind: { enum: productExplorationArtifactKinds },
} as const;

const semanticCandidate = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...GRAPH_PROPOSAL_CANDIDATE_REQUIRED,
    ...PRODUCT_EXPLORATION_CANDIDATE_EXTENSION_REQUIRED,
  ],
  properties: {
    ...GRAPH_PROPOSAL_CANDIDATE_PROPERTIES,
    ...PRODUCT_EXPLORATION_CANDIDATE_EXTENSION_PROPERTIES,
  },
} as const;

export const PRODUCT_EXPLORATION_RESULT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Product Exploration Result',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'candidates'],
      properties: {
        outcome: { const: 'proposal' },
        candidates: { type: 'array', minItems: 1, items: semanticCandidate },
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
      required: ['outcome', 'reason'],
      properties: {
        outcome: { const: 'no-change' },
        reason: { ...NON_EMPTY_STRING_SCHEMA, maxLength: 600 },
      },
    },
  ],
} as const;

export const PRODUCT_EXPLORATION_RESULT_CONTRACT: ResultContract<ProductExplorationResult> =
  defineResultContract<ProductExplorationResult>({
    id: PRODUCT_EXPLORATION_RESULT_CONTRACT_ID,
    version: PRODUCT_EXPLORATION_RESULT_CONTRACT_VERSION,
    schema: PRODUCT_EXPLORATION_RESULT_SCHEMA,
  });

export const PRODUCT_EXPLORATION_MINIMAL_EXAMPLE: ProductExplorationResult = {
  outcome: 'proposal',
  candidates: [
    {
      localKey: 'first-direction',
      type: 'direction',
      title: 'Example direction',
      summary: 'One sentence describing the proposed direction.',
      derivedFrom: [{ kind: 'node', id: 'NODE-00000001' }],
      dependsOn: [],
      resources: [],
      typeTemplateRef: null,
      metadata: {},
      presentation: {},
      assumptions: [],
      outputMarkdown:
        '# Example direction\n\n## Why this direction\n\n- Reason one\n- Reason two',
      layer: 'discovery',
      artifactKind: 'direction',
    },
  ],
};
