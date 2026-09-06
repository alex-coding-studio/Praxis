import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sha256Hex } from '../materialization/hash.ts';
import {
  resolvePlanningPath,
  TASK_GRAPH_MARKDOWN_SHAPES,
} from '../planning-paths.ts';
import {
  collectLatestUnacceptedCandidateStates,
  collectReservedCandidateIds,
  collectAcceptedCandidateIds,
  PRODUCT_EXPLORATION_GRAPH_ROOT,
} from '../modules/product-discovery/assembly.ts';
import {
  prepareProductExplorationMaterializationBasis,
  type ProductExplorationMaterializationBasis,
} from '../modules/product-discovery/basis.ts';
import {
  intentionDestination,
  whatsNextIntentions,
  whatsNextLayers,
  whatsNextMotions,
  type WhatsNextIntention,
  type WhatsNextLayer,
  type WhatsNextMotion,
} from '../modules/product-discovery/intention.ts';
import { listTaskGraphNodes } from '../graph/task/nodes.ts';
import type { RegisteredProject } from '../project-registry.ts';
import { invalidArgument } from './errors.ts';
import { MCP_MODULE_DEFINITIONS } from './modules.ts';
import {
  encodeSourceId,
  newMcpOperationId,
  writeMcpOperation,
  writeMcpOperationSource,
  writeMcpOperationBasis,
  writeMcpOperationUserInput,
  type McpOperationRecord,
  type McpOperationSource,
} from './operations.ts';
import { contractUri, moduleUri, operationSourceUri } from './uri.ts';

export const MAX_USER_INPUT_LENGTH = 20_000;

export type ProductExplorationPrepareRequest = {
  userInput: string;
  layer: WhatsNextLayer;
  intention?: WhatsNextIntention;
  motion?: WhatsNextMotion;
  sourceNodeIds?: string[];
};

function assertUserInput(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw invalidArgument('request.userInput must be a non-empty string.');
  if (value.length > MAX_USER_INPUT_LENGTH)
    throw invalidArgument(
      `request.userInput is longer than ${MAX_USER_INPUT_LENGTH} characters.`,
    );
  return value;
}

function assertLayer(value: unknown): WhatsNextLayer {
  if (!(whatsNextLayers as readonly unknown[]).includes(value))
    throw invalidArgument(
      `request.layer must be one of ${whatsNextLayers.join(', ')}.`,
    );
  return value as WhatsNextLayer;
}

function resolveIntention(
  layer: WhatsNextLayer,
  supplied: unknown,
): WhatsNextIntention {
  const allowed = whatsNextIntentions.filter(
    (intention) => intentionDestination(intention).layer === layer,
  );
  if (supplied === undefined || supplied === null) {
    if (allowed.length === 1) return allowed[0] as WhatsNextIntention;
    throw invalidArgument(
      `request.intention is required for layer ${layer}. The allowed values are ${allowed.join(', ')}.`,
    );
  }
  if (!allowed.includes(supplied as WhatsNextIntention))
    throw invalidArgument(
      `request.intention ${JSON.stringify(supplied)} is not valid for layer ${layer}. The allowed values are ${allowed.join(', ')}.`,
    );
  return supplied as WhatsNextIntention;
}

function resolveMotion(supplied: unknown): WhatsNextMotion {
  if (supplied === undefined || supplied === null) return 'unspecified';
  if (!(whatsNextMotions as readonly unknown[]).includes(supplied))
    throw invalidArgument(
      `request.motion must be one of ${whatsNextMotions.join(', ')}.`,
    );
  return supplied as WhatsNextMotion;
}

export type ProductExplorationPreparedRequest = {
  layer: WhatsNextLayer;
  intention: WhatsNextIntention;
  motion: WhatsNextMotion;
  operation: 'explore';
  sourceNodeIds: string[];
  userInputSha256: string;
};

export async function assembleProductExplorationBasis(
  project: RegisteredProject,
  request: Pick<
    ProductExplorationPreparedRequest,
    'intention' | 'motion' | 'sourceNodeIds'
  >,
  preparedAt?: string,
) {
  const nodes = await listTaskGraphNodes(
    project,
    PRODUCT_EXPLORATION_GRAPH_ROOT,
  );
  return prepareProductExplorationMaterializationBasis(
    project,
    {
      operation: 'explore',
      intention: request.intention,
      motion: request.motion,
      sourceNodeIds: request.sourceNodeIds,
      knownNodeIds: nodes.map((node) => node.id),
      acceptedCandidateIds: await collectAcceptedCandidateIds(project),
      knownResourcePaths: [
        ...new Set(
          nodes.flatMap((node) =>
            node.resources.map((resource) => resource.path),
          ),
        ),
      ],
      reservedCandidateIds: await collectReservedCandidateIds(project),
      currentCandidates: await collectLatestUnacceptedCandidateStates(project),
    },
    preparedAt ? () => preparedAt : undefined,
  );
}

