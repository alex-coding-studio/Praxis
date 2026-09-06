import { canonicalJson, sha256Hex } from '../materialization/hash.ts';
import {
  activeRunRegistryOwnership,
  getActiveRun,
  type ActiveRunReservation,
} from '../execution-observability/active-runs.ts';
import { readLatestResponse } from '../execution-observability/latest-response-store.ts';
import {
  ownerLogUrlPath,
  type ResponseOwner,
} from '../execution-observability/types.ts';
import { listTaskGraphNodes, type TaskGraphNode } from '../graph/task/nodes.ts';
import { readDomainModelView } from '../modules/domain-modeling/model.ts';
import { readWhatToDoCurrentMapWithFingerprint } from '../modules/delivery-planning/storage.ts';
import {
  isAcceptedPlanningShape,
  TASK_GRAPH_MARKDOWN_SHAPES,
} from '../planning-paths.ts';
import { getProject, listProjects } from '../project-registry.ts';
import type { RegisteredProject } from '../project-registry.ts';
import { encodeArtifactId, readProjectArtifact } from './artifacts.ts';
import {
  contractMismatch,
  projectNotFound,
  resourceNotFound,
} from './errors.ts';
import {
  boundedLimit,
  DEFAULT_LIST_LIMIT,
  DEFAULT_LOG_LINES,
  DEFAULT_READ_BYTES,
  MAX_LIST_LIMIT,
  MAX_LOG_LINES,
  MAX_READ_BYTES,
  pageContent,
  pageList,
} from './pagination.ts';
import {
  MCP_MODULES,
  MCP_MODULE_DEFINITIONS,
  mcpModuleForContract,
  type McpModule,
} from './modules.ts';
import {
  artifactUri,
  capabilitiesUri,
  contractUri,
  latestResponseUri,
  moduleUri,
  operationLogUri,
  operationUri,
  parseMcpUri,
  projectsUri,
} from './uri.ts';
import { requireMcpOperation, type McpOperationRecord } from './operations.ts';
import { readRunLogTail } from '../execution-observability/run-log.ts';
import path from 'node:path';

export const MCP_API_VERSION = 1;
export const MCP_SERVER_NAME = 'praxis';
export const MCP_JSON_MEDIA_TYPE = 'application/json';

export const MCP_IMPLEMENTED_TOOLS = [
  'praxis_list_projects',
  'praxis_read_resource',
  'praxis_prepare',
  'praxis_submit_product_exploration',
  'praxis_get_operation',
  'praxis_read_log',
] as const;

export type McpResourceContent = {
  uri: string;
  mimeType: string;
  text: string;
  revision: string;
  byteOffset: number;
  byteLength: number;
  totalBytes: number;
  nextCursor: string | null;
};

export type McpReadOptions = {
  cursor?: string | undefined;
  limit?: number | undefined;
  limitBytes?: number | undefined;
};

function jsonDocument(uri: string, value: unknown, options: McpReadOptions) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const revision = sha256Hex(text);
  const limitBytes = boundedLimit(
    options.limitBytes,
    DEFAULT_READ_BYTES,
    MAX_READ_BYTES,
  );
  const page = pageContent(text, revision, options.cursor, limitBytes);
  return { uri, mimeType: MCP_JSON_MEDIA_TYPE, revision, ...page };
}

