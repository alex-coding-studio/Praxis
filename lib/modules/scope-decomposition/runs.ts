import { PublicApiError } from '../../api-errors.ts';
import {
  resolveProductContextReferences,
  type ResolvedProductContextResource,
} from '../product-context/resource.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  validateAgentProfile,
  sameModelSelection,
  type AgentProfile,
} from '../../agents/profile.ts';
import { candidatePromptView } from '../../graph/identity.ts';
import {
  ensureGraphIdentities,
  readIdentifiedEntities,
  reserveNodeIdentity,
  reservedCandidateAliases,
} from '../../graph/identity-store.ts';
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import trash from 'trash';
import type { RegisteredProject } from '../../project-registry.ts';
import {
  isCurrentRun,
  settleRun,
  type ActiveRunReservation,
} from '../../execution-observability/active-runs.ts';
import {
  agentActivityEntry,
  beginModuleRun,
  classifyModuleRun,
  moduleRunFailureKind,
  stopModuleRun,
} from '../../execution-observability/module-run.ts';
import type { ResponseClassification } from '../../execution-observability/types.ts';
import {
  TASK_DECOMPOSITION_HARNESS_ID,
  TASK_DECOMPOSITION_HARNESS_REVISION,
  parseTaskDecompositionHarnessResult,
  type HarnessCandidate,
  type TaskDecompositionHarnessResult,
} from './harness.ts';
import {
  prepareScopeDecompositionMaterializationBasis,
  type ScopeDecompositionBasisInput,
} from './basis.ts';
import { MaterializationError } from '../../materialization/receipt.ts';
import { materializeScopeDecompositionResult } from './materializer.ts';
import { toScopeDecompositionSemanticResult } from './producer-adapter.ts';
import {
  buildTaskDecompositionContinuationPrompt,
  buildTaskDecompositionPrompt,
} from './prompt.ts';
import {
  readTaskDecompositionAttachment,
  readTaskDecompositionContext,
} from './context.ts';
import {
  primarySourceResourcePaths,
  relatedContextNodeIds,
  agentGraphContentPacket,
  assembleAgentGraphWorkspaceInputs,
  userInputWorkspaceInput,
  writeAgentGraphContextWorkspace,
  type ContextWorkspaceEntry,
  type ContextWorkspaceInput,
} from '../../graph/agent/context-workspace.ts';
import {
  candidateDependencyBlockers,
  resolveCandidateDependencies,
} from './dependencies.ts';
import {
  startLocalAgentRun,
  type LocalAgentKind,
  type LocalAgentRun,
  type LocalAgentUsage,
} from '../../agents/transport.ts';
import {
  agentGraphErrorMessage,
  createAgentGraphActivityRecorder,
  initialAgentGraphActivity,
  initializeAgentGraphActivity,
  writeAgentGraphRunEvidence,
  type AgentGraphActivity,
  type AgentGraphActivityRecorder,
} from '../../graph/agent/run.ts';
import {
  renderTaskDecompositionResponseMarkdown,
  renderTaskDecompositionSummaryMarkdown,
} from './response.ts';
import {
  listTaskGraphNodes,
  readTaskGraphMarkdownResource,
  type TaskGraphNode,
} from '../../graph/task/nodes.ts';
import {
  taskDecompositionIntentionRegistry,
  taskDecompositionIntentionProfile,
  type TaskDecompositionIntention,
} from './intention.ts';
import {
  taskDecompositionMotionProfile,
  type TaskDecompositionMotion,
} from './motion.ts';
import { successfulRecomposeOutputCandidateIds } from '../../graph/agent/recompose.ts';

export type TaskDecompositionRunStatus =
  | 'running'
  | 'validating'
  | 'proposal'
  | 'clarification'
  | 'insufficient-evidence'
  | 'no-change'
  | 'failed'
  | 'canceled';

export type TaskDecompositionRunTransport =
  | 'codex-cli'
  | 'claude-cli'
  | 'deepseek-cli';

const RUN_TRANSPORTS: Record<LocalAgentKind, TaskDecompositionRunTransport> = {
  codex: 'codex-cli',
  claude: 'claude-cli',
  deepseek: 'deepseek-cli',
};

export type TaskDecompositionRunRecord = {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  requestId: string;
  agentSessionId: string | null;
  agentSessionMode?: 'persistent';
  sourceNodeId: string;
  intention?: TaskDecompositionIntention;
  motion?: TaskDecompositionMotion;
  operation:
    | 'propose'
    | 'append-candidates'
    | 'revise-candidate'
    | 'recompose-candidates';
  recomposeCandidateIds?: string[];
  parentRunId?: string;
  revisionOf?: string;
  status: TaskDecompositionRunStatus;
  transport: TaskDecompositionRunTransport;
  profile?: AgentProfile;
  harness: {
    id: typeof TASK_DECOMPOSITION_HARNESS_ID;
    revision: typeof TASK_DECOMPOSITION_HARNESS_REVISION;
  };
  input?: {
    userInputPath: string | null;
    moduleInstructionsState?: 'present' | 'cleared';
    resourcePaths: string[];
    requestArtifact: 'request.json';
  };
  inputFingerprint: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  usage: LocalAgentUsage | null;
  sessionUsage?: LocalAgentUsage | null;
  activity: AgentGraphActivity[];
  result: TaskDecompositionHarnessResult | null;
  error: string | null;
  logRef?: string;
  hostPid?: number;
  cancelRequestedAt?: string;
  response?: ResponseClassification;
};

type RunRequest = {
  sourceNodeId: string;
  agent: LocalAgentKind;
  model?: AgentProfile['model'];
  effort?: AgentProfile['effort'];
  instruction: string;
  contextRefs: string[];
  files: File[];
  revisionRunId?: string;
  revisionCandidateId?: string;
  operation?: 'propose' | 'append-candidates';
  intention?: TaskDecompositionIntention;
  motion?: TaskDecompositionMotion;
  recomposeCandidateIds?: string[];
};

type ActiveRun = {
  record: TaskDecompositionRunRecord;
  agent: LocalAgentRun;
  activityRecorder: AgentGraphActivityRecorder;
  reservation: ActiveRunReservation | null;
};
const TASK_DECOMPOSITION_RETAINED = 'No Candidate or Formal Node was changed.';

const activeRuns = getActiveRuns();

export async function startTaskDecompositionRun(
  project: RegisteredProject,
  input: RunRequest,
  launch: typeof startLocalAgentRun = startLocalAgentRun,
) {
  return mutateTaskDecomposition(project, () =>
    startTaskDecompositionRunUnlocked(project, input, launch),
  );
}

