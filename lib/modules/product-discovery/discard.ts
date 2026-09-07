import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import trash from 'trash';
import { candidateDependencyBlockers } from '../../graph/proposal/dependencies.ts';
import {
  revisionRunInProgress,
  withModuleMutation,
} from '../../graph/proposal/module-runtime.ts';
import {
  CandidateAcceptanceError,
  assertExpectedRevision,
  candidateRevision,
  latestPendingCandidates,
  readIdentifiedProposalRuns,
  visibleProposalRuns,
  type AcceptCandidateOptions,
} from '../../graph/proposal/pending.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import {
  collectAcceptedCandidateIds,
  productExplorationRunsDirectory,
  PRODUCT_EXPLORATION_GRAPH_ROOT,
} from './assembly.ts';
import {
  ensureProductExplorationRunArtifacts,
  normalizeProductExplorationRun,
  productExplorationRunPath,
  writeProductExplorationRunRecord,
  type StoredProductExplorationRun,
} from './run-store.ts';

const MUTATION_KEY = 'whatsNextMutations' as const;
const RUN_REGISTRY_KEY = '__praxisWhatsNextRuns' as const;

export type DiscardCandidateResult = {
  candidateId: string;
  runDeleted: boolean;
  deletedRunIds: string[];
  runs: StoredProductExplorationRun[];
};

async function readRuns(project: RegisteredProject) {
  return visibleProposalRuns(
    await readIdentifiedProposalRuns(
      project.planningPath,
      PRODUCT_EXPLORATION_GRAPH_ROOT,
      productExplorationRunsDirectory(project),
    ),
  ).map((run) =>
    normalizeProductExplorationRun(run as StoredProductExplorationRun),
  );
}

export async function discardProductExplorationCandidate(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
  options: AcceptCandidateOptions = {},
): Promise<DiscardCandidateResult> {
  return withModuleMutation(MUTATION_KEY, project.planningPath, () =>
    discardProductExplorationCandidateUnlocked(
      project,
      runId,
      candidateId,
      options,
    ),
  );
}

async function discardProductExplorationCandidateUnlocked(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
  options: AcceptCandidateOptions,
): Promise<DiscardCandidateResult> {
  const runs = await readRuns(project);
  const availableRun = runs.find((run) => run.runId === runId);
  if (!availableRun)
    throw new CandidateAcceptanceError(
      'proposal-unavailable',
      'The Candidate proposal is no longer available.',
      400,
    );
  if (revisionRunInProgress(RUN_REGISTRY_KEY, candidateId))
    throw new CandidateAcceptanceError(
      'active-revision',
      'Cancel or finish the active Candidate revision first.',
      400,
    );
  if (availableRun.result?.outcome !== 'proposal')
    throw new CandidateAcceptanceError(
      'proposal-unavailable',
      'The Candidate proposal is unavailable.',
      400,
    );
  const candidate = (availableRun.result.candidates ?? []).find(
    (value) => value.candidateId === candidateId,
  );
  if (!candidate)
    throw new CandidateAcceptanceError(
      'candidate-not-found',
      'The Candidate could not be found.',
      400,
    );
  assertExpectedRevision(candidate, options.expectedRevision);
  const acceptedIds = await collectAcceptedCandidateIds(project);
  if (acceptedIds.includes(candidateId))
    throw new CandidateAcceptanceError(
      'already-accepted',
      'An accepted Candidate must be managed as a formal Node.',
      400,
    );
  const pending = latestPendingCandidates(runs, new Set(acceptedIds));
  const latest = pending.find(
    (entry) => entry.candidate.candidateId === candidateId,
  );
  if (latest && latest.runId !== runId)
    throw new CandidateAcceptanceError(
      'stale-revision',
      `Candidate ${candidateId} is now revision ${candidateRevision(latest.candidate)} from Run ${latest.runId}, not revision ${candidateRevision(candidate)} from Run ${runId}. Read the module resource again before discarding it.`,
      409,
    );
  const blockers = candidateDependencyBlockers(
    candidateId,
    pending.map((entry) => ({
      candidateId: entry.candidate.candidateId!,
      revision: candidateRevision(entry.candidate),
      dependsOn: entry.candidate.dependsOn ?? [],
    })),
  );
  if (blockers.length > 0)
    throw new CandidateAcceptanceError(
      'dependency-blocked',
      `${candidateId} is still required by ${blockers.join(', ')}. Discard those directions first.`,
      409,
    );

  const candidateRuns = runs.filter(
    (run) =>
      run.result?.outcome === 'proposal' &&
      (run.result.candidates ?? []).some(
        (entry) => entry.candidateId === candidateId,
      ),
  );
  let requestedRunDeleted = false;
  const deletedRunIds: string[] = [];
  const updatedRuns: StoredProductExplorationRun[] = [];
  for (const run of candidateRuns) {
    const runDeleted = await discardCandidateFromRun(project, run, candidateId);
    if (runDeleted) deletedRunIds.push(run.runId);
    else updatedRuns.push(run);
    if (run.runId === runId) requestedRunDeleted = runDeleted;
  }
  return {
    candidateId,
    runDeleted: requestedRunDeleted,
    deletedRunIds,
    runs: updatedRuns,
  };
}

async function discardCandidateFromRun(
  project: RegisteredProject,
  run: StoredProductExplorationRun,
  candidateId: string,
) {
  if (run.result?.outcome !== 'proposal') return false;
  const candidates = run.result.candidates ?? [];
  const candidateIndex = candidates.findIndex(
    (candidate) => candidate.candidateId === candidateId,
  );
  if (candidateIndex < 0) return false;
  const runPath = productExplorationRunPath(project, run.runId);
  if (candidates.length === 1) {
    await trash(runPath);
    return true;
  }
  const candidatePath = path.join(runPath, 'candidates', candidateId);
  const stagedPath = path.join(
    runPath,
    'candidates',
    `.${candidateId}-${randomUUID()}.discarding`,
  );
  await rename(candidatePath, stagedPath);
  try {
    candidates.splice(candidateIndex, 1);
    run.updatedAt = new Date().toISOString();
    await writeProductExplorationRunRecord(project, run);
    await ensureProductExplorationRunArtifacts(project, run);
  } catch (error) {
    await rename(stagedPath, candidatePath);
    throw error;
  }
  await trash(stagedPath);
  return false;
}

export async function listDiscardableProductExplorationCandidateIds(
  project: RegisteredProject,
) {
  const runs = await readRuns(project);
  const accepted = new Set(await collectAcceptedCandidateIds(project));
  return latestPendingCandidates(runs, accepted).map(
    (entry) => entry.candidate.candidateId!,
  );
}