export function readCapabilities(options: McpReadOptions = {}) {
  const value = {
    apiVersion: MCP_API_VERSION,
    server: MCP_SERVER_NAME,
    protocolBaseline: '2025-11-25',
    release: 'product-exploration-submission',
    host: { activeRunRegistry: activeRunRegistryOwnership() },
    tools: MCP_IMPLEMENTED_TOOLS,
    resources: {
      capabilities: capabilitiesUri(),
      projects: projectsUri(),
      moduleTemplate: 'praxis://projects/{projectId}/modules/{module}',
      latestResponseTemplate:
        'praxis://projects/{projectId}/modules/{module}/latest-response',
      artifactTemplate: 'praxis://projects/{projectId}/artifacts/{artifactId}',
      operationTemplate:
        'praxis://projects/{projectId}/operations/{operationId}',
      operationLogTemplate:
        'praxis://projects/{projectId}/operations/{operationId}/log',
      contractTemplate: 'praxis://contracts/{contractId}/{version}',
    },
    limits: {
      logLinesDefault: DEFAULT_LOG_LINES,
      logLinesMax: MAX_LOG_LINES,
      listDefault: DEFAULT_LIST_LIMIT,
      listMax: MAX_LIST_LIMIT,
      readBytesDefault: DEFAULT_READ_BYTES,
      readBytesMax: MAX_READ_BYTES,
    },
    modules: MCP_MODULES.map((module) => {
      const definition = MCP_MODULE_DEFINITIONS[module];
      return {
        module,
        responseOwner: definition.responseOwner,
        layers: definition.layers,
        implementationPath: definition.implementationPath,
        contract: {
          id: definition.contract.id,
          version: definition.contract.version,
          hash: definition.contract.hash,
          uri: contractUri(definition.contract.id, definition.contract.version),
        },
        preparationOperations:
          module === 'product-exploration' ? ['explore'] : [],
        submissionTool:
          module === 'product-exploration' ? definition.submissionTool : null,
        plannedPreparationOperations: definition.preparationOperations,
        plannedSubmissionTool: definition.submissionTool,
      };
    }),
  };
  return jsonDocument(capabilitiesUri(), value, options);
}

function projectSummary(project: RegisteredProject) {
  return {
    id: project.id,
    name: project.name,
    kind: project.kind,
    description: project.description,
    createdAt: project.createdAt,
    modules: MCP_MODULES.map((module) => ({
      module,
      uri: moduleUri(project.id, module),
    })),
  };
}

export async function readProjects(options: McpReadOptions = {}) {
  const limit = boundedLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const projects = (await listProjects()).map(projectSummary);
  const paged = pageList(projects, options.cursor, limit);
  const text = `${JSON.stringify(
    {
      projects: paged.page,
      total: paged.total,
      nextCursor: paged.nextCursor,
    },
    null,
    2,
  )}\n`;
  return {
    uri: projectsUri(),
    mimeType: MCP_JSON_MEDIA_TYPE,
    text,
    revision: sha256Hex(text),
    byteOffset: 0,
    byteLength: Buffer.byteLength(text, 'utf8'),
    totalBytes: Buffer.byteLength(text, 'utf8'),
    nextCursor: paged.nextCursor,
  } satisfies McpResourceContent;
}

export async function requireProject(projectId: string) {
  const project = await getProject(projectId);
  if (!project) throw projectNotFound(projectId);
  return project;
}

function moduleOwner(
  project: RegisteredProject,
  module: McpModule,
): ResponseOwner {
  return {
    kind: 'module',
    projectId: project.id,
    planningPath: project.planningPath,
    module: MCP_MODULE_DEFINITIONS[module].responseOwner,
  };
}

function activeOperationSummary(
  owner: ResponseOwner,
  reservation: ActiveRunReservation | null,
) {
  if (!reservation) return null;
  return {
    runId: reservation.runId,
    status: 'running' as const,
    phase: reservation.phase,
    actor: reservation.actor,
    startedAt: reservation.startedAt,
    hostPid: reservation.hostPid,
    layer: reservation.layer ?? null,
    logUrlPath: ownerLogUrlPath(owner, reservation.runId),
  };
}

function artifactLink(
  project: RegisteredProject,
  kind: string,
  relativePath: string,
) {
  if (!isAcceptedPlanningShape(relativePath, TASK_GRAPH_MARKDOWN_SHAPES))
    return null;
  return {
    kind,
    relativePath,
    uri: artifactUri(project.id, encodeArtifactId(relativePath)),
  };
}

function nodeArtifacts(project: RegisteredProject, node: TaskGraphNode) {
  return node.resources
    .map((resource) => artifactLink(project, resource.kind, resource.path))
    .filter((link) => link !== null);
}

function graphEntities(project: RegisteredProject, nodes: TaskGraphNode[]) {
  return nodes.map((node) => ({
    id: node.id,
    role: node.role,
    type: node.type,
    title: node.title,
    status: node.status,
    layer: node.layer ?? null,
    artifactKind: node.artifactKind ?? null,
    dependsOn: node.dependsOn,
    derivedFrom: node.derivedFrom ?? [],
    updatedAt: node.updatedAt,
    artifacts: nodeArtifacts(project, node),
  }));
}