async function startTaskDecompositionRunUnlocked(
  project: RegisteredProject,
  input: RunRequest,
  launch: typeof startLocalAgentRun,
) {
  validateRunRequest(input);
  const profile: AgentProfile = {
    agent: input.agent,
    model: input.model ?? '',
    effort: input.effort ?? '',
  };
  validateAgentProfile(profile);
  let intention: TaskDecompositionIntention;
  let motion: TaskDecompositionMotion;
  try {
    intention = taskDecompositionIntentionProfile(input.intention).id;
  } catch {
    throw new PublicApiError(
      'The Break It Down Intention Profile is invalid.',
      400,
    );
  }
  try {
    motion = taskDecompositionMotionProfile(input.motion).id;
  } catch {
    throw new PublicApiError('The Break It Down Motion is invalid.', 400);
  }
  const nodes = await listTaskGraphNodes(project);
  const sourceNode = nodes.find((node) => node.id === input.sourceNodeId);
  if (!sourceNode)
    throw new PublicApiError('The source Node could not be found.', 400);
  if (
    !input.instruction.trim() &&
    !sourceNode.resources.some(
      (resource) => resource.kind === 'user-input' || resource.kind === 'idea',
    )
  )
    throw new PublicApiError('A User Input is required.', 400);
  const revisionTarget = await resolveRevisionTarget(project, input);
  const recomposeWorkingSet = input.recomposeCandidateIds?.length
    ? await resolveRecomposeWorkingSet(
        project,
        sourceNode.id,
        input.recomposeCandidateIds,
      )
    : [];
  if (revisionTarget) {
    const revisionIntention = taskDecompositionIntentionProfile(
      revisionTarget.run.intention,
    ).id;
    if (input.intention !== undefined && intention !== revisionIntention) {
      throw new PublicApiError(
        'A Candidate revision must keep its original Intention Profile.',
        409,
      );
    }
    intention = revisionIntention;
    const revisionMotion = taskDecompositionMotionProfile(
      revisionTarget.run.motion,
    ).id;
    if (input.motion !== undefined && motion !== revisionMotion)
      throw new PublicApiError(
        'A Candidate revision must keep its original Motion.',
        409,
      );
    motion = revisionMotion;
  }
  const operation = revisionTarget
    ? 'revise-candidate'
    : recomposeWorkingSet.length
      ? 'recompose-candidates'
      : (input.operation ?? 'propose');
  const coordinatorCandidate =
    operation === 'propose'
      ? null
      : (revisionTarget?.run ??
        (await findLatestCoordinatorRun(project, sourceNode.id)));
  const transport = RUN_TRANSPORTS[input.agent];
  const coordinatorRun =
    coordinatorCandidate?.agentSessionMode === 'persistent' &&
    coordinatorCandidate.transport === transport &&
    coordinatorCandidate.harness.revision ===
      TASK_DECOMPOSITION_HARNESS_REVISION &&
    (coordinatorCandidate.intention ??
      taskDecompositionIntentionRegistry.defaultId) === intention &&
    (coordinatorCandidate.motion ?? 'unspecified') === motion &&
    sameModelSelection(coordinatorCandidate.profile, profile)
      ? coordinatorCandidate
      : null;
  const continuesExistingSession = Boolean(coordinatorRun?.agentSessionId);
  const existingCandidateChildren = await collectExistingCandidateChildren(
    project,
    sourceNode.id,
  );
  const reservedCandidateIds = await collectReservedCandidateIds(project);
  const formalChildren = nodes.filter((node) =>
    node.derivedFrom?.includes(sourceNode.id),
  );
  if (
    input.recomposeCandidateIds?.length &&
    (input.operation !== undefined ||
      input.revisionRunId !== undefined ||
      input.revisionCandidateId !== undefined)
  )
    throw new PublicApiError(
      'Recompose cannot be combined with append or single-Candidate revision.',
      400,
    );
  if ((input.recomposeCandidateIds?.length ?? 0) > 20)
    throw new PublicApiError('Recompose at most 20 Candidates at once.', 400);
  if (
    input.recomposeCandidateIds?.some(
      (candidateId) =>
        !/^CANDIDATE-(?:[0-9]{4,}|[0-9a-f]{8,32})$/.test(candidateId),
    )
  )
    throw new PublicApiError(
      'A Recompose Candidate identifier is invalid.',
      400,
    );

  const productContextResources = await resolveProductContextReferences(
    project,
    input.contextRefs,
    ['task-breakdown'],
  );
  const runId = `RUN-${randomUUID()}`;
  const sessionId = coordinatorRun?.sessionId ?? `SESSION-${randomUUID()}`;
  const requestId = `REQUEST-${randomUUID()}`;
  const runPath = taskDecompositionRunPath(project, runId);
  let record!: TaskDecompositionRunRecord;
  let prompt!: string;
  let resources!: ContextWorkspaceEntry[];
  let activity!: AgentGraphActivity[];
  const { reservation } = await beginModuleRun(project, 'task-decomposition', {
    runId,
    subject: { kind: 'node', label: sourceNode.title, id: sourceNode.id },
    agentProfile: profile,
    startMessage: `Scope Decomposition Run started for ${sourceNode.title} with ${input.agent}`,
    validate: async () => undefined,
    persist: async (reservation) => {
      const resourcesPath = path.join(runPath, 'resources');
      await mkdir(resourcesPath, { recursive: true });

      const uploadedResources = await saveUploadedResources(
        runId,
        resourcesPath,
        input.files,
      );
      const featureContext = await readTaskDecompositionContext(project);
      const recomposeContexts = await recomposeCandidateContexts(
        project,
        recomposeWorkingSet,
      );
      const contextInputs = await collectContextWorkspaceInputs(
        project,
        sourceNode,
        nodes,
        productContextResources,
        uploadedResources,
        featureContext.attachments.map((attachment) => attachment.fileName),
        revisionTarget
          ? {
              outputPath: `task-decomposition/runs/${revisionTarget.run.runId}/candidates/${revisionTarget.candidate.candidateId}/output.md`,
              resourcePaths: revisionTarget.candidate.resources.map(
                (resource) => resource.path,
              ),
            }
          : undefined,
        recomposeContexts,
      );
      const userInput = userInputWorkspaceInput(
        `task-decomposition/runs/${runId}/context/input/user-input.md`,
        input.instruction,
      );
      const moduleInstructions = featureContext.instructions.trim()
        ? {
            role: 'primary' as const,
            kind: 'module-instructions',
            logicalPath: 'task-decomposition/instructions.md',
            content: featureContext.instructions,
          }
        : null;
      const contextWorkspace = await writeAgentGraphContextWorkspace(
        runPath,
        assembleAgentGraphWorkspaceInputs(userInput, [
          ...(moduleInstructions ? [moduleInstructions] : []),
          ...contextInputs,
        ]),
      );
      const content = agentGraphContentPacket(contextWorkspace.manifest);
      resources = [
        ...contextWorkspace.manifest.primary,
        ...contextWorkspace.manifest.related,
      ];
      const requestIdentity = {
        sessionId,
        requestId,
        inputFingerprint: '',
      };
      const packetWithoutFingerprint = {
        request: requestIdentity,
        operation,
        intention,
        motion,
        content,
        moduleInstructionsState: moduleInstructions ? 'present' : 'cleared',
        graphMap: continuesExistingSession
          ? undefined
          : nodes.map(graphMapEntry),
        currentNode: continuesExistingSession ? undefined : sourceNode,
        contextWorkspace: {
          root: contextWorkspace.root,
          indexPath: contextWorkspace.indexPath,
        },
        revisionTarget: revisionTarget
          ? candidatePromptView(revisionTarget.candidate)
          : null,
        workingSet:
          operation === 'recompose-candidates'
            ? recomposeWorkingSet.map(candidatePromptView)
            : undefined,
        reservedCandidateIds: reservedCandidateIds.filter(
          (candidateId) =>
            candidateId !== revisionTarget?.candidate.candidateId,
        ),
        previousProposalAliases: coordinatorRun?.result?.candidateAliases ?? {},
        existingChildren:
          operation === 'append-candidates'
            ? continuesExistingSession
              ? [
                  ...formalChildren.map((node) => ({
                    id: node.id,
                    updatedAt: node.updatedAt,
                    acceptedFromCandidateId:
                      node.provenance?.candidateId ?? null,
                  })),
                  ...existingCandidateChildren.map((candidate) => ({
                    candidateId: candidate.candidateId,
                    revision: candidate.revision,
                  })),
                ]
              : [
                  ...formalChildren.map(graphMapEntry),
                  ...existingCandidateChildren,
                ]
            : undefined,
      };
      requestIdentity.inputFingerprint = createHash('sha256')
        .update(JSON.stringify(packetWithoutFingerprint))
        .digest('hex');
      prompt = continuesExistingSession
        ? buildTaskDecompositionContinuationPrompt(packetWithoutFingerprint)
        : buildTaskDecompositionPrompt(
            packetWithoutFingerprint,
            intention,
            motion,
          );
      const timestamp = new Date().toISOString();
      activity = initialAgentGraphActivity(
        'Decomposing the selected scope.',
        timestamp,
      );
      await writeFile(
        path.join(runPath, 'request.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            createdAt: timestamp,
            profile,
            packet: packetWithoutFingerprint,
            prompt,
          },
          null,
          2,
        )}\n`,
        { flag: 'wx' },
      );
      record = {
        schemaVersion: 1,
        runId,
        sessionId,
        requestId,
        agentSessionId: null,
        agentSessionMode: 'persistent',
        sourceNodeId: sourceNode.id,
        intention,
        motion,
        operation,
        recomposeCandidateIds:
          operation === 'recompose-candidates'
            ? recomposeWorkingSet.map((candidate) => candidate.candidateId)
            : undefined,
        parentRunId: coordinatorCandidate?.runId,
        revisionOf: revisionTarget?.candidate.candidateId,
        status: 'running',
        transport,
        profile,
        harness: {
          id: TASK_DECOMPOSITION_HARNESS_ID,
          revision: TASK_DECOMPOSITION_HARNESS_REVISION,
        },
        input: {
          userInputPath: content.input?.workspacePath ?? null,
          moduleInstructionsState: moduleInstructions ? 'present' : 'cleared',
          resourcePaths: resources.map((resource) => resource.logicalPath),
          requestArtifact: 'request.json',
        },
        inputFingerprint: requestIdentity.inputFingerprint,
        startedAt: timestamp,
        updatedAt: timestamp,
        endedAt: null,
        usage: null,
        sessionUsage: null,
        activity,
        result: null,
        error: null,
      };
      record.logRef = reservation.logRef;
      record.hostPid = process.pid;
      await writeRunRecord(project, record);
      await initializeAgentGraphActivity(runPath, activity);
      return async () => {
        await rm(runPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      };
    },
  });
  const activityRecorder = createAgentGraphActivityRecorder(
    runPath,
    activity,
    (item) => {
      record.updatedAt = item.at;
    },
  );
  const agent = launch(input.agent, {
    workingDirectory: runPath,
    prompt,
    resumeSessionId: coordinatorRun?.agentSessionId ?? undefined,
    sessionUsageBaseline:
      coordinatorRun?.sessionUsage ?? coordinatorRun?.usage ?? undefined,
    model: profile.model || undefined,
    effort: profile.effort || undefined,
    onActivity: (event) => {
      activityRecorder.onActivity(event);
      reservation.record(agentActivityEntry(event));
    },
  });
  reservation.attach(agent);
  activeRuns.set(runKey(project, runId), {
    record,
    agent,
    activityRecorder,
    reservation,
  });
  void finishTaskDecompositionRun(
    project,
    record,
    agent,
    reservation,
    nodes,
    resources,
    existingCandidateChildren,
    revisionTarget?.candidate,
    operation === 'revise-candidate' ? [] : reservedCandidateIds,
  );
  return record;
}

async function readAvailableProposalRun(
  project: RegisteredProject,
  runId: string,
) {
  const recordPath = path.join(
    taskDecompositionRunPath(project, runId),
    'run.json',
  );
  try {
    return await readTaskDecompositionRun(project, runId);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'ENOENT' && failure.path === recordPath)
      throw new PublicApiError('The Candidate proposal is unavailable.', 400);
    throw error;
  }
}

export async function readTaskDecompositionRun(
  project: RegisteredProject,
  runId: string,
) {
  validateRunId(runId);
  await ensureGraphIdentities(project.planningPath, 'task-graph');
  const record = JSON.parse(
    await readFile(
      path.join(taskDecompositionRunPath(project, runId), 'run.json'),
      'utf8',
    ),
  ) as TaskDecompositionRunRecord;
  record.operation ??= record.revisionOf ? 'revise-candidate' : 'propose';
  record.intention ??= taskDecompositionIntentionRegistry.defaultId;
  record.motion ??= 'unspecified';
  record.activity ??= [];
  if (record.result?.outcome === 'proposal') {
    record.result.candidates = await readIdentifiedEntities(
      project.planningPath,
      'task-graph',
      record.result.candidates,
    );
  }
  await ensureCandidateArtifacts(project, record);
  const active = activeRuns.get(runKey(project, runId));
  if (active)
    return {
      ...record,
      updatedAt: active.record.updatedAt,
      activity: [...active.record.activity],
    };
  return record;
}

export async function listLatestTaskDecompositionRuns(
  project: RegisteredProject,
) {
  const root = path.join(project.planningPath, 'task-decomposition', 'runs');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^RUN-/i.test(entry.name))
      .map((entry) =>
        readTaskDecompositionRun(project, entry.name).catch(() => null),
      ),
  );
  return records
    .filter((record): record is TaskDecompositionRunRecord => record !== null)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export async function cancelTaskDecompositionRun(
  project: RegisteredProject,
  runId: string,
) {
  const record = await readTaskDecompositionRun(project, runId);
  if (!['running', 'validating'].includes(record.status)) return record;

  const active = activeRuns.get(runKey(project, runId));
  const reservation = active?.reservation ?? null;
  const interruptedPhase = reservation?.phase ?? 'executing';
  const stop = reservation ? await stopModuleRun(reservation) : 'confirmed';
  if (!reservation) active?.agent.cancel();
  const classification = classifyModuleRun(
    stop === 'confirmed'
      ? {
          runState: 'canceled',
          interruptedPhase,
          interruptedActor: 'AGENT',
          retainedNote: TASK_DECOMPOSITION_RETAINED,
        }
      : { runState: 'termination-unconfirmed', interruptedActor: 'AGENT' },
  );
  const timestamp = new Date().toISOString();
  const canceledRecord = active?.record ?? record;
  canceledRecord.status = stop === 'confirmed' ? 'canceled' : 'failed';
  canceledRecord.updatedAt = timestamp;
  canceledRecord.endedAt = timestamp;
  canceledRecord.error = stop === 'confirmed' ? null : classification.detail;
  canceledRecord.response = classification;
  await active?.activityRecorder.flush();
  const document = `# ${classification.title}\n\n${classification.detail}\n`;
  await writeAgentGraphRunEvidence(taskDecompositionRunPath(project, runId), {
    activity: canceledRecord.activity,
    summary: document,
    response: document,
  });
  await writeRunRecord(project, canceledRecord);
  if (reservation) await settleRun(reservation, { classification });
  return canceledRecord;
}

export async function acceptTaskDecompositionCandidate(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
) {
  return mutateTaskDecomposition(project, () =>
    acceptTaskDecompositionCandidateUnlocked(project, runId, candidateId),
  );
}

async function acceptTaskDecompositionCandidateUnlocked(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
) {
  if (
    [...activeRuns.values()].some(
      (active) =>
        active.record.revisionOf === candidateId &&
        ['running', 'validating'].includes(active.record.status),
    )
  ) {
    throw new PublicApiError(
      'Wait for the active Candidate revision to finish.',
      400,
    );
  }
  const run = await readAvailableProposalRun(project, runId);
  if (run.result?.outcome !== 'proposal') {
    throw new PublicApiError('The Candidate proposal is unavailable.', 400);
  }
  const candidate = run.result.candidates.find(
    (value) => value.candidateId === candidateId,
  );
  if (!candidate)
    throw new PublicApiError('The Candidate could not be found.', 400);

  const existingNodes = await listTaskGraphNodes(project);
  const accepted = existingNodes.find((node) => node.uid === candidate.uid);
  if (accepted) return { node: accepted, nodes: existingNodes };
  if (
    !(await collectLatestUnacceptedCandidates(project)).some(
      (item) => item.candidateId === candidateId,
    )
  )
    throw new PublicApiError(
      'This Candidate was replaced or removed by Recompose.',
      409,
    );
  const resolvedDependencies = resolveCandidateDependencies(
    candidate.candidateId,
    candidate.dependsOn,
    existingNodes,
  );

  if (!candidate.uid) throw new Error('Candidate stable identity is missing.');
  const { id: nodeId } = await reserveNodeIdentity(
    project.planningPath,
    'task-graph',
    candidate.uid,
  );
  const nodesPath = path.join(project.planningPath, 'task-graph', 'nodes');
  const nodePath = path.join(nodesPath, nodeId);
  const temporaryPath = path.join(nodesPath, `.${nodeId}-${randomUUID()}.tmp`);
  const candidateOutput = path.join(
    taskDecompositionRunPath(project, runId),
    'candidates',
    candidateId,
    'output.md',
  );
  await mkdir(temporaryPath, { recursive: true });

  try {
    await copyFile(candidateOutput, path.join(temporaryPath, 'output.md'));
    const timestamp = new Date().toISOString();
    const matchingType = existingNodes.find(
      (node) => node.type === candidate.type,
    );
    const node: TaskGraphNode = {
      schemaVersion: 1,
      id: nodeId,
      uid: candidate.uid,
      relations: candidate.relations,
      role: 'node',
      type: candidate.type,
      title: candidate.title,
      summary: candidate.summary,
      status: 'accepted',
      createdAt: timestamp,
      updatedAt: timestamp,
      resources: [
        ...candidate.resources,
        {
          kind: 'output',
          path: `task-graph/nodes/${nodeId}/output.md`,
        },
      ],
      derivedFrom: candidate.derivedFrom,
      dependsOn: resolvedDependencies,
      typeTemplateRef:
        candidate.typeTemplateRef ??
        matchingType?.typeTemplateRef ??
        matchingType?.id ??
        nodeId,
      metadata: candidate.metadata,
      presentation: candidate.presentation,
      provenance: {
        runId,
        candidateId,
        revision: candidate.revision,
      },
    };
    await writeFile(
      path.join(temporaryPath, 'node.json'),
      `${JSON.stringify(node, null, 2)}\n`,
      { flag: 'wx' },
    );
    await mkdir(nodesPath, { recursive: true });
    await rename(temporaryPath, nodePath);
    return { node, nodes: await listTaskGraphNodes(project) };
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) =>
      rm(temporaryPath, { recursive: true, force: true }),
    );
    throw error;
  }
}

