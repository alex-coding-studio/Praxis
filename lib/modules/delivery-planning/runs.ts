import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import {
  sameModelSelection,
  validateAgentProfile,
  type AgentProfile,
} from '../../agents/profile.ts';
import {
  createAgentGraphActivityRecorder,
  initialAgentGraphActivity,
  initializeAgentGraphActivity,
  writeAgentGraphRunEvidence,
  type AgentGraphActivity,
  type AgentGraphActivityRecorder,
} from '../../graph/agent/run.ts';
import { PublicApiError } from '../../api-errors.ts';
import { assertDeliveryMapPreservesTargets } from '../delivery/map-boundary.ts';
import {
  startLocalAgentRun,
  type LocalAgentRun,
  type LocalAgentUsage,
} from '../../agents/transport.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import {
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
import { prepareWhatToDoContext, type WhatToDoRunInput } from './context.ts';
import {
  createWhatToDoHarnessRequest,
  parseWhatToDoHarnessResult,
  WHAT_TO_DO_HARNESS_REVISION,
  whatToDoHarnessPrompt,
  type WhatToDoHarnessRequest,
  type WhatToDoHarnessResult,
} from './harness.ts';
import {
  materializeWhatToDoDeliveryMap,
  renderWhatToDoContract,
  whatToDoContractCandidateId,
  whatToDoKnownCandidates,
  whatToDoKnownSourceClaims,
  type WhatToDoDeliveryMap,
  whatToDoCurrentMapPromptView,
} from './map.ts';
import { readWhatToDoRunDraft } from './run-draft.ts';
import {
  atomicWhatToDoText,
  readWhatToDoCurrentMap,
  readWhatToDoCurrentMapWithFingerprint,
  whatToDoDirectory,
  whatToDoRunDirectory,
  writeWhatToDoCurrentMap,
  writeWhatToDoRepositorySummary,
} from './storage.ts';
import {
  planningService,
  type PlanningCard,
} from '../implementation/planning-service.ts';
import { deliveryContractPlanningSource } from '../implementation/planning-sources.ts';
import { withDeliveryState } from '../../delivery-state-lock.ts';
import { toDeliveryMapSemanticResult } from './producer-adapter.ts';
import { MaterializationError } from '../../materialization/receipt.ts';
import { prepareDeliveryMapBasis, type DeliveryMapBasis } from './basis.ts';

export type WhatToDoRunRecord = {
  schemaVersion: 1;
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  sourceUids: string[];
  contextRefs: string[];
  repositoryEvidencePaths: string[];
  focusContractIds: string[];
  clarificationRunId: string | null;
  attachmentNames: string[];
  profile: AgentProfile;
  startedAt: string;
  endedAt: string | null;
  agentSessionId: string | null;
  usage: LocalAgentUsage | null;
  sessionUsage?: LocalAgentUsage | null;
  activity: AgentGraphActivity[];
  request: WhatToDoHarnessRequest;
  result: WhatToDoHarnessResult | null;
  map: WhatToDoDeliveryMap | null;
  error: string | null;
  logRef?: string;
  hostPid?: number;
  cancelRequestedAt?: string;
  response?: ResponseClassification;
};

type ActiveRun = {
  runId: string;
  cancel: () => void;
  canceled: boolean;
  settling: boolean;
  terminal: WhatToDoRunRecord | null;
  activity: AgentGraphActivity[];
  recorder: AgentGraphActivityRecorder | null;
  agentOutput: string | null;
  reservation: ActiveRunReservation | null;
};
const WHAT_TO_DO_RETAINED = 'The Delivery Map was not changed.';

const runtime = globalThis as typeof globalThis & {
  whatToDoRuns?: Map<string, ActiveRun>;
};
const activeRuns = (runtime.whatToDoRuns ??= new Map<string, ActiveRun>());

