import { z, type ZodType } from 'zod';

export const ENFORCED_JSON_SCHEMA_KEYWORDS = [
  'additionalProperties',
  'const',
  'enum',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'oneOf',
  'pattern',
  'properties',
  'required',
  'type',
] as const;

export const ADVISORY_JSON_SCHEMA_KEYWORDS = ['uniqueItems'] as const;

export const ANNOTATION_JSON_SCHEMA_KEYWORDS = [
  '$schema',
  'description',
  'title',
] as const;

const ACCEPTED = new Set<string>([
  ...ENFORCED_JSON_SCHEMA_KEYWORDS,
  ...ADVISORY_JSON_SCHEMA_KEYWORDS,
  ...ANNOTATION_JSON_SCHEMA_KEYWORDS,
]);

const SUBSCHEMA_VALUE = new Set(['additionalProperties', 'items']);
const SUBSCHEMA_LIST = new Set(['oneOf']);
const SUBSCHEMA_MAP = new Set(['properties']);

export class McpSchemaConversionError extends Error {
  readonly keyword: string;
  readonly location: string;
  constructor(keyword: string, location: string, reason: string) {
    super(
      `${keyword} at ${location} ${reason}. Verify how the conversion treats it and add it to the adapter's classification before a contract relies on it.`,
    );
    this.name = 'McpSchemaConversionError';
    this.keyword = keyword;
    this.location = location;
  }
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function collectSchemaKeywords(schema: unknown) {
  const found = new Map<string, string[]>();
  const record = (keyword: string, location: string) => {
    const locations = found.get(keyword) ?? [];
    locations.push(location);
    found.set(keyword, locations);
  };
  const walk = (node: unknown, location: string) => {
    if (!isSchemaObject(node)) return;
    for (const [keyword, value] of Object.entries(node)) {
      record(keyword, location);
      const next = location === '' ? keyword : `${location}.${keyword}`;
      if (SUBSCHEMA_MAP.has(keyword) && isSchemaObject(value))
        for (const [name, sub] of Object.entries(value))
          walk(sub, `${next}.${name}`);
      else if (SUBSCHEMA_LIST.has(keyword) && Array.isArray(value))
        value.forEach((sub, index) => walk(sub, `${next}[${index}]`));
      else if (SUBSCHEMA_VALUE.has(keyword)) walk(value, next);
    }
  };
  walk(schema, '');
  return found;
}

export function assertConvertibleSchema(schema: unknown, label: string) {
  for (const [keyword, locations] of collectSchemaKeywords(schema)) {
    if (ACCEPTED.has(keyword)) continue;
    throw new McpSchemaConversionError(
      keyword,
      `${label}${locations[0] === '' ? '' : `.${locations[0]}`}`,
      'is not classified by the Praxis MCP schema adapter',
    );
  }
}

export function toToolInputSchema<T>(
  schema: unknown,
  label: string,
): ZodType<T> {
  assertConvertibleSchema(schema, label);
  try {
    return z.fromJSONSchema(
      schema as Parameters<typeof z.fromJSONSchema>[0],
    ) as unknown as ZodType<T>;
  } catch (error) {
    throw new McpSchemaConversionError(
      'schema',
      label,
      `could not be converted for tool registration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
