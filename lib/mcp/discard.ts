import { CandidateAcceptanceError } from '../graph/proposal/pending.ts';
import { listPendingProductExplorationCandidates } from '../modules/product-discovery/acceptance.ts';
import { discardProductExplorationCandidate } from '../modules/product-discovery/discard.ts';
import { listPendingScopeDecompositionCandidates } from '../modules/scope-decomposition/acceptance.ts';
import { discardScopeDecompositionCandidate } from '../modules/scope-decomposition/discard.ts';
import { collectAcceptedCandidateIds as acceptedExplorationIds } from '../modules/product-discovery/assembly.ts';
import { collectAcceptedCandidateIds as acceptedScopeIds } from '../modules/scope-decomposition/assembly.ts';
import { candidateOperationFailure, type AcceptanceModule } from './accept.ts';
import { requireProject } from './catalog.ts';
import { moduleUri } from './uri.ts';
import type { RegisteredProject } from '../project-registry.ts';

const MODULE = {
  'product-exploration': {
    discard: discardProductExplorationCandidate,
    pending: listPendingProductExplorationCandidates,
    accepted: acceptedExplorationIds,
  },
  'scope-decomposition': {
    discard: discardScopeDecompositionCandidate,
    pending: listPendingScopeDecompositionCandidates,
    accepted: acceptedScopeIds,
  },
} as const;

const UNCHANGED = 'The Candidate was not discarded and nothing was removed.';

async function remainingCandidates(
  project: RegisteredProject,
  module: AcceptanceModule,
) {
  return MODULE[module].pending(project);
}

async function alreadyAbsent(
  project: RegisteredProject,
  module: AcceptanceModule,
  candidateId: string,
) {
  const pending = await remainingCandidates(project, module);
  if (pending.some((entry) => entry.candidateId === candidateId)) return null;
  if ((await MODULE[module].accepted(project)).includes(candidateId))
    return null;
  return pending;
}

export async function discardCandidate(input: {
  projectId: string;
  module: AcceptanceModule;
  runId: string;
  candidateId: string;
  expectedRevision: number;
}) {
  const project = await requireProject(input.projectId);
  const identity = {
    projectId: project.id,
    module: input.module,
    runId: input.runId,
    candidateId: input.candidateId,
    expectedRevision: input.expectedRevision,
    moduleUri: moduleUri(project.id, input.module),
  };
  let outcome;
  try {
    outcome = await MODULE[input.module].discard(
      project,
      input.runId,
      input.candidateId,
      { expectedRevision: input.expectedRevision },
    );
  } catch (error) {
    if (
      error instanceof CandidateAcceptanceError &&
      (error.reason === 'candidate-not-found' ||
        error.reason === 'proposal-unavailable')
    ) {
      const pending = await alreadyAbsent(
        project,
        input.module,
        input.candidateId,
      );
      if (pending)
        return {
          ...identity,
          discarded: false,
          alreadyAbsent: true,
          runDeleted: false,
          deletedRunIds: [],
          remainingCandidates: pending,
        };
    }
    throw candidateOperationFailure(error, UNCHANGED);
  }
  return {
    ...identity,
    discarded: true,
    alreadyAbsent: false,
    runDeleted: outcome.runDeleted,
    deletedRunIds: outcome.deletedRunIds,
    remainingCandidates: await remainingCandidates(project, input.module),
  };
}