async function freezeSources(
  project: RegisteredProject,
  operationId: string,
  logicalPaths: readonly string[],
): Promise<McpOperationSource[]> {
  const frozen: McpOperationSource[] = [];
  for (const logicalPath of logicalPaths) {
    let resolved;
    try {
      resolved = await resolvePlanningPath(project, logicalPath, {
        shapes: TASK_GRAPH_MARKDOWN_SHAPES,
        require: 'file',
      });
    } catch {
      throw invalidArgument(
        `The source document ${JSON.stringify(logicalPath)} is not readable through this project's published documents, so it cannot be frozen as evidence.`,
      );
    }
    let content: string;
    try {
      content = await readFile(resolved.absolutePath, 'utf8');
    } catch {
      throw invalidArgument(
        `The source document ${JSON.stringify(logicalPath)} could not be read while freezing evidence.`,
      );
    }
    const sourceId = encodeSourceId(logicalPath);
    await writeMcpOperationSource(project, operationId, sourceId, content);
    frozen.push({
      sourceId,
      logicalPath,
      sha256: sha256Hex(content),
      byteLength: Buffer.byteLength(content, 'utf8'),
    });
  }
  return frozen;
}

export type PreparedProductExploration = {
  record: McpOperationRecord;
  basis: ProductExplorationMaterializationBasis;
};

export async function prepareProductExplorationOperation(
  project: RegisteredProject,
  request: ProductExplorationPrepareRequest,
  clientInfo: { name: string; version: string } | null = null,
): Promise<PreparedProductExploration> {
  const userInput = assertUserInput(request.userInput);
  const layer = assertLayer(request.layer);
  const intention = resolveIntention(layer, request.intention);
  const motion = resolveMotion(request.motion);

  const nodes = await listTaskGraphNodes(
    project,
    PRODUCT_EXPLORATION_GRAPH_ROOT,
  );
  const knownNodeIds = nodes.map((node) => node.id);
  const sourceNodeIds = request.sourceNodeIds ?? [];
  for (const id of sourceNodeIds)
    if (!knownNodeIds.includes(id))
      throw invalidArgument(
        `request.sourceNodeIds contains ${JSON.stringify(id)}, which is not a node in this project's Product Exploration graph.`,
      );
  if (intention === 'product-design-completion' && sourceNodeIds.length !== 1)
    throw invalidArgument(
      'request.sourceNodeIds must name exactly one Product Source for product-design-completion.',
    );

  const basis = await assembleProductExplorationBasis(project, {
    intention,
    motion,
    sourceNodeIds,
  });

  const operationId = newMcpOperationId();
  const userInputPath = await writeMcpOperationUserInput(
    project,
    operationId,
    userInput,
  );
  const basisPath = await writeMcpOperationBasis(project, operationId, basis);
  const sources = await freezeSources(
    project,
    operationId,
    basis.knownResourcePaths,
  );
  const definition = MCP_MODULE_DEFINITIONS['product-exploration'];
  const record: McpOperationRecord = {
    schemaVersion: 1,
    operationId,
    projectId: project.id,
    module: 'product-exploration',
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
      layer,
      intention,
      motion,
      operation: 'explore',
      sourceNodeIds,
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

export function preparedOperationProjection(record: McpOperationRecord) {
  const definition = MCP_MODULE_DEFINITIONS[record.module];
  return {
    operationId: record.operationId,
    status: record.status,
    projectId: record.projectId,
    module: record.module,
    contract: record.contract,
    basis: record.basis,
    request: record.request,
    context: {
      summary: `${record.sources.length} frozen source document${record.sources.length === 1 ? '' : 's'}; the User Input is stored as submitted evidence.`,
      resources: record.sources.map((source) => ({
        logicalPath: source.logicalPath,
        sha256: source.sha256,
        byteLength: source.byteLength,
        uri: operationSourceUri(
          record.projectId,
          record.operationId,
          source.sourceId,
        ),
      })),
    },
    contractUri: contractUri(record.contract.id, record.contract.version),
    moduleUri: moduleUri(record.projectId, record.module),
    operationUri: `praxis://projects/${record.projectId}/operations/${record.operationId}`,
    submitTool: definition.submissionTool,
  };
}