export async function discardTaskDecompositionCandidate(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
) {
  return mutateTaskDecomposition(project, () =>
    discardTaskDecompositionCandidateUnlocked(project, runId, candidateId),
  );
}

async function discardTaskDecompositionCandidateUnlocked(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
) {
  if (
    [...activeRuns.values()].some(
      (active) =>
        active.record.revisionOf === candidateId &&
        ['running', 'validating'].includes(active.record.status),
    )
  ) {
    throw new PublicApiError(
      'Cancel or finish the active Candidate revision first.',
      400,
    );
  }
  const requestedRun = await readAvailableProposalRun(project, runId);
  if (requestedRun.result?.outcome !== 'proposal') {
    throw new PublicApiError('The Candidate proposal is unavailable.', 400);
  }
  const requestedCandidate = requestedRun.result.candidates.find(
    (candidate) => candidate.candidateId === candidateId,
  );
  if (!requestedCandidate)
    throw new PublicApiError('The Candidate could not be found.', 400);
  const allRuns = await readAllTaskDecompositionRuns(project);
  if (successfulRecomposeOutputCandidateIds(allRuns).has(candidateId))
    throw new PublicApiError(
      'Recompose output Candidates belong to one atomic working set and cannot be discarded individually.',
      409,
    );
  if (
    [...activeRuns.values()].some(
      (active) =>
        active.record.sourceNodeId === requestedRun.sourceNodeId &&
        ['running', 'validating'].includes(active.record.status),
    )
  ) {
    throw new PublicApiError(
      'Cancel or finish the active Agent Run first.',
      400,
    );
  }
  const accepted = (await listTaskGraphNodes(project)).some(
    (node) => node.provenance?.candidateId === candidateId,
  );
  if (accepted) {
    throw new PublicApiError(
      'An accepted Candidate must be managed as a formal Node.',
      400,
    );
  }
  if (
    !(await collectLatestUnacceptedCandidates(project)).some(
      (item) => item.candidateId === candidateId,
    )
  )
    throw new PublicApiError(
      'This Candidate was replaced or removed by Recompose.',
      409,
    );
  const blockers = candidateDependencyBlockers(
    candidateId,
    await collectLatestUnacceptedCandidates(project),
  );
  if (blockers.length > 0) {
    throw new Error(
      `${candidateId} is still required by ${blockers.join(', ')}. Discard dependent Candidates first.`,
    );
  }

  const candidateRuns = allRuns.filter(
    (run) =>
      run.result?.outcome === 'proposal' &&
      run.result.candidates.some(
        (candidate) => candidate.candidateId === candidateId,
      ),
  );
  let requestedRunDeleted = false;
  const deletedRunIds: string[] = [];
  const updatedRuns: TaskDecompositionRunRecord[] = [];
  for (const run of candidateRuns) {
    const runDeleted = await discardCandidateFromRun(project, run, candidateId);
    if (runDeleted) deletedRunIds.push(run.runId);
    else updatedRuns.push(run);
    if (run.runId === runId) requestedRunDeleted = runDeleted;
  }
  return {
    candidateId,
    runDeleted: requestedRunDeleted,
    deletedRunIds,
    runs: updatedRuns,
  };
}

