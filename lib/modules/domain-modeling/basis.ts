import type { MaterializationBasisCore } from '../../materialization/basis.ts';
import { contractIdentity } from '../../materialization/contract.ts';
import { semanticResultHash } from '../../materialization/hash.ts';
import { MaterializationError } from '../../materialization/receipt.ts';
import { DOMAIN_MODEL_RESULT_CONTRACT } from './contract.ts';
import type { DomainModel } from './model.ts';
import type { RegisteredProject } from '../../project-registry.ts';

export type DomainModelBasis = MaterializationBasisCore & {
  stateVersion: number;
  selectedIds: readonly string[];
  model: DomainModel;
};

export type DomainModelBasisInput = {
  model: DomainModel;
  selectedIds: readonly string[];
};

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
  }
  return value;
}

export function assertDomainModelSelection(
  model: DomainModel,
  selectedIds: readonly string[],
) {
  const available = new Set([
    ...model.entities.map((entity) => entity.id),
    ...model.relationships.map((relationship) => relationship.id),
  ]);
  if (selectedIds.some((id) => !available.has(id))) {
    throw new MaterializationError(
      'stale-basis',
      'A selected Domain element is no longer available.',
    );
  }
}

export function prepareDomainModelBasis(
  project: RegisteredProject,
  input: DomainModelBasisInput,
  now: () => string = () => new Date().toISOString(),
): DomainModelBasis {
  const selectedIds = [...new Set(input.selectedIds)];
  assertDomainModelSelection(input.model, selectedIds);
  const model = structuredClone(input.model);
  return deepFreeze({
    project: { id: project.id, planningPath: project.planningPath },
    module: 'domain-model',
    operation: 'change-model',
    contract: contractIdentity(DOMAIN_MODEL_RESULT_CONTRACT),
    fingerprint: semanticResultHash({
      stateVersion: model.stateVersion,
      selectedIds: [...selectedIds].sort(),
      model,
    }),
    preparedAt: now(),
    stateVersion: model.stateVersion,
    selectedIds,
    model,
  });
}
