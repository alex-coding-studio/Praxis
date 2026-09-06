import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const PROPOSAL_RUN_ID = /^RUN-[0-9a-f-]{36}$/i;

export type StoredProposalCandidate = {
  candidateId?: string;
  revision?: number;
  dependsOn?: unknown;
};

export type StoredProposalRun = {
  runId: string;
  startedAt: string;
  operation?: string;
  recomposeCandidateIds?: string[];
  replacement?: { state?: string; runIds?: string[] };
  result?: {
    outcome?: string;
    candidates?: StoredProposalCandidate[];
    recomposition?: { effects?: Array<{ kind?: string; from?: unknown }> };
  } | null;
};

export type ProposalCandidateState = {
  candidateId: string;
  revision: number;
  dependsOn: string[];
};

export function proposalCandidateState(
  candidate: StoredProposalCandidate,
): ProposalCandidateState | null {
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

export async function listStoredProposalRuns(
  runsDirectory: string,
): Promise<StoredProposalRun[]> {
  const entries = await readdir(runsDirectory, {
    withFileTypes: true,
  }).catch(() => []);
  const stored = await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && PROPOSAL_RUN_ID.test(entry.name),
      )
      .map(async (entry) => {
        try {
          const parsed = JSON.parse(
            await readFile(
              path.join(runsDirectory, entry.name, 'run.json'),
              'utf8',
            ),
          ) as StoredProposalRun;
          if (
            typeof parsed.runId !== 'string' ||
            typeof parsed.startedAt !== 'string'
          )
            return null;
          return parsed;
        } catch {
          return null;
        }
      }),
  );
  return stored
    .filter((run): run is StoredProposalRun => run !== null)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export function withoutSupersededRuns(runs: readonly StoredProposalRun[]) {
  const superseded = new Set(
    runs.flatMap((run) =>
      run.replacement?.state === 'applied'
        ? (run.replacement.runIds ?? [])
        : [],
    ),
  );
  return runs.filter((run) => !superseded.has(run.runId));
}

export function retainedByRecomposition(run: StoredProposalRun) {
  const effects = run.result?.recomposition?.effects ?? [];
  return new Set(
    effects
      .filter((effect) => effect.kind === 'retain')
      .flatMap((effect) =>
        Array.isArray(effect.from)
          ? effect.from.filter(
              (entry): entry is string => typeof entry === 'string',
            )
          : [],
      ),
  );
}