async function discardCandidateFromRun(
  project: RegisteredProject,
  run: TaskDecompositionRunRecord,
  candidateId: string,
) {
  if (run.result?.outcome !== 'proposal') return false;
  const candidateIndex = run.result.candidates.findIndex(
    (candidate) => candidate.candidateId === candidateId,
  );
  if (candidateIndex < 0) return false;
  const runPath = taskDecompositionRunPath(project, run.runId);
  if (run.result.candidates.length === 1) {
    await trash(runPath);
    return true;
  }
  const candidatePath = path.join(runPath, 'candidates', candidateId);
  const stagedPath = path.join(
    runPath,
    'candidates',
    `.${candidateId}-${randomUUID()}.discarding`,
  );
  await rename(candidatePath, stagedPath);
  try {
    run.result.candidates.splice(candidateIndex, 1);
    run.updatedAt = new Date().toISOString();
    await writeRunRecord(project, run);
    await ensureCandidateArtifacts(project, run);
  } catch (error) {
    await rename(stagedPath, candidatePath);
    throw error;
  }
  await trash(stagedPath);
  return false;
}

async function finishTaskDecompositionRun(
  project: RegisteredProject,
  record: TaskDecompositionRunRecord,
  agent: LocalAgentRun,
  reservation: ActiveRunReservation,
  nodes: TaskGraphNode[],
  resources: ContextWorkspaceEntry[],
  knownCandidates: Array<
    Extract<
      TaskDecompositionHarnessResult,
      { outcome: 'proposal' }
    >['candidates'][number]
  >,
  revisionTarget?: Extract<
    TaskDecompositionHarnessResult,
    { outcome: 'proposal' }
  >['candidates'][number],
  reservedCandidateIds: string[] = [],
) {
  let agentOutput: string | null = null;
  const superseded = () => reservation.canceling || !isCurrentRun(reservation);
  try {
    const agentResult = await agent.completion;
    if (superseded()) return;
    agentOutput = agentResult.finalOutput;
    const active = activeRuns.get(runKey(project, record.runId));
    await active?.activityRecorder.flush();
    await writeAgentGraphRunEvidence(
      taskDecompositionRunPath(project, record.runId),
      {
        activity: record.activity,
        agentOutput,
      },
    );
    record.status = 'validating';
    record.agentSessionId = agentResult.agentSessionId;
    record.usage = agentResult.usage;
    record.sessionUsage = agentResult.sessionUsage ?? agentResult.usage;
    record.updatedAt = new Date().toISOString();
    reservation.setPhase('finalizing', 'HOST');
    await writeRunRecord(project, record);
    if (superseded()) return;

    const acceptedCandidateIds = nodes.flatMap((node) =>
      node.provenance?.candidateId ? [node.provenance.candidateId] : [],
    );
    const envelope = parseTaskDecompositionHarnessResult(
      agentResult.finalOutput,
      {
        request: {
          sessionId: record.sessionId,
          requestId: record.requestId,
          inputFingerprint: record.inputFingerprint,
        },
        knownNodeIds: nodes.map((node) => node.id),
        availableNodeContentIds: [
          record.sourceNodeId,
          ...resources.flatMap((resource) =>
            resource.nodeId ? [resource.nodeId] : [],
          ),
        ],
        knownResourcePaths: resources.map((resource) => resource.logicalPath),
        acceptedCandidateIds,
        previousCandidateRevisions: revisionTarget
          ? { [revisionTarget.candidateId]: revisionTarget.revision }
          : undefined,
        revisionCandidateId: revisionTarget?.candidateId,
        reservedCandidateIds,
        knownCandidates,
      },
    );
    const subject = {
      intention:
        record.intention ?? taskDecompositionIntentionRegistry.defaultId,
      motion: record.motion ?? 'unspecified',
      knownNodeIds: nodes.map((node) => node.id),
      acceptedCandidateIds,
      knownResourcePaths: resources.map((resource) => resource.logicalPath),
      reservedCandidateIds,
      currentCandidates: knownCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        revision: candidate.revision,
        dependsOn: [...candidate.dependsOn],
      })),
    };
    const basis = await scopeDecompositionBasis(
      project,
      record,
      revisionTarget,
      subject,
    );
    const materialized = await materializeScopeDecompositionResult(
      basis,
      toScopeDecompositionSemanticResult(envelope),
    );
    const result = materialized
      ? {
          ...envelope,
          candidates: materialized.candidates,
          ...(materialized.candidateAliases && {
            candidateAliases: materialized.candidateAliases,
          }),
          ...(materialized.effects && {
            recomposition: { effects: materialized.effects },
          }),
        }
      : envelope;
    if (
      revisionTarget &&
      result.outcome === 'proposal' &&
      (result.candidates.length !== 1 ||
        result.candidates[0]?.candidateId !== revisionTarget.candidateId)
    ) {
      throw new Error(
        'A revision must return exactly the requested Candidate identifier.',
      );
    }
    const endedAt = new Date().toISOString();
    record.status = result.outcome;
    record.result = result;
    const classification = classifyModuleRun(
      result.outcome === 'proposal'
        ? {
            runState: 'settled',
            outcome: 'proposal',
            summary: `${result.candidates.length} ${result.candidates.length === 1 ? 'Candidate' : 'Candidates'} proposed for ${record.sourceNodeId}. Review them on the graph.`,
          }
        : result.outcome === 'clarification'
          ? {
              runState: 'settled',
              outcome: 'clarification',
              question: result.clarification.question,
            }
          : result.outcome === 'insufficient-evidence'
            ? {
                runState: 'settled',
                outcome: 'insufficient-evidence',
                missingEvidence: result.missingEvidence,
              }
            : {
                runState: 'settled',
                outcome: 'no-change',
                reason: result.reason,
              },
    );
    record.response = classification;
    await ensureCandidateArtifacts(project, record);
    record.updatedAt = endedAt;
    record.endedAt = endedAt;
    await writeRunRecord(project, record);
    await settleRun(reservation, { classification, endedAt });
  } catch (error) {
    if (superseded()) return;
    const endedAt = new Date().toISOString();
    const original = agentGraphErrorMessage(error, 'The Agent Run failed.');
    reservation.record({
      level: 'ERROR',
      actor: 'HOST',
      phase: 'FINALIZE',
      event: agentOutput ? 'result.rejected' : 'agent.failed',
      message: original,
    });
    const classification = classifyModuleRun({
      runState: 'settled',
      failure: {
        kind: moduleRunFailureKind(error, agentOutput),
        message: original,
      },
    });
    record.status = 'failed';
    record.error = original;
    record.response = classification;
    const active = activeRuns.get(runKey(project, record.runId));
    await active?.activityRecorder.flush();
    await writeAgentGraphRunEvidence(
      taskDecompositionRunPath(project, record.runId),
      {
        activity: record.activity,
        agentOutput,
        summary: `# ${classification.title}\n\n${classification.detail}\n\n${record.error}\n`,
        response: `# ${classification.title}\n\n${classification.detail}\n`,
      },
    );
    record.updatedAt = endedAt;
    record.endedAt = endedAt;
    await writeRunRecord(project, record);
    await settleRun(reservation, { classification, endedAt }).catch(
      () => undefined,
    );
  } finally {
    activeRuns.delete(runKey(project, record.runId));
  }
}

