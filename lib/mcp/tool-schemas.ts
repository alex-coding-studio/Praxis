import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_READ_BYTES,
  MAX_LIST_LIMIT,
  MAX_READ_BYTES,
} from './pagination.ts';

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
