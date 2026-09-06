import {
  beginRun,
  getActiveRun,
  releaseRun,
  settleRun,
  ActiveRunConflictError,
} from '../execution-observability/active-runs.ts';
import {
  moduleOwner,
  moduleRunLogPaths,
} from '../execution-observability/module-run.ts';
import { ownerLogUrlPath } from '../execution-observability/types.ts';
import { semanticResultHash } from '../materialization/hash.ts';
import {
  MaterializationError,
  type MaterializationReceipt,
} from '../materialization/receipt.ts';
import {
  PRODUCT_EXPLORATION_RESULT_CONTRACT,
  type ProductExplorationResult,
} from '../modules/product-discovery/contract.ts';
import { publishProductExplorationResult } from '../modules/product-discovery/publish.ts';
import type { RegisteredProject } from '../project-registry.ts';
import {
  activeRunConflict,
  contractMismatch,
  invalidResult,
  publicationFailed,
  staleBasis,
  submissionConflict,
} from './errors.ts';
import type { ProductExplorationMaterializationBasis } from '../modules/product-discovery/basis.ts';
import { assembleProductExplorationBasis } from './prepare.ts';
import {
  readMcpOperationBasis,
  requireMcpOperation,
  withMcpOperationLock,
  writeMcpOperation,
  type McpOperationRecord,
} from './operations.ts';

export type McpSubmissionOutcome = {
  record: McpOperationRecord;
  replayed: boolean;
};

function assertContractIdentity(
  record: McpOperationRecord,
  supplied: { id: string; version: number; hash: string },
) {
  if (
    supplied.id !== record.contract.id ||
    supplied.version !== record.contract.version ||
    supplied.hash !== record.contract.hash
  )
    throw contractMismatch(
      `This operation was prepared against ${record.contract.id} version ${record.contract.version} (${record.contract.hash}). Reload that contract and submit against it.`,
    );
}

function outcomeSummary(result: ProductExplorationResult, count: number) {
  if (result.outcome === 'proposal')
    return {
      kind: 'proposal',
      summary: `${count} Candidate${count === 1 ? '' : 's'} proposed for acceptance.`,
    };
  if (result.outcome === 'clarification')
    return {
      kind: 'clarification',
      summary: 'The module returned a clarification instead of Candidates.',
    };
  return { kind: result.outcome, summary: 'The module reported no change.' };
}