async function scopeDecompositionBasis(
  project: RegisteredProject,
  record: TaskDecompositionRunRecord,
  revisionTarget: HarnessCandidate | undefined,
  subject: Omit<
    ScopeDecompositionBasisInput,
    'operation' | 'revisionTarget' | 'recomposeCandidateIds'
  >,
) {
  if (revisionTarget) {
    if (!revisionTarget.uid) {
      throw new MaterializationError(
        'identity',
        `Candidate ${revisionTarget.candidateId} has no stable identity to revise.`,
      );
    }
    return prepareScopeDecompositionMaterializationBasis(project, {
      ...subject,
      operation: 'revise-candidate',
      revisionTarget: {
        candidateId: revisionTarget.candidateId,
        revision: revisionTarget.revision,
        uid: revisionTarget.uid,
      },
    });
  }
  if (record.operation === 'revise-candidate') {
    throw new MaterializationError(
      'validation',
      'A revision Run must resolve the Candidate it is revising.',
    );
  }
  if (record.operation === 'recompose-candidates') {
    return prepareScopeDecompositionMaterializationBasis(project, {
      ...subject,
      operation: 'recompose-candidates',
      recomposeCandidateIds: record.recomposeCandidateIds ?? [],
    });
  }
  return prepareScopeDecompositionMaterializationBasis(project, {
    ...subject,
    operation: record.operation,
  });
}

