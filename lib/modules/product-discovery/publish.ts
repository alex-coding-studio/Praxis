import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomically } from '../../atomic-json-store.ts';
import { stageCandidateDocuments } from '../../graph/proposal/stage.ts';
import { MaterializationError } from '../../materialization/receipt.ts';
import type { ProductExplorationMaterializationBasis } from './basis.ts';
import type {
  ProductExplorationCandidateRecord,
  ProductExplorationResult,
} from './contract.ts';
import { materializeProductExplorationResult } from './materializer.ts';

const RUN_ID = /^RUN-[0-9a-f-]{36}$/;

export type ProductExplorationPublicationRecord = {
  schemaVersion: 1;
  runId: string;
  operation: string;
  intention: string;
  motion: string;
  sourceNodeIds: string[];
  status: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  activity: unknown[];
  result: unknown;
  error: string | null;
};

export type ProductExplorationProducer<
  T extends ProductExplorationPublicationRecord,
> =
  | { kind: 'agent-run'; record: T; resultBase: object }
  | { kind: 'direct'; runId?: string; sourceNodeIds: readonly string[] };

export type PublishedProductExploration<
  T extends ProductExplorationPublicationRecord,
> = {
  runId: string;
  outcome: ProductExplorationResult['outcome'];
  candidates: ProductExplorationCandidateRecord[];
  candidateAliases: Record<string, string> | null;
  candidatePaths: Record<string, string>;
  record: T;
};

function assertRunId(runId: string) {
  if (!RUN_ID.test(runId))
    throw new MaterializationError(
      'publication',
      'The Run identifier is invalid.',
    );
  return runId;
}

function runDirectory(
  basis: ProductExplorationMaterializationBasis,
  runId: string,
) {
  return path.join(basis.project.planningPath, 'whats-next', 'runs', runId);
}

function directRecord(
  basis: ProductExplorationMaterializationBasis,
  runId: string,
  sourceNodeIds: readonly string[],
  timestamp: string,
): ProductExplorationPublicationRecord {
  return {
    schemaVersion: 1,
    runId,
    operation: basis.operation,
    intention: basis.intention,
    motion: basis.motion,
    sourceNodeIds: [...sourceNodeIds],
    status: 'proposal',
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: timestamp,
    activity: [],
    result: null,
    error: null,
  };
}

export async function publishProductExplorationResult<
  T extends ProductExplorationPublicationRecord,
>(
  basis: ProductExplorationMaterializationBasis,
  result: ProductExplorationResult,
  producer: ProductExplorationProducer<T>,
  now: () => string = () => new Date().toISOString(),
): Promise<PublishedProductExploration<T>> {
  const timestamp = now();
  const base =
    producer.kind === 'agent-run'
      ? producer.record
      : (directRecord(
          basis,
          assertRunId(producer.runId ?? `RUN-${randomUUID()}`),
          producer.sourceNodeIds,
          timestamp,
        ) as T);
  assertRunId(base.runId);
  const materialized = await materializeProductExplorationResult(basis, result);
  const directory = runDirectory(basis, base.runId);
  const candidates = materialized?.candidates ?? [];
  if (materialized) {
    await mkdir(directory, { recursive: true });
    await stageCandidateDocuments(
      directory,
      candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        markdown: candidate.outputMarkdown,
      })),
    );
  }
  const resultBase =
    producer.kind === 'agent-run' ? producer.resultBase : result;
  const record: T = {
    ...base,
    status: result.outcome,
    result: materialized
      ? {
          ...resultBase,
          candidates,
          ...(materialized.candidateAliases && {
            candidateAliases: materialized.candidateAliases,
          }),
        }
      : resultBase,
    error: null,
    updatedAt: timestamp,
    endedAt: base.endedAt ?? timestamp,
  };
  await mkdir(directory, { recursive: true });
  await writeFileAtomically(
    path.join(directory, 'run.json'),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return {
    runId: record.runId,
    outcome: result.outcome,
    candidates,
    candidateAliases: materialized?.candidateAliases ?? null,
    candidatePaths: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.candidateId,
        path.posix.join(
          'whats-next',
          'runs',
          record.runId,
          'candidates',
          candidate.candidateId,
          'output.md',
        ),
      ]),
    ),
    record,
  };
}
