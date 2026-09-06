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
import {
  ensureGraphIdentities,
  readIdentifiedEntities,
  reservedCandidateAliases,
} from '../../graph/identity-store.ts';
import {
  access,
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
  WHATS_NEXT_HARNESS_ID,
  WHATS_NEXT_HARNESS_REVISION,
  canReuseWhatsNextSession,
  createWhatsNextRevisionTarget,
  parseWhatsNextHarnessResult,
  type WhatsNextCandidate,
  type WhatsNextHarnessResult,
} from './harness.ts';
import {
  buildWhatsNextContinuationPrompt,
  buildWhatsNextPrompt,
} from './prompt.ts';
import {
  renderWhatsNextResponseMarkdown,
  renderWhatsNextSummaryMarkdown,
} from './response.ts';
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
  redoProposalPlan,
  redoProposalContext,
  redoProposalInputRun,
  type ProposalReplacement,
} from './redo.ts';
import { readWhatsNextAttachment, readWhatsNextContext } from './context.ts';
import { candidateDependencyBlockers } from '../../graph/proposal/dependencies.ts';
import {
  whatsNextValidationContext,
  type WhatsNextValidationContextInput,
} from './validation-context.ts';
import { MaterializationError } from '../../materialization/receipt.ts';
import { prepareProductExplorationMaterializationBasis } from './basis.ts';
import {
  publishProductExplorationResult,
  type MaterializationLog,
} from './publish.ts';
import { materializationLogEntry } from '../../materialization/log.ts';
import {
  toProductExplorationCandidate,
  toProductExplorationSemanticResult,
} from './producer-adapter.ts';
import { promoteCandidateToNode } from '../../graph/proposal/promote.ts';
import { stageCandidateDocuments } from '../../graph/proposal/stage.ts';
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
  startLocalAgentRun,
  type LocalAgentKind,
  type LocalAgentRun,
  type LocalAgentUsage,
} from '../../agents/transport.ts';
import {
  listTaskGraphNodes,
  readTaskGraphMarkdownResource,
  type TaskGraphNode,
} from '../../graph/task/nodes.ts';
import {
  assertWhatsNextIntention,
  assertWhatsNextMotion,
  intentionDestination,
  type WhatsNextIntention,
  type WhatsNextMotion,
} from './intention.ts';

const GRAPH_ROOT = 'whats-next' as const;

export type WhatsNextRunStatus =
  | 'running'
  | 'validating'
  | 'proposal'
  | 'clarification'
  | 'no-change'
  | 'failed'
  | 'canceled';

export type WhatsNextRunTransport = 'codex-cli' | 'claude-cli' | 'deepseek-cli';

const RUN_TRANSPORTS: Record<LocalAgentKind, WhatsNextRunTransport> = {
  codex: 'codex-cli',
  claude: 'claude-cli',
  deepseek: 'deepseek-cli',
};

export type WhatsNextRunRecord = {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  requestId: string;
  agentSessionId: string | null;
  agentSessionMode?: 'persistent';
  sourceNodeIds: string[];
  operation: 'explore' | 'refine-candidate';
  intention: WhatsNextIntention;
  motion: WhatsNextMotion;
  parentRunId?: string;
  revisionOf?: string;
  replacement?: ProposalReplacement;
  cleanupWarning?: string;
  status: WhatsNextRunStatus;
  transport: WhatsNextRunTransport;
  profile?: AgentProfile;
  harness: {
    id: typeof WHATS_NEXT_HARNESS_ID;
    revision: typeof WHATS_NEXT_HARNESS_REVISION;
  };
  input?: {
    instruction?: string;
    userInputPath?: string | null;
    moduleInstructionsState?: 'present' | 'cleared';
    resourcePaths: string[];
    feedback?: WhatsNextFeedbackAnchor[];
    feedbackAnchors?: Array<
      Omit<WhatsNextFeedbackAnchor, 'excerpt' | 'instruction'>
    >;
    requestArtifact: 'request.json';
    intention: WhatsNextIntention;
    motion: WhatsNextMotion;
  };
  inputFingerprint: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  usage: LocalAgentUsage | null;
  sessionUsage?: LocalAgentUsage | null;
  activity: AgentGraphActivity[];
  result: WhatsNextHarnessResult | null;
  error: string | null;
  logRef?: string;
  hostPid?: number;
  cancelRequestedAt?: string;
  response?: ResponseClassification;
};

export type WhatsNextFeedbackAnchor = {
  feedbackId: string;
  path: string;
  baseRevision: number;
  startLine: number;
  endLine: number;
  excerpt: string;
  excerptHash: string;
  instruction: string;
};

type RunRequest = {
  sourceNodeIds: string[];
  agent: LocalAgentKind;
  model?: AgentProfile['model'];
  effort?: AgentProfile['effort'];
  instruction: string;
  contextRefs: string[];
  files: File[];
  feedback?: WhatsNextFeedbackAnchor[];
  revisionRunId?: string;
  revisionCandidateId?: string;
  redoProposal?: boolean;
  intention?: WhatsNextIntention;
  motion?: WhatsNextMotion;
};

type ActiveRun = {
  record: WhatsNextRunRecord;
  agent: LocalAgentRun;
  activityRecorder: AgentGraphActivityRecorder;
  reservation: ActiveRunReservation | null;
};
const WHATS_NEXT_RETAINED = 'The graph was not changed.';

const activeRuns = getActiveRuns();

export async function startWhatsNextRun(
  project: RegisteredProject,
  input: RunRequest,
  launch: typeof startLocalAgentRun = startLocalAgentRun,
) {
  return mutateWhatsNext(project, () =>
    startWhatsNextRunUnlocked(project, input, launch),
  );
}

