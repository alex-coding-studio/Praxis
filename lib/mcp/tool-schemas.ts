import Ajv2020 from 'ajv/dist/2020.js';
import { invalidArgument } from './errors.ts';
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
      pattern: '^praxis://',
      description: 'A praxis:// resource URI from the catalog.',
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

const ajv = new Ajv2020({ strict: true, allErrors: true });

const validators = new Map<object, ReturnType<typeof ajv.compile>>();

function validatorFor(schema: object) {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  return validate;
}

export function validateToolInput<T>(
  toolName: string,
  schema: object,
  value: unknown,
): T {
  const validate = validatorFor(schema);
  const candidate = value ?? {};
  if (!validate(candidate))
    throw invalidArgument(
      `${toolName}: ${ajv.errorsText(validate.errors, { dataVar: 'arguments' })}.`,
    );
  return candidate as T;
}
