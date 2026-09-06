import type { MaterializationBasisCore } from '../../materialization/basis.ts';
import { contractIdentity } from '../../materialization/contract.ts';
import { semanticResultHash } from '../../materialization/hash.ts';
import { DELIVERY_MAP_RESULT_CONTRACT } from './contract.ts';
import type { WhatToDoDeliveryMap } from './map.ts';
import type { RegisteredProject } from '../../project-registry.ts';

export type DeliveryMapOperation = 'create-map' | 'adjust-map';

export type DeliveryMapBasis = MaterializationBasisCore & {
  operation: DeliveryMapOperation;
  currentMap: WhatToDoDeliveryMap | null;
  currentMapFingerprint: string;
};

export function prepareDeliveryMapBasis(
  project: RegisteredProject,
  input: {
    currentMap: WhatToDoDeliveryMap | null;
    currentMapFingerprint: string;
  },
  now: () => string = () => new Date().toISOString(),
): DeliveryMapBasis {
  return Object.freeze({
    project: { id: project.id, planningPath: project.planningPath },
    module: 'what-to-do' as const,
    operation:
      input.currentMapFingerprint === 'absent'
        ? ('create-map' as const)
        : ('adjust-map' as const),
    contract: contractIdentity(DELIVERY_MAP_RESULT_CONTRACT),
    fingerprint: semanticResultHash({
      currentMapFingerprint: input.currentMapFingerprint,
    }),
    preparedAt: now(),
    currentMap: input.currentMap ? structuredClone(input.currentMap) : null,
    currentMapFingerprint: input.currentMapFingerprint,
  });
}
