import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  readIdentifiedEntities,
  reservedCandidateAliases,
} from '../../graph/identity-store.ts';
import { listTaskGraphNodes } from '../../graph/task/nodes.ts';
import type { RegisteredProject } from '../../project-registry.ts';

export const PRODUCT_EXPLORATION_GRAPH_ROOT = 'whats-next' as const;

const RUN_ID = /^RUN-[0-9a-f-]{36}$/i;

export type ProductExplorationCandidateState = {
  candidateId: string;
  revision: number;
  dependsOn: string[];
};

type StoredCandidate = {
  candidateId?: string;
  revision?: number;
  dependsOn?: unknown;
};

type StoredRun = {
  runId?: string;
  startedAt?: string;
  replacement?: { state?: string; runIds?: string[] };
  result?: { outcome?: string; candidates?: StoredCandidate[] } | null;
};

export function productExplorationRunsDirectory(project: RegisteredProject) {
  return path.join(
    project.planningPath,
    PRODUCT_EXPLORATION_GRAPH_ROOT,
    'runs',
  );
}

async function readStoredRun(project: RegisteredProject, runId: string) {
  if (!RUN_ID.test(runId)) return null;
  let stored: StoredRun;
  try {
    stored = JSON.parse(
      await readFile(
        path.join(productExplorationRunsDirectory(project), runId, 'run.json'),
        'utf8',
      ),
    ) as StoredRun;
  } catch {
    return null;
  }
  if (typeof stored.runId !== 'string' || typeof stored.startedAt !== 'string')
    return null;
  return stored;
}

export async function listProductExplorationRunStates(
  project: RegisteredProject,
) {
  const entries = await readdir(productExplorationRunsDirectory(project), {
    withFileTypes: true,
  }).catch(() => []);
  const stored = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
      .map((entry) => readStoredRun(project, entry.name)),
  );
  const visible = stored.filter((run): run is StoredRun => run !== null);
  const superseded = new Set(
    visible.flatMap((run) =>
      run.replacement?.state === 'applied'
        ? (run.replacement.runIds ?? [])
        : [],
    ),
  );
  return visible
    .filter((run) => !superseded.has(run.runId as string))
    .sort((left, right) =>
      (left.startedAt as string).localeCompare(right.startedAt as string),
    );
}

function candidateState(
  candidate: StoredCandidate,
): ProductExplorationCandidateState | null {
  if (typeof candidate.candidateId !== 'string') return null;
  return {
    candidateId: candidate.candidateId,
    revision: typeof candidate.revision === 'number' ? candidate.revision : 1,
    dependsOn: Array.isArray(candidate.dependsOn)
      ? candidate.dependsOn.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
  };
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
    )) as StoredCandidate[];
    for (const candidate of identified) {
      const state = candidateState(candidate);
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