async function startWhatsNextRunUnlocked(
  project: RegisteredProject,
  input: RunRequest,
  launch: typeof startLocalAgentRun,
) {
  validateRunRequest(input);
  const intention = input.intention ?? 'mvp-exploration';
  const motion = input.motion ?? 'unspecified';
  const profile: AgentProfile = {
    agent: input.agent,
    model: input.model ?? '',
    effort: input.effort ?? '',
  };
  validateAgentProfile(profile);
  const nodes = await listTaskGraphNodes(project, GRAPH_ROOT);
  const allRuns = await readAllWhatsNextRuns(project);
  const redo = input.redoProposal
    ? redoProposalPlan(nodes, allRuns, input.sourceNodeIds)
    : null;
  const sourceNodes = input.sourceNodeIds.map((nodeId) => {
    const node = nodes.find((value) => value.id === nodeId);
    if (!node) throw new Error(`${nodeId} could not be found.`);
    return node;
  });
  if (
    sourceNodes.some((node) => node.role === 'start') &&
    sourceNodes.length !== 1
  )
    throw new PublicApiError('A Source must be selected by itself.', 400);
  if (
    intention === 'feature-synthesis' &&
    sourceNodes.some(
      (node) =>
        node.role !== 'start' && (node.layer ?? 'discovery') !== 'discovery',
    )
  )
    throw new PublicApiError(
      'Feature Synthesis currently accepts Discovery sources.',
      400,
    );
  if (
    intention === 'product-design-completion' &&
    !input.revisionCandidateId &&
    (sourceNodes.length !== 1 || sourceNodes[0]?.role !== 'start')
  )
    throw new PublicApiError(
      'Product Design Completion must start from the Product Source.',
      400,
    );
  const revisionTarget = await resolveRevisionTarget(project, input);
  if (revisionTarget && input.feedback?.length) {
    await validateInlineFeedback(project, revisionTarget, input.feedback);
  }
  const operation = revisionTarget ? 'refine-candidate' : 'explore';
  const transport = RUN_TRANSPORTS[input.agent];
  const coordinatorCandidate = revisionTarget
    ? revisionTarget.run
    : await findLatestCoordinatorRun(project, input.sourceNodeIds);
  const coordinatorRun =
    !redo &&
    coordinatorCandidate &&
    (intention !== 'product-design-completion' || Boolean(revisionTarget)) &&
    canReuseWhatsNextSession(coordinatorCandidate, transport) &&
    sameModelSelection(coordinatorCandidate.profile, profile) &&
    coordinatorCandidate.intention === intention &&
    coordinatorCandidate.motion === motion
      ? coordinatorCandidate
      : null;
  const continuesExistingSession = Boolean(coordinatorRun?.agentSessionId);
  const reservedCandidateIds = await collectReservedCandidateIds(project);
  const productContextResources = await resolveProductContextReferences(
    project,
    input.contextRefs,
    ['mvp-prototype', 'product-design'],
  );
  const runId = `RUN-${randomUUID()}`;
  const sessionId = coordinatorRun?.sessionId ?? `SESSION-${randomUUID()}`;
  const requestId = `REQUEST-${randomUUID()}`;
  const runPath = whatsNextRunPath(project, runId);
  let record!: WhatsNextRunRecord;
  let prompt!: string;
  let resources!: ContextWorkspaceEntry[];
  let preflightFailure: string | null = null;
  const layer = intentionDestination(intention).layer;
  const layerLabel =
    layer === 'discovery' ? 'Product Discovery' : 'Product Design';
  const { reservation } = await beginModuleRun(project, 'whats-next', {
    runId,
    subject: { kind: 'layer', label: layerLabel },
    layer: layer,
    agentProfile: profile,
    startMessage: `${layerLabel} Run started with ${input.agent}`,
    validate: async () => undefined,
    persist: async (reservation) => {
      const resourcesPath = path.join(runPath, 'resources');
      await mkdir(resourcesPath, { recursive: true });

      const uploadedResources = await saveUploadedResources(
        runId,
        resourcesPath,
        input.files,
      );
      if (redo) {
        const priorPaths = new Set(
          redo.targets.flatMap(({ candidate }) =>
            candidate.resources.map((resource) => resource.path),
          ),
        );
        for (const [index, resourcePath] of [...priorPaths].entries()) {
          const resource = await readTaskGraphMarkdownResource(
            project,
            resourcePath,
          );
          const name = `prior-resource-${index + 1}.md`;
          await writeFile(path.join(resourcesPath, name), resource.markdown, {
            flag: 'wx',
          });
          uploadedResources.push({
            logicalPath: `whats-next/runs/${runId}/resources/${name}`,
            kind: 'prior-context',
            role: 'primary',
            content: resource.markdown,
          });
        }
        const previousRun = redoProposalInputRun(redo);
        const previousUserInput = previousRun?.input?.userInputPath
          ? await readFile(
              path.join(
                whatsNextRunPath(project, previousRun.runId),
                'context',
                previousRun.input.userInputPath,
              ),
              'utf8',
            )
          : undefined;
        const priorMarkdown = redoProposalContext(
          redo,
          previousUserInput,
        ).markdown;
        await writeFile(
          path.join(resourcesPath, 'previous-proposal.md'),
          priorMarkdown,
          { flag: 'wx' },
        );
        uploadedResources.push({
          logicalPath: `whats-next/runs/${runId}/resources/previous-proposal.md`,
          kind: 'previous-proposal',
          role: 'primary',
          content: priorMarkdown,
        });
      }
      const featureContext = await readWhatsNextContext(project);
      const implicitProductDesignContext =
        intention === 'product-design-completion'
          ? nodes.filter(
              (node) =>
                node.role === 'start' || node.layer === 'product-design',
            )
          : [];
      const contextInputs = await collectContextWorkspaceInputs(
        project,
        sourceNodes,
        nodes,
        productContextResources,
        uploadedResources,
        featureContext.attachments.map((attachment) => attachment.fileName),
        redo ? false : continuesExistingSession,
        implicitProductDesignContext,
        revisionTarget
          ? {
              outputPath: `whats-next/runs/${revisionTarget.run.runId}/candidates/${revisionTarget.candidate.candidateId}/output.md`,
              resourcePaths: revisionTarget.candidate.resources.map(
                (resource) => resource.path,
              ),
            }
          : undefined,
      );
      const userInput = userInputWorkspaceInput(
        `whats-next/runs/${runId}/context/input/user-input.md`,
        renderWhatsNextUserInput(input.instruction, input.feedback ?? []),
      );
      const moduleInstructions = featureContext.instructions.trim()
        ? {
            role: 'primary' as const,
            kind: 'module-instructions',
            logicalPath: 'whats-next/instructions.md',
            content: featureContext.instructions,
          }
        : null;
      if (redo) {
        for (const [index, resource] of contextInputs.entries()) {
          if (
            !redo.runIds.some((id) =>
              resource.logicalPath.startsWith(`whats-next/runs/${id}/`),
            )
          )
            continue;
          const name = `retained-context-${index}.md`;
          await writeFile(path.join(resourcesPath, name), resource.content, {
            flag: 'wx',
          });
          resource.logicalPath = `whats-next/runs/${runId}/resources/${name}`;
        }
      }
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
      const requestIdentity = { sessionId, requestId, inputFingerprint: '' };
      const packet = {
        request: requestIdentity,
        operation,
        intention,
        motion,
        destination: intentionDestination(intention),
        implicitProductDesignContext:
          intention === 'product-design-completion'
            ? {
                sourceNodeId:
                  implicitProductDesignContext.find(
                    (node) => node.role === 'start',
                  )?.id ?? null,
                featureNodeIds: implicitProductDesignContext
                  .filter((node) => node.layer === 'product-design')
                  .map((node) => node.id),
              }
            : undefined,
        proposalCorrection: redo
          ? {
              intent:
                'Redo the entire unaccepted proposal from these origins using the current User Input as feedback. The previous proposal is evidence of what the user is correcting, not a direction to preserve. Return a new proposal, not single-card refinement. Do not modify the parent or other branches.',
              previousCandidateIds: redo.candidateIds,
            }
          : undefined,
        content,
        continuationFocus:
          coordinatorRun?.result?.reflection.continuationAdvice
            .recommendedFocus ?? null,
        moduleInstructionsState: moduleInstructions ? 'present' : 'cleared',
        graphMap: continuesExistingSession
          ? undefined
          : nodes.map(graphMapEntry),
        origins: sourceNodes.map(graphMapEntry),
        contextWorkspace: {
          root: contextWorkspace.root,
          indexPath: contextWorkspace.indexPath,
        },
        revisionTarget: revisionTarget
          ? createWhatsNextRevisionTarget(revisionTarget.candidate)
          : null,
        feedbackAnchors: (input.feedback ?? []).map(feedbackAnchorReference),
        previousProposalAliases: coordinatorRun?.result?.candidateAliases ?? {},
        reservedCandidateIds: reservedCandidateIds.filter(
          (candidateId) =>
            candidateId !== revisionTarget?.candidate.candidateId,
        ),
      };
      requestIdentity.inputFingerprint = createHash('sha256')
        .update(JSON.stringify(packet))
        .digest('hex');
      prompt =
        continuesExistingSession &&
        coordinatorRun?.harness.revision === WHATS_NEXT_HARNESS_REVISION
          ? buildWhatsNextContinuationPrompt(packet, intention, motion)
          : buildWhatsNextPrompt(packet, intention, motion);
      const timestamp = new Date().toISOString();
      await writeFile(
        path.join(runPath, 'request.json'),
        `${JSON.stringify(
          { schemaVersion: 1, createdAt: timestamp, profile, packet, prompt },
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
        sourceNodeIds: input.sourceNodeIds,
        operation,
        intention,
        motion,
        parentRunId: coordinatorCandidate?.runId,
        revisionOf: revisionTarget?.candidate.candidateId,
        replacement: redo
          ? {
              state: 'applied',
              candidateIds: redo.candidateIds,
              runIds: redo.runIds,
            }
          : undefined,
        status: 'running',
        transport,
        profile,
        harness: {
          id: WHATS_NEXT_HARNESS_ID,
          revision: WHATS_NEXT_HARNESS_REVISION,
        },
        input: {
          userInputPath: content.input?.workspacePath ?? null,
          moduleInstructionsState: moduleInstructions ? 'present' : 'cleared',
          resourcePaths: resources.map((resource) => resource.logicalPath),
          feedbackAnchors: (input.feedback ?? []).map(feedbackAnchorReference),
          requestArtifact: 'request.json',
          intention,
          motion,
        },
        inputFingerprint: requestIdentity.inputFingerprint,
        startedAt: timestamp,
        updatedAt: timestamp,
        endedAt: null,
        usage: null,
        sessionUsage: null,
        activity: initialAgentGraphActivity(
          'Exploring the selected direction.',
          timestamp,
        ),
        result: null,
        error: null,
      };
      record.logRef = reservation.logRef;
      record.hostPid = process.pid;
      await writeRunRecord(project, record);
      await initializeAgentGraphActivity(runPath, record.activity);

      if (redo) {
        try {
          const obsoletePaths: string[] = [];
          for (const id of redo.runIds) {
            const folder = whatsNextRunPath(project, id);
            try {
              await access(folder);
              obsoletePaths.push(folder);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
            }
          }
          if (obsoletePaths.length) await trash(obsoletePaths);
        } catch {
          preflightFailure =
            'Could not move all abandoned proposal files to system Trash. No Agent was started; abandoned directions remain hidden.';
        }
      }
      return async () => {
        await rm(runPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      };
    },
  });
  if (preflightFailure) {
    const classification = classifyModuleRun({
      runState: 'settled',
      failure: { kind: 'persistence', message: preflightFailure },
    });
    record.status = 'failed';
    record.error = preflightFailure;
    record.endedAt = new Date().toISOString();
    record.updatedAt = record.endedAt;
    record.response = classification;
    await writeRunRecord(project, record);
    reservation.record({
      level: 'ERROR',
      actor: 'HOST',
      phase: 'PREPARE',
      event: 'preflight.failed',
      message: preflightFailure,
    });
    await settleRun(reservation, { classification });
    return record;
  }
  const activityRecorder = createAgentGraphActivityRecorder(
    runPath,
    record.activity,
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
  void finishWhatsNextRun(
    project,
    record,
    agent,
    reservation,
    nodes,
    resources,
    revisionTarget?.candidate,
    operation === 'refine-candidate' ? [] : reservedCandidateIds,
  );
  return record;
}

export async function readWhatsNextRun(
  project: RegisteredProject,
  runId: string,
) {
  validateRunId(runId);
  await ensureGraphIdentities(project.planningPath, GRAPH_ROOT);
  const stored = JSON.parse(
    await readFile(
      path.join(whatsNextRunPath(project, runId), 'run.json'),
      'utf8',
    ),
  ) as Omit<WhatsNextRunRecord, 'operation'> & { operation?: string };
  if (stored.operation === 'revise-candidate') {
    stored.operation = 'refine-candidate';
  }
  stored.operation ??= stored.revisionOf ? 'refine-candidate' : 'explore';
  const record = stored as WhatsNextRunRecord;
  record.activity ??= [];
  record.intention ??= 'mvp-exploration';
  record.motion ??= 'diverge';
  if (record.input) {
    record.input.intention ??= record.intention;
    record.input.motion ??= record.motion;
  }
  if (record.result?.outcome === 'proposal') {
    for (const candidate of record.result.candidates) {
      candidate.layer ??= 'discovery';
      candidate.artifactKind ??= 'direction';
    }
    record.result.candidates = await readIdentifiedEntities(
      project.planningPath,
      GRAPH_ROOT,
      record.result.candidates,
    );
  }
  if (record.result && !record.result.reflection) {
    record.result.reflection = {
      markdown: record.result.exploration?.notes?.length
        ? `# Reflection\n\n${record.result.exploration.notes.join('\n\n')}`
        : '# Reflection\n\nThis Run did not record a Reflection.',
      continuationAdvice: {
        action: 'continue',
        recommendedFocus: 'expand',
        reason: 'This legacy Run predates explicit continuation advice.',
      },
    };
  }
  if (record.result?.reflection.continuationAdvice) {
    record.result.reflection.continuationAdvice.recommendedFocus ??= 'expand';
  }
  if (record.result?.outcome === 'proposal') {
    for (const candidate of record.result.candidates) {
      if (candidate.outputMarkdown) continue;
      candidate.outputMarkdown = await readFile(
        path.join(
          whatsNextRunPath(project, record.runId),
          'candidates',
          candidate.candidateId,
          'output.md',
        ),
        'utf8',
      ).catch(() => renderLegacyCandidateMarkdown(candidate));
    }
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

export async function listLatestWhatsNextRuns(project: RegisteredProject) {
  return (await readAllWhatsNextRuns(project)).sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
}

export async function recoverWhatsNextRunResult(
  project: RegisteredProject,
  runId: string,
  finalOutput: string,
) {
  const record = await readWhatsNextRun(project, runId);
  if (record.status !== 'failed' || record.result) {
    throw new PublicApiError(
      'Only a failed Run without a validated result can recover.',
      400,
    );
  }
  const nodes = await listTaskGraphNodes(project, GRAPH_ROOT);
  const revisionTarget =
    record.revisionOf && record.parentRunId
      ? await readWhatsNextRun(project, record.parentRunId).then((parent) =>
          parent.result?.outcome === 'proposal'
            ? (parent.result.candidates.find(
                (candidate) => candidate.candidateId === record.revisionOf,
              ) ?? null)
            : null,
        )
      : null;
  const submission = await prepareWhatsNextSubmission(project, finalOutput, {
    record,
    nodes,
    knownResourcePaths: record.input?.resourcePaths ?? [],
    reservedCandidateIds:
      record.operation === 'refine-candidate'
        ? []
        : await collectReservedCandidateIds(project),
    knownCandidates: await collectLatestUnacceptedCandidates(project),
    revisionTarget: revisionTarget ?? undefined,
  });
  await writeProducerEvidence(
    project,
    record.runId,
    record.activity,
    submission.envelope,
  );
  const published = await publishProductExplorationResult(
    submission.basis,
    submission.semantic,
    { kind: 'agent-run', record, resultBase: submission.envelope },
  );
  await writeWhatsNextCheckpoint(project, published.record);
  return published.record;
}

export async function cancelWhatsNextRun(
  project: RegisteredProject,
  runId: string,
) {
  const record = await readWhatsNextRun(project, runId);
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
          retainedNote: WHATS_NEXT_RETAINED,
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
  await writeAgentGraphRunEvidence(whatsNextRunPath(project, runId), {
    activity: canceledRecord.activity,
    summary: document,
    response: document,
  });
  await writeRunRecord(project, canceledRecord);
  if (reservation) await settleRun(reservation, { classification });
  return canceledRecord;
}

export async function acceptWhatsNextCandidate(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
) {
  return mutateWhatsNext(project, () =>
    acceptWhatsNextCandidateUnlocked(project, runId, candidateId),
  );
}

async function acceptWhatsNextCandidateUnlocked(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
) {
  const allRuns = await readAllWhatsNextRuns(project);
  const availableRun = allRuns.find((run) => run.runId === runId);
  if (!availableRun)
    throw new PublicApiError(
      'The Candidate proposal is no longer available.',
      400,
    );
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
  const run = await readWhatsNextRun(project, runId);
  if (run.result?.outcome !== 'proposal') {
    throw new PublicApiError('The Candidate proposal is unavailable.', 400);
  }
  const candidate = run.result.candidates.find(
    (value) => value.candidateId === candidateId,
  );
  if (!candidate)
    throw new PublicApiError('The Candidate could not be found.', 400);
  if (!candidate.uid || !candidate.relations)
    throw new PublicApiError('The Candidate has no stable identity.', 409);

  return promoteCandidateToNode(project, {
    scope: GRAPH_ROOT,
    runId,
    candidate: {
      ...candidate,
      uid: candidate.uid,
      relations: candidate.relations,
    },
    extension: { layer: candidate.layer, artifactKind: candidate.artifactKind },
    provenanceFeature: 'whats-next',
  });
}

export async function discardWhatsNextCandidate(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
) {
  return mutateWhatsNext(project, () =>
    discardWhatsNextCandidateUnlocked(project, runId, candidateId),
  );
}

async function discardWhatsNextCandidateUnlocked(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
) {
  const allRuns = await readAllWhatsNextRuns(project);
  const availableRun = allRuns.find((run) => run.runId === runId);
  if (!availableRun)
    throw new PublicApiError(
      'The Candidate proposal is no longer available.',
      400,
    );
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
  const requestedRun = await readWhatsNextRun(project, runId);
  if (requestedRun.result?.outcome !== 'proposal') {
    throw new PublicApiError('The Candidate proposal is unavailable.', 400);
  }
  if (
    !requestedRun.result.candidates.some(
      (candidate) => candidate.candidateId === candidateId,
    )
  ) {
    throw new PublicApiError('The Candidate could not be found.', 400);
  }
  const accepted = (await listTaskGraphNodes(project, GRAPH_ROOT)).some(
    (node) => node.provenance?.candidateId === candidateId,
  );
  if (accepted) {
    throw new PublicApiError(
      'An accepted Candidate must be managed as a formal Node.',
      400,
    );
  }
  const blockers = candidateDependencyBlockers(
    candidateId,
    await collectLatestUnacceptedCandidates(project),
  );
  if (blockers.length > 0) {
    throw new Error(
      `${candidateId} is still required by ${blockers.join(', ')}. Discard those directions first.`,
    );
  }

  const candidateRuns = (await readAllWhatsNextRuns(project)).filter(
    (run) =>
      run.result?.outcome === 'proposal' &&
      run.result.candidates.some(
        (candidate) => candidate.candidateId === candidateId,
      ),
  );
  let requestedRunDeleted = false;
  const deletedRunIds: string[] = [];
  const updatedRuns: WhatsNextRunRecord[] = [];
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
  run: WhatsNextRunRecord,
  candidateId: string,
) {
  if (run.result?.outcome !== 'proposal') return false;
  const candidateIndex = run.result.candidates.findIndex(
    (candidate) => candidate.candidateId === candidateId,
  );
  if (candidateIndex < 0) return false;
  const runPath = whatsNextRunPath(project, run.runId);
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

async function finishWhatsNextRun(
  project: RegisteredProject,
  record: WhatsNextRunRecord,
  agent: LocalAgentRun,
  reservation: ActiveRunReservation,
  nodes: TaskGraphNode[],
  resources: ContextWorkspaceEntry[],
  revisionTarget?: WhatsNextCandidate,
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
    await writeAgentGraphRunEvidence(whatsNextRunPath(project, record.runId), {
      activity: record.activity,
      agentOutput,
    });
    record.status = 'validating';
    record.agentSessionId = agentResult.agentSessionId;
    record.usage = agentResult.usage;
    record.sessionUsage = agentResult.sessionUsage ?? agentResult.usage;
    record.updatedAt = new Date().toISOString();
    reservation.setPhase('finalizing', 'HOST');
    await writeRunRecord(project, record);
    if (superseded()) return;

    const submission = await prepareWhatsNextSubmission(
      project,
      agentResult.finalOutput,
      {
        record,
        nodes,
        knownResourcePaths: resources.map((resource) => resource.logicalPath),
        reservedCandidateIds,
        knownCandidates: (
          await collectLatestUnacceptedCandidates(project)
        ).filter(
          (candidate) =>
            !record.replacement?.candidateIds.includes(candidate.candidateId),
        ),
        revisionTarget,
      },
      reservation.record,
    );
    await writeProducerEvidence(
      project,
      record.runId,
      record.activity,
      submission.envelope,
    );
    const envelope = submission.envelope;
    record.response = classifyModuleRun(
      envelope.outcome === 'proposal'
        ? {
            runState: 'settled',
            outcome: 'proposal',
            summary: plainSummary(envelope.reflection.markdown),
          }
        : envelope.outcome === 'clarification'
          ? {
              runState: 'settled',
              outcome: 'clarification',
              question: envelope.clarification.question,
            }
          : {
              runState: 'settled',
              outcome: 'no-change',
              reason: envelope.reason,
            },
    );
    const published = await publishProductExplorationResult(
      submission.basis,
      submission.semantic,
      {
        kind: 'agent-run',
        record,
        resultBase: envelope,
        harness: {
          id: envelope.harness.id,
          revision: envelope.harness.revision,
        },
      },
      undefined,
      reservation.record,
    );
    const result = published.record.result as WhatsNextHarnessResult;
    if (
      revisionTarget &&
      result.outcome === 'proposal' &&
      (result.candidates.length !== 1 ||
        result.candidates[0]?.candidateId !== revisionTarget.candidateId)
    ) {
      throw new Error(
        'Refine must return exactly the requested Candidate identifier.',
      );
    }
    Object.assign(record, published.record);
    const endedAt = record.endedAt ?? new Date().toISOString();
    const classification = record.response;
    await writeWhatsNextCheckpoint(project, record);
    await settleRun(reservation, { classification, endedAt });
  } catch (error) {
    if (superseded()) return;
    const endedAt = new Date().toISOString();
    const original = agentGraphErrorMessage(
      error,
      "The What's next Run failed.",
    );
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
    await writeAgentGraphRunEvidence(whatsNextRunPath(project, record.runId), {
      activity: record.activity,
      agentOutput,
      summary: `# ${classification.title}\n\n${classification.detail}\n\n${record.error}\n`,
      response: `# ${classification.title}\n\n${classification.detail}\n`,
    });
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

async function collectContextWorkspaceInputs(
  project: RegisteredProject,
  sourceNodes: TaskGraphNode[],
  nodes: TaskGraphNode[],
  contextResources: ResolvedProductContextResource[],
  uploads: ContextWorkspaceInput[],
  featureAttachmentNames: string[],
  continuesExistingSession: boolean,
  implicitPrimaryNodes: TaskGraphNode[] = [],
  revision?: { outputPath: string; resourcePaths: string[] },
) {
  const relatedNodeIds = new Set(
    sourceNodes.flatMap((sourceNode) => [
      ...relatedContextNodeIds(sourceNode, nodes),
    ]),
  );
  for (const sourceNode of sourceNodes) relatedNodeIds.delete(sourceNode.id);

  const graphRequests = [
    ...sourceNodes.flatMap((sourceNode) => {
      const sourceOutputPaths = new Set(
        sourceNode.resources
          .filter((resource) => resource.kind === 'output')
          .map((resource) => resource.path),
      );
      const primaryPaths = primarySourceResourcePaths(
        sourceNode.role,
        sourceNode.resources,
      );
      return sourceNode.resources.map((resource) => ({
        path: resource.path,
        role:
          !continuesExistingSession && primaryPaths.has(resource.path)
            ? ('primary' as const)
            : ('related' as const),
        kind:
          resource.kind === 'user-input' || resource.kind === 'idea'
            ? 'source-input'
            : resource.kind,
        nodeId: sourceOutputPaths.has(resource.path)
          ? sourceNode.id
          : undefined,
      }));
    }),
    ...implicitPrimaryNodes.flatMap((node) =>
      node.resources
        .filter(
          (resource) =>
            node.role === 'start' ||
            resource.path.endsWith(`/nodes/${node.id}/output.md`),
        )
        .map((resource) => ({
          path: resource.path,
          role: 'primary' as const,
          kind:
            node.role === 'start' ? 'product-source' : 'product-design-context',
          nodeId: resource.path.endsWith(`/nodes/${node.id}/output.md`)
            ? node.id
            : undefined,
        })),
    ),
    ...(revision?.resourcePaths.map((resourcePath) => ({
      path: resourcePath,
      role: 'related' as const,
      kind: 'candidate-context',
      nodeId: undefined,
    })) ?? []),
    ...(revision
      ? [
          {
            path: revision.outputPath,
            role: 'primary' as const,
            kind: 'candidate-output',
            nodeId: undefined,
          },
        ]
      : []),
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
      const attachment = await readWhatsNextAttachment(project, fileName);
      return {
        role: 'related' as const,
        kind: 'whats-next-context',
        logicalPath: `whats-next/attachments/${attachment.fileName}`,
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
        "Only Markdown Resources can be added to a What's next Run.",
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
        'whats-next',
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
    layer: node.layer ?? 'discovery',
    artifactKind:
      node.artifactKind ?? (node.role === 'start' ? 'source' : 'direction'),
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
  record: WhatsNextRunRecord,
) {
  const runPath = whatsNextRunPath(project, record.runId);
  await mkdir(runPath, { recursive: true });
  const filePath = path.join(runPath, 'run.json');
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}

function renderWhatsNextUserInput(
  instruction: string,
  feedback: WhatsNextFeedbackAnchor[],
) {
  const direct = instruction.trim();
  const annotations = feedback.map(
    (item, index) => `## Feedback ${index + 1}

- Target: ${item.path}
- Revision: ${item.baseRevision}
- Lines: ${item.startLine}-${item.endLine}

### Selected text

${item.excerpt
  .split('\n')
  .map((line) => `> ${line}`)
  .join('\n')}

### Request

${item.instruction.trim()}`,
  );
  return [
    direct,
    annotations.length
      ? `# Inline Feedback\n\n${annotations.join('\n\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function feedbackAnchorReference({
  excerpt: _excerpt,
  instruction: _instruction,
  ...reference
}: WhatsNextFeedbackAnchor) {
  return reference;
}

function validateRunRequest(input: RunRequest) {
  assertWhatsNextIntention(input.intention ?? 'mvp-exploration');
  assertWhatsNextMotion(input.motion ?? 'unspecified');
  if (
    input.redoProposal &&
    (input.revisionRunId || input.revisionCandidateId || input.feedback?.length)
  )
    throw new PublicApiError(
      'Redo a proposal separately from single-Candidate refinement.',
      400,
    );
  if (input.redoProposal && !input.instruction.trim())
    throw new PublicApiError(
      'Describe what the whole proposal misunderstood and what you want instead.',
      400,
    );
  if (input.sourceNodeIds.length === 0) {
    throw new PublicApiError('Select at least one origin Node.', 400);
  }
  if (input.sourceNodeIds.length > 10) {
    throw new PublicApiError('Select no more than 10 origin Nodes.', 400);
  }
  if (new Set(input.sourceNodeIds).size !== input.sourceNodeIds.length) {
    throw new PublicApiError('Origin Nodes must be unique.', 400);
  }
  if (
    input.sourceNodeIds.some((nodeId) => !/^NODE-[0-9a-f]{8,32}$/.test(nodeId))
  ) {
    throw new PublicApiError('An origin Node is invalid.', 400);
  }
  const instruction = input.instruction.trim();
  if (
    input.revisionCandidateId &&
    !instruction &&
    (input.feedback?.length ?? 0) === 0
  ) {
    throw new PublicApiError('Refine requires feedback or User Input.', 400);
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
  for (const feedback of input.feedback ?? []) {
    if (
      !feedback.feedbackId ||
      !feedback.path ||
      feedback.baseRevision < 1 ||
      feedback.startLine < 1 ||
      feedback.endLine < feedback.startLine ||
      !feedback.excerpt.trim() ||
      !feedback.excerptHash ||
      !feedback.instruction.trim()
    ) {
      throw new PublicApiError('Inline feedback is invalid.', 400);
    }
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
}

async function resolveRevisionTarget(
  project: RegisteredProject,
  input: RunRequest,
) {
  if (!input.revisionRunId || !input.revisionCandidateId) return null;
  const run = await readWhatsNextRun(project, input.revisionRunId);
  if (run.result?.outcome !== 'proposal') {
    throw new PublicApiError(
      'The Candidate revision source is unavailable.',
      400,
    );
  }
  const candidate = run.result.candidates.find(
    (value) => value.candidateId === input.revisionCandidateId,
  );
  if (!candidate)
    throw new PublicApiError('The Candidate revision target is invalid.', 400);
  return { run, candidate };
}

async function validateInlineFeedback(
  project: RegisteredProject,
  target: { run: WhatsNextRunRecord; candidate: WhatsNextCandidate },
  feedback: WhatsNextFeedbackAnchor[],
) {
  const expectedPath = `whats-next/runs/${target.run.runId}/candidates/${target.candidate.candidateId}/output.md`;
  const markdown = await readFile(
    path.join(
      whatsNextRunPath(project, target.run.runId),
      'candidates',
      target.candidate.candidateId,
      'output.md',
    ),
    'utf8',
  );
  const lines = markdown.split('\n');
  for (const item of feedback) {
    const selfHash = createHash('sha256').update(item.excerpt).digest('hex');
    const currentExcerpt = lines
      .slice(item.startLine - 1, item.endLine)
      .join('\n');
    if (
      item.path !== expectedPath ||
      item.baseRevision !== target.candidate.revision ||
      selfHash !== item.excerptHash ||
      !normalizeExcerpt(currentExcerpt).includes(normalizeExcerpt(item.excerpt))
    ) {
      throw new PublicApiError(
        'Inline feedback is stale. Reopen the current Candidate and select the text again.',
        400,
      );
    }
  }
}

function normalizeExcerpt(value: string) {
  return value
    .replace(/^\s*[-*#>]\s*/gm, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findLatestCoordinatorRun(
  project: RegisteredProject,
  sourceNodeIds: string[],
) {
  const key = [...sourceNodeIds].sort().join(',');
  return (
    (await readAllWhatsNextRuns(project))
      .filter(
        (run) =>
          run.agentSessionId &&
          run.agentSessionMode === 'persistent' &&
          run.harness.revision === WHATS_NEXT_HARNESS_REVISION &&
          ['proposal', 'clarification', 'no-change'].includes(run.status) &&
          [...run.sourceNodeIds].sort().join(',') === key,
      )
      .sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
      )[0] ?? null
  );
}

async function collectLatestUnacceptedCandidates(project: RegisteredProject) {
  const runs = await readAllWhatsNextRuns(project);
  const latestByCandidate = new Map<string, WhatsNextCandidate>();
  for (const run of runs.sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  )) {
    if (run.result?.outcome !== 'proposal') continue;
    for (const candidate of run.result.candidates) {
      const current = latestByCandidate.get(candidate.candidateId);
      if (!current || candidate.revision > current.revision) {
        latestByCandidate.set(candidate.candidateId, candidate);
      }
    }
  }
  const acceptedIds = new Set(
    (await listTaskGraphNodes(project, GRAPH_ROOT)).flatMap((node) =>
      node.provenance?.candidateId ? [node.provenance.candidateId] : [],
    ),
  );
  return [...latestByCandidate.values()].filter(
    (candidate) => !acceptedIds.has(candidate.candidateId),
  );
}

async function collectReservedCandidateIds(project: RegisteredProject) {
  return reservedCandidateAliases(project.planningPath, GRAPH_ROOT);
}

async function readAllWhatsNextRuns(project: RegisteredProject) {
  const root = path.join(project.planningPath, 'whats-next', 'runs');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^RUN-/i.test(entry.name))
      .map((entry) => readWhatsNextRun(project, entry.name).catch(() => null)),
  );
  const visible = records.filter(
    (record): record is WhatsNextRunRecord => record !== null,
  );
  const superseded = new Set(
    visible.flatMap((run) =>
      run.replacement?.state === 'applied' ? run.replacement.runIds : [],
    ),
  );
  return visible.filter((run) => !superseded.has(run.runId));
}

const mutationRuntime = globalThis as typeof globalThis & {
  whatsNextMutations?: Map<string, Promise<unknown>>;
};
const mutations = (mutationRuntime.whatsNextMutations ??= new Map());

async function mutateWhatsNext<T>(
  project: RegisteredProject,
  work: () => Promise<T>,
) {
  const previous = mutations.get(project.planningPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  mutations.set(project.planningPath, next);
  try {
    return await next;
  } finally {
    if (mutations.get(project.planningPath) === next)
      mutations.delete(project.planningPath);
  }
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

function whatsNextRunPath(project: RegisteredProject, runId: string) {
  validateRunId(runId);
  return path.join(project.planningPath, 'whats-next', 'runs', runId);
}

function plainSummary(markdown: string) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

function validateRunId(runId: string) {
  if (!/^RUN-[0-9a-f-]{36}$/i.test(runId)) {
    throw new PublicApiError("The What's next Run identifier is invalid.", 400);
  }
}

function runKey(project: RegisteredProject, runId: string) {
  return `${project.id}:${runId}`;
}

function getActiveRuns() {
  const runtime = globalThis as typeof globalThis & {
    __praxisWhatsNextRuns?: Map<string, ActiveRun>;
  };
  runtime.__praxisWhatsNextRuns ??= new Map<string, ActiveRun>();
  return runtime.__praxisWhatsNextRuns;
}

async function prepareWhatsNextSubmission(
  project: RegisteredProject,
  output: string,
  input: WhatsNextValidationContextInput,
  log: MaterializationLog = () => undefined,
) {
  const envelope = parseWhatsNextHarnessResult(
    output,
    whatsNextValidationContext(input),
  );
  const { record, nodes, revisionTarget } = input;
  if (revisionTarget && !revisionTarget.uid) {
    throw new MaterializationError(
      'identity',
      `Candidate ${revisionTarget.candidateId} has no stable identity to revise.`,
    );
  }
  if (record.operation === 'refine-candidate' && !revisionTarget) {
    throw new MaterializationError(
      'validation',
      'A refine Run must resolve the Candidate it is revising.',
    );
  }
  const subject = {
    intention: record.intention ?? 'mvp-exploration',
    motion: record.motion ?? 'unspecified',
    sourceNodeIds: record.sourceNodeIds,
    knownNodeIds: nodes.map((node) => node.id),
    acceptedCandidateIds: nodes.flatMap((node) =>
      node.provenance?.candidateId ? [node.provenance.candidateId] : [],
    ),
    knownResourcePaths: input.knownResourcePaths,
    reservedCandidateIds: input.reservedCandidateIds,
    currentCandidates: input.knownCandidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      revision: candidate.revision,
      dependsOn: [...candidate.dependsOn],
    })),
  };
  const basis = await prepareProductExplorationMaterializationBasis(
    project,
    revisionTarget?.uid
      ? {
          ...subject,
          operation: 'refine-candidate',
          revisionTarget: {
            candidateId: revisionTarget.candidateId,
            revision: revisionTarget.revision,
            uid: revisionTarget.uid,
          },
          revisionSource: toProductExplorationCandidate(
            revisionTarget,
            new Set(),
          ),
        }
      : { ...subject, operation: 'explore' },
  );
  log(
    materializationLogEntry(
      'materialization.basis.prepared',
      `Prepared the ${basis.operation} Basis at fingerprint ${basis.fingerprint.slice(0, 12)}.`,
    ),
  );
  return {
    envelope,
    basis,
    semantic: toProductExplorationSemanticResult(envelope),
  };
}

async function writeProducerEvidence(
  project: RegisteredProject,
  runId: string,
  activity: WhatsNextRunRecord['activity'],
  envelope: WhatsNextHarnessResult,
) {
  const runPath = whatsNextRunPath(project, runId);
  await mkdir(runPath, { recursive: true });
  await writeAgentGraphRunEvidence(runPath, {
    activity: activity ?? [],
    summary: renderWhatsNextSummaryMarkdown(envelope),
    response: renderWhatsNextResponseMarkdown(envelope),
  });
  const reflectionPath = path.join(runPath, 'reflection.md');
  if (
    !(await access(reflectionPath)
      .then(() => true)
      .catch(() => false))
  ) {
    await writeFile(
      reflectionPath,
      `${envelope.reflection.markdown.trim()}\n`,
      {
        flag: 'wx',
      },
    );
  }
  const responsePath = path.join(runPath, 'response.md');
  const responseMarkdown = renderWhatsNextResponseMarkdown(envelope);
  const existingResponse = await readFile(responsePath, 'utf8').catch(() => '');
  if (existingResponse !== responseMarkdown) {
    const temporaryResponsePath = `${responsePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryResponsePath, responseMarkdown, { flag: 'wx' });
    await rename(temporaryResponsePath, responsePath);
  }
}

async function ensureCandidateArtifacts(
  project: RegisteredProject,
  record: WhatsNextRunRecord,
) {
  if (!record.result) return;
  const runPath = whatsNextRunPath(project, record.runId);
  await writeAgentGraphRunEvidence(runPath, {
    activity: record.activity ?? [],
    summary: renderWhatsNextSummaryMarkdown(record.result),
    response: renderWhatsNextResponseMarkdown(record.result),
  });
  const reflectionPath = path.join(runPath, 'reflection.md');
  if (
    !(await access(reflectionPath)
      .then(() => true)
      .catch(() => false))
  ) {
    await writeFile(
      reflectionPath,
      `${record.result.reflection.markdown.trim()}\n`,
      {
        flag: 'wx',
      },
    );
  }
  const responsePath = path.join(runPath, 'response.md');
  const responseMarkdown = renderWhatsNextResponseMarkdown(record.result);
  const existingResponse = await readFile(responsePath, 'utf8').catch(() => '');
  if (existingResponse !== responseMarkdown) {
    const temporaryResponsePath = `${responsePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryResponsePath, responseMarkdown, { flag: 'wx' });
    await rename(temporaryResponsePath, responsePath);
  }
  if (record.result.outcome !== 'proposal') return;
  await stageCandidateDocuments(
    runPath,
    record.result.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      markdown:
        candidate.outputMarkdown ?? renderLegacyCandidateMarkdown(candidate),
    })),
  );
}

async function writeWhatsNextCheckpoint(
  project: RegisteredProject,
  record: WhatsNextRunRecord,
) {
  if (!record.result) return;
  if (!/^SESSION-[0-9a-f-]{36}$/i.test(record.sessionId)) {
    throw new PublicApiError(
      "The What's Next Session identifier is invalid.",
      400,
    );
  }
  const sessionPath = path.join(
    project.planningPath,
    'whats-next',
    'sessions',
    record.sessionId,
  );
  await mkdir(sessionPath, { recursive: true });
  const activeCandidates = new Map(
    (await collectLatestUnacceptedCandidates(project)).map((candidate) => [
      candidate.candidateId,
      candidate,
    ]),
  );
  if (record.result.outcome === 'proposal') {
    for (const candidate of record.result.candidates) {
      activeCandidates.set(candidate.candidateId, candidate);
    }
  }
  const checkpoint = {
    schemaVersion: 1,
    sessionId: record.sessionId,
    providerSessionId: record.agentSessionId,
    latestRunId: record.runId,
    updatedAt: record.updatedAt,
    sourceNodeIds: record.sourceNodeIds,
    operation: record.operation,
    status: record.status,
    candidateRevisions: Object.fromEntries(
      [...activeCandidates.values()].map((candidate) => [
        candidate.candidateId,
        candidate.revision,
      ]),
    ),
    unresolvedFeedback: [],
    contextIndexPath: `whats-next/runs/${record.runId}/context/index.json`,
    reflectionPath: `whats-next/runs/${record.runId}/reflection.md`,
    responsePath: `whats-next/runs/${record.runId}/response.md`,
  };
  const filePath = path.join(sessionPath, 'checkpoint.json');
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}

function renderLegacyCandidateMarkdown(candidate: WhatsNextCandidate) {
  const legacyAssumptions = (
    candidate as WhatsNextCandidate & { assumptions?: string[] }
  ).assumptions;
  const assumptions = legacyAssumptions?.length
    ? legacyAssumptions.map((assumption) => `- ${assumption}`).join('\n')
    : '- None';
  return `# ${candidate.title}

${candidate.summary}

## Why this direction

- This direction was generated by the legacy What's Next Harness.
- Review its original Run evidence before accepting or refining it.

## Assumptions

${assumptions}`;
}