async function recomposeCandidateContexts(
  project: RegisteredProject,
  candidates: HarnessCandidate[],
) {
  if (candidates.length === 0) return [];
  const runs = (await readAllTaskDecompositionRuns(project)).sort(
    (left, right) => right.startedAt.localeCompare(left.startedAt),
  );
  return candidates.map((candidate) => {
    const owner = runs.find(
      (run) =>
        run.result?.outcome === 'proposal' &&
        run.result.candidates.some(
          (item) =>
            item.candidateId === candidate.candidateId &&
            item.revision === candidate.revision,
        ),
    );
    if (!owner)
      throw new Error(
        `Candidate ${candidate.candidateId} output is unavailable for Recompose.`,
      );
    return {
      outputPath: `task-decomposition/runs/${owner.runId}/candidates/${candidate.candidateId}/output.md`,
      resourcePaths: candidate.resources.map((resource) => resource.path),
    };
  });
}

async function collectContextWorkspaceInputs(
  project: RegisteredProject,
  sourceNode: TaskGraphNode,
  nodes: TaskGraphNode[],
  contextResources: ResolvedProductContextResource[],
  uploads: ContextWorkspaceInput[],
  featureAttachmentNames: string[],
  revision?: { outputPath: string; resourcePaths: string[] },
  workingSet: Array<{ outputPath: string; resourcePaths: string[] }> = [],
) {
  const sourceOutputPaths = new Set(
    sourceNode.resources
      .filter((resource) => resource.kind === 'output')
      .map((resource) => resource.path),
  );
  const primarySourcePaths = primarySourceResourcePaths(
    sourceNode.role,
    sourceNode.resources,
  );
  const relatedNodeIds = relatedContextNodeIds(sourceNode, nodes);
  const graphRequests: Array<{
    path: string;
    role: 'primary' | 'related';
    kind: string;
    nodeId?: string;
  }> = [
    ...sourceNode.resources.map((resource) => ({
      path: resource.path,
      role: primarySourcePaths.has(resource.path)
        ? ('primary' as const)
        : ('related' as const),
      kind:
        resource.kind === 'user-input' || resource.kind === 'idea'
          ? 'source-input'
          : resource.kind,
      nodeId: sourceOutputPaths.has(resource.path) ? sourceNode.id : undefined,
    })),
    ...(revision?.resourcePaths.map((resourcePath) => ({
      path: resourcePath,
      role: 'related' as const,
      kind: 'candidate-context',
    })) ?? []),
    ...(revision
      ? [
          {
            path: revision.outputPath,
            role: 'primary' as const,
            kind: 'candidate-output',
          },
        ]
      : []),
    ...workingSet.flatMap((candidate) => [
      ...candidate.resourcePaths.map((resourcePath) => ({
        path: resourcePath,
        role: 'related' as const,
        kind: 'candidate-context',
      })),
      {
        path: candidate.outputPath,
        role: 'primary' as const,
        kind: 'candidate-output',
      },
    ]),
    ...nodes.flatMap((node) =>
      !relatedNodeIds.has(node.id)
        ? []
        : node.resources
            .filter((resource) => resource.kind === 'output')
            .map((resource) => ({
              path: resource.path,
              role: 'related' as const,
              kind: 'node-output',
              nodeId: node.id,
            })),
    ),
  ];
  const graphResources = await Promise.all(
    graphRequests.map(async (request) => {
      const resource = await readTaskGraphMarkdownResource(
        project,
        request.path,
      );
      return {
        role: request.role,
        kind: request.kind,
        logicalPath: resource.path,
        content: resource.markdown,
        ...(request.nodeId ? { nodeId: request.nodeId } : {}),
      };
    }),
  );
  const featureResources = await Promise.all(
    featureAttachmentNames.map(async (fileName) => {
      const attachment = await readTaskDecompositionAttachment(
        project,
        fileName,
      );
      return {
        role: 'related' as const,
        kind: 'decomposition-context',
        logicalPath: `task-decomposition/attachments/${attachment.fileName}`,
        content: attachment.content,
      };
    }),
  );
  const selectedContext = contextResources.map((resource) => ({
    role: 'primary' as const,
    kind: 'run-context',
    logicalPath: resource.path,
    content: resource.markdown,
  }));
  return [
    ...graphResources,
    ...selectedContext,
    ...featureResources,
    ...uploads,
  ];
}

