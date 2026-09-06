import type { DomainModelBasis } from './basis.ts';
import type { DomainModelResult } from './contract.ts';
import { composeDomainModel } from './materializer.ts';
import {
  applyProposedDomainModel,
  type DomainChange,
  type ProposedDomainModel,
} from './model.ts';
import type { RegisteredProject } from '../../project-registry.ts';

export type DomainModelPublicationOutcome =
  | 'model-change'
  | 'no-change'
  | 'clarification';

type PublishedDomainModelBase = {
  summary: string;
  change: DomainChange | null;
  stateVersion: number;
};

export type PublishedDomainModel = PublishedDomainModelBase &
  (
    | { outcome: 'model-change'; model: ProposedDomainModel }
    | { outcome: 'no-change' | 'clarification'; model: null }
  );

export const DOMAIN_MODEL_UNCHANGED_REASON =
  'The current Domain Model already represents this request.';

export async function publishDomainModelResult(
  project: RegisteredProject,
  basis: DomainModelBasis,
  result: DomainModelResult,
  producer: { runId: string; userInputPath: string | null },
): Promise<PublishedDomainModel> {
  if (result.outcome !== 'model-change')
    return {
      outcome: result.outcome,
      summary: result.summary,
      model: null,
      change: null,
      stateVersion: basis.stateVersion,
    };
  const model = composeDomainModel(basis.model, result);
  const applied = await applyProposedDomainModel(project, {
    baseVersion: basis.stateVersion,
    runId: producer.runId,
    userInputPath: producer.userInputPath,
    summary: result.summary,
    proposed: model,
  });
  return applied.change
    ? {
        outcome: 'model-change',
        summary: result.summary,
        model,
        change: applied.change,
        stateVersion: applied.model.stateVersion,
      }
    : {
        outcome: 'no-change',
        summary: result.summary,
        model: null,
        change: null,
        stateVersion: applied.model.stateVersion,
      };
}