export async function startWhatToDoRun(
  project: RegisteredProject,
  input: WhatToDoRunInput,
  transport = startLocalAgentRun,
) {
  validateAgentProfile(input.profile);
  const key = project.planningPath;
  if (activeRuns.get(key)?.terminal) activeRuns.delete(key);
  const runId = `RUN-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const activity = initialAgentGraphActivity(
    'Preparing the What to Do delivery map.',
    startedAt,
  );
  const active: ActiveRun = {
    runId,
    cancel: () => undefined,
    canceled: false,
    settling: false,
    terminal: null,
    activity,
    recorder: null,
    agentOutput: null,
    reservation: null,
  };
  let run!: WhatToDoRunRecord;
  let prepared!: Awaited<ReturnType<typeof prepareWhatToDoContext>>;
  let currentMap: WhatToDoDeliveryMap | null = null;
  let coordinatorRun = null as WhatToDoRunRecord | null;
  let basis = null as DeliveryMapBasis | null;
  let effectiveInput: WhatToDoRunInput = input;
  const { reservation } = await beginModuleRun(project, 'what-to-do', {
    runId,
    subject: { kind: 'module', label: 'Delivery Map' },
    agentProfile: input.profile,
    startMessage: `Delivery Planning Run started with ${input.profile.agent}`,
    validate: async () => {
      const current = await readWhatToDoCurrentMapWithFingerprint(project);
      currentMap = current.map;
      basis = prepareDeliveryMapBasis(project, {
        currentMap: current.map,
        currentMapFingerprint: current.fingerprint,
      });
      const clarificationRun = await resolveClarificationRun(
        project,
        input.clarificationRunId,
        currentMap,
      );
      effectiveInput = clarificationRun
        ? await amendClarificationInput(project, clarificationRun, input)
        : input;
      if (
        clarificationRun?.agentSessionId &&
        clarificationRun.request.harness.revision ===
          WHAT_TO_DO_HARNESS_REVISION &&
        clarificationRun.profile.agent === effectiveInput.profile.agent &&
        sameModelSelection(clarificationRun.profile, effectiveInput.profile)
      ) {
        coordinatorRun = clarificationRun;
      } else if (currentMap) {
        const currentMapRun = await readWhatToDoRun(project, currentMap.runId);
        if (
          currentMapRun.status !== 'succeeded' ||
          currentMapRun.map?.runId !== currentMap.runId
        )
          throw new Error('The current What to Do Map has no committed Run.');
        if (
          currentMapRun.agentSessionId &&
          currentMapRun.profile.agent === effectiveInput.profile.agent &&
          sameModelSelection(currentMapRun.profile, effectiveInput.profile) &&
          currentMapRun.request.harness.revision === WHAT_TO_DO_HARNESS_REVISION
        )
          coordinatorRun = currentMapRun;
      }
      return { clarificationRun };
    },
    prepare: async () => {
      prepared = await prepareWhatToDoContext(project, runId, {
        ...effectiveInput,
        currentMap,
      });
      return async () => {
        await rm(await whatToDoRunDirectory(project, runId), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      };
    },
    persist: async (reservation, { clarificationRun }) => {
      const rollback = async () => undefined;
      try {
        const contextRoot = await relativeContextRoot(
          project,
          prepared.workspace.root,
        );
        const request = createWhatToDoHarnessRequest({
          sessionId:
            clarificationRun?.request.request.sessionId ??
            coordinatorRun?.request.request.sessionId ??
            `SESSION-${randomUUID()}`,
          requestId: runId,
          contextRoot,
          content: prepared.packet,
          operation: currentMap ? 'adjust-map' : 'create-map',
          currentMapPath: currentMap ? 'what-to-do/current-map.json' : null,
          focusCandidateIds: currentMap
            ? (effectiveInput.focusContractIds ?? []).map((contractId) =>
                whatToDoContractCandidateId(
                  currentMap!.contracts.find(
                    (contract) => contract.id === contractId,
                  )!,
                ),
              )
            : [],
          sourceFeatures: prepared.sources,
          repository: {
            factsPath: 'what-to-do/repository-context/facts.json',
            fingerprint: prepared.repositoryFacts.fingerprint,
            reusable: prepared.repositoryFacts.reusable,
            summaryPath: prepared.packet.references.some(
              (entry) => entry.kind === 'repository-summary',
            )
              ? 'what-to-do/repository-context/summary.md'
              : null,
          },
          domain: {
            stateVersion: prepared.domainModel.stateVersion,
            summaryPath: 'domain-model/domain-model-summary.md',
            modelPath: 'domain-model/domain-model.json',
          },
        });
        run = {
          schemaVersion: 1,
          id: runId,
          status: 'running' as const,
          sourceUids: [...new Set(effectiveInput.sourceUids)],
          contextRefs: [...new Set(effectiveInput.contextRefs ?? [])],
          repositoryEvidencePaths: [
            ...new Set(effectiveInput.repositoryEvidencePaths ?? []),
          ],
          focusContractIds: [...new Set(effectiveInput.focusContractIds ?? [])],
          clarificationRunId: clarificationRun?.id ?? null,
          attachmentNames: (effectiveInput.files ?? []).map(
            (file) => file.name,
          ),
          profile: structuredClone(effectiveInput.profile),
          startedAt,
          endedAt: null,
          agentSessionId: null,
          usage: null,
          sessionUsage: null,
          activity,
          request,
          result: null,
          map: null,
          error: null,
          logRef: reservation.logRef,
          hostPid: process.pid,
        };
        const runPath = await whatToDoRunDirectory(project, runId);
        await initializeAgentGraphActivity(runPath, activity);
        active.recorder = createAgentGraphActivityRecorder(runPath, activity);
        await writeRunRecord(project, run);
        await atomicWhatToDoText(
          path.join(runPath, 'request.json'),
          `${JSON.stringify(request, null, 2)}\n`,
        );
      } catch (error) {
        await rollback();
        throw error;
      }
      return rollback;
    },
  });
  active.reservation = reservation;
  activeRuns.set(key, active);
  const recorder = active.recorder!;
  const agentRun = transport(effectiveInput.profile.agent, {
    workingDirectory: project.codePath ?? project.rootPath,
    protectedPath: project.planningPath,
    environment: whatToDoAgentEnvironment(),
    prompt: whatToDoHarnessPrompt(run.request),
    model: effectiveInput.profile.model || undefined,
    effort: effectiveInput.profile.effort || undefined,
    resumeSessionId: coordinatorRun?.agentSessionId ?? undefined,
    sessionUsageBaseline:
      coordinatorRun?.sessionUsage ?? coordinatorRun?.usage ?? undefined,
    access: 'read-only',
    disableDelegation: true,
    isolatedProcessGroup: true,
    onActivity: (event) => {
      recorder.onActivity(event);
      reservation.record(agentActivityEntry(event));
    },
  });
  active.cancel = agentRun.cancel;
  reservation.attach(agentRun);
  settleLater(project, run, active, agentRun, prepared, currentMap, basis);
  return run;
}

async function resolveClarificationRun(
  project: RegisteredProject,
  clarificationRunId: string | undefined,
  currentMap: WhatToDoDeliveryMap | null,
) {
  if (!clarificationRunId) return null;
  if (!/^RUN-[0-9a-f-]{36}$/.test(clarificationRunId))
    throw new PublicApiError('The Clarification Run is invalid.', 400);
  const latest = (await listLatestWhatToDoRuns(project, 1))[0];
  if (
    !latest ||
    latest.id !== clarificationRunId ||
    latest.status !== 'succeeded' ||
    latest.result?.outcome !== 'clarification' ||
    ![1, 2, WHAT_TO_DO_HARNESS_REVISION].includes(
      latest.request.harness.revision,
    )
  )
    throw new PublicApiError(
      'The Clarification is no longer the current What to Do request.',
      409,
    );
  if ((latest.request.operation === 'adjust-map') !== Boolean(currentMap))
    throw new PublicApiError(
      'The Delivery Map changed after this Clarification.',
      409,
    );
  if (currentMap) {
    const mapEntry = latest.request.content.references.find(
      (entry) => entry.kind === 'delivery-map',
    );
    const currentMapHash = createHash('sha256')
      .update(
        `${JSON.stringify(whatToDoCurrentMapPromptView(currentMap), null, 2)}\n`,
      )
      .digest('hex');
    if (!mapEntry || mapEntry.sha256 !== currentMapHash)
      throw new PublicApiError(
        'The Delivery Map changed after this Clarification.',
        409,
      );
  }
  return latest;
}

async function amendClarificationInput(
  project: RegisteredProject,
  clarificationRun: WhatToDoRunRecord,
  input: WhatToDoRunInput,
): Promise<WhatToDoRunInput> {
  const answer = input.instruction.trim();
  if (!answer)
    throw new PublicApiError('A Clarification Answer is required.', 400);
  if (clarificationRun.result?.outcome !== 'clarification')
    throw new Error('The What to Do clarification result was lost.');
  const draft = await readWhatToDoRunDraft(project, clarificationRun);
  const files = [
    ...draft.files.map(
      (file) => new File([file.content], file.name, { type: file.mediaType }),
    ),
    ...(input.files ?? []),
  ];
  return {
    ...input,
    instruction: `${draft.instruction.trim()}\n\n## Clarification\n\n${clarificationRun.result.clarification.question.trim()}\n\n## Clarification Answer\n\n${answer}`,
    sourceUids: [
      ...new Set([...clarificationRun.sourceUids, ...input.sourceUids]),
    ],
    contextRefs: [
      ...new Set([
        ...clarificationRun.contextRefs,
        ...(input.contextRefs ?? []),
      ]),
    ],
    repositoryEvidencePaths: [
      ...new Set([
        ...clarificationRun.repositoryEvidencePaths,
        ...(input.repositoryEvidencePaths ?? []),
      ]),
    ],
    focusContractIds: [
      ...new Set([
        ...clarificationRun.focusContractIds,
        ...(input.focusContractIds ?? []),
      ]),
    ],
    files,
    clarificationContent: clarificationRun.request.content,
  };
}

