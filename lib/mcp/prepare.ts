import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../materialization/hash.ts';
import {
  collectLatestUnacceptedCandidateStates,
  collectReservedCandidateIds,
  collectAcceptedCandidateIds,
  PRODUCT_EXPLORATION_GRAPH_ROOT,
} from '../modules/product-discovery/assembly.ts';
import {
  prepareProductExplorationMaterializationBasis,
  type ProductExplorationMaterializationBasis,
  type ProductExplorationOperation,
} from '../modules/product-discovery/basis.ts';
import { findPendingProductExplorationCandidate } from '../modules/product-discovery/acceptance.ts';
import { toProductExplorationCandidate } from '../modules/product-discovery/producer-adapter.ts';
import type { ProductExplorationCandidateInput } from '../modules/product-discovery/contract.ts';
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
import { freezeLogicalSources } from './evidence.ts';
import { MCP_MODULE_DEFINITIONS } from './modules.ts';
import {
  newMcpOperationId,
  writeMcpOperation,
  writeMcpOperationBasis,
  writeMcpOperationUserInput,
  type McpOperationRecord,
} from './operations.ts';
import { contractUri, moduleUri, operationSourceUri } from './uri.ts';

export const MAX_USER_INPUT_LENGTH = 20_000;

export const PRODUCT_EXPLORATION_OPERATIONS = [
  'explore',
  'refine-candidate',
] as const satisfies readonly ProductExplorationOperation[];

export type ProductExplorationPrepareRequest = {
  userInput: string;
  layer: WhatsNextLayer;
  intention?: WhatsNextIntention;
  motion?: WhatsNextMotion;
  sourceNodeIds?: string[];
  operation?: ProductExplorationOperation;
  candidateIds?: string[];
};

export function assertUserInput(value: unknown): string {
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

function assertProductExplorationOperation(
  supplied: unknown,
): ProductExplorationOperation {
  if (supplied === undefined || supplied === null) return 'explore';
  if (
    !(PRODUCT_EXPLORATION_OPERATIONS as readonly unknown[]).includes(supplied)
  )
    throw invalidArgument(
      `request.operation must be one of ${PRODUCT_EXPLORATION_OPERATIONS.join(', ')} for product-exploration.`,
    );
  return supplied as ProductExplorationOperation;
}

function assertSingleRefineTarget(supplied: string[] | undefined) {
  const candidateIds = supplied ?? [];
  if (candidateIds.length !== 1)
    throw invalidArgument(
      'A refine-candidate operation names exactly one open Candidate in request.candidateIds.',
    );
  return candidateIds[0] as string;
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
  operation: ProductExplorationOperation;
  sourceNodeIds: string[];
  revisionCandidateId: string | null;
  userInputSha256: string;
};

export async function resolveProductExplorationRefineTarget(
  project: RegisteredProject,
  candidateId: string,
) {
  const pending = await findPendingProductExplorationCandidate(
    project,
    candidateId,
  );
  if (!pending)
    throw invalidArgument(
      `Candidate ${JSON.stringify(candidateId)} is not an open Product Exploration Candidate in this project. Read pendingCandidates in the module resource; an accepted Candidate is a formal Node and is not refined here.`,
    );
  const candidate = pending.candidate;
  if (!candidate.uid)
    throw invalidArgument(
      `Candidate ${JSON.stringify(candidateId)} has no stable identity to revise.`,
    );
  return {
    runId: pending.runId,
    revisionTarget: {
      candidateId,
      revision: typeof candidate.revision === 'number' ? candidate.revision : 1,
      uid: candidate.uid,
    },
    revisionSource: toProductExplorationCandidate(
      candidate as unknown as ProductExplorationCandidateInput,
      new Set<string>(),
    ),
  };
}

export async function assembleProductExplorationBasis(
  project: RegisteredProject,
  request: Pick<
    ProductExplorationPreparedRequest,
    'intention' | 'motion' | 'sourceNodeIds'
  > &
    Partial<Pick<ProductExplorationPreparedRequest, 'operation'>> & {
      revisionCandidateId?: string | null;
    },
  preparedAt?: string,
) {
  const nodes = await listTaskGraphNodes(
    project,
    PRODUCT_EXPLORATION_GRAPH_ROOT,
  );
  const operation = request.operation ?? 'explore';
  const refining = operation === 'refine-candidate';
  const subject = {
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
    reservedCandidateIds: refining
      ? []
      : await collectReservedCandidateIds(project),
    currentCandidates: await collectLatestUnacceptedCandidateStates(project),
  };
  const now = preparedAt ? () => preparedAt : undefined;
  if (!refining)
    return prepareProductExplorationMaterializationBasis(
      project,
      { ...subject, operation: 'explore' },
      now,
    );
  const target = await resolveProductExplorationRefineTarget(
    project,
    request.revisionCandidateId as string,
  );
  return prepareProductExplorationMaterializationBasis(
    project,
    {
      ...subject,
      operation: 'refine-candidate',
      revisionTarget: target.revisionTarget,
      revisionSource: target.revisionSource,
    },
    now,
  );
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
  const operation = assertProductExplorationOperation(request.operation);
  const revisionCandidateId =
    operation === 'refine-candidate'
      ? assertSingleRefineTarget(request.candidateIds)
      : null;
  if (operation === 'explore' && (request.candidateIds ?? []).length > 0)
    throw invalidArgument(
      'request.candidateIds is only read by the refine-candidate operation.',
    );

  const nodes = await listTaskGraphNodes(
    project,
    PRODUCT_EXPLORATION_GRAPH_ROOT,
  );
  const knownNodeIds = nodes.map((node) => node.id);
  const sourceNodeIds = request.sourceNodeIds ?? [];
  if (sourceNodeIds.length === 0)
    throw invalidArgument(
      nodes.length === 0
        ? 'This project has no Product Source. Call praxis_create_source with the full document first, then prepare with its sourceNodeId in sourceNodeIds.'
        : `Select sourceNodeIds from the module resource before preparing: ${nodes.map((node) => `${node.id} (${node.title})`).join(', ')}. Read its intention guidance; no source will be created implicitly.`,
    );
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
    operation,
    revisionCandidateId,
  });
  const revisionTarget = basis.revisionTarget
    ? {
        candidateId: basis.revisionTarget.candidateId,
        revision: basis.revisionTarget.revision,
        requiredRevision: basis.revisionTarget.revision + 1,
      }
    : null;

  const operationId = newMcpOperationId();
  const userInputPath = await writeMcpOperationUserInput(
    project,
    operationId,
    userInput,
  );
  const basisPath = await writeMcpOperationBasis(project, operationId, basis);
  const sources = await freezeLogicalSources(
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
      operation,
      sourceNodeIds,
      revisionCandidateId,
      revisionTarget,
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
    refine:
      record.request.operation === 'refine-candidate'
        ? {
            ...(record.request.revisionTarget as object),
            rules:
              'Return exactly this candidateId as localKey at requiredRevision, refining only its title, summary and outputMarkdown. Type, origins, dependencies, layer, artifact kind, Resources, type template, metadata and presentation must be returned unchanged.',
            nextStep:
              'Refinement republishes the Candidate; it does not accept it. Accept it separately with praxis_accept_candidate once the user decides to.',
          }
        : null,
    contractUri: contractUri(record.contract.id, record.contract.version),
    moduleUri: moduleUri(record.projectId, record.module),
    operationUri: `praxis://projects/${record.projectId}/operations/${record.operationId}`,
    submitTool: definition.submissionTool,
  };
}
