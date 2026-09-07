import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import trash from 'trash';
import { successfulRecomposeOutputCandidateIds } from '../../graph/agent/recompose.ts';
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
  readIdentifiedProposalRun,
  readIdentifiedProposalRuns,
  type AcceptCandidateOptions,
} from '../../graph/proposal/pending.ts';
import { moduleRunRegistry } from '../../graph/proposal/module-runtime.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import {
  collectAcceptedCandidateIds,
  scopeDecompositionRunsDirectory,
  SCOPE_DECOMPOSITION_GRAPH_ROOT,
} from './assembly.ts';
import {
  ensureScopeDecompositionRunArtifacts,
  normalizeScopeDecompositionRun,
  scopeDecompositionRunPath,
  validateScopeDecompositionRunId,
  writeScopeDecompositionRunRecord,
  type StoredScopeDecompositionRun,
} from './run-store.ts';

const MUTATION_KEY = 'taskDecompositionMutations' as const;
const RUN_REGISTRY_KEY = '__praxisRuns' as const;
const RUN_IN_PROGRESS = ['running', 'validating'];

export type ScopeDiscardResult = {
  candidateId: string;
  runDeleted: boolean;
  deletedRunIds: string[];
  runs: StoredScopeDecompositionRun[];
};

async function readRuns(project: RegisteredProject) {
  return (
    await readIdentifiedProposalRuns(
      project.planningPath,
      SCOPE_DECOMPOSITION_GRAPH_ROOT,
      scopeDecompositionRunsDirectory(project),
    )
  ).map((run) =>
    normalizeScopeDecompositionRun(run as StoredScopeDecompositionRun),
  );
}

function sourceRunInProgress(sourceNodeId: string | undefined) {
  if (!sourceNodeId) return false;
  return [
    ...moduleRunRegistry<{
      record?: { sourceNodeId?: string; status?: string };
    }>(RUN_REGISTRY_KEY).values(),
  ].some(
    (active) =>
      active.record?.sourceNodeId === sourceNodeId &&
      RUN_IN_PROGRESS.includes(active.record.status ?? ''),
  );
}

export async function discardScopeDecompositionCandidate(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
  options: AcceptCandidateOptions = {},
): Promise<ScopeDiscardResult> {
  return withModuleMutation(MUTATION_KEY, project.planningPath, () =>
    discardScopeDecompositionCandidateUnlocked(
      project,
      runId,
      candidateId,
      options,
    ),
  );
}

async function discardScopeDecompositionCandidateUnlocked(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
  options: AcceptCandidateOptions,
): Promise<ScopeDiscardResult> {
  if (revisionRunInProgress(RUN_REGISTRY_KEY, candidateId))
    throw new CandidateAcceptanceError(
      'active-revision',
      'Cancel or finish the active Candidate revision first.',
      400,
    );
  validateScopeDecompositionRunId(runId);
  const requested = await readIdentifiedProposalRun(
    project.planningPath,
    SCOPE_DECOMPOSITION_GRAPH_ROOT,
    scopeDecompositionRunsDirectory(project),
    runId,
  );
  const requestedRun = requested
    ? normalizeScopeDecompositionRun(requested as StoredScopeDecompositionRun)
    : null;
  if (!requestedRun || requestedRun.result?.outcome !== 'proposal')
    throw new CandidateAcceptanceError(
      'proposal-unavailable',
      'The Candidate proposal is unavailable.',
      400,
    );
  const candidate = (requestedRun.result.candidates ?? []).find(
    (value) => value.candidateId === candidateId,
  );
  if (!candidate)
    throw new CandidateAcceptanceError(
      'candidate-not-found',
      'The Candidate could not be found.',
      400,
    );
  assertExpectedRevision(candidate, options.expectedRevision);
  const runs = await readRuns(project);
  if (successfulRecomposeOutputCandidateIds(runs as never).has(candidateId))
    throw new CandidateAcceptanceError(
      'recompose-output',
      'Recompose output Candidates belong to one atomic working set and cannot be discarded individually.',
      409,
    );
  if (sourceRunInProgress(requestedRun.sourceNodeId))
    throw new CandidateAcceptanceError(
      'active-revision',
      'Cancel or finish the active Agent Run first.',
      400,
    );
  const acceptedIds = await collectAcceptedCandidateIds(project);
  if (acceptedIds.includes(candidateId))
    throw new CandidateAcceptanceError(
      'already-accepted',
      'An accepted Candidate must be managed as a formal Node.',
      400,
    );
  const pending = latestPendingCandidates(runs, new Set(acceptedIds), {
    recomposition: true,
  });
  const latest = pending.find(
    (entry) => entry.candidate.candidateId === candidateId,
  );
  if (!latest)
    throw new CandidateAcceptanceError(
      'replaced-by-recompose',
      'This Candidate was replaced or removed by Recompose.',
      409,
    );
  if (latest.runId !== runId)
    throw new CandidateAcceptanceError(
      'stale-revision',
      `Candidate ${candidateId} is now revision ${candidateRevision(latest.candidate)} from Run ${latest.runId}, not revision ${candidateRevision(candidate)} from Run ${runId}. Read the module resource again before discarding it.`,
      409,
    );
  const blockers = candidateDependencyBlockers(
    candidateId,
    pending.map((entry) => ({
      candidateId: entry.candidate.candidateId!,
      dependsOn: entry.candidate.dependsOn ?? [],
    })),
  );
  if (blockers.length > 0)
    throw new CandidateAcceptanceError(
      'dependency-blocked',
      `${candidateId} is still required by ${blockers.join(', ')}. Discard dependent Candidates first.`,
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
  const updatedRuns: StoredScopeDecompositionRun[] = [];
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
  run: StoredScopeDecompositionRun,
  candidateId: string,
) {
  if (run.result?.outcome !== 'proposal') return false;
  const candidates = run.result.candidates ?? [];
  const candidateIndex = candidates.findIndex(
    (candidate) => candidate.candidateId === candidateId,
  );
  if (candidateIndex < 0) return false;
  const runPath = scopeDecompositionRunPath(project, run.runId);
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
    await writeScopeDecompositionRunRecord(project, run);
    await ensureScopeDecompositionRunArtifacts(project, run);
  } catch (error) {
    await rename(stagedPath, candidatePath);
    throw error;
  }
  await trash(stagedPath);
  return false;
}
