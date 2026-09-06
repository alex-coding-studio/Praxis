import {
  defineResultContract,
  type ResultContract,
} from '../../materialization/contract.ts';
import type {
  DomainConstraint,
  DomainEntity,
  DomainRelationship,
  ProposedDomainModel,
} from './model.ts';

export const DOMAIN_MODEL_RESULT_CONTRACT_ID = 'praxis.domain-model.result';
export const DOMAIN_MODEL_RESULT_CONTRACT_VERSION = 1;

export type DomainModelPatch = {
  upsertEntities: DomainEntity[];
  removeEntityIds: string[];
  removeFieldIds: string[];
  upsertRelationships: DomainRelationship[];
  removeRelationshipIds: string[];
  upsertConstraints: DomainConstraint[];
  removeConstraintIds: string[];
};

export type DomainModelChange =
  | { kind: 'patch'; patch: DomainModelPatch }
  | { kind: 'model'; model: ProposedDomainModel };

export type DomainModelResult =
  | { outcome: 'model-change'; summary: string; change: DomainModelChange }
  | { outcome: 'clarification'; summary: string; question: string }
  | { outcome: 'no-change'; summary: string; reason: string };

const text = { type: 'string', minLength: 1, pattern: '\\S' } as const;
const boundedText = { ...text, maxLength: 4_000 } as const;
const elementId = {
  type: 'string',
  pattern:
    '^(?:(?:ENTITY|FIELD|RELATIONSHIP|CONSTRAINT)-[0-9a-f-]{36}|NEW_(?:ENTITY|FIELD|RELATIONSHIP|CONSTRAINT)_[A-Z0-9_]+)$',
} as const;
const idArray = { type: 'array', uniqueItems: true, items: elementId } as const;
const provenance = { enum: ['explicit', 'inferred'] } as const;

const field = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'meaning',
    'valueType',
    'required',
    'multiple',
    'display',
    'provenance',
  ],
  properties: {
    id: elementId,
    name: boundedText,
    meaning: boundedText,
    valueType: boundedText,
    required: { type: 'boolean' },
    multiple: { type: 'boolean' },
    display: { enum: ['primary', 'secondary', 'system'] },
    provenance,
  },
} as const;

const entity = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'meaning', 'fields', 'provenance'],
  properties: {
    id: elementId,
    name: boundedText,
    meaning: boundedText,
    fields: { type: 'array', items: field },
    provenance,
  },
} as const;

const relationship = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sourceEntityId',
    'targetEntityId',
    'label',
    'meaning',
    'semanticRole',
    'direction',
    'sourceCardinality',
    'targetCardinality',
    'provenance',
  ],
  properties: {
    id: elementId,
    sourceEntityId: elementId,
    targetEntityId: elementId,
    label: boundedText,
    meaning: boundedText,
    semanticRole: { enum: ['inheritance', 'containment', 'association'] },
    direction: { enum: ['directed', 'undirected'] },
    sourceCardinality: boundedText,
    targetCardinality: boundedText,
    provenance,
  },
} as const;

const constraint = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'target', 'text', 'provenance'],
  properties: {
    id: elementId,
    target: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id'],
      properties: {
        kind: { enum: ['model', 'entity', 'relationship'] },
        id: { oneOf: [elementId, { type: 'null' }] },
      },
    },
    text: boundedText,
    provenance,
  },
} as const;

export const DOMAIN_MODEL_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'upsertEntities',
    'removeEntityIds',
    'removeFieldIds',
    'upsertRelationships',
    'removeRelationshipIds',
    'upsertConstraints',
    'removeConstraintIds',
  ],
  properties: {
    upsertEntities: { type: 'array', items: entity },
    removeEntityIds: idArray,
    removeFieldIds: idArray,
    upsertRelationships: { type: 'array', items: relationship },
    removeRelationshipIds: idArray,
    upsertConstraints: { type: 'array', items: constraint },
    removeConstraintIds: idArray,
  },
} as const;

export const PROPOSED_DOMAIN_MODEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entities', 'relationships', 'constraints'],
  properties: {
    entities: { type: 'array', items: entity },
    relationships: { type: 'array', items: relationship },
    constraints: { type: 'array', items: constraint },
  },
} as const;

export const DOMAIN_MODEL_RESULT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Domain Model Result',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'summary', 'change'],
      properties: {
        outcome: { const: 'model-change' },
        summary: boundedText,
        change: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'patch'],
              properties: {
                kind: { const: 'patch' },
                patch: DOMAIN_MODEL_PATCH_SCHEMA,
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'model'],
              properties: {
                kind: { const: 'model' },
                model: PROPOSED_DOMAIN_MODEL_SCHEMA,
              },
            },
          ],
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'summary', 'question'],
      properties: {
        outcome: { const: 'clarification' },
        summary: boundedText,
        question: boundedText,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'summary', 'reason'],
      properties: {
        outcome: { const: 'no-change' },
        summary: boundedText,
        reason: boundedText,
      },
    },
  ],
} as const;

export const DOMAIN_MODEL_RESULT_CONTRACT: ResultContract<DomainModelResult> =
  defineResultContract<DomainModelResult>({
    id: DOMAIN_MODEL_RESULT_CONTRACT_ID,
    version: DOMAIN_MODEL_RESULT_CONTRACT_VERSION,
    schema: DOMAIN_MODEL_RESULT_SCHEMA,
  });

export const DOMAIN_MODEL_MINIMAL_EXAMPLE: DomainModelResult = {
  outcome: 'model-change',
  summary: 'Adds one example entity.',
  change: {
    kind: 'patch',
    patch: {
      upsertEntities: [
        {
          id: 'NEW_ENTITY_EXAMPLE',
          name: 'Example',
          meaning: 'A placeholder entity.',
          fields: [
            {
              id: 'NEW_FIELD_EXAMPLE_NAME',
              name: 'name',
              meaning: 'Display name.',
              valueType: 'text',
              required: true,
              multiple: false,
              display: 'primary',
              provenance: 'explicit',
            },
          ],
          provenance: 'explicit',
        },
      ],
      removeEntityIds: [],
      removeFieldIds: [],
      upsertRelationships: [],
      removeRelationshipIds: [],
      upsertConstraints: [],
      removeConstraintIds: [],
    },
  },
};
