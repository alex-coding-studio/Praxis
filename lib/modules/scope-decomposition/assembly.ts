import path from 'node:path';
import {
  readIdentifiedEntities,
  reservedCandidateAliases,
} from '../../graph/identity-store.ts';
import {
  listStoredProposalRuns,
  proposalCandidateState,
  retainedByRecomposition,
  type ProposalCandidateState,
  type StoredProposalCandidate,
} from '../../graph/proposal/run-state.ts';
import { listTaskGraphNodes } from '../../graph/task/nodes.ts';
import type { RegisteredProject } from '../../project-registry.ts';

export const SCOPE_DECOMPOSITION_GRAPH_ROOT = 'task-graph' as const;
export const SCOPE_DECOMPOSITION_RUNS_ROOT = 'task-decomposition' as const;

export function scopeDecompositionRunsDirectory(project: RegisteredProject) {
  return path.join(project.planningPath, SCOPE_DECOMPOSITION_RUNS_ROOT, 'runs');
}

export async function collectAcceptedCandidateIds(project: RegisteredProject) {
  return (
    await listTaskGraphNodes(project, SCOPE_DECOMPOSITION_GRAPH_ROOT)
  ).flatMap((node) =>
    node.provenance?.candidateId ? [node.provenance.candidateId] : [],
  );
}

export async function collectLatestUnacceptedCandidateStates(
  project: RegisteredProject,
): Promise<ProposalCandidateState[]> {
  const runs = await listStoredProposalRuns(
    scopeDecompositionRunsDirectory(project),
  );
  const latest = new Map<string, ProposalCandidateState>();
  for (const run of runs) {
    if (run.result?.outcome !== 'proposal') continue;
    if (run.operation === 'recompose-candidates' && run.result.recomposition) {
      const retained = retainedByRecomposition(run);
      for (const candidateId of run.recomposeCandidateIds ?? [])
        if (!retained.has(candidateId)) latest.delete(candidateId);
    }
    const identified = (await readIdentifiedEntities(
      project.planningPath,
      SCOPE_DECOMPOSITION_GRAPH_ROOT,
      (run.result.candidates ?? []) as never,
    )) as StoredProposalCandidate[];
    for (const candidate of identified) {
      const state = proposalCandidateState(candidate);
      if (!state) continue;
      const current = latest.get(state.candidateId);
      if (!current || state.revision > current.revision)
        latest.set(state.candidateId, state);
    }
  }
  const accepted = new Set(await collectAcceptedCandidateIds(project));
  return [...latest.values()].filter(
    (candidate) => !accepted.has(candidate.candidateId),
  );
}

export async function collectReservedCandidateIds(project: RegisteredProject) {
  return reservedCandidateAliases(
    project.planningPath,
    SCOPE_DECOMPOSITION_GRAPH_ROOT,
  );
}

export type ScopeDecompositionRevisionTarget = {
  candidateId: string;
  revision: number;
  uid: string;
};

export async function findRevisionTarget(
  project: RegisteredProject,
  candidateId: string,
): Promise<ScopeDecompositionRevisionTarget | null> {
  const runs = await listStoredProposalRuns(
    scopeDecompositionRunsDirectory(project),
  );
  let found: ScopeDecompositionRevisionTarget | null = null;
  for (const run of runs) {
    if (run.result?.outcome !== 'proposal') continue;
    const identified = (await readIdentifiedEntities(
      project.planningPath,
      SCOPE_DECOMPOSITION_GRAPH_ROOT,
      (run.result.candidates ?? []) as never,
    )) as Array<StoredProposalCandidate & { uid?: string }>;
    for (const candidate of identified) {
      if (candidate.candidateId !== candidateId) continue;
      const revision =
        typeof candidate.revision === 'number' ? candidate.revision : 1;
      if (found && found.revision >= revision) continue;
      if (typeof candidate.uid !== 'string' || candidate.uid.trim() === '')
        continue;
      found = { candidateId, revision, uid: candidate.uid };
    }
  }
  return found;
}
