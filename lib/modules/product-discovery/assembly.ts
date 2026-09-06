import path from 'node:path';
import {
  readIdentifiedEntities,
  reservedCandidateAliases,
} from '../../graph/identity-store.ts';
import {
  listStoredProposalRuns,
  proposalCandidateState,
  withoutSupersededRuns,
  type ProposalCandidateState,
  type StoredProposalCandidate,
} from '../../graph/proposal/run-state.ts';
import { listTaskGraphNodes } from '../../graph/task/nodes.ts';
import type { RegisteredProject } from '../../project-registry.ts';

export const PRODUCT_EXPLORATION_GRAPH_ROOT = 'whats-next' as const;

export type ProductExplorationCandidateState = ProposalCandidateState;

export function productExplorationRunsDirectory(project: RegisteredProject) {
  return path.join(
    project.planningPath,
    PRODUCT_EXPLORATION_GRAPH_ROOT,
    'runs',
  );
}

export async function listProductExplorationRunStates(
  project: RegisteredProject,
) {
  return withoutSupersededRuns(
    await listStoredProposalRuns(productExplorationRunsDirectory(project)),
  );
}

export async function collectAcceptedCandidateIds(project: RegisteredProject) {
  return (
    await listTaskGraphNodes(project, PRODUCT_EXPLORATION_GRAPH_ROOT)
  ).flatMap((node) =>
    node.provenance?.candidateId ? [node.provenance.candidateId] : [],
  );
}

export async function collectLatestUnacceptedCandidateStates(
  project: RegisteredProject,
): Promise<ProductExplorationCandidateState[]> {
  const runs = await listProductExplorationRunStates(project);
  const latest = new Map<string, ProductExplorationCandidateState>();
  for (const run of runs) {
    if (run.result?.outcome !== 'proposal') continue;
    const identified = (await readIdentifiedEntities(
      project.planningPath,
      PRODUCT_EXPLORATION_GRAPH_ROOT,
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
    PRODUCT_EXPLORATION_GRAPH_ROOT,
  );
}