async function saveUploadedResources(
  runId: string,
  resourcesPath: string,
  files: File[],
) {
  const usedNames = new Set<string>();
  const resources: ContextWorkspaceInput[] = [];
  for (const file of files) {
    if (!/\.(md|markdown|txt|html|htm)$/i.test(file.name)) {
      throw new PublicApiError(
        'Only Markdown Resources can be added to an Agent Run.',
        400,
      );
    }
    if (file.size > 2 * 1024 * 1024) {
      throw new PublicApiError(
        'Each Markdown Resource must be 2 MB or smaller.',
        400,
      );
    }
    const fileName = chooseUniqueFileName(file.name, usedNames);
    const content = await file.text();
    await writeFile(path.join(resourcesPath, fileName), content, {
      flag: 'wx',
    });
    resources.push({
      role: 'primary',
      kind: 'run-attachment',
      logicalPath: path.posix.join(
        'task-decomposition',
        'runs',
        runId,
        'resources',
        fileName,
      ),
      content,
    });
  }
  return resources;
}

function graphMapEntry(node: TaskGraphNode) {
  return {
    id: node.id,
    uid: node.uid,
    relations: node.relations,
    role: node.role,
    type: node.type,
    title: node.title,
    summary: node.summary ?? '',
    derivedFrom: node.derivedFrom ?? [],
    dependsOn: node.dependsOn,
    acceptedFromCandidateId: node.provenance?.candidateId ?? null,
    resourcePaths: node.resources.map((resource) => resource.path),
  };
}

async function writeRunRecord(
  project: RegisteredProject,
  record: TaskDecompositionRunRecord,
) {
  const runPath = taskDecompositionRunPath(project, record.runId);
  await mkdir(runPath, { recursive: true });
  const filePath = path.join(runPath, 'run.json');
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}

function validateRunRequest(input: RunRequest) {
  if (!/^NODE-[0-9a-f]{8,32}$/.test(input.sourceNodeId)) {
    throw new PublicApiError('The source Node is invalid.', 400);
  }
  if (input.contextRefs.length > 50) {
    throw new PublicApiError(
      'Select no more than 50 additional Context Resources.',
      400,
    );
  }
  if (input.files.length > 20) {
    throw new PublicApiError('Upload no more than 20 Markdown Resources.', 400);
  }
  if (
    (input.revisionRunId && !input.revisionCandidateId) ||
    (!input.revisionRunId && input.revisionCandidateId)
  ) {
    throw new PublicApiError(
      'A complete Candidate revision target is required.',
      400,
    );
  }
  if (
    input.operation !== undefined &&
    !['propose', 'append-candidates'].includes(input.operation)
  ) {
    throw new PublicApiError('The decomposition operation is invalid.', 400);
  }
}

async function resolveRevisionTarget(
  project: RegisteredProject,
  input: RunRequest,
) {
  if (!input.revisionRunId || !input.revisionCandidateId) return null;
  const run = await readTaskDecompositionRun(project, input.revisionRunId);
  if (run.result?.outcome !== 'proposal') {
    throw new PublicApiError(
      'The Candidate revision source is unavailable.',
      400,
    );
  }
  const candidate = run.result.candidates.find(
    (value) => value.candidateId === input.revisionCandidateId,
  );
  if (!candidate || run.sourceNodeId !== input.sourceNodeId) {
    throw new PublicApiError('The Candidate revision target is invalid.', 400);
  }
  return { run, candidate };
}

async function resolveRecomposeWorkingSet(
  project: RegisteredProject,
  sourceNodeId: string,
  candidateIds: string[],
) {
  if (new Set(candidateIds).size !== candidateIds.length)
    throw new PublicApiError('Recompose Candidates must be unique.', 400);
  const available = await collectLatestUnacceptedCandidates(project);
  const selected = candidateIds.map((candidateId) => {
    const candidate = available.find(
      (item) => item.candidateId === candidateId,
    );
    if (!candidate)
      throw new PublicApiError(
        `Candidate ${candidateId} is no longer available for Recompose.`,
        409,
      );
    if (!candidate.derivedFrom.includes(sourceNodeId))
      throw new PublicApiError(
        'Every Recompose Candidate must belong to the selected source Node.',
        400,
      );
    return candidate;
  });
  const selectedIds = new Set(candidateIds);
  const blocker = available.find(
    (candidate) =>
      !selectedIds.has(candidate.candidateId) &&
      candidate.dependsOn.some((dependencyId) => selectedIds.has(dependencyId)),
  );
  if (blocker)
    throw new PublicApiError(
      `${blocker.candidateId} depends on the selected working set. Include it or revise that dependency first.`,
      409,
    );
  const selectedOutputPaths = new Set(
    (await readAllTaskDecompositionRuns(project)).flatMap((run) =>
      run.result?.outcome === 'proposal' &&
      run.result.candidates.some((candidate) =>
        selectedIds.has(candidate.candidateId),
      )
        ? run.result.candidates
            .filter((candidate) => selectedIds.has(candidate.candidateId))
            .map(
              (candidate) =>
                `task-decomposition/runs/${run.runId}/candidates/${candidate.candidateId}/output.md`,
            )
        : [],
    ),
  );
  const protectedNode = (await listTaskGraphNodes(project)).find((node) =>
    node.resources.some((resource) => selectedOutputPaths.has(resource.path)),
  );
  if (protectedNode)
    throw new PublicApiError(
      `Accepted Node ${protectedNode.id} uses output from the selected working set.`,
      409,
    );
  return selected;
}

