import { PRODUCT_EXPLORATION_RESULT_SCHEMA } from '../modules/product-discovery/contract.ts';
import { SCOPE_DECOMPOSITION_RESULT_SCHEMA } from '../modules/scope-decomposition/contract.ts';
import { DOMAIN_MODEL_RESULT_SCHEMA } from '../modules/domain-modeling/contract.ts';
import { DELIVERY_MAP_RESULT_SCHEMA } from '../modules/delivery-planning/contract.ts';
import {
  whatsNextIntentions,
  whatsNextLayers,
  whatsNextMotions,
} from '../modules/product-discovery/intention.ts';
import { CANDIDATE_ALIAS_PATTERN } from '../graph/identity.ts';
import { PROPOSAL_RUN_ID } from '../graph/proposal/run-state.ts';
import { ACCEPTANCE_MODULES } from './accept.ts';
import { MCP_OPERATION_ID_PATTERN } from './operations.ts';
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_LOG_LINES,
  DEFAULT_READ_BYTES,
  MAX_LIST_LIMIT,
  MAX_LOG_LINES,
  MAX_READ_BYTES,
} from './pagination.ts';
import {
  MAX_USER_INPUT_LENGTH,
  PRODUCT_EXPLORATION_OPERATIONS,
} from './prepare.ts';
import {
  SCOPE_DECOMPOSITION_INTENTIONS,
  SCOPE_DECOMPOSITION_MOTIONS,
  SCOPE_DECOMPOSITION_OPERATIONS,
} from './prepare-scope-decomposition.ts';

export const LIST_PROJECTS_INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: {
      type: 'string',
      description: 'Continuation cursor returned by a previous page.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_LIST_LIMIT,
      description: `Maximum project summaries to return (default ${DEFAULT_LIST_LIMIT}).`,
    },
  },
} as const;

export const READ_RESOURCE_INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['uri'],
  properties: {
    uri: {
      type: 'string',
      minLength: 1,
      description:
        'A praxis:// resource URI from the catalog. Read praxis://capabilities for the shapes this Host serves.',
    },
    cursor: {
      type: 'string',
      description: 'Continuation cursor returned by a previous page.',
    },
    limitBytes: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_READ_BYTES,
      description: `Maximum bytes of content to return (default ${DEFAULT_READ_BYTES}).`,
    },
  },
} as const;

const OPERATION_ID_PROPERTY = {
  type: 'string',
  pattern: MCP_OPERATION_ID_PATTERN.source,
  description: 'An operation id issued by praxis_prepare.',
} as const;

export const PREPARE_INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'module', 'request'],
  properties: {
    projectId: {
      type: 'string',
      minLength: 1,
      description: 'A registered project id from praxis://projects.',
    },
    module: {
      type: 'string',
      enum: [
        'product-exploration',
        'scope-decomposition',
        'domain-modeling',
        'delivery-planning',
      ],
      description: 'The module to prepare against.',
    },
    request: {
      type: 'object',
      additionalProperties: false,
      required: ['userInput'],
      properties: {
        userInput: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_USER_INPUT_LENGTH,
          description: 'The intent to record as submitted evidence.',
        },
        layer: {
          type: 'string',
          enum: [...whatsNextLayers],
          description:
            'product-exploration: which layer to prepare against. Required for that module.',
        },
        intention: {
          type: 'string',
          enum: [
            ...new Set([
              ...whatsNextIntentions,
              ...SCOPE_DECOMPOSITION_INTENTIONS,
            ]),
          ],
          description:
            'Required when the module and layer allow more than one intention; otherwise inferred.',
        },
        motion: {
          type: 'string',
          enum: [
            ...new Set([...whatsNextMotions, ...SCOPE_DECOMPOSITION_MOTIONS]),
          ],
          description: 'Defaults to unspecified.',
        },
        sourceNodeIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 50,
          description:
            'product-exploration: existing graph node ids to explore from. Exactly one is required for product-design-completion.',
        },
        sourceNodeId: {
          type: 'string',
          minLength: 1,
          description:
            'scope-decomposition: the graph node being decomposed. Required for that module.',
        },
        operation: {
          type: 'string',
          enum: [
            ...new Set([
              ...SCOPE_DECOMPOSITION_OPERATIONS,
              ...PRODUCT_EXPLORATION_OPERATIONS,
            ]),
          ],
          description:
            'scope-decomposition: defaults to propose. revise-candidate names exactly one Candidate; recompose-candidates names a nonempty selection. product-exploration: defaults to explore. refine-candidate names exactly one open Candidate to revise in place.',
        },
        candidateIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 100,
          description:
            'scope-decomposition: open Candidate ids this operation revises or recomposes. product-exploration: exactly one open Candidate id for refine-candidate.',
        },
        selectionIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 100,
          description:
            'domain-modeling: entity or relationship ids to focus on, empty for the current model scope. delivery-planning: Contract ids in the current Delivery Map to focus on; focus is not permission to discard the rest.',
        },
        sourceUids: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 20,
          description:
            'delivery-planning: accepted Product Design Feature uids to plan from. At least one is required when no Delivery Map exists yet.',
        },
        contextIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 50,
          description:
            'Artifact handles from the project catalog to freeze as context evidence.',
        },
      },
    },
  },
} as const;

