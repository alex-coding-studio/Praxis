import type { DomainModelPatch, DomainModelResult } from './contract.ts';
import type {
  DomainEntity,
  DomainModel,
  ProposedDomainModel,
} from './model.ts';

export function applyDomainModelPatch(
  current: DomainModel,
  patch: DomainModelPatch,
): ProposedDomainModel {
  if (
    !patch ||
    !Array.isArray(patch.upsertEntities) ||
    !Array.isArray(patch.removeEntityIds) ||
    !Array.isArray(patch.removeFieldIds) ||
    !Array.isArray(patch.upsertRelationships) ||
    !Array.isArray(patch.removeRelationshipIds) ||
    !Array.isArray(patch.upsertConstraints) ||
    !Array.isArray(patch.removeConstraintIds)
  )
    throw new Error('The Domain Model patch is invalid.');
  const entitiesWithFieldRemovals = applyFieldRemovals(
    current.entities,
    patch.upsertEntities,
    patch.removeEntityIds,
    patch.removeFieldIds,
  );
  return {
    entities: patchCollection(
      entitiesWithFieldRemovals,
      patch.upsertEntities,
      patch.removeEntityIds,
      'Entity',
    ),
    relationships: patchCollection(
      current.relationships,
      patch.upsertRelationships,
      patch.removeRelationshipIds,
      'Relationship',
    ),
    constraints: patchCollection(
      current.constraints,
      patch.upsertConstraints,
      patch.removeConstraintIds,
      'Constraint',
    ),
  };
}

export function assertLegacyModelCoverage(
  current: DomainModel,
  proposed: ProposedDomainModel,
) {
  assertIdentifiersCovered(current.entities, proposed.entities, 'Entity');
  const proposedEntities = new Map(
    proposed.entities.map((entity) => [entity.id, entity]),
  );
  for (const entity of current.entities) {
    const proposedEntity = proposedEntities.get(entity.id);
    if (proposedEntity)
      assertIdentifiersCovered(entity.fields, proposedEntity.fields, 'Field');
  }
  assertIdentifiersCovered(
    current.relationships,
    proposed.relationships,
    'Relationship',
  );
  assertIdentifiersCovered(
    current.constraints,
    proposed.constraints,
    'Constraint',
  );
}

function applyFieldRemovals(
  current: DomainEntity[],
  upserts: DomainEntity[],
  removeEntityIds: string[],
  removeFieldIds: string[],
) {
  if (new Set(removeFieldIds).size !== removeFieldIds.length)
    throw new Error('Field removal identifiers must be unique.');
  const fieldOwners = new Map(
    current.flatMap((entity) =>
      entity.fields.map((field) => [field.id, entity.id] as const),
    ),
  );
  if (removeFieldIds.some((id) => !fieldOwners.has(id)))
    throw new Error('Field patch removes an unknown identifier.');
  const removedEntities = new Set(removeEntityIds);
  if (removeFieldIds.some((id) => removedEntities.has(fieldOwners.get(id)!)))
    throw new Error('A removed Entity cannot also remove one of its Fields.');
  const removedFields = new Set(removeFieldIds);
  const entities = current.map((entity) => ({
    ...entity,
    fields: entity.fields.filter((field) => !removedFields.has(field.id)),
  }));
  const currentById = new Map(entities.map((entity) => [entity.id, entity]));
  for (const entity of upserts) {
    if (entity.fields.some((field) => removedFields.has(field.id)))
      throw new Error('A Field cannot be updated and removed together.');
    const existing = currentById.get(entity.id);
    if (!existing) continue;
    const incomingIds = new Set(entity.fields.map((field) => field.id));
    if (existing.fields.some((field) => !incomingIds.has(field.id)))
      throw new Error(
        'An Entity patch must preserve every Field not explicitly removed.',
      );
  }
  return entities;
}

function assertIdentifiersCovered<T extends { id: string }>(
  current: T[],
  proposed: T[],
  label: string,
) {
  const proposedIds = new Set(proposed.map((item) => item.id));
  if (current.some((item) => !proposedIds.has(item.id)))
    throw new Error(
      `A legacy full-model response cannot omit an existing ${label}.`,
    );
}

function patchCollection<T extends { id: string }>(
  current: T[],
  upserts: T[],
  removals: string[],
  label: string,
) {
  const currentIds = new Set(current.map((item) => item.id));
  const upsertIds = upserts.map((item) => item.id);
  if (new Set(upsertIds).size !== upsertIds.length)
    throw new Error(`${label} patch identifiers must be unique.`);
  if (new Set(removals).size !== removals.length)
    throw new Error(`${label} removal identifiers must be unique.`);
  if (removals.some((id) => !currentIds.has(id)))
    throw new Error(`${label} patch removes an unknown identifier.`);
  if (removals.some((id) => upsertIds.includes(id)))
    throw new Error(`${label} cannot be updated and removed together.`);
  const updates = new Map(upserts.map((item) => [item.id, item]));
  const removed = new Set(removals);
  return [
    ...current
      .filter((item) => !removed.has(item.id))
      .map((item) => updates.get(item.id) ?? item),
    ...upserts.filter((item) => !currentIds.has(item.id)),
  ];
}

export function composeDomainModel(
  current: DomainModel,
  result: Extract<DomainModelResult, { outcome: 'model-change' }>,
): ProposedDomainModel {
  if (result.change.kind === 'patch')
    return applyDomainModelPatch(current, result.change.patch);
  assertLegacyModelCoverage(current, result.change.model);
  return result.change.model;
}
