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
import { semanticResultHash, sha256Hex } from '../materialization/hash.ts';
import type { MaterializationReceipt } from '../materialization/receipt.ts';
import type { DeliveryMapBasis } from '../modules/delivery-planning/basis.ts';
import {
  DELIVERY_MAP_RESULT_CONTRACT,
  type DeliveryMapResult,
} from '../modules/delivery-planning/contract.ts';
import { deliveryPublicationHost } from '../modules/delivery-planning/publication-host.ts';
import { submitDeliveryMapResult } from '../modules/delivery-planning/publish.ts';
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
import { readContextArtifacts } from './evidence.ts';
import {
  readMcpOperationBasis,
  readMcpOperationSource,
  readMcpOperationUserInput,
  requireMcpOperation,
  withMcpOperationLock,
  writeMcpOperation,
  type McpOperationRecord,
  type McpOperationSource,
} from './operations.ts';
import {
  assembleDeliveryMapEvidence,
  deliveryMapBasisFor,
  deliveryUserInputLogicalPath,
} from './prepare-delivery-map.ts';
import { publicationBoundary } from './publication-boundary.ts';

export function operationSourceStoredPath(
  operationId: string,
  source: McpOperationSource,
) {
  return `mcp/operations/${operationId}/sources/${source.sourceId}`;
}

function outcomeSummary(result: DeliveryMapResult) {
  if (result.outcome === 'map-proposal')
    return { kind: 'map-proposal', summary: 'The Delivery Map was published.' };
  if (result.outcome === 'clarification')
    return {
      kind: 'clarification',
      summary: 'The module returned a clarification instead of a Map.',
    };
  return { kind: result.outcome, summary: 'The module reported no change.' };
}

export async function frozenDeliveryEvidence(
  project: RegisteredProject,
  record: McpOperationRecord,
) {
  const userInputPath = deliveryUserInputLogicalPath(record.runId);
  const claimPaths = new Set(
    ((record.request.sourcePaths as string[] | undefined) ?? []).concat(
      userInputPath,
    ),
  );
  const frozen: Record<string, { sha256: string; content: string }> = {};
  for (const source of record.sources) {
    if (!claimPaths.has(source.logicalPath)) continue;
    frozen[source.logicalPath] = {
      sha256: source.sha256,
      content: await readMcpOperationSource(
        project,
        record.operationId,
        source.sourceId,
      ),
    };
  }
  const userInput = record.sources.find(
    (source) => source.logicalPath === userInputPath,
  );
  if (!userInput || !frozen[userInputPath])
    throw staleBasis(
      'The frozen User Input for this operation is no longer readable. Prepare a new operation.',
    );
  const knownSources = Object.fromEntries(
    Object.entries(frozen).filter(
      ([logicalPath]) => logicalPath !== userInputPath,
    ),
  );
  return {
    sourceUids: (record.request.sourceUids as string[] | undefined) ?? [],
    userInput: {
      path: userInputPath,
      sha256: userInput.sha256,
      content: frozen[userInputPath].content,
    },
    sourceSnapshots: record.sources
      .filter(
        (source) =>
          source.logicalPath !== userInputPath &&
          claimPaths.has(source.logicalPath),
      )
      .map((source) => ({
        logicalPath: source.logicalPath,
        sha256: source.sha256,
        storedPath: operationSourceStoredPath(record.operationId, source),
      })),
    knownSources,
    knownEvidencePaths: [
      '.',
      ...record.sources.map((source) => source.logicalPath),
    ],
  };
}

export async function driftedDeliveryEvidence(
  project: RegisteredProject,
  record: McpOperationRecord,
) {
  const contextInputs = await readContextArtifacts(
    project,
    (record.request.contextIds as string[] | undefined) ?? [],
  );
  const { current, evidence } = await assembleDeliveryMapEvidence(
    project,
    record.runId,
    {
      userInput: await readMcpOperationUserInput(project, record.operationId),
      sourceUids: (record.request.sourceUids as string[] | undefined) ?? [],
      contextInputs,
    },
  );
  const frozen = new Map(
    record.sources.map((source) => [source.logicalPath, source.sha256]),
  );
  const drifted: string[] = [];
  for (const input of evidence.inputs) {
    const recorded = frozen.get(input.logicalPath);
    if (recorded === undefined || recorded !== sha256Hex(input.content))
      drifted.push(input.logicalPath);
  }
  return { current, drifted };
}

export async function submitDeliveryMapOperation(
  project: RegisteredProject,
  operationId: string,
  contract: { id: string; version: number; hash: string },
  result: unknown,
) {
  return withMcpOperationLock(operationId, async () => {
    const record = await requireMcpOperation(project, operationId);
    if (record.module !== 'delivery-planning')
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
      DELIVERY_MAP_RESULT_CONTRACT.validateStructure(result);
    } catch (error) {
      throw invalidResult(
        error instanceof Error
          ? error.message
          : 'The result did not satisfy the Result Contract.',
      );
    }
    const typed = result as DeliveryMapResult;
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

    const owner = moduleOwner(project, 'what-to-do');
    const active = getActiveRun(owner);
    if (active)
      throw activeRunConflict(
        `Run ${active.runId} owns Delivery Planning for this project. Retry after it ends; its log is at ${ownerLogUrlPath(owner, active.runId)}.`,
      );

    const { current, drifted } = await driftedDeliveryEvidence(project, record);
    if (
      deliveryMapBasisFor(project, current, record.basis.preparedAt)
        .fingerprint !== record.basis.fingerprint
    )
      throw staleBasis(
        'The Delivery Map changed after this operation was prepared. Read it again, prepare a new operation, then reapply the requested change.',
      );
    if (drifted.length > 0)
      throw staleBasis(
        `These source documents changed after this operation was prepared: ${drifted.join(', ')}. Read them again and prepare a new operation.`,
      );
    const basis = await readMcpOperationBasis<DeliveryMapBasis>(
      project,
      operationId,
    );
    if (basis.fingerprint !== record.basis.fingerprint)
      throw staleBasis(
        'The frozen Basis for this operation no longer matches its record. Prepare a new operation.',
      );
    const evidence = await frozenDeliveryEvidence(project, record);

    const paths = moduleRunLogPaths(project, 'what-to-do', record.runId);
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
        subject: { kind: 'module', label: 'Delivery Planning' },
        startMessage: `Publishing an external Delivery Map result for operation ${operationId}`,
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
      published = await submitDeliveryMapResult(
        project,
        basis,
        typed,
        { runId: record.runId, ...evidence },
        deliveryPublicationHost,
        (entry) => reservation.record(entry),
      );
    } catch (error) {
      const boundary = publicationBoundary(error);
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
          status: typed.outcome === 'map-proposal' ? 'completed' : 'warning',
          title:
            typed.outcome === 'map-proposal'
              ? 'The Delivery Map was published'
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
