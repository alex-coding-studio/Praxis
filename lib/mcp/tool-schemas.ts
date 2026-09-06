import { PRODUCT_EXPLORATION_RESULT_SCHEMA } from '../modules/product-discovery/contract.ts';
import {
  whatsNextIntentions,
  whatsNextLayers,
  whatsNextMotions,
} from '../modules/product-discovery/intention.ts';
import { MCP_OPERATION_ID_PATTERN } from './operations.ts';
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_LOG_LINES,
  DEFAULT_READ_BYTES,
  MAX_LIST_LIMIT,
  MAX_LOG_LINES,
  MAX_READ_BYTES,
} from './pagination.ts';
import { MAX_USER_INPUT_LENGTH } from './prepare.ts';

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
      enum: ['product-exploration'],
      description: 'The only module this release prepares.',
    },
    request: {
      type: 'object',
      additionalProperties: false,
      required: ['userInput', 'layer'],
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
          description: 'Which Product Exploration layer to prepare against.',
        },
        intention: {
          type: 'string',
          enum: [...whatsNextIntentions],
          description:
            'Required when the layer allows more than one intention; otherwise inferred.',
        },
        motion: {
          type: 'string',
          enum: [...whatsNextMotions],
          description: 'Defaults to unspecified.',
        },
        sourceNodeIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 50,
          description:
            'Existing graph node ids to explore from. Exactly one is required for product-design-completion.',
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