async function moduleEntities(project: RegisteredProject, module: McpModule) {
  if (module === 'product-exploration')
    return {
      kind: 'graph-nodes' as const,
      entities: graphEntities(
        project,
        await listTaskGraphNodes(project, 'whats-next'),
      ),
    };
  if (module === 'scope-decomposition')
    return {
      kind: 'graph-nodes' as const,
      entities: graphEntities(
        project,
        await listTaskGraphNodes(project, 'task-graph'),
      ),
    };
  if (module === 'domain-modeling') {
    const view = await readDomainModelView(project);
    return {
      kind: 'domain-model' as const,
      stateVersion: view.model.stateVersion,
      lastRunId: view.model.lastRunId,
      updatedAt: view.model.updatedAt,
      entities: view.model.entities.map((entity) => ({
        id: entity.id,
        name: entity.name,
        provenance: entity.provenance,
        fields: entity.fields.map((field) => field.name),
      })),
      relationships: view.model.relationships.map((relationship) => ({
        id: relationship.id,
        sourceEntityId: relationship.sourceEntityId,
        targetEntityId: relationship.targetEntityId,
        label: relationship.label,
        semanticRole: relationship.semanticRole,
      })),
      constraints: view.model.constraints.map((constraint) => ({
        id: constraint.id,
        target: constraint.target,
        text: constraint.text,
      })),
      artifacts: [
        view.model.lastRunId
          ? artifactLink(
              project,
              'domain-model-summary',
              `domain-model/runs/${view.model.lastRunId}/summary.md`,
            )
          : null,
      ].filter((link) => link !== null),
    };
  }
  const { map, fingerprint } =
    await readWhatToDoCurrentMapWithFingerprint(project);
  return {
    kind: 'delivery-map' as const,
    mapFingerprint: fingerprint,
    runId: map?.runId ?? null,
    contracts: (map?.contracts ?? []).map((contract) => ({
      id: contract.id,
      uid: contract.uid,
      title: contract.title,
      outcome: contract.outcome,
      dependsOn: contract.dependsOn,
      derivedFrom: contract.relations.derivedFrom,
      artifacts: [
        artifactLink(project, 'delivery-contract-output', contract.outputPath),
      ].filter((link) => link !== null),
    })),
  };
}

export async function readModuleState(
  projectId: string,
  module: McpModule,
  options: McpReadOptions = {},
) {
  const project = await requireProject(projectId);
  const definition = MCP_MODULE_DEFINITIONS[module];
  const owner = moduleOwner(project, module);
  const state = await moduleEntities(project, module);
  const latest = await readLatestResponse(owner);
  const value = {
    projectId: project.id,
    module,
    responseOwner: definition.responseOwner,
    layers: definition.layers,
    contract: {
      id: definition.contract.id,
      version: definition.contract.version,
      hash: definition.contract.hash,
      uri: contractUri(definition.contract.id, definition.contract.version),
    },
    revision: sha256Hex(canonicalJson(state)),
    state,
    activeOperation: activeOperationSummary(owner, getActiveRun(owner)),
    latestResponse: latest
      ? {
          runId: latest.runId,
          status: latest.status,
          updatedAt: latest.updatedAt,
          uri: latestResponseUri(project.id, module),
        }
      : null,
    latestResponseUri: latestResponseUri(project.id, module),
  };
  return jsonDocument(moduleUri(project.id, module), value, options);
}

export async function readLatestResponseProjection(
  projectId: string,
  module: McpModule,
  options: McpReadOptions = {},
) {
  const project = await requireProject(projectId);
  const owner = moduleOwner(project, module);
  const document = await readLatestResponse(owner);
  return jsonDocument(
    latestResponseUri(project.id, module),
    document === null
      ? { projectId: project.id, module, latestResponse: null }
      : { projectId: project.id, module, latestResponse: document },
    options,
  );
}