async function findLatestCoordinatorRun(
  project: RegisteredProject,
  sourceNodeId: string,
) {
  const runs = await readAllTaskDecompositionRuns(project);
  return (
    runs
      .filter(
        (run) =>
          run.sourceNodeId === sourceNodeId &&
          run.agentSessionId &&
          run.agentSessionMode === 'persistent',
      )
      .sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
      )[0] ?? null
  );
}

async function collectExistingCandidateChildren(
  project: RegisteredProject,
  sourceNodeId: string,
) {
  return (await collectLatestUnacceptedCandidates(project)).filter(
    (candidate) => candidate.derivedFrom.includes(sourceNodeId),
  );
}

async function collectLatestUnacceptedCandidates(project: RegisteredProject) {
  const runs = await readAllTaskDecompositionRuns(project);
  const latestByCandidate = new Map<
    string,
    Extract<
      TaskDecompositionHarnessResult,
      { outcome: 'proposal' }
    >['candidates'][number]
  >();
  for (const run of runs.sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  )) {
    if (run.result?.outcome !== 'proposal') {
      continue;
    }
    if (run.operation === 'recompose-candidates' && run.result.recomposition) {
      const retained = new Set(
        run.result.recomposition.effects
          .filter((effect) => effect.kind === 'retain')
          .flatMap((effect) => effect.from),
      );
      for (const candidateId of run.recomposeCandidateIds ?? [])
        if (!retained.has(candidateId)) latestByCandidate.delete(candidateId);
    }
    for (const candidate of run.result.candidates) {
      const current = latestByCandidate.get(candidate.candidateId);
      if (!current || candidate.revision > current.revision) {
        latestByCandidate.set(candidate.candidateId, candidate);
      }
    }
  }
  const acceptedIds = new Set(
    (await listTaskGraphNodes(project)).flatMap((node) =>
      node.provenance?.candidateId ? [node.provenance.candidateId] : [],
    ),
  );
  return [...latestByCandidate.values()].filter(
    (candidate) => !acceptedIds.has(candidate.candidateId),
  );
}

async function collectReservedCandidateIds(project: RegisteredProject) {
  return reservedCandidateAliases(project.planningPath, 'task-graph');
}

async function readAllTaskDecompositionRuns(project: RegisteredProject) {
  const root = path.join(project.planningPath, 'task-decomposition', 'runs');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^RUN-/i.test(entry.name))
      .map((entry) =>
        readTaskDecompositionRun(project, entry.name).catch(() => null),
      ),
  );
  return records.filter(
    (record): record is TaskDecompositionRunRecord => record !== null,
  );
}

function chooseUniqueFileName(value: string, usedNames: Set<string>) {
  const parsed = path.parse(path.basename(value));
  const baseName =
    parsed.name
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9\s_-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'resource';
  const extension =
    parsed.ext.toLowerCase() === '.markdown' ? '.markdown' : '.md';
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const fileName = `${baseName}${suffix === 1 ? '' : `-${suffix}`}${extension}`;
    if (!usedNames.has(fileName)) {
      usedNames.add(fileName);
      return fileName;
    }
  }
  throw new Error('Could not choose a unique Run Resource name.');
}

function taskDecompositionRunPath(project: RegisteredProject, runId: string) {
  validateRunId(runId);
  return path.join(project.planningPath, 'task-decomposition', 'runs', runId);
}

function validateRunId(runId: string) {
  if (!/^RUN-[0-9a-f-]{36}$/i.test(runId)) {
    throw new PublicApiError('The Agent Run identifier is invalid.', 400);
  }
}

function runKey(project: RegisteredProject, runId: string) {
  return `${project.id}:${runId}`;
}

const mutationRuntime = globalThis as typeof globalThis & {
  taskDecompositionMutations?: Map<string, Promise<unknown>>;
};
const mutations = (mutationRuntime.taskDecompositionMutations ??= new Map<
  string,
  Promise<unknown>
>());

async function mutateTaskDecomposition<T>(
  project: RegisteredProject,
  work: () => Promise<T>,
): Promise<T> {
  const previous = mutations.get(project.planningPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  mutations.set(project.planningPath, next);
  try {
    return (await next) as T;
  } finally {
    if (mutations.get(project.planningPath) === next)
      mutations.delete(project.planningPath);
  }
}

function getActiveRuns() {
  const runtime = globalThis as typeof globalThis & {
    __praxisRuns?: Map<string, ActiveRun>;
  };
  runtime.__praxisRuns ??= new Map<string, ActiveRun>();
  return runtime.__praxisRuns;
}

async function ensureCandidateArtifacts(
  project: RegisteredProject,
  record: TaskDecompositionRunRecord,
) {
  if (!record.result) return;
  await writeAgentGraphRunEvidence(
    taskDecompositionRunPath(project, record.runId),
    {
      activity: record.activity ?? [],
      summary: renderTaskDecompositionSummaryMarkdown(record.result),
      response: renderTaskDecompositionResponseMarkdown(record.result),
    },
  );
  if (record.result.outcome !== 'proposal') return;
  await Promise.all(
    record.result.candidates.map(async (candidate) => {
      const candidatePath = path.join(
        taskDecompositionRunPath(project, record.runId),
        'candidates',
        candidate.candidateId,
      );
      const outputPath = path.join(candidatePath, 'output.md');
      if (
        await access(outputPath)
          .then(() => true)
          .catch(() => false)
      )
        return;
      await mkdir(candidatePath, { recursive: true });
      await writeFile(outputPath, renderCandidateMarkdown(candidate), {
        flag: 'wx',
      });
    }),
  );
}

function renderCandidateMarkdown(
  candidate: Extract<
    TaskDecompositionHarnessResult,
    { outcome: 'proposal' }
  >['candidates'][number],
) {
  const relationships = [
    `- Derived from: ${candidate.derivedFrom.join(', ')}`,
    `- Depends on: ${candidate.dependsOn.join(', ') || 'None'}`,
  ];
  const resources = candidate.resources.length
    ? candidate.resources.map(
        (resource) => `- \`${resource.path}\` (${resource.kind})`,
      )
    : ['- None'];
  const assumptions = candidate.assumptions.length
    ? candidate.assumptions.map((assumption) => `- ${assumption}`)
    : ['- None'];
  const metadata = Object.keys(candidate.metadata).length
    ? `\n\`\`\`json\n${JSON.stringify(candidate.metadata, null, 2)}\n\`\`\``
    : '\nNone.';
  return `# ${candidate.title}

${candidate.summary}

## Candidate

- ID: \`${candidate.candidateId}\`
- Revision: ${candidate.revision}
- Type: ${candidate.type}

## Relationships

${relationships.join('\n')}

## Resources

${resources.join('\n')}

## Assumptions

${assumptions.join('\n')}

## Metadata
${metadata}
`;
}
