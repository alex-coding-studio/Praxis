import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  ADVISORY_JSON_SCHEMA_KEYWORDS,
  ANNOTATION_JSON_SCHEMA_KEYWORDS,
  ENFORCED_JSON_SCHEMA_KEYWORDS,
  McpSchemaConversionError,
  assertConvertibleSchema,
  collectSchemaKeywords,
  toToolInputSchema,
} from '../lib/mcp/schema-adapter.ts';
import { MCP_MODULES, MCP_MODULE_DEFINITIONS } from '../lib/mcp/modules.ts';
import {
  LIST_PROJECTS_INPUT_SCHEMA,
  READ_RESOURCE_INPUT_SCHEMA,
} from '../lib/mcp/tool-schemas.ts';

function objectSchema(property: object) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['v'],
    properties: { v: property },
  };
}

const ENFORCEMENT_PROBES: Array<[string, object, unknown]> = [
  ['type', { type: 'string' }, 1],
  ['type', { type: 'integer' }, 1.5],
  ['type', { type: 'array', items: { type: 'string' } }, [1]],
  ['enum', { enum: ['a', 'b'] }, 'c'],
  ['const', { const: 'a' }, 'b'],
  ['minLength', { type: 'string', minLength: 2 }, 'a'],
  ['maxLength', { type: 'string', maxLength: 2 }, 'abc'],
  ['pattern', { type: 'string', pattern: '^[a-z]+$' }, 'A1'],
  ['minimum', { type: 'integer', minimum: 1 }, 0],
  ['maximum', { type: 'integer', maximum: 5 }, 9],
  [
    'minItems',
    { type: 'array', items: { type: 'string' }, minItems: 2 },
    ['a'],
  ],
  [
    'maxItems',
    { type: 'array', items: { type: 'string' }, maxItems: 1 },
    ['a', 'b'],
  ],
  ['oneOf', { oneOf: [{ type: 'string' }, { type: 'number' }] }, true],
];

void test('every keyword the four Result Contracts use is classified by the adapter', () => {
  const unclassified = new Map<string, string[]>();
  const accepted = new Set<string>([
    ...ENFORCED_JSON_SCHEMA_KEYWORDS,
    ...ADVISORY_JSON_SCHEMA_KEYWORDS,
    ...ANNOTATION_JSON_SCHEMA_KEYWORDS,
  ]);
  for (const moduleName of MCP_MODULES) {
    const schema = MCP_MODULE_DEFINITIONS[moduleName].contract.schema;
    for (const [keyword, locations] of collectSchemaKeywords(schema))
      if (!accepted.has(keyword)) unclassified.set(keyword, locations);
    assert.doesNotThrow(() => assertConvertibleSchema(schema, moduleName));
  }
  assert.deepEqual([...unclassified.keys()], []);
});

void test('every enforced keyword still rejects a violating value after conversion', () => {
  for (const [keyword, property, violating] of ENFORCEMENT_PROBES) {
    const converted = toToolInputSchema(objectSchema(property), keyword);
    assert.equal(
      converted.safeParse({ v: violating }).success,
      false,
      `${keyword} must stay enforced after conversion`,
    );
  }
});

void test('required, optional and additionalProperties survive conversion', () => {
  const converted = toToolInputSchema(
    {
      type: 'object',
      additionalProperties: false,
      required: ['need'],
      properties: {
        need: { type: 'string' },
        optional: { type: 'string' },
      },
    },
    'shape',
  );
  assert.equal(converted.safeParse({ need: 'x' }).success, true);
  assert.equal(converted.safeParse({ need: 'x', optional: 'y' }).success, true);
  assert.equal(converted.safeParse({ optional: 'y' }).success, false);
  assert.equal(converted.safeParse({ need: 'x', extra: 1 }).success, false);
});

void test('a null never satisfies a typed field that does not allow it', () => {
  for (const property of [
    { type: 'string' },
    { type: 'integer' },
    { type: 'array', items: { type: 'string' } },
    { type: 'object', additionalProperties: false, properties: {} },
  ]) {
    const converted = toToolInputSchema(objectSchema(property), 'null-probe');
    assert.equal(converted.safeParse({ v: null }).success, false);
  }
});

