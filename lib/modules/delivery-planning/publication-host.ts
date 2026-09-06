import {
  listPlanningCards,
  stagePlanningCardDeletion,
} from '../implementation/card-store.ts';
import { deliveryContractPlanningSource } from '../implementation/planning-source.ts';
import { assertDeliveryMapPreservesTargets } from '../delivery/map-boundary.ts';
import type { DeliveryPublicationHost } from './publish.ts';

export const deliveryPublicationHost: DeliveryPublicationHost = {
  list: (project) => listPlanningCards(project),
  stageDeleteCard: (project, cardId, revision) =>
    stagePlanningCardDeletion(project, cardId, revision),
  contractSource: deliveryContractPlanningSource,
  assertPreservesTargets: assertDeliveryMapPreservesTargets,
};