export function readContract(
  contractId: string,
  version: number,
  options: McpReadOptions = {},
) {
  const definition = mcpModuleForContract(contractId);
  if (!definition)
    throw resourceNotFound(
      `No Praxis Result Contract has the id ${JSON.stringify(contractId)}. Read praxis://capabilities for the contracts this release serves.`,
    );
  if (definition.contract.version !== version)
    throw contractMismatch(
      `${contractId} is at version ${definition.contract.version}; ${version} is not served. Read the contract at ${contractUri(contractId, definition.contract.version)}.`,
    );
  return jsonDocument(
    contractUri(contractId, version),
    {
      module: definition.module,
      id: definition.contract.id,
      version: definition.contract.version,
      hash: definition.contract.hash,
      compatibleOperations: definition.preparationOperations,
      schema: definition.contract.schema,
      example: definition.example,
    },
    options,
  );
}

export async function readArtifact(
  projectId: string,
  artifactId: string,
  options: McpReadOptions = {},
) {
  const project = await requireProject(projectId);
  const document = await readProjectArtifact(project, artifactId);
  const limitBytes = boundedLimit(
    options.limitBytes,
    DEFAULT_READ_BYTES,
    MAX_READ_BYTES,
  );
  const page = pageContent(
    document.content,
    document.revision,
    options.cursor,
    limitBytes,
  );
  return {
    uri: artifactUri(project.id, artifactId),
    mimeType: document.mimeType,
    revision: document.revision,
    ...page,
  } satisfies McpResourceContent;
}

export function operationProjection(record: McpOperationRecord) {
  return {
    operationId: record.operationId,
    projectId: record.projectId,
    module: record.module,
    status: record.status,
    contract: record.contract,
    basis: record.basis,
    runId: record.runId,
    request: record.request,
    preparedAt: record.preparedAt,
    admittedAt: record.admittedAt,
    settledAt: record.settledAt,
    semanticResultHash: record.semanticResultHash,
    outcome: record.outcome,
    receipt: record.receipt,
    error: record.error,
    retryAction: record.error?.retryAction ?? null,
    logUri: record.logRef
      ? operationLogUri(record.projectId, record.operationId)
      : null,
    logUrlPath: record.logUrlPath,
    operationUri: operationUri(record.projectId, record.operationId),
    moduleUri: moduleUri(record.projectId, record.module),
  };
}

export async function readOperationResource(
  projectId: string,
  operationId: string,
  options: McpReadOptions = {},
) {
  const project = await requireProject(projectId);
  const record = await requireMcpOperation(project, operationId);
  return jsonDocument(
    operationUri(project.id, operationId),
    operationProjection(record),
    options,
  );
}

export async function readOperationLog(
  projectId: string,
  operationId: string,
  options: McpReadOptions = {},
) {
  const project = await requireProject(projectId);
  const record = await requireMcpOperation(project, operationId);
  const uri = operationLogUri(project.id, operationId);
  if (!record.logRef)
    return {
      uri,
      mimeType: 'text/plain',
      text: '',
      revision: 'empty',
      byteOffset: 0,
      byteLength: 0,
      totalBytes: 0,
      nextCursor: null,
    } satisfies McpResourceContent;
  const file = path.join(project.planningPath, record.logRef);
  const limitBytes = boundedLimit(
    options.limitBytes,
    DEFAULT_READ_BYTES,
    MAX_READ_BYTES,
  );
  const slice = await readRunLogTail(file, 0, limitBytes);
  const text = slice.text;
  const revision = sha256Hex(text);
  const page = pageContent(text, revision, options.cursor, limitBytes);
  return {
    uri,
    mimeType: 'text/plain',
    revision,
    ...page,
  } satisfies McpResourceContent;
}

export async function resolveMcpResource(
  uri: string,
  options: McpReadOptions = {},
): Promise<McpResourceContent> {
  const reference = parseMcpUri(uri);
  if (reference.kind === 'capabilities') return readCapabilities(options);
  if (reference.kind === 'projects') return readProjects(options);
  if (reference.kind === 'contract')
    return readContract(reference.contractId, reference.version, options);
  if (reference.kind === 'module')
    return readModuleState(reference.projectId, reference.module, options);
  if (reference.kind === 'latest-response')
    return readLatestResponseProjection(
      reference.projectId,
      reference.module,
      options,
    );
  if (reference.kind === 'operation')
    return readOperationResource(
      reference.projectId,
      reference.operationId,
      options,
    );
  if (reference.kind === 'operation-log')
    return readOperationLog(
      reference.projectId,
      reference.operationId,
      options,
    );
  return readArtifact(reference.projectId, reference.artifactId, options);
}