export async function submitProductExplorationResult(
  project: RegisteredProject,
  operationId: string,
  contract: { id: string; version: number; hash: string },
  result: unknown,
): Promise<McpSubmissionOutcome> {
  return withMcpOperationLock(operationId, async () => {
    const record = await requireMcpOperation(project, operationId);
    assertContractIdentity(record, contract);

    try {
      PRODUCT_EXPLORATION_RESULT_CONTRACT.validateStructure(result);
    } catch (error) {
      throw invalidResult(
        error instanceof Error
          ? error.message
          : 'The result did not satisfy the Result Contract.',
      );
    }
    const typed = result as ProductExplorationResult;
    const resultHash = semanticResultHash(typed);

    if (record.semanticResultHash !== null) {
      if (record.semanticResultHash !== resultHash)
        throw submissionConflict(
          `Operation ${operationId} was already admitted with a different result. Inspect it with praxis_get_operation and prepare a new operation to correct it.`,
        );
      return { record, replayed: true };
    }

    const owner = moduleOwner(project, 'whats-next');
    const active = getActiveRun(owner);
    if (active)
      throw activeRunConflict(
        `Run ${active.runId} owns Product Exploration for this project. Retry after it ends; its log is at ${ownerLogUrlPath(owner, active.runId)}.`,
      );

    const current = await assembleProductExplorationBasis(
      project,
      {
        intention: record.request.intention as never,
        motion: record.request.motion as never,
        sourceNodeIds: record.request.sourceNodeIds as string[],
      },
      record.basis.preparedAt,
    );
    if (current.fingerprint !== record.basis.fingerprint)
      throw staleBasis(
        'Read the module resource again, prepare a new operation with the current state, then reapply the requested change.',
      );
    const basis =
      await readMcpOperationBasis<ProductExplorationMaterializationBasis>(
        project,
        operationId,
      );
    if (basis.fingerprint !== record.basis.fingerprint)
      throw staleBasis(
        'The frozen Basis for this operation no longer matches its record. Prepare a new operation.',
      );

    const paths = moduleRunLogPaths(project, 'whats-next', record.runId);
    const admitted: McpOperationRecord = {
      ...record,
      status: 'running',
      admittedAt: new Date().toISOString(),
      semanticResultHash: resultHash,
      logRef: paths.logRef,
      logUrlPath: ownerLogUrlPath(owner, record.runId),
    };
    await writeMcpOperation(project, admitted);

    let reservation;
    try {
      ({ reservation } = await beginRun<null>({
        owner,
        runId: record.runId,
        logFile: paths.logFile,
        logRef: paths.logRef,
        subject: { kind: 'module', label: 'Product Exploration and Design' },
        layer: record.request.layer as 'discovery' | 'product-design',
        startMessage: `Publishing an external Product Exploration result for operation ${operationId}`,
        phase: 'publishing',
        actor: 'HOST',
        validate: async () => null,
        persist: async () => async () => undefined,
      }));
    } catch (error) {
      const rolledBack: McpOperationRecord = {
        ...record,
        status: 'prepared',
        admittedAt: null,
        semanticResultHash: null,
        logRef: null,
        logUrlPath: null,
      };
      await writeMcpOperation(project, rolledBack);
      if (error instanceof ActiveRunConflictError)
        throw activeRunConflict(error.message);
      throw error;
    }

    let published;
    try {
      published = await publishProductExplorationResult(
        basis,
        typed,
        {
          kind: 'direct',
          runId: record.runId,
          sourceNodeIds: record.request.sourceNodeIds as string[],
        },
        () => new Date().toISOString(),
        (entry) => reservation.record(entry),
      );
    } catch (error) {
      const boundary =
        error instanceof MaterializationError ? error.boundary : 'publication';
      const message =
        error instanceof Error ? error.message : 'The publication failed.';
      const failed: McpOperationRecord = {
        ...admitted,
        status: 'rejected',
        settledAt: new Date().toISOString(),
        error: {
          code:
            boundary === 'stale-basis' ? 'STALE_BASIS' : 'PUBLICATION_FAILED',
          title: 'The result was not published',
          detail: message,
          boundary: boundary === 'stale-basis' ? 'stale-basis' : 'publication',
          retryAction:
            boundary === 'stale-basis' ? 'prepare-again' : 'inspect-operation',
        },
      };
      await writeMcpOperation(project, failed).catch(() => undefined);
      try {
        await settleRun(reservation, {
          classification: {
            status: 'fail',
            title: 'The external result was not published',
            detail: message,
            supplementaryWarnings: [],
            recovery: ['log'],
          },
        });
      } catch {
        releaseRun(reservation);
      }
      if (boundary === 'stale-basis') throw staleBasis(message);
      if (boundary === 'validation' || boundary === 'identity')
        throw invalidResult(message);
      throw publicationFailed(message);
    }

    const summary = outcomeSummary(typed, published.candidates.length);
    const settled: McpOperationRecord = {
      ...admitted,
      status: 'completed',
      settledAt: new Date().toISOString(),
      outcome: summary,
      receipt:
        (published.record.materialization as MaterializationReceipt) ?? null,
    };
    let statusWriteFailed: string | null = null;
    try {
      await writeMcpOperation(project, settled);
    } catch (error) {
      statusWriteFailed =
        error instanceof Error ? error.message : 'unknown failure';
      try {
        reservation.record({
          level: 'WARN',
          actor: 'HOST',
          phase: 'RUN',
          event: 'operation.status-write-failed',
          message: `The result is published and its receipt is committed, but the operation status could not be written: ${statusWriteFailed}. Recover the outcome from the Run receipt.`,
        });
      } catch {}
    }
    try {
      await settleRun(reservation, {
        classification: {
          status: typed.outcome === 'proposal' ? 'completed' : 'warning',
          title:
            typed.outcome === 'proposal'
              ? 'Candidates ready for review'
              : 'The module reported no Candidates',
          detail: summary.summary,
          supplementaryWarnings: [],
          recovery: ['log'],
        },
      });
    } catch {
      releaseRun(reservation);
    }
    return { record: settled, replayed: false };
  });
}
