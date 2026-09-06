import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../materialization/hash.ts';
import { MaterializationError } from '../materialization/receipt.ts';
import {
  prepareDomainModelBasis,
  type DomainModelBasis,
} from '../modules/domain-modeling/basis.ts';
import { readDomainModelView } from '../modules/domain-modeling/model.ts';
import type { RegisteredProject } from '../project-registry.ts';
import { invalidArgument, staleBasis } from './errors.ts';
import { freezeContextSources } from './evidence.ts';
import { MCP_MODULE_DEFINITIONS } from './modules.ts';
import {
  newMcpOperationId,
  writeMcpOperation,
  writeMcpOperationBasis,
  writeMcpOperationUserInput,
  type McpOperationRecord,
} from './operations.ts';
import { assertUserInput } from './prepare.ts';

export type DomainModelPrepareRequest = {
  userInput: string;
  selectionIds?: string[];
  contextIds?: string[];
};

export async function assembleDomainModelBasis(
  project: RegisteredProject,
  selectionIds: readonly string[],
  preparedAt?: string,
): Promise<DomainModelBasis> {
  const view = await readDomainModelView(project);
  try {
    return prepareDomainModelBasis(
      project,
      { model: view.model, selectedIds: selectionIds },
      preparedAt ? () => preparedAt : undefined,
    );
  } catch (error) {
    if (
      error instanceof MaterializationError &&
      error.boundary === 'stale-basis'
    )
      throw staleBasis(
        `${error.message} Read the module resource again and prepare a new operation.`,
      );
    throw error;
  }
}

export async function prepareDomainModelOperation(
  project: RegisteredProject,
  request: DomainModelPrepareRequest,
  clientInfo: { name: string; version: string } | null = null,
) {
  const userInput = assertUserInput(request.userInput);
  const selectionIds = [...new Set(request.selectionIds ?? [])];
  const contextIds = [...new Set(request.contextIds ?? [])];
  if (selectionIds.some((id) => typeof id !== 'string' || id.length === 0))
    throw invalidArgument(
      'request.selectionIds entries must be non-empty ids.',
    );

  const basis = await assembleDomainModelBasis(project, selectionIds);
  const operationId = newMcpOperationId();
  const userInputPath = await writeMcpOperationUserInput(
    project,
    operationId,
    userInput,
  );
  const basisPath = await writeMcpOperationBasis(project, operationId, basis);
  const sources = await freezeContextSources(project, operationId, contextIds);
  const definition = MCP_MODULE_DEFINITIONS['domain-modeling'];
  const record: McpOperationRecord = {
    schemaVersion: 1,
    operationId,
    projectId: project.id,
    module: 'domain-modeling',
    status: 'prepared',
    transport: 'mcp',
    clientInfo,
    contract: {
      id: definition.contract.id,
      version: definition.contract.version,
      hash: definition.contract.hash,
    },
    basis: { fingerprint: basis.fingerprint, preparedAt: basis.preparedAt },
    runId: `RUN-${randomUUID()}`,
    request: {
      operation: 'change-model',
      selectionIds,
      contextIds,
      stateVersion: basis.stateVersion,
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