export const SUBMIT_PRODUCT_EXPLORATION_INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['operationId', 'contract', 'result'],
  properties: {
    operationId: OPERATION_ID_PROPERTY,
    contract: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'hash'],
      properties: {
        id: { type: 'string', minLength: 1 },
        version: { type: 'integer', minimum: 1 },
        hash: { type: 'string', minLength: 1 },
      },
      description:
        'The Result Contract identity this result was written against.',
    },
    result: PRODUCT_EXPLORATION_RESULT_SCHEMA,
  },
} as const;

export const GET_OPERATION_INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'operationId'],
  properties: {
    projectId: { type: 'string', minLength: 1 },
    operationId: OPERATION_ID_PROPERTY,
  },
} as const;

export const READ_LOG_INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'operationId'],
  properties: {
    projectId: { type: 'string', minLength: 1 },
    operationId: OPERATION_ID_PROPERTY,
    cursor: {
      type: 'string',
      description: 'Continuation cursor returned by a previous page.',
    },
    limitLines: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_LOG_LINES,
      description: `Maximum log lines to return (default ${DEFAULT_LOG_LINES}).`,
    },
  },
} as const;

export const SUBMIT_SCOPE_DECOMPOSITION_INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['operationId', 'contract', 'result'],
  properties: {
    operationId: OPERATION_ID_PROPERTY,
    contract: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'hash'],
      properties: {
        id: { type: 'string', minLength: 1 },
        version: { type: 'integer', minimum: 1 },
        hash: { type: 'string', minLength: 1 },
      },
      description:
        'The Result Contract identity this result was written against.',
    },
    result: SCOPE_DECOMPOSITION_RESULT_SCHEMA,
  },
} as const;

function submissionSchema(resultSchema: object) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['operationId', 'contract', 'result'],
    properties: {
      operationId: OPERATION_ID_PROPERTY,
      contract: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'version', 'hash'],
        properties: {
          id: { type: 'string', minLength: 1 },
          version: { type: 'integer', minimum: 1 },
          hash: { type: 'string', minLength: 1 },
        },
        description:
          'The Result Contract identity this result was written against.',
      },
      result: resultSchema,
    },
  };
}

export const SUBMIT_DOMAIN_MODEL_INPUT_SCHEMA = submissionSchema(
  DOMAIN_MODEL_RESULT_SCHEMA,
);

export const SUBMIT_DELIVERY_MAP_INPUT_SCHEMA = submissionSchema(
  DELIVERY_MAP_RESULT_SCHEMA,
);

export const ACCEPT_CANDIDATE_INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'module', 'runId', 'candidateId', 'expectedRevision'],
  properties: {
    projectId: {
      type: 'string',
      minLength: 1,
      description: 'A project id from praxis://projects.',
    },
    module: {
      enum: [...ACCEPTANCE_MODULES],
      description:
        'The module that proposed the Candidate. Only Product Exploration and Scope Decomposition serve acceptance.',
    },
    runId: {
      type: 'string',
      pattern: PROPOSAL_RUN_ID.source,
      description:
        'The proposing Run id, as reported by pendingCandidates in the module resource.',
    },
    candidateId: {
      type: 'string',
      pattern: CANDIDATE_ALIAS_PATTERN,
      description: 'The Candidate to accept.',
    },
    expectedRevision: {
      type: 'integer',
      minimum: 1,
      description:
        'The Candidate revision this acceptance was decided against. A newer revision is refused rather than accepted silently.',
    },
  },
} as const;

export const DISCARD_CANDIDATE_INPUT_SCHEMA = {
  ...ACCEPT_CANDIDATE_INPUT_SCHEMA,
  properties: {
    ...ACCEPT_CANDIDATE_INPUT_SCHEMA.properties,
    expectedRevision: {
      ...ACCEPT_CANDIDATE_INPUT_SCHEMA.properties.expectedRevision,
      description:
        'The Candidate revision this discard was decided against. A Candidate revised after the read is refused rather than removed silently.',
    },
  },
} as const;
