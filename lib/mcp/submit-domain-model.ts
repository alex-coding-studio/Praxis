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
import { PublicApiError } from '../api-errors.ts';
import { semanticResultHash } from '../materialization/hash.ts';
import {
  MaterializationError,
  type MaterializationReceipt,
} from '../materialization/receipt.ts';
import type { DomainModelBasis } from '../modules/domain-modeling/basis.ts';
import {
  DOMAIN_MODEL_RESULT_CONTRACT,
  type DomainModelResult,
} from '../modules/domain-modeling/contract.ts';
import { publishDomainModelResult } from '../modules/domain-modeling/publish.ts';
import type { RegisteredProject } from '../project-registry.ts';
import { reconcileMcpOperation } from './catalog.ts';
import {
  activeRunConflict,
  contractMismatch,
  invalidResult,
  publicationFailed,
  staleBasis,
  submissionConflict,
} from './errors.ts';
import {
  readMcpOperationBasis,
  requireMcpOperation,
  withMcpOperationLock,
  writeMcpOperation,
  type McpOperationRecord,
} from './operations.ts';
import { assembleDomainModelBasis } from './prepare-domain-model.ts';
import { driftedSources } from './submit.ts';

export type DomainPublicationBoundary =
  | 'stale-basis'
  | 'validation'
  | 'identity'
  | 'publication';

export function domainPublicationBoundary(
  error: unknown,
): DomainPublicationBoundary {
  if (error instanceof PublicApiError && error.status === 409)
    return 'stale-basis';
  if (error instanceof MaterializationError) {
    if (
      error.boundary === 'stale-basis' ||
      error.boundary === 'validation' ||
      error.boundary === 'identity'
    )
      return error.boundary;
  }
  return 'publication';
}

function outcomeSummary(result: DomainModelResult) {
  if (result.outcome === 'model-change')
    return { kind: 'model-change', summary: 'The Domain Model was updated.' };
  if (result.outcome === 'clarification')
    return {
      kind: 'clarification',
      summary: 'The module returned a clarification instead of a change.',
    };
  return { kind: result.outcome, summary: 'The module reported no change.' };
}

export async function submitDomainModelOperation(
  project: RegisteredProject,
  operationId: string,
  contract: { id: string; version: number; hash: string },
  result: unknown,
) {
  return withMcpOperationLock(operationId, async () => {
    const record = await requireMcpOperation(project, operationId);
    if (record.module !== 'domain-modeling')
      throw contractMismatch(
        `Operation ${operationId} was prepared for ${record.module}; submit it with that module's tool.`,
      );
    if (
      contract.id !== record.contract.id ||
      contract.version !== record.contract.version ||
      contract.hash !== record.contract.hash
    )
      throw contractMismatch(
        `This operation was prepared against ${record.contract.id} version ${record.contract.version} (${record.contract.hash}). Reload that contract and submit against it.`,
      );

    try {
      DOMAIN_MODEL_RESULT_CONTRACT.validateStructure(result);
    } catch (error) {
      throw invalidResult(
        error instanceof Error
          ? error.message
          : 'The result did not satisfy the Result Contract.',
      );
    }
    const typed = result as DomainModelResult;
    const resultHash = semanticResultHash(typed);

    if (record.semanticResultHash !== null) {
      if (record.semanticResultHash !== resultHash)
        throw submissionConflict(
          `Operation ${operationId} was already admitted with a different result. Inspect it with praxis_get_operation and prepare a new operation to correct it.`,
        );
      const reconciled = await reconcileMcpOperation(project, record);
      if (reconciled.status === 'interrupted')
        throw publicationFailed(
          reconciled.error?.detail ??
            `Operation ${operationId} was admitted but its outcome is not provable. Inspect its Run log before preparing a replacement; this retry did not republish it.`,
        );
      return { record: reconciled, replayed: true };
    }

    const owner = moduleOwner(project, 'domain-model');
    const active = getActiveRun(owner);
    if (active)
      throw activeRunConflict(
        `Run ${active.runId} owns Domain Modeling for this project. Retry after it ends; its log is at ${ownerLogUrlPath(owner, active.runId)}.`,
      );

    const current = await assembleDomainModelBasis(
      project,
      record.request.selectionIds as string[],
      record.basis.preparedAt,
    );
    if (current.fingerprint !== record.basis.fingerprint)
      throw staleBasis(
        'The Domain Model changed after this operation was prepared. Read it again, prepare a new operation, then reapply the requested change.',
      );
    const basis = await readMcpOperationBasis<DomainModelBasis>(
      project,
      operationId,
    );
    if (basis.fingerprint !== record.basis.fingerprint)
      throw staleBasis(
        'The frozen Basis for this operation no longer matches its record. Prepare a new operation.',
      );
    const drifted = await driftedSources(project, record.sources);
    if (drifted.length > 0)
      throw staleBasis(
        `These source documents changed after this operation was prepared: ${drifted.join(', ')}. Read them again and prepare a new operation.`,
      );

    const paths = moduleRunLogPaths(project, 'domain-model', record.runId);
    const admitted: McpOperationRecord = {
      ...record,
      status: 'running',
      admittedAt: new Date().toISOString(),
      admittedHostPid: process.pid,
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
        subject: { kind: 'module', label: 'Domain Modeling' },
        startMessage: `Publishing an external Domain Model result for operation ${operationId}`,
        phase: 'publishing',
        actor: 'HOST',
        validate: async () => null,
        persist: async () => async () => undefined,
      }));
    } catch (error) {
      await writeMcpOperation(project, {
        ...record,
        status: 'prepared',
        admittedAt: null,
        admittedHostPid: null,
        semanticResultHash: null,
        logRef: null,
        logUrlPath: null,
      }).catch(() => undefined);
      if (error instanceof ActiveRunConflictError)
        throw activeRunConflict(error.message);
      throw error;
    }

    let published;
    try {
      published = await publishDomainModelResult(
        project,
        basis,
        typed,
        {
          kind: 'direct',
          runId: record.runId,
          userInputPath: record.userInputPath,
        },
        () => new Date().toISOString(),
        (entry) => reservation.record(entry),
      );
    } catch (error) {
      const conflict = error instanceof PublicApiError && error.status === 409;
      const boundary = conflict
        ? 'stale-basis'
        : error instanceof MaterializationError
          ? error.boundary
          : 'publication';
      const message =
        error instanceof Error ? error.message : 'The publication failed.';
      await writeMcpOperation(project, {
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
      }).catch(() => undefined);
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

    const summary = outcomeSummary(typed);
    const settled: McpOperationRecord = {
      ...admitted,
      status: 'completed',
      settledAt: new Date().toISOString(),
      outcome: summary,
      receipt: (published.receipt as MaterializationReceipt) ?? null,
    };
    try {
      await writeMcpOperation(project, settled);
    } catch (error) {
      try {
        reservation.record({
          level: 'WARN',
          actor: 'HOST',
          phase: 'RUN',
          event: 'operation.status-write-failed',
          message: `The result is published and its receipt is committed, but the operation status could not be written: ${error instanceof Error ? error.message : 'unknown failure'}. Recover the outcome from the Run receipt.`,
        });
      } catch {}
    }
    try {
      await settleRun(reservation, {
        classification: {
          status: typed.outcome === 'model-change' ? 'completed' : 'warning',
          title:
            typed.outcome === 'model-change'
              ? 'The Domain Model was updated'
              : 'The module reported no change',
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
