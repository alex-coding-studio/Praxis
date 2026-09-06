import { PublicApiError } from '../../api-errors.ts';
import {
  validateAgentProfile,
  type AgentProfile,
} from '../../agents/profile.ts';
import type { DeliveryModels } from './types.ts';

export function validateDeliveryModels(models: DeliveryModels) {
  validateAgentProfile(models.orchestrator);
  for (const pool of [models.workers, models.reviewers]) {
    if (!Array.isArray(pool))
      throw new PublicApiError('Configure delivery model pools.');
    for (const profile of pool) validateAgentProfile(profile);
  }
}

export function selectDeliveryModel(
  models: DeliveryModels,
  role: 'worker' | 'reviewer',
  profile: AgentProfile,
) {
  validateAgentProfile(profile);
  const pool = role === 'worker' ? models.workers : models.reviewers;
  if (
    !pool.some(
      (entry) => entry.agent === profile.agent && entry.model === profile.model,
    )
  ) {
    throw new PublicApiError(
      `The ${role} model is outside the configured pool. Select an available model or ask the user to update model settings.`,
    );
  }
  return profile;
}
