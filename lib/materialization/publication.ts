import type { RunLogInput } from '../execution-observability/log-types.ts';
import type { ResultContract } from './contract.ts';
import { contractIdentity } from './contract.ts';
import { materializationLogEntry } from './log.ts';
import {
  attachRejectionReceipt,
  MaterializationError,
  type MaterializationFailureBoundary,
  type MaterializationReceipt,
} from './receipt.ts';
import { PublicApiError } from '../api-errors.ts';
import type { ProducerKind } from './producer.ts';

export type MaterializationLog = (entry: RunLogInput) => void;

export type ReceiptIdentity = Pick<
  MaterializationReceipt,
  'contract' | 'producer'
>;

export const NO_AFFECTED_IDENTITIES: MaterializationReceipt['affected'] = {
  candidateIds: [],
  nodeIds: [],
  contractIds: [],
  domainIds: [],
};

export function receiptIdentity<T>(
  contract: ResultContract<T>,
  producer: {
    kind: ProducerKind;
    runId: string;
    harness?: { id: string; revision: number };
  },
): ReceiptIdentity {
  return {
    contract: contractIdentity(contract),
    producer: {
      kind: producer.kind,
      runId: producer.runId,
      ...(producer.harness && { harness: producer.harness }),
    },
  };
}

export function semanticResultDocument(
  identity: ReceiptIdentity,
  semanticResultHash: string,
  result: unknown,
) {
  return `${JSON.stringify(
    { schemaVersion: 1, ...identity, semanticResultHash, result },
    null,
    2,
  )}\n`;
}

export function boundaryEvent(boundary: MaterializationFailureBoundary) {
  if (boundary === 'stale-basis') return 'materialization.stale' as const;
  return boundary === 'validation' || boundary === 'identity'
    ? ('materialization.rejected' as const)
    : ('materialization.publication.failed' as const);
}

export type MaterializationGuard = <T>(
  boundary: MaterializationFailureBoundary,
  step: () => Promise<T>,
) => Promise<T>;

export function materializationGuard(context: {
  log: MaterializationLog;
  identity: ReceiptIdentity;
  basis: { fingerprint: string; preparedAt: string };
  semanticResultHash: string;
  onReject?: (receipt: MaterializationReceipt) => Promise<void>;
}): MaterializationGuard {
  return async (boundary, step) => {
    try {
      return await step();
    } catch (error) {
      const conflict = error instanceof PublicApiError && error.status === 409;
      const failure =
        error instanceof MaterializationError || conflict
          ? (error as MaterializationError | PublicApiError)
          : new MaterializationError(
              boundary,
              error instanceof Error ? error.message : String(error),
            );
      const failedAt =
        failure instanceof MaterializationError
          ? failure.boundary
          : ('stale-basis' as const);
      context.log(
        materializationLogEntry(
          boundaryEvent(failedAt),
          `${failedAt}: ${failure.message}`,
          'ERROR',
        ),
      );
      const receipt: MaterializationReceipt = {
        schemaVersion: 1,
        ...context.identity,
        basis: {
          fingerprint: context.basis.fingerprint,
          preparedAt: context.basis.preparedAt,
        },
        semanticResultHash: context.semanticResultHash,
        outcome: 'rejected',
        affected: { ...NO_AFFECTED_IDENTITIES },
        publication: null,
        failure: { boundary: failedAt, message: failure.message },
      };
      if (context.onReject)
        await context.onReject(receipt).catch(() => undefined);
      throw attachRejectionReceipt(failure, receipt);
    }
  };
}
