import type { RunLogInput } from '../execution-observability/log-types.ts';
import type { ResultContract } from './contract.ts';
import { contractIdentity } from './contract.ts';
import { materializationLogEntry } from './log.ts';
import {
  MaterializationError,
  type MaterializationFailureBoundary,
  type MaterializationReceipt,
} from './receipt.ts';
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
      const failure =
        error instanceof MaterializationError
          ? error
          : new MaterializationError(
              boundary,
              error instanceof Error ? error.message : String(error),
            );
      context.log(
        materializationLogEntry(
          boundaryEvent(failure.boundary),
          `${failure.boundary}: ${failure.message}`,
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
        failure: { boundary: failure.boundary, message: failure.message },
      };
      if (context.onReject)
        await context.onReject(receipt).catch(() => undefined);
      throw failure.withReceipt(receipt);
    }
  };
}