function settleLater(
  project: RegisteredProject,
  run: WhatToDoRunRecord,
  active: ActiveRun,
  agentRun: LocalAgentRun,
  prepared: Awaited<ReturnType<typeof prepareWhatToDoContext>>,
  currentMap: WhatToDoDeliveryMap | null,
  basis: DeliveryMapBasis | null,
) {
  void agentRun.completion
    .then(async (agent) => {
      if (active.canceled) return;
      active.settling = true;
      active.agentOutput = agent.finalOutput;
      active.reservation?.setPhase('finalizing', 'HOST');
      const result = parseWhatToDoHarnessResult(agent.finalOutput, {
        request: run.request.request,
        operation: run.request.operation,
        knownSources: prepared.knownSources,
        requiredSourcePaths: prepared.requiredSourcePaths,
        userInput: prepared.userInput,
        knownEvidencePaths: prepared.knownEvidencePaths,
        evidencePathAliases: prepared.evidencePathAliases,
        ...(currentMap
          ? {
              knownCandidates: whatToDoKnownCandidates(currentMap),
              knownSourceClaims: whatToDoKnownSourceClaims(currentMap),
              focusCandidateIds: run.request.focusCandidateIds,
            }
          : {}),
      });
      const endedAt = new Date().toISOString();
      const semantic = toDeliveryMapSemanticResult(result, {
        formalContractIdByCandidateId: Object.fromEntries(
          (basis?.currentMap?.contracts ?? []).map((contract) => [
            whatToDoContractCandidateId(contract),
            contract.id,
          ]),
        ),
      });
      const map =
        semantic.outcome === 'map-proposal'
          ? materializeWhatToDoDeliveryMap({
              runId: run.id,
              updatedAt: endedAt,
              sourceUids: [
                ...(basis?.currentMap?.sourceUids ?? []),
                ...run.sourceUids,
              ],
              result: semantic,
              basis: {
                currentMap: basis?.currentMap ?? null,
                userInput: {
                  path: prepared.userInput.path,
                  sha256: prepared.userInput.sha256,
                },
              },
              sourceSnapshots: prepared.sourceSnapshots,
            })
          : null;
      const classification = classifyModuleRun(
        result.outcome === 'map-proposal'
          ? {
              runState: 'settled',
              outcome: 'proposal',
              summary: mapSummary(map),
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
      const terminal: WhatToDoRunRecord = {
        ...run,
        status: 'succeeded',
        endedAt,
        agentSessionId: agent.agentSessionId,
        usage: agent.usage,
        sessionUsage: agent.sessionUsage ?? agent.usage,
        activity: [...active.activity],
        result,
        map,
        error: null,
        response: classification,
      };
      const runPath = await whatToDoRunDirectory(project, run.id);
      await active.recorder?.flush();
      await writeAgentGraphRunEvidence(runPath, {
        activity: terminal.activity,
        agentOutput: agent.finalOutput,
        summary: renderRunSummary(result),
        response: result.responseMarkdown,
      });
      if (map)
        await Promise.all(
          map.contracts
            .filter((contract) =>
              contract.outputPath.startsWith(
                `what-to-do/runs/${run.id}/contracts/`,
              ),
            )
            .map(async (contract) => {
              const directory = path.join(runPath, 'contracts', contract.id);
              await mkdir(directory, { recursive: true });
              await atomicWhatToDoText(
                path.join(directory, 'output.md'),
                renderWhatToDoContract(contract),
              );
            }),
        );
      if (map) {
        await stageTerminalRunRecord(project, terminal);
        await publishDeliveryMap(project, map, planningService, basis);
        await publishTerminalRunRecord(project, run.id).catch(() => undefined);
      } else {
        await writeRunRecord(project, terminal);
      }
      await writeWhatToDoRepositorySummary(
        project,
        result.repositorySummary.markdown,
        run.request.repository.fingerprint,
      ).catch(() => undefined);
      active.terminal = terminal;
      if (active.reservation)
        await settleRun(active.reservation, { classification, endedAt });
    })
    .catch(async (error: unknown) => {
      if (active.canceled) return;
      active.settling = true;
      const original = error instanceof Error ? error.message : String(error);
      active.reservation?.record({
        level: 'ERROR',
        actor: 'HOST',
        phase: 'FINALIZE',
        event: active.agentOutput ? 'result.rejected' : 'agent.failed',
        message: original,
      });
      const classification = classifyModuleRun({
        runState: 'settled',
        failure: {
          kind: moduleRunFailureKind(error, active.agentOutput),
          message: original,
        },
      });
      const message =
        error instanceof PublicApiError || error instanceof MaterializationError
          ? error.message
          : `${classification.detail} ${WHAT_TO_DO_RETAINED}`;
      const terminal: WhatToDoRunRecord = {
        ...run,
        status: 'failed',
        endedAt: new Date().toISOString(),
        activity: [...active.activity],
        result: null,
        map: null,
        error: message,
        response: classification,
      };
      const runPath = await whatToDoRunDirectory(project, run.id);
      await rm(path.join(runPath, 'terminal.json'), { force: true }).catch(
        () => undefined,
      );
      await active.recorder?.flush().catch(() => undefined);
      await writeAgentGraphRunEvidence(runPath, {
        activity: terminal.activity,
        summary: `# Failed\n\n${message}\n`,
        response: `# Failed\n\n${message}\n`,
        agentOutput: active.agentOutput ?? String(error),
      }).catch(() => undefined);
      await writeRunRecord(project, terminal).catch(() => undefined);
      active.terminal = terminal;
      if (active.reservation)
        await settleRun(active.reservation, { classification }).catch(
          () => undefined,
        );
    })
    .finally(() => {
      if (activeRuns.get(project.planningPath) === active)
        activeRuns.delete(project.planningPath);
    });
}

type DeliveryPlanningStore = Pick<
  typeof planningService,
  'list' | 'stageDeleteCard'
>;

export async function publishDeliveryMap(
  project: RegisteredProject,
  map: WhatToDoDeliveryMap,
  store: DeliveryPlanningStore = planningService,
  basis: DeliveryMapBasis | null = null,
) {
  await withDeliveryState(project, async () => {
    await assertDeliveryMapPreservesTargets(project, map);
    if (basis) {
      const { fingerprint } =
        await readWhatToDoCurrentMapWithFingerprint(project);
      if (fingerprint !== basis.currentMapFingerprint) {
        throw new MaterializationError(
          'stale-basis',
          'The current Delivery Map changed after this Run was prepared.',
        );
      }
    }
    const nextSources = new Map(
      map.contracts.map((contract) => {
        const source = deliveryContractPlanningSource(contract);
        return [source.uid, source] as const;
      }),
    );
    const superseded = (await store.list(project)).filter((card) => {
      if (card.source.module !== 'what-to-do') return false;
      const source = nextSources.get(card.source.uid);
      return (
        !source ||
        source.id !== card.source.id ||
        source.version !== card.source.version
      );
    });
    const protectedCards = superseded.filter(planningCardProtectsDeliveryMap);
    if (protectedCards.length)
      throw new PublicApiError(
        `The Delivery Map cannot replace Contracts already in progress: ${protectedCards.map((card) => card.source.title).join(', ')}.`,
        409,
      );
    const staged: Array<
      Awaited<ReturnType<DeliveryPlanningStore['stageDeleteCard']>>
    > = [];
    try {
      for (const card of superseded)
        staged.push(
          await store.stageDeleteCard(project, card.id, card.revision),
        );
      await writeWhatToDoCurrentMap(project, map);
    } catch (error) {
      await Promise.allSettled(
        staged.reverse().map((transition) => transition.rollback()),
      );
      throw error;
    }
    await Promise.allSettled(staged.map((transition) => transition.finalize()));
  });
}

function planningCardProtectsDeliveryMap(card: PlanningCard) {
  return Boolean(
    card.run?.status === 'running' ||
    card.plan?.status === 'finalized' ||
    card.actions.length ||
    card.execution?.runs.length,
  );
}

export async function cancelWhatToDoRun(
  project: RegisteredProject,
  runId: string,
) {
  const active = activeRuns.get(project.planningPath);
  if (!active || active.runId !== runId)
    throw new PublicApiError('The What to Do Run is not active.', 400);
  if (active.settling)
    throw new PublicApiError('The What to Do Run is already finishing.', 409);
  active.canceled = true;
  const reservation = active.reservation;
  const interruptedPhase = reservation?.phase ?? 'executing';
  const stop = reservation ? await stopModuleRun(reservation) : 'confirmed';
  if (!reservation) active.cancel();
  await active.recorder?.flush();
  const classification = classifyModuleRun(
    stop === 'confirmed'
      ? {
          runState: 'canceled',
          interruptedPhase,
          interruptedActor: 'AGENT',
          retainedNote: WHAT_TO_DO_RETAINED,
        }
      : { runState: 'termination-unconfirmed', interruptedActor: 'AGENT' },
  );
  const current = await readWhatToDoRun(project, runId);
  const canceled: WhatToDoRunRecord = {
    ...current,
    status: stop === 'confirmed' ? 'canceled' : 'failed',
    endedAt: new Date().toISOString(),
    activity: [...active.activity],
    error: stop === 'confirmed' ? null : classification.detail,
    response: classification,
  };
  active.terminal = canceled;
  const document = `# ${classification.title}\n\n${classification.detail}\n`;
  await writeAgentGraphRunEvidence(await whatToDoRunDirectory(project, runId), {
    activity: canceled.activity,
    summary: document,
    response: document,
  });
  await writeRunRecord(project, canceled);
  if (reservation) await settleRun(reservation, { classification });
  if (activeRuns.get(project.planningPath) === active)
    activeRuns.delete(project.planningPath);
  return canceled;
}

export async function readWhatToDoRun(
  project: RegisteredProject,
  runId: string,
) {
  const currentActive = activeRuns.get(project.planningPath);
  if (!currentActive || currentActive.runId !== runId)
    await reconcileTerminalRunRecord(project, runId);
  const file = path.join(
    await whatToDoRunDirectory(project, runId),
    'run.json',
  );
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
    throw new Error('Invalid What to Do Run record.');
  const stored = JSON.parse(
    await readFile(file, 'utf8'),
  ) as Partial<WhatToDoRunRecord>;
  const run = {
    ...stored,
    focusContractIds: Array.isArray(stored.focusContractIds)
      ? stored.focusContractIds
      : [],
    clarificationRunId: stored.clarificationRunId ?? null,
    map: stored.map ?? null,
  } as WhatToDoRunRecord;
  if (
    run.schemaVersion !== 1 ||
    run.id !== runId ||
    !['running', 'succeeded', 'failed', 'canceled'].includes(run.status)
  )
    throw new Error('Invalid What to Do Run record.');
  const active = currentActive;
  if (active?.runId === run.id && active.terminal) return active.terminal;
  if (active?.runId === run.id && active.settling)
    return {
      ...run,
      status: 'running' as const,
      endedAt: null,
      result: null,
      map: null,
    };
  if (run.status === 'running' && active?.runId === run.id)
    return { ...run, activity: [...active.activity] };
  if (run.status === 'running') {
    const interrupted: WhatToDoRunRecord = {
      ...run,
      status: 'failed' as const,
      endedAt: info.mtime.toISOString(),
      error: 'The What to Do Agent Run was interrupted.',
    };
    await writeAgentGraphRunEvidence(
      await whatToDoRunDirectory(project, runId),
      {
        activity: interrupted.activity,
        summary:
          '# Interrupted\n\nThe What to Do Agent Run was interrupted before completion.\n',
        response:
          '# Interrupted\n\nThe What to Do Agent Run was interrupted before completion.\n',
      },
    );
    await writeRunRecord(project, interrupted);
    return interrupted;
  }
  return run;
}

export async function listLatestWhatToDoRuns(
  project: RegisteredProject,
  limit = 12,
) {
  const root = await whatToDoDirectory(project, ['runs']);
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const runs = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && /^RUN-[0-9a-f-]{36}$/.test(entry.name),
      )
      .map((entry) => readWhatToDoRun(project, entry.name)),
  );
  return runs
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit);
}