void test('uniqueItems is advisory at the tool layer and authoritative in the contract', () => {
  const definition = MCP_MODULE_DEFINITIONS['delivery-planning'];
  const valid = definition.example as {
    contracts: Array<{ includedScope: string[] }>;
  };
  const duplicated = structuredClone(valid);
  const scope = duplicated.contracts[0]!.includedScope;
  scope.push(scope[0]!);

  const converted = toToolInputSchema(
    definition.contract.schema,
    'delivery-planning',
  );
  assert.equal(
    converted.safeParse(valid).success,
    true,
    'the valid example must not be refused by the converted schema',
  );
  assert.equal(
    converted.safeParse(duplicated).success,
    true,
    'uniqueItems is known not to survive conversion; this test pins that boundary',
  );
  assert.throws(
    () => definition.contract.validateStructure(duplicated),
    /NOT have duplicate items/,
  );
});

void test('the adapter refuses a schema keyword it has not classified', () => {
  assert.throws(
    () =>
      assertConvertibleSchema(
        objectSchema({
          type: 'array',
          items: { type: 'string' },
          contains: { type: 'string' },
        }),
        'probe',
      ),
    (error: unknown) =>
      error instanceof McpSchemaConversionError && error.keyword === 'contains',
  );
  assert.throws(
    () => assertConvertibleSchema({ type: 'object', multipleOf: 5 }, 'probe'),
    (error: unknown) =>
      error instanceof McpSchemaConversionError &&
      error.keyword === 'multipleOf',
  );
});

void test('an unsupported construct fails registration instead of widening the field', () => {
  for (const schema of [
    { type: 'object', properties: { v: { not: { type: 'string' } } } },
    {
      type: 'object',
      properties: { v: { type: 'string' } },
      dependentRequired: { v: ['w'] },
    },
  ]) {
    assert.throws(
      () => toToolInputSchema(schema, 'unsupported'),
      (error: unknown) => error instanceof McpSchemaConversionError,
    );
  }
});

void test('each Result Contract converts and accepts its own valid example', () => {
  for (const moduleName of MCP_MODULES) {
    const definition = MCP_MODULE_DEFINITIONS[moduleName];
    const converted = toToolInputSchema(definition.contract.schema, moduleName);
    assert.equal(
      converted.safeParse(definition.example).success,
      true,
      `${moduleName} must accept the example its own contract validates`,
    );
    assert.doesNotThrow(() =>
      definition.contract.validateStructure(definition.example),
    );
  }
});

void test('a converted contract still refuses an example missing a required field', () => {
  for (const moduleName of MCP_MODULES) {
    const definition = MCP_MODULE_DEFINITIONS[moduleName];
    const converted = toToolInputSchema(definition.contract.schema, moduleName);
    assert.equal(converted.safeParse({}).success, false, moduleName);
    assert.equal(converted.safeParse(null).success, false, moduleName);
  }
});

void test('the tool input schemas convert and enforce their advertised bounds', () => {
  const projects = toToolInputSchema<{ cursor?: string; limit?: number }>(
    LIST_PROJECTS_INPUT_SCHEMA,
    'praxis_list_projects',
  );
  assert.equal(projects.safeParse({}).success, true);
  assert.equal(projects.safeParse({ limit: 50 }).success, true);
  assert.equal(projects.safeParse({ limit: 0 }).success, false);
  assert.equal(projects.safeParse({ limit: 101 }).success, false);
  assert.equal(projects.safeParse({ limit: 1.5 }).success, false);
  assert.equal(projects.safeParse({ unknown: 1 }).success, false);

  const resource = toToolInputSchema<{ uri: string }>(
    READ_RESOURCE_INPUT_SCHEMA,
    'praxis_read_resource',
  );
  assert.equal(
    resource.safeParse({ uri: 'praxis://capabilities' }).success,
    true,
  );
  assert.equal(resource.safeParse({}).success, false);
  assert.equal(resource.safeParse({ uri: '' }).success, false);
  assert.equal(
    resource.safeParse({ uri: 'file:///etc/passwd' }).success,
    true,
    'URI shape stays a catalog decision so its refusal keeps the Praxis error envelope',
  );
});

void test('the pinned Zod release is the one these results were measured against', async () => {
  const { default: manifest } = await import('zod/package.json', {
    with: { type: 'json' },
  });
  assert.equal((manifest as { version: string }).version, '4.5.4');
  assert.equal(typeof z.fromJSONSchema, 'function');
});
