import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PublicApiError } from '../../api-errors.ts';
import { readIdentifiedEntities, type Scope } from '../identity-store.ts';
import type { StableRelations } from '../identity.ts';
import type { GraphCandidateRecord } from './contract.ts';
import {
  PROPOSAL_RUN_ID,
  retainedByRecomposition,
  withoutSupersededRuns,
  type StoredProposalRun,
} from './run-state.ts';

export type StoredCandidateDocument = Partial<GraphCandidateRecord> & {
  candidateId?: string;
  revision?: number;
  uid?: string;
  relations?: StableRelations;
  outputMarkdown?: string;
  layer?: string;
  artifactKind?: string;
};

export type IdentifiedProposalRun = Omit<StoredProposalRun, 'result'> & {
  result?: {
    outcome?: string;
    candidates?: StoredCandidateDocument[];
    recomposition?: { effects?: Array<{ kind?: string; from?: unknown }> };
  } | null;
};

export type PendingCandidateProjection = {
  runId: string;
  candidateId: string;
  revision: number;
  uid: string | null;
  type: string;
  title: string;
  summary: string;
  layer: string | null;
  artifactKind: string | null;
  derivedFrom: string[];
  dependsOn: string[];
  acceptance: { acceptable: boolean; reason: string | null };
};

export async function readIdentifiedProposalRuns(
  planningPath: string,
  scope: Scope,
  runsDirectory: string,
): Promise<IdentifiedProposalRun[]> {
  const entries = await readdir(runsDirectory, {
    withFileTypes: true,
  }).catch(() => []);
  const runs = await Promise.all(
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
          ) as IdentifiedProposalRun;
          if (
            typeof parsed.runId !== 'string' ||
            typeof parsed.startedAt !== 'string'
          )
            return null;
          if (parsed.result?.outcome === 'proposal')
            parsed.result.candidates = await readIdentifiedEntities(
              planningPath,
              scope,
              (parsed.result.candidates ?? []) as never,
            );
          return parsed;
        } catch {
          return null;
        }
      }),
  );
  return runs
    .filter((run): run is IdentifiedProposalRun => run !== null)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export async function readIdentifiedProposalRun(
  planningPath: string,
  scope: Scope,
  runsDirectory: string,
  runId: string,
): Promise<IdentifiedProposalRun | null> {
  const recordPath = path.join(runsDirectory, runId, 'run.json');
  let raw: string;
  try {
    raw = await readFile(recordPath, 'utf8');
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'ENOENT' && failure.path === recordPath) return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as IdentifiedProposalRun;
  if (parsed.result?.outcome === 'proposal')
    parsed.result.candidates = await readIdentifiedEntities(
      planningPath,
      scope,
      (parsed.result.candidates ?? []) as never,
    );
  return parsed;
}

export function candidateRevision(candidate: StoredCandidateDocument) {
  return typeof candidate.revision === 'number' ? candidate.revision : 1;
}

export type PendingCandidateEntry = {
  runId: string;
  candidate: StoredCandidateDocument;
};

export function latestPendingCandidates(
  runs: readonly IdentifiedProposalRun[],
  acceptedCandidateIds: ReadonlySet<string>,
  options: { recomposition?: boolean } = {},
): PendingCandidateEntry[] {
  const latest = new Map<string, PendingCandidateEntry>();
  for (const run of runs) {
    if (run.result?.outcome !== 'proposal') continue;
    if (
      options.recomposition &&
      run.operation === 'recompose-candidates' &&
      run.result.recomposition
    ) {
      const retained = retainedByRecomposition(run as StoredProposalRun);
      for (const candidateId of run.recomposeCandidateIds ?? [])
        if (!retained.has(candidateId)) latest.delete(candidateId);
    }
    for (const candidate of run.result.candidates ?? []) {
      if (typeof candidate.candidateId !== 'string') continue;
      const current = latest.get(candidate.candidateId);
      if (
        current &&
        candidateRevision(current.candidate) >= candidateRevision(candidate)
      )
        continue;
      latest.set(candidate.candidateId, { runId: run.runId, candidate });
    }
  }
  return [...latest.values()].filter(
    (entry) => !acceptedCandidateIds.has(entry.candidate.candidateId!),
  );
}

export function visibleProposalRuns(runs: readonly IdentifiedProposalRun[]) {
  return withoutSupersededRuns(
    runs as readonly StoredProposalRun[],
  ) as IdentifiedProposalRun[];
}

export const CANDIDATE_ACCEPTANCE_REASONS = [
  'proposal-unavailable',
  'candidate-not-found',
  'active-revision',
  'stale-revision',
  'replaced-by-recompose',
  'no-stable-identity',
  'already-accepted',
  'dependency-blocked',
  'recompose-output',
] as const;

export type CandidateAcceptanceReason =
  (typeof CANDIDATE_ACCEPTANCE_REASONS)[number];

export class CandidateAcceptanceError extends PublicApiError {
  readonly reason: CandidateAcceptanceReason;
  constructor(
    reason: CandidateAcceptanceReason,
    message: string,
    status: number,
  ) {
    super(message, status);
    this.name = 'CandidateAcceptanceError';
    this.reason = reason;
  }
}

export type AcceptCandidateOptions = { expectedRevision?: number };

export function assertExpectedRevision(
  candidate: StoredCandidateDocument,
  expectedRevision: number | undefined,
) {
  if (expectedRevision === undefined) return;
  const revision = candidateRevision(candidate);
  if (revision !== expectedRevision)
    throw new CandidateAcceptanceError(
      'stale-revision',
      `Candidate ${candidate.candidateId} is at revision ${revision}, not ${expectedRevision}. Read the module resource again before accepting it.`,
      409,
    );
}

export function assertLatestPendingSelection(
  pending: readonly PendingCandidateEntry[],
  selection: { runId: string; candidateId: string; revision: number },
) {
  const latest = pending.find(
    (entry) => entry.candidate.candidateId === selection.candidateId,
  );
  if (!latest) return;
  const latestRevision = candidateRevision(latest.candidate);
  if (latest.runId === selection.runId && latestRevision === selection.revision)
    return;
  throw new CandidateAcceptanceError(
    'stale-revision',
    `Candidate ${selection.candidateId} is now revision ${latestRevision} from Run ${latest.runId}, not revision ${selection.revision} from Run ${selection.runId}. Read the module resource again and accept the current revision.`,
    409,
  );
}
