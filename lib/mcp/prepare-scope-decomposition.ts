import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sha256Hex } from '../materialization/hash.ts';
import {
  collectAcceptedCandidateIds,
  collectLatestUnacceptedCandidateStates,
  collectReservedCandidateIds,
  findRevisionTarget,
  SCOPE_DECOMPOSITION_GRAPH_ROOT,
} from '../modules/scope-decomposition/assembly.ts';
import {
  prepareScopeDecompositionMaterializationBasis,
  type ScopeDecompositionMaterializationBasis,
  type ScopeDecompositionOperation,
} from '../modules/scope-decomposition/basis.ts';
import { taskDecompositionIntentionRegistry } from '../modules/scope-decomposition/intention.ts';
import { taskDecompositionMotionRegistry } from '../modules/scope-decomposition/motion.ts';
import { listTaskGraphNodes } from '../graph/task/nodes.ts';
import {
  resolvePlanningPath,
  TASK_GRAPH_MARKDOWN_SHAPES,
} from '../planning-paths.ts';
import type { RegisteredProject } from '../project-registry.ts';
import { invalidArgument } from './errors.ts';
import { MCP_MODULE_DEFINITIONS } from './modules.ts';
import {
  encodeSourceId,
  newMcpOperationId,
  writeMcpOperation,
  writeMcpOperationBasis,
  writeMcpOperationSource,
  writeMcpOperationUserInput,
  type McpOperationRecord,
  type McpOperationSource,
} from './operations.ts';
import { MAX_USER_INPUT_LENGTH } from './prepare.ts';

export const SCOPE_DECOMPOSITION_OPERATIONS = [
  'propose',
  'append-candidates',
  'revise-candidate',
  'recompose-candidates',
] as const;

export const SCOPE_DECOMPOSITION_INTENTIONS =
  taskDecompositionIntentionRegistry.profiles.map((profile) => profile.id);
export const SCOPE_DECOMPOSITION_MOTIONS =
  taskDecompositionMotionRegistry.profiles.map((profile) => profile.id);

export type ScopeDecompositionPrepareRequest = {
  userInput: string;
  sourceNodeId: string;
  operation?: ScopeDecompositionOperation;
  candidateIds?: string[];
  intention?: string;
  motion?: string;
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

function assertOperation(value: unknown): ScopeDecompositionOperation {
  if (value === undefined || value === null) return 'propose';
  if (!(SCOPE_DECOMPOSITION_OPERATIONS as readonly unknown[]).includes(value))
    throw invalidArgument(
      `request.operation must be one of ${SCOPE_DECOMPOSITION_OPERATIONS.join(', ')}.`,
    );
  return value as ScopeDecompositionOperation;
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

export async function assembleScopeDecompositionBasis(
  project: RegisteredProject,
  request: {
    operation: ScopeDecompositionOperation;
    intention: string;
    motion: string;
    candidateIds: string[];
    revisionTarget: {
      candidateId: string;
      revision: number;
      uid: string;
    } | null;
  },
  preparedAt?: string,
): Promise<ScopeDecompositionMaterializationBasis> {
  const nodes = await listTaskGraphNodes(
    project,
    SCOPE_DECOMPOSITION_GRAPH_ROOT,
  );
  const subject = {
    intention: request.intention as never,
    motion: request.motion as never,
    knownNodeIds: nodes.map((node) => node.id),
    acceptedCandidateIds: await collectAcceptedCandidateIds(project),
    knownResourcePaths: [
      ...new Set(
        nodes.flatMap((node) =>
          node.resources.map((resource) => resource.path),
        ),
      ),
    ],
    reservedCandidateIds:
      request.operation === 'revise-candidate'
        ? []
        : await collectReservedCandidateIds(project),
    currentCandidates: await collectLatestUnacceptedCandidateStates(project),
  };
  const now = preparedAt ? () => preparedAt : undefined;
  if (request.operation === 'revise-candidate') {
    if (!request.revisionTarget)
      throw invalidArgument(
        'A revise-candidate operation must resolve the Candidate it revises.',
      );
    return prepareScopeDecompositionMaterializationBasis(
      project,
      {
        ...subject,
        operation: 'revise-candidate',
        revisionTarget: request.revisionTarget,
      },
      now,
    );
  }
  if (request.operation === 'recompose-candidates')
    return prepareScopeDecompositionMaterializationBasis(
      project,
      {
        ...subject,
        operation: 'recompose-candidates',
        recomposeCandidateIds: request.candidateIds,
      },
      now,
    );
  return prepareScopeDecompositionMaterializationBasis(
    project,
    { ...subject, operation: request.operation },
    now,
  );
}

export async function prepareScopeDecompositionOperation(
  project: RegisteredProject,
  request: ScopeDecompositionPrepareRequest,
  clientInfo: { name: string; version: string } | null = null,
) {
  const userInput = assertUserInput(request.userInput);
  const operation = assertOperation(request.operation);
  const intention =
    request.intention ?? taskDecompositionIntentionRegistry.defaultId;
  const motion = request.motion ?? taskDecompositionMotionRegistry.defaultId;
  if (!SCOPE_DECOMPOSITION_INTENTIONS.includes(intention as never))
    throw invalidArgument(
      `request.intention must be one of ${SCOPE_DECOMPOSITION_INTENTIONS.join(', ')}.`,
    );
  if (!SCOPE_DECOMPOSITION_MOTIONS.includes(motion as never))
    throw invalidArgument(
      `request.motion must be one of ${SCOPE_DECOMPOSITION_MOTIONS.join(', ')}.`,
    );

  const nodes = await listTaskGraphNodes(
    project,
    SCOPE_DECOMPOSITION_GRAPH_ROOT,
  );
  if (!nodes.some((node) => node.id === request.sourceNodeId))
    throw invalidArgument(
      `request.sourceNodeId ${JSON.stringify(request.sourceNodeId)} is not a node in this project's Scope Decomposition graph.`,
    );

  const candidateIds = request.candidateIds ?? [];
  const available = await collectLatestUnacceptedCandidateStates(project);
  const availableIds = new Set(available.map((entry) => entry.candidateId));
  for (const candidateId of candidateIds)
    if (!availableIds.has(candidateId))
      throw invalidArgument(
        `request.candidateIds contains ${JSON.stringify(candidateId)}, which is not an open Candidate in this module. Read the module resource for the current Candidates.`,
      );

  let revisionTarget = null;
  if (operation === 'revise-candidate') {
    if (candidateIds.length !== 1)
      throw invalidArgument(
        'A revise-candidate operation names exactly one Candidate in request.candidateIds.',
      );
    revisionTarget = await findRevisionTarget(
      project,
      candidateIds[0] as string,
    );
    if (!revisionTarget)
      throw invalidArgument(
        `Candidate ${JSON.stringify(candidateIds[0])} has no stable identity to revise.`,
      );
  }
  if (operation === 'recompose-candidates' && candidateIds.length === 0)
    throw invalidArgument(
      'A recompose-candidates operation names the Candidates it recomposes in request.candidateIds.',
    );

  const basis = await assembleScopeDecompositionBasis(project, {
    operation,
    intention,
    motion,
    candidateIds,
    revisionTarget,
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
  const definition = MCP_MODULE_DEFINITIONS['scope-decomposition'];
  const record: McpOperationRecord = {
    schemaVersion: 1,
    operationId,
    projectId: project.id,
    module: 'scope-decomposition',
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
      operation,
      intention,
      motion,
      sourceNodeId: request.sourceNodeId,
      candidateIds,
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
