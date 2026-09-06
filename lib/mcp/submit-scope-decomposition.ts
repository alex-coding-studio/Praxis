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
import type { ScopeDecompositionMaterializationBasis } from '../modules/scope-decomposition/basis.ts';
import {
  SCOPE_DECOMPOSITION_RESULT_CONTRACT,
  type ScopeDecompositionResult,
} from '../modules/scope-decomposition/contract.ts';
import { submitScopeDecompositionResult as publishScopeDecomposition } from '../modules/scope-decomposition/publish.ts';
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
import { assembleScopeDecompositionBasis } from './prepare-scope-decomposition.ts';
import { driftedSources } from './submit.ts';
import {
  readMcpOperationBasis,
  requireMcpOperation,
  withMcpOperationLock,
  writeMcpOperation,
  type McpOperationRecord,
} from './operations.ts';

function outcomeSummary(result: ScopeDecompositionResult, count: number) {
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

export async function submitScopeDecompositionOperation(
  project: RegisteredProject,
  operationId: string,
  contract: { id: string; version: number; hash: string },
  result: unknown,
) {
  return withMcpOperationLock(operationId, async () => {
    const record = await requireMcpOperation(project, operationId);
    if (record.module !== 'scope-decomposition')
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
      SCOPE_DECOMPOSITION_RESULT_CONTRACT.validateStructure(result);
    } catch (error) {
      throw invalidResult(
        error instanceof Error
          ? error.message
          : 'The result did not satisfy the Result Contract.',
      );
    }
    const typed = result as ScopeDecompositionResult;
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

    const owner = moduleOwner(project, 'task-decomposition');
    const active = getActiveRun(owner);
    if (active)
      throw activeRunConflict(
        `Run ${active.runId} owns Scope Decomposition for this project. Retry after it ends; its log is at ${ownerLogUrlPath(owner, active.runId)}.`,
      );

    const request = record.request as {
      operation: never;
      intention: string;
      motion: string;
      candidateIds: string[];
      sourceNodeId: string;
      revisionTarget: {
        candidateId: string;
        revision: number;
        uid: string;
      } | null;
    };
    const current = await assembleScopeDecompositionBasis(
      project,
      request,
      record.basis.preparedAt,
    );
    if (current.fingerprint !== record.basis.fingerprint)
      throw staleBasis(
        'Read the module resource again, prepare a new operation with the current state, then reapply the requested change.',
      );
    const basis =
      await readMcpOperationBasis<ScopeDecompositionMaterializationBasis>(
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

    const paths = moduleRunLogPaths(
      project,
      'task-decomposition',
      record.runId,
    );
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
        subject: { kind: 'module', label: 'Scope Decomposition' },
        startMessage: `Publishing an external Scope Decomposition result for operation ${operationId}`,
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
      published = await publishScopeDecomposition(
        basis,
        typed,
        { runId: record.runId, sourceNodeId: request.sourceNodeId },
        () => new Date().toISOString(),
        (entry) => reservation.record(entry),
      );
    } catch (error) {
      const boundary =
        error instanceof MaterializationError ? error.boundary : 'publication';
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

    const summary = outcomeSummary(typed, published.candidates.length);
    const settled: McpOperationRecord = {
      ...admitted,
      status: 'completed',
      settledAt: new Date().toISOString(),
      outcome: summary,
      receipt:
        (published.record.materialization as MaterializationReceipt) ?? null,
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
