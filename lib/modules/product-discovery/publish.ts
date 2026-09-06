import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomically } from '../../atomic-json-store.ts';
import { stageCandidateDocuments } from '../../graph/proposal/stage.ts';
import { contractIdentity } from '../../materialization/contract.ts';
import { semanticResultHash } from '../../materialization/hash.ts';
import { materializationLogEntry } from '../../materialization/log.ts';
import {
  MaterializationError,
  type MaterializationReceipt,
} from '../../materialization/receipt.ts';
import type { RunLogInput } from '../../execution-observability/log-types.ts';
import type { ProductExplorationMaterializationBasis } from './basis.ts';
import {
  PRODUCT_EXPLORATION_RESULT_CONTRACT,
  type ProductExplorationCandidateRecord,
  type ProductExplorationResult,
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
  materialization?: MaterializationReceipt;
  error: string | null;
};

export type ProductExplorationProducer<
  T extends ProductExplorationPublicationRecord,
> =
  | {
      kind: 'agent-run';
      record: T;
      resultBase: object;
      harness?: { id: string; revision: number };
    }
  | { kind: 'direct'; runId?: string; sourceNodeIds: readonly string[] };

export type MaterializationLog = (entry: RunLogInput) => void;

function receiptOutcome(
  outcome: ProductExplorationResult['outcome'],
): MaterializationReceipt['outcome'] {
  return outcome === 'proposal' ? 'candidates' : outcome;
}

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

async function report<T>(log: MaterializationLog, step: () => Promise<T>) {
  try {
    return await step();
  } catch (error) {
    const boundary =
      error instanceof MaterializationError ? error.boundary : 'validation';
    const message = error instanceof Error ? error.message : String(error);
    log(
      materializationLogEntry(
        boundary === 'stale-basis'
          ? 'materialization.stale'
          : boundary === 'validation' || boundary === 'identity'
            ? 'materialization.rejected'
            : 'materialization.publication.failed',
        `${boundary}: ${message}`,
        'ERROR',
      ),
    );
    throw error;
  }
}

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
  log: MaterializationLog = () => undefined,
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
  const resultHash = semanticResultHash(result);
  const materialized = await report(log, () =>
    materializeProductExplorationResult(basis, result),
  );
  log(
    materializationLogEntry(
      'materialization.validated',
      `The ${result.outcome} result satisfies ${PRODUCT_EXPLORATION_RESULT_CONTRACT.id} v${PRODUCT_EXPLORATION_RESULT_CONTRACT.version}.`,
    ),
  );
  const directory = runDirectory(basis, base.runId);
  const candidates = materialized?.candidates ?? [];
  if (materialized) {
    if (materialized.candidateAliases)
      log(
        materializationLogEntry(
          'materialization.identities.allocated',
          `Allocated ${Object.keys(materialized.candidateAliases).length} Candidate identities.`,
        ),
      );
    await mkdir(directory, { recursive: true });
    await report(log, () =>
      stageCandidateDocuments(
        directory,
        candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          markdown: candidate.outputMarkdown,
        })),
      ),
    );
    log(
      materializationLogEntry(
        'materialization.staged',
        `Staged ${candidates.length} Candidate documents.`,
      ),
    );
  }
  const receipt: MaterializationReceipt = {
    schemaVersion: 1,
    contract: contractIdentity(PRODUCT_EXPLORATION_RESULT_CONTRACT),
    producer: {
      kind: producer.kind,
      runId: base.runId,
      ...(producer.kind === 'agent-run' &&
        producer.harness && { harness: producer.harness }),
    },
    basis: { fingerprint: basis.fingerprint, preparedAt: basis.preparedAt },
    semanticResultHash: resultHash,
    outcome: receiptOutcome(result.outcome),
    affected: {
      candidateIds: candidates.map((candidate) => candidate.candidateId),
      nodeIds: [],
      contractIds: [],
      domainIds: [],
    },
    publication: { target: 'run-record', at: timestamp, revision: null },
    failure: null,
  };
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
    materialization: receipt,
    error: null,
    updatedAt: timestamp,
    endedAt: base.endedAt ?? timestamp,
  };
  await mkdir(directory, { recursive: true });
  await report(log, async () => {
    await writeFileAtomically(
      path.join(directory, 'semantic-result.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          contract: receipt.contract,
          producer: receipt.producer,
          semanticResultHash: resultHash,
          result,
        },
        null,
        2,
      )}\n`,
    );
    await writeFileAtomically(
      path.join(directory, 'run.json'),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  });
  log(
    materializationLogEntry(
      'materialization.published',
      `Published the ${receipt.outcome} outcome to the Run record.`,
    ),
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