async function relativeContextRoot(
  project: RegisteredProject,
  contextPath: string,
) {
  const relative = path.relative(
    await realpath(project.codePath ?? project.rootPath),
    contextPath,
  );
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`))
    throw new Error('What to Do Context is outside the project.');
  return relative.split(path.sep).join('/');
}

async function writeRunRecord(
  project: RegisteredProject,
  run: WhatToDoRunRecord,
) {
  await atomicWhatToDoText(
    path.join(await whatToDoRunDirectory(project, run.id), 'run.json'),
    `${JSON.stringify(run, null, 2)}\n`,
  );
}

async function stageTerminalRunRecord(
  project: RegisteredProject,
  run: WhatToDoRunRecord,
) {
  await atomicWhatToDoText(
    path.join(await whatToDoRunDirectory(project, run.id), 'terminal.json'),
    `${JSON.stringify(run, null, 2)}\n`,
  );
}

async function publishTerminalRunRecord(
  project: RegisteredProject,
  runId: string,
) {
  const directory = await whatToDoRunDirectory(project, runId);
  await rename(
    path.join(directory, 'terminal.json'),
    path.join(directory, 'run.json'),
  );
}

async function reconcileTerminalRunRecord(
  project: RegisteredProject,
  runId: string,
) {
  const directory = await whatToDoRunDirectory(project, runId);
  const terminalFile = path.join(directory, 'terminal.json');
  try {
    const info = await lstat(terminalFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
      throw new Error('Invalid What to Do terminal Run record.');
    const terminal = JSON.parse(
      await readFile(terminalFile, 'utf8'),
    ) as WhatToDoRunRecord;
    const currentMap = await readWhatToDoCurrentMap(project);
    if (
      terminal.schemaVersion === 1 &&
      terminal.id === runId &&
      terminal.status === 'succeeded' &&
      terminal.map?.runId === runId &&
      currentMap?.runId === runId
    ) {
      await publishTerminalRunRecord(project, runId);
      return;
    }
    await rm(terminalFile, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function mapSummary(map: WhatToDoDeliveryMap | null) {
  if (!map) return 'The Delivery Map proposal is ready for review.';
  const count = map.contracts.length;
  return `${count} Delivery ${count === 1 ? 'Contract' : 'Contracts'} proposed. Review the Delivery Map to continue.`;
}

function renderRunSummary(result: WhatToDoHarnessResult) {
  if (result.outcome === 'map-proposal') {
    const dependencyUpdates = result.contractDependencyUpdates?.length ?? 0;
    return `# Delivery Map\n\nApplied ${result.candidates.length + dependencyUpdates} Contract changes: ${result.candidates.length} new or replacement boundaries and ${dependencyUpdates} dependency-only updates.\n`;
  }
  if (result.outcome === 'clarification')
    return `# Clarification\n\n${result.clarification.question}\n`;
  if (result.outcome === 'insufficient-evidence')
    return `# More evidence needed\n\n${result.missingEvidence.map((item) => `- ${item}`).join('\n')}\n`;
  return `# No change\n\n${result.reason}\n`;
}

export function whatToDoAgentEnvironment(
  source: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'COLORTERM',
    'NODE_ENV',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ];
  return Object.fromEntries(
    allowed.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  ) as NodeJS.ProcessEnv;
}
