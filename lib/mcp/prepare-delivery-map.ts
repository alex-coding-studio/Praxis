import { randomUUID } from 'node:crypto';
import { PublicApiError } from '../api-errors.ts';
import { sha256Hex } from '../materialization/hash.ts';
import {
  prepareDeliveryMapBasis,
  type DeliveryMapBasis,
} from '../modules/delivery-planning/basis.ts';
import {
  assertDeliveryPlanningSelection,
  collectDeliveryPlanningEvidence,
} from '../modules/delivery-planning/evidence.ts';
import { listWhatToDoFeatureSources } from '../modules/delivery-planning/sources.ts';
import { readWhatToDoCurrentMapWithFingerprint } from '../modules/delivery-planning/storage.ts';
import type { RegisteredProject } from '../project-registry.ts';
import { invalidArgument, staleBasis } from './errors.ts';
import {
  freezeEvidenceContents,
  readContextArtifacts,
  type EvidenceContent,
} from './evidence.ts';
import { MCP_MODULE_DEFINITIONS } from './modules.ts';
import {
  newMcpOperationId,
  writeMcpOperation,
  writeMcpOperationBasis,
  writeMcpOperationUserInput,
  type McpOperationRecord,
} from './operations.ts';
import { assertUserInput } from './prepare.ts';

export type DeliveryMapPrepareRequest = {
  userInput: string;
  sourceUids?: string[];
  selectionIds?: string[];
  contextIds?: string[];
};

export function deliveryClaimSourcePaths(
  sources: readonly { outputPath: string }[],
) {
  return [...new Set(sources.map((source) => source.outputPath))];
}

export function deliveryUserInputLogicalPath(runId: string) {
  return `what-to-do/runs/${runId}/context/input/user-input.md`;
}

export function deliverySelectionBoundary(error: unknown): never {
  if (error instanceof PublicApiError && error.status === 409)
    throw staleBasis(
      `${error.message} Read the module resource again and prepare a new operation.`,
    );
  if (error instanceof PublicApiError) throw invalidArgument(error.message);
  throw error;
}

export async function assembleDeliveryMapEvidence(
  project: RegisteredProject,
  runId: string,
  request: {
    userInput: string;
    sourceUids: readonly string[];
    contextInputs: readonly EvidenceContent[];
  },
) {
  const current = await readWhatToDoCurrentMapWithFingerprint(project);
  let evidence;
  try {
    evidence = await collectDeliveryPlanningEvidence(project, {
      userInputPath: deliveryUserInputLogicalPath(runId),
      userInput: request.userInput,
      sourceUids: [...request.sourceUids],
      currentMap: current.map,
      repositoryEvidencePaths: [],
      extraInputs: request.contextInputs.map((entry) => ({
        role: 'related' as const,
        kind: 'context-document',
        logicalPath: entry.logicalPath,
        content: entry.content,
      })),
    });
  } catch (error) {
    deliverySelectionBoundary(error);
  }
  return { current, evidence };
}

export function deliveryMapBasisFor(
  project: RegisteredProject,
  current: { map: DeliveryMapBasis['currentMap']; fingerprint: string },
  preparedAt?: string,
) {
  return prepareDeliveryMapBasis(
    project,
    { currentMap: current.map, currentMapFingerprint: current.fingerprint },
    preparedAt ? () => preparedAt : undefined,
  );
}

export async function prepareDeliveryMapOperation(
  project: RegisteredProject,
  request: DeliveryMapPrepareRequest,
  clientInfo: { name: string; version: string } | null = null,
) {
  const userInput = assertUserInput(request.userInput);
  const sourceUids = [...new Set(request.sourceUids ?? [])];
  const selectionIds = [...new Set(request.selectionIds ?? [])];
  const contextIds = [...new Set(request.contextIds ?? [])];
  if (sourceUids.some((uid) => typeof uid !== 'string' || uid.length === 0))
    throw invalidArgument('request.sourceUids entries must be non-empty ids.');
  if (selectionIds.some((id) => typeof id !== 'string' || id.length === 0))
    throw invalidArgument(
      'request.selectionIds entries must be non-empty ids.',
    );

  const current = await readWhatToDoCurrentMapWithFingerprint(project);
  if (!current.map && sourceUids.length === 0) {
    const available = await listWhatToDoFeatureSources(project);
    throw invalidArgument(
      available.length === 0
        ? 'This project has no accepted Product Design Feature, so there is nothing a first Delivery Map can be built from. Accept a Feature in Product Exploration first.'
        : `A first Delivery Map is built from accepted Product Design Features, so request.sourceUids must name at least one of: ${available.map((source) => source.uid).join(', ')}.`,
    );
  }
  try {
    assertDeliveryPlanningSelection({
      currentMap: current.map,
      sourceUids,
      focusContractIds: selectionIds,
    });
  } catch (error) {
    if (error instanceof PublicApiError && error.status === 409)
      throw invalidArgument(
        `${error.message} Read ${MCP_MODULE_DEFINITIONS['delivery-planning'].module}'s module resource for the current Delivery Map.`,
      );
    throw error;
  }

  const operationId = newMcpOperationId();
  const runId = `RUN-${randomUUID()}`;
  const contextInputs = await readContextArtifacts(project, contextIds);
  const { evidence } = await assembleDeliveryMapEvidence(project, runId, {
    userInput,
    sourceUids,
    contextInputs,
  });
  const basis = deliveryMapBasisFor(project, current);
  const sourcePaths = deliveryClaimSourcePaths(evidence.sources);

  const userInputPath = await writeMcpOperationUserInput(
    project,
    operationId,
    userInput,
  );
  const basisPath = await writeMcpOperationBasis(project, operationId, basis);
  const sources = await freezeEvidenceContents(
    project,
    operationId,
    evidence.inputs,
  );
  const definition = MCP_MODULE_DEFINITIONS['delivery-planning'];
  const record: McpOperationRecord = {
    schemaVersion: 1,
    operationId,
    projectId: project.id,
    module: 'delivery-planning',
    status: 'prepared',
    transport: 'mcp',
    clientInfo,
    contract: {
      id: definition.contract.id,
      version: definition.contract.version,
      hash: definition.contract.hash,
    },
    basis: { fingerprint: basis.fingerprint, preparedAt: basis.preparedAt },
    runId,
    request: {
      operation: basis.operation,
      sourceUids,
      sourcePaths,
      selectionIds,
      contextIds,
      currentMapFingerprint: current.fingerprint,
      userInputSha256: sha256Hex(userInput),
    },
    userInputPath,
    basisPath,
    sources,
    preparedAt: basis.preparedAt,
    admittedAt: null,
    admittedHostPid: null,
    semanticResultHash: null,
    settledAt: null,
    outcome: null,
    receipt: null,
    logRef: null,
    logUrlPath: null,
    error: null,
  };
  await writeMcpOperation(project, record);
  return { record, basis };
}
