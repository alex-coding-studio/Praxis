import { planningService } from '../implementation/planning-service.ts';
import { deliveryContractPlanningSource } from '../implementation/planning-sources.ts';
import { assertDeliveryMapPreservesTargets } from '../delivery/map-boundary.ts';
import type { DeliveryPublicationHost } from './publish.ts';

export const deliveryPublicationHost: DeliveryPublicationHost = {
  list: (project) => planningService.list(project),
  stageDeleteCard: (project, cardId, revision) =>
    planningService.stageDeleteCard(project, cardId, revision),
  contractSource: deliveryContractPlanningSource,
  assertPreservesTargets: assertDeliveryMapPreservesTargets,
};
