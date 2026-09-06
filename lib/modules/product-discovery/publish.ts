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
  type MaterializationFailureBoundary,
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

function boundaryEvent(boundary: MaterializationFailureBoundary) {
  if (boundary === 'stale-basis') return 'materialization.stale' as const;
  return boundary === 'validation' || boundary === 'identity'
    ? ('materialization.rejected' as const)
    : ('materialization.publication.failed' as const);
}

async function report<T>(
  log: MaterializationLog,
  boundary: MaterializationFailureBoundary,
  step: () => Promise<T>,
) {
  try {
    return await step();
  } catch (error) {
    const failure =
      error instanceof MaterializationError
        ? error
        : new MaterializationError(
            boundary,
            error instanceof Error ? error.message : String(error),
          );
    log(
      materializationLogEntry(
        boundaryEvent(failure.boundary),
        `${failure.boundary}: ${failure.message}`,
        'ERROR',
      ),
    );
    throw failure;
  }
}

type ReceiptIdentity = Pick<MaterializationReceipt, 'contract' | 'producer'>;

function failureGuard(context: {
  log: MaterializationLog;
  basis: ProductExplorationMaterializationBasis;
  identity: ReceiptIdentity;
  semanticResultHash: string;
  directory: string;
  base: ProductExplorationPublicationRecord;
  timestamp: string;
}) {
  return async <T>(
    boundary: MaterializationFailureBoundary,
    step: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await report(context.log, boundary, step);
    } catch (error) {
      const failure = error as MaterializationError;
      const receipt: MaterializationReceipt = {
        schemaVersion: 1,
        ...context.identity,
        basis: {
          fingerprint: context.basis.fingerprint,
          preparedAt: context.basis.preparedAt,
        },
        semanticResultHash: context.semanticResultHash,
        outcome: 'rejected',
        affected: {
          candidateIds: [],
          nodeIds: [],
          contractIds: [],
          domainIds: [],
        },
        publication: null,
        failure: { boundary: failure.boundary, message: failure.message },
      };
      if (context.identity.producer.kind === 'direct')
        await writeFileAtomically(
          path.join(context.directory, 'run.json'),
          `${JSON.stringify(
            {
              ...context.base,
              status: 'failed',
              result: null,
              materialization: receipt,
              error: failure.message,
              updatedAt: context.timestamp,
              endedAt: context.timestamp,
            },
            null,
            2,
          )}\n`,
        ).catch(() => undefined);
      throw failure.withReceipt(receipt);
    }
  };
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
  const directory = runDirectory(basis, base.runId);
  const identity = {
    contract: contractIdentity(PRODUCT_EXPLORATION_RESULT_CONTRACT),
    producer: {
      kind: producer.kind,
      runId: base.runId,
      ...(producer.kind === 'agent-run' &&
        producer.harness && { harness: producer.harness }),
    },
  };
  const guard = failureGuard({
    log,
    basis,
    identity,
    semanticResultHash: resultHash,
    directory,
    base,
    timestamp,
  });
  await guard('publication', async () => {
    await mkdir(directory, { recursive: true });
    await writeFileAtomically(
      path.join(directory, 'semantic-result.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          ...identity,
          semanticResultHash: resultHash,
          result,
        },
        null,
        2,
      )}\n`,
    );
  });
  const materialized = await guard('validation', () =>
    materializeProductExplorationResult(basis, result),
  );
  log(
    materializationLogEntry(
      'materialization.validated',
      `The ${result.outcome} result satisfies ${PRODUCT_EXPLORATION_RESULT_CONTRACT.id} v${PRODUCT_EXPLORATION_RESULT_CONTRACT.version}.`,
    ),
  );
  const candidates = materialized?.candidates ?? [];
  if (materialized) {
    if (materialized.candidateAliases)
      log(
        materializationLogEntry(
          'materialization.identities.allocated',
          `Allocated ${Object.keys(materialized.candidateAliases).length} Candidate identities.`,
        ),
      );
    await guard('staging', async () => {
      await mkdir(directory, { recursive: true });
      await stageCandidateDocuments(
        directory,
        candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          markdown: candidate.outputMarkdown,
        })),
      );
    });
    log(
      materializationLogEntry(
        'materialization.staged',
        `Staged ${candidates.length} Candidate documents.`,
      ),
    );
  }
  const receipt: MaterializationReceipt = {
    schemaVersion: 1,
    ...identity,
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
  await guard('publication', () =>
    writeFileAtomically(
      path.join(directory, 'run.json'),
      `${JSON.stringify(record, null, 2)}\n`,
    ),
  );
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
