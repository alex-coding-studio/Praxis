import { PublicApiError } from '../../api-errors.ts';
import { actionPublicationBranch } from './action-publication.ts';
import {
  startCoordinatedExecution,
  CoordinationRunError,
  totalCoordinationUsage,
  type CoordinatedResult,
  type CoordinationProgress,
} from './coordination-runner.ts';
import type { PriorEvidence } from './coordination.ts';
import { redactActivity } from '../../agents/activity.ts';
import {
  hasUnsupportedAppArtifact,
  hasReviewableReport,
} from './result-display.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  validateAcceptanceCriteria,
  assessRequiredChecks,
  type AcceptanceCriterion,
} from './checklist.ts';
import { getGitHubRepositoryUrl } from '../../project-registry.ts';
import {
  ensureCardWorkspace,
  cardGitWritePaths,
  verifyCardWorkspace,
  workspaceProject,
  restartCardWorkspace,
  restartCardWorkspaceAt,
  undoWorkspaceRestart,
  type CardWorkspace,
} from './worktree.ts';
import {
  discoverGitHubDelivery,
  refreshGitHubDelivery,
  githubReader,
  verifiedGitHubArtifactRefs,
} from '../../github-delivery.ts';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import {
  checkpointWorkspace,
  includeInGitHistory,
  restoreCheckpoint,
} from './git.ts';
import {
  validateAgentProfile,
  type AgentProfile,
} from '../../agents/profile.ts';
import {
  assertCurrentPlanningCardSource,
  planningService,
  readPlanningInstructions,
  type PlanningCard,
} from './planning-service.ts';
import { withDeliveryState } from '../../delivery-state-lock.ts';
import {
  appendCardWorkRecord,
  readCardWorkDocument,
  readCardWorklog,
  type CardWorkRecord,
} from './worklog.ts';
import {
  ExecutionEvidenceError,
  assertCardUuid,
  buildCardHarnessPrompt,
  createCardHarnessRequest,
  parseCardHarnessResult,
  type CardHarnessRequest,
} from './harness.ts';
import {
  startLocalAgentRun,
  type LocalAgentRun,
} from '../../agents/transport.ts';
import { startEventDrivenWorkerRun } from '../../agents/event-driven-transport.ts';
import { readCodexSkills } from '../../agents/skills.ts';
import {
  captureLocalAcceptanceArtifacts,
  observedChanges,
  observedGitCommits,
  verifiedOutputVersionRefs,
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from './artifacts.ts';
import type { ActionRun, ExecuteActionInput } from './execution-types.ts';
import { prepareCardEnvironment } from '../../card-host-operations.ts';
import { resolveProductContextReferences } from '../product-context/resource.ts';
import { workerPacketPrompt } from './delivery-packet.ts';
import {
  beginRun,
  listActiveRuns,
  requestStop,
  settleRun,
  type ActiveRunReservation,
} from '../../execution-observability/active-runs.ts';
import {
  clearLatestResponse,
  publishLatestResponse,
} from '../../execution-observability/latest-response-store.ts';
import { openRunLog } from '../../execution-observability/run-log.ts';
import {
  classifyResponse,
  type ClassificationFacts,
} from '../../execution-observability/status.ts';
import type {
  JobLogReference,
  LogActor,
  LogPhase,
  ResponseClassification,
  RunPhase,
} from '../../execution-observability/types.ts';
import {
  runHostOperation,
  type HostOperationKind,
} from '../../execution-observability/host-operations.ts';
import type { CardHostOperation } from './execution-types.ts';
import type { CheckOverride } from './checklist.ts';
import {
  cardOwner,
  cardResponseDocument,
  cardRunLogPaths,
  cardRunSubject,
  retainedEffectsOf,
} from './execution-response.ts';

const exec = promisify(execFile);

type Active = {
  id: string;
  cardId: string;
  handle: LocalAgentRun | null;
  timer: ReturnType<typeof setTimeout> | null;
  canceling?: boolean;
  timeoutError?: Error;
  progress?: CoordinationProgress;
  activity?: CoordinationProgress[];
  reservation?: ActiveRunReservation | null;
  jobs?: JobLogReference[];
};

function actorForProgress(progress: CoordinationProgress): LogActor {
  if (progress.actor) return progress.actor;
  if (/^Running job: |^Finished: /.test(progress.summary)) return 'JOB';
  return ['prepare', 'dispatch', 'qualify', 'complete'].includes(progress.phase)
    ? 'COORDINATOR'
    : 'WORKER';
}

function runPhaseForProgress(progress: CoordinationProgress): RunPhase {
  if (progress.job?.status === 'running') return 'verifying';
  if (progress.phase === 'complete') return 'finalizing';
  return ['prepare', 'dispatch', 'qualify'].includes(progress.phase)
    ? 'coordinating'
    : 'executing';
}

function logPhaseForProgress(progress: CoordinationProgress): LogPhase {
  if (progress.job || actorForProgress(progress) === 'JOB') return 'VERIFY';
  if (progress.phase === 'prepare' || progress.phase === 'dispatch')
    return 'PREPARE';
  if (progress.phase === 'qualify' || progress.phase === 'complete')
    return 'FINALIZE';
  return 'EXECUTE';
}

function jobReference(
  project: Project,
  job: NonNullable<CoordinationProgress['job']>,
): JobLogReference {
  return {
    jobId: job.jobId,
    label: job.label,
    ref: path.isAbsolute(job.logRef)
      ? path.relative(project.planningPath, job.logRef)
      : job.logRef,
  };
}

async function loggedCardOperation<T>(
  project: Project,
  input: { kind: HostOperationKind; label: string; cardId: string },
  work: (operation: CardHostOperation) => Promise<T>,
) {
  const outcome = await runHostOperation(project, input, async (context) => {
    context.log.append({
      level: 'INFO',
      actor: 'HOST',
      phase: 'RECOVERY',
      event: 'operation.card',
      message: `Card ${input.cardId}`,
    });
    return work({
      id: context.operationId,
      kind: input.kind,
      label: input.label,
      status: 'completed',
      logUrlPath: context.logUrlPath,
      endedAt: new Date().toISOString(),
    });
  });
  return outcome.result;
}

async function recordOwnershipLoss(
  project: Project,
  card: PlanningCard,
  run: ActionRun,
  classification: ResponseClassification,
) {
  if (run.logRef) {
    try {
      const log = await openRunLog(path.join(project.planningPath, run.logRef));
      log.append({
        level: 'ERROR',
        actor: 'HOST',
        phase: 'RECOVERY',
        event: 'recovery.ownership-lost',
        message: `Host process ${run.hostPid} no longer owns this Run; closing it as Fail`,
      });
      await log.close();
    } catch {}
  }
  await publishLatestResponse(
    cardOwner(project, card.id),
    cardResponseDocument(project, card, run, classification, {
      retained: retainedEffectsOf(run, run.observedRefs.length),
      jobLogs: run.jobs,
    }),
  ).catch(() => undefined);
}

async function publishRecheck(
  project: Project,
  card: PlanningCard,
  run: ActionRun,
  classification: ResponseClassification,
  event: 'recovery.reread' | 'recovery.override' = 'recovery.reread',
) {
  if (run.logRef) {
    try {
      const log = await openRunLog(path.join(project.planningPath, run.logRef));
      log.append({
        level: classification.status === 'completed' ? 'INFO' : 'WARN',
        actor: 'HOST',
        phase: 'RECOVERY',
        event,
        message:
          event === 'recovery.reread'
            ? `Re-read the saved result without starting an Agent: ${classification.title}`
            : `User override satisfied the required checklist: ${classification.title}`,
      });
      await log.close();
    } catch {}
  }
  await publishLatestResponse(
    cardOwner(project, card.id),
    cardResponseDocument(project, card, run, classification, {
      retained: retainedEffectsOf(run, run.observedRefs.length),
      jobLogs: run.jobs,
    }),
    { allowTerminalReplace: true },
  ).catch(() => undefined);
}

export function classifyActionRun(
  run: ActionRun,
  input: {
    runState?: ClassificationFacts['runState'];
    failure?: ClassificationFacts['failure'];
    accepted?: boolean;
    retained?: ClassificationFacts['retained'];
    interruptedPhase?: RunPhase | null;
    interruptedActor?: LogActor | null;
    overrides?: Record<string, CheckOverride>;
  } = {},
): ResponseClassification {
  const result = run.result;
  const decision = run.coordination?.decisions.at(-1);
  const effective =
    result && run.acceptanceChecklist
      ? assessRequiredChecks(
          run.acceptanceChecklist,
          result.checks,
          input.overrides,
        )
      : null;
  const overridden = effective?.passed
    ? (result?.checks ?? []).filter((check) => check.status !== 'passed')
    : [];
  const satisfied = new Set([
    ...(result?.checks ?? [])
      .filter((check) => check.status === 'passed' && check.criterionId)
      .map((check) => check.criterionId!),
    ...Object.keys(input.overrides ?? {}),
  ]);
  const userDecisions = (decision?.verificationPlan ?? []).filter(
    (item) => item.mode === 'needs-user-decision',
  );
  const decisionResolved =
    decision?.decision === 'needs-user' &&
    userDecisions.length > 0 &&
    Boolean(effective?.passed) &&
    userDecisions.every((item) => satisfied.has(item.criterionId));
  const activeDecision = decisionResolved ? null : decision;
  const semantic =
    activeDecision &&
    (activeDecision.decision === 'needs-user' ||
      activeDecision.decision === 'blocked') &&
    activeDecision.title &&
    activeDecision.detail
      ? { title: activeDecision.title, detail: activeDecision.detail }
      : null;
  const checks = result?.checks ?? [];
  return classifyResponse({
    surface: 'card',
    runState: input.runState ?? 'settled',
    outcome: result
      ? result.outcome === 'delivered' ||
        (result.outcome === 'blocked' &&
          (decisionResolved || (!decision && overridden.length > 0)))
        ? 'delivered'
        : result.outcome === 'blocked'
          ? 'blocked'
          : 'failed'
      : null,
    coordinatorDecision:
      activeDecision?.decision === 'needs-user' ||
      activeDecision?.decision === 'blocked'
        ? activeDecision.decision
        : null,
    requiredChecks: result
      ? effective?.passed
        ? { total: checks.length, passed: checks.length, failed: 0, notRun: 0 }
        : {
            total: checks.length,
            passed: checks.filter((check) => check.status === 'passed').length,
            failed: checks.filter((check) => check.status === 'failed').length,
            notRun: checks.filter((check) => check.status === 'not-run').length,
          }
      : null,
    additionalFindings: [
      ...overridden.map(
        (check) =>
          `Accepted by user override: ${check.summary} (${check.status})`,
      ),
      ...(result?.additionalChecks ?? [])
        .filter((check) => check.status !== 'passed')
        .map((check) => check.summary),
      ...(run.evidenceErrors ?? []).filter(() => run.status === 'succeeded'),
    ],
    failure: input.failure ?? null,
    interruptedPhase: input.interruptedPhase ?? null,
    interruptedActor: input.interruptedActor ?? null,
    retained: input.retained ?? null,
    accepted: input.accepted ?? false,
    semantic,
    summary: overridden.length
      ? `User overrides satisfied the remaining required ${overridden.length === 1 ? 'check' : 'checks'} (${overridden.map((check) => check.summary).join(', ')}). The original report and its findings remain in the Run Log.`
      : (result?.summary ?? null),
  });
}
const runtime = globalThis as typeof globalThis & {
  jdiExecutionActive?: Map<string, Active>;
};
const sharedActive = (runtime.jdiExecutionActive ??= new Map());
const root = (project: Parameters<typeof planningService.read>[0]) =>
  path.join(project.planningPath, 'implementation/cards');
type Project = Parameters<typeof planningService.read>[0];
const cardKey = (project: Project, cardId: string) =>
  `card:${path.resolve(project.planningPath)}:${cardId}`;
const reference = (card: PlanningCard, file: string) =>
  `implementation/cards/${card.id}/${String(card.revision + 1).padStart(8, '0')}/${file}`;

export function resumableWorkerSession(
  runs: ActionRun[] | undefined,
  actionId: string,
  profile: AgentProfile,
) {
  const latest = runs?.findLast((run) => run.actionId === actionId);
  const sessionId = latest?.agentSessionId;
  if (
    sessionId &&
    runs?.some((run) =>
      run.coordination?.attempts.some(
        (attempt) =>
          attempt.role === 'coordinator' && attempt.sessionId === sessionId,
      ),
    )
  )
    return undefined;
  return latest &&
    (latest.status === 'succeeded' || latest.status === 'failed') &&
    latest.agentSessionId &&
    latest.profile.agent === profile.agent &&
    latest.profile.model === profile.model
    ? latest.agentSessionId
    : undefined;
}

function supplementalExecutionInput(input: ExecuteActionInput) {
  const contextRefs = input.contextRefs ?? [];
  const files = input.files ?? [];
  if (
    !Array.isArray(contextRefs) ||
    !Array.isArray(files) ||
    contextRefs.length > 50 ||
    contextRefs.some((ref) => typeof ref !== 'string' || !ref) ||
    files.length > 20 ||
    files.some(
      (file) =>
        typeof file?.name !== 'string' ||
        !/\.(md|markdown|txt|html|htm)$/i.test(file.name) ||
        typeof file.content !== 'string' ||
        Buffer.byteLength(file.content) > 1_000_000,
    ) ||
    files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) >
      1_000_000
  )
    throw new PublicApiError('Invalid execution resources.', 400);
  return { contextRefs: [...new Set(contextRefs)], files };
}

function baselineRevision(cardId: string, ref?: string) {
  if (!ref) return null;
  const parts = ref.split('/');
  if (
    parts.length !== 5 ||
    parts[0] !== 'implementation' ||
    parts[1] !== 'cards' ||
    parts[2] !== cardId ||
    !/^\d{8}$/.test(parts[3]!) ||
    parts[4] !== 'baseline.json'
  )
    return null;
  return Number(parts[3]);
}

async function readActionBaseline(
  project: Project,
  card: PlanningCard,
  run: ActionRun,
) {
  const readAt = async (revision: number) => {
    const value: unknown = JSON.parse(
      await readCardWorkDocument(
        root(project),
        card.id,
        revision,
        'baseline.json',
      ),
    );
    const baseline = value as Partial<WorkspaceSnapshot>;
    if (
      typeof baseline.root !== 'string' ||
      typeof baseline.head !== 'string' ||
      !/^[0-9a-f]{40,64}$/.test(baseline.head) ||
      typeof baseline.files !== 'object' ||
      baseline.files === null ||
      Object.values(baseline.files).some((entry) => typeof entry !== 'string')
    )
      throw new Error('Invalid Action baseline snapshot.');
    return baseline as WorkspaceSnapshot & { head: string };
  };
  const recorded = baselineRevision(card.id, run.baselineRef);
  if (recorded !== null) return readAt(recorded);
  const log = await readCardWorklog(root(project), card.id);
  for (const entry of log.entries) {
    if (
      entry.record.kind !== 'user-input' ||
      entry.record.actionId !== run.actionId
    )
      continue;
    try {
      const request = JSON.parse(
        await readCardWorkDocument(
          root(project),
          card.id,
          entry.revision,
          'request.json',
        ),
      ) as { requestId?: unknown };
      if (request.requestId === run.id) return readAt(entry.revision);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Action baseline snapshot is unavailable.');
}

function orderedFiles(
  snapshot: WorkspaceSnapshot,
  omitted = new Set<string>(),
) {
  return Object.fromEntries(
    Object.entries(snapshot.files)
      .filter(([file]) => !omitted.has(file))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function copyPreservedBaselineFiles(
  sourceRoot: string,
  targetRoot: string,
  files: string[],
) {
  for (const file of files) {
    const source = path.resolve(sourceRoot, file);
    const target = path.resolve(targetRoot, file);
    if (
      !source.startsWith(sourceRoot + path.sep) ||
      !target.startsWith(targetRoot + path.sep)
    )
      throw new Error('Unsafe preserved baseline path.');
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { force: true });
    await cp(source, target, { force: true, verbatimSymlinks: true });
  }
}

async function restoreBaselineModes(
  rootPath: string,
  files: Record<string, string>,
  omitted: Set<string>,
) {
  for (const [file, fingerprint] of Object.entries(files)) {
    if (omitted.has(file)) continue;
    if (fingerprint.startsWith('link:')) continue;
    const match = fingerprint.match(/^(\d{1,3}):[0-9a-f]{64}$/);
    const mode = Number(match?.[1]);
    if (!match || !Number.isInteger(mode) || mode < 0 || mode > 0o777)
      throw new Error('Invalid Action baseline file mode.');
    const absolute = path.resolve(rootPath, file);
    if (!absolute.startsWith(rootPath + path.sep))
      throw new Error('Unsafe Action baseline mode path.');
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Action baseline mode target is not a regular file.');
    await chmod(absolute, mode);
  }
}

async function trackedFilesAt(repository: string, commit: string) {
  const output = (
    await exec(
      'git',
      ['-C', repository, 'ls-tree', '-r', '--name-only', '-z', commit],
      { timeout: 10000, maxBuffer: 20_000_000 },
    )
  ).stdout;
  return new Set(output.split('\0').filter(Boolean));
}

export function createExecutionService(
  store = planningService,
  transport = startLocalAgentRun,
  active = sharedActive,
  timeoutMs = 7200000,
  reader = githubReader,
  provisionWorkspace: (
    project: Project,
    card: PlanningCard,
    initializeRepository?: boolean,
  ) => Promise<CardWorkspace | undefined> = ensureCardWorkspace,
  writeRecord = appendCardWorkRecord,
  coordinate = startCoordinatedExecution,
  workerTransport?: typeof startLocalAgentRun,
) {
  async function commit(
    project: Project,
    card: PlanningCard,
    record: CardWorkRecord,
    files: Record<string, string> = {},
  ) {
    const next = {
      ...card,
      revision: card.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeRecord(root(project), card.id, card.revision, record, {
      ...files,
      'planning-state.json': JSON.stringify(next),
    });
    return next;
  }

  async function refresh(
    project: Project,
    card: PlanningCard,
  ): Promise<PlanningCard> {
    const run = card.execution?.runs.at(-1);
    const live = active.get(cardKey(project, card.id));
    if (run?.status === 'running' && live?.id === run.id && live.progress)
      return replaceRun(card, { ...run, progress: live.progress });
    if (
      run?.status !== 'running' ||
      active.get(cardKey(project, card.id))?.id === run.id
    )
      return card;
    if (run.hostPid !== process.pid) {
      try {
        process.kill(run.hostPid, 0);
        return card;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const error =
      'Execution was interrupted. Files may have changed; nothing was rolled back. Inspect the workspace before retrying.';
    const classification = classifyActionRun(run, {
      runState: 'ownership-lost',
    });
    const next = replaceRun(card, {
      ...run,
      status: 'failed',
      endedAt: new Date().toISOString(),
      error,
      response: classification,
    });
    try {
      const committed = await commit(project, next, {
        kind: 'system-event',
        stage: 'execution',
        actionId: run.actionId,
        event: 'run-ended',
        text: error,
        refs: [],
      });
      await recordOwnershipLoss(
        project,
        committed,
        committed.execution!.runs.at(-1)!,
        classification,
      );
      return committed;
    } catch (error) {
      if (/revision conflict/.test(String(error)))
        return store.read(project, card.id);
      throw error;
    }
  }

  async function finish(
    project: Project,
    request: CardHarnessRequest,
    baseline: WorkspaceSnapshot,
    outcome: Awaited<LocalAgentRun['completion']> | Error,
  ) {
    try {
      const canceling = active.get(cardKey(project, request.context.cardId));
      if (canceling?.id === request.requestId && canceling.canceling) return;
      const card = await store.read(project, request.context.cardId);
      const run = card.execution?.runs.at(-1);
      if (
        run?.id !== request.requestId ||
        run.status !== 'running' ||
        card.revision !== request.context.contextRevision
      )
        return;
      const workingProject = workspaceProject(
        project,
        card.execution?.workspace,
      );
      let refs: string[] = [];
      let snapshot: WorkspaceSnapshot | null = null;
      let nextRun: ActionRun = {
        ...run,
        endedAt: new Date().toISOString(),
        agentSessionId:
          outcome instanceof Error ? null : outcome.agentSessionId,
        usage: outcome instanceof Error ? null : outcome.usage,
        executionAccess:
          outcome instanceof Error ? undefined : outcome.executionAccess,
      };
      const files: Record<string, string> = {};
      if (!(outcome instanceof Error))
        files['raw-response.txt'] = outcome.finalOutput.slice(0, 1000000);
      const coordinated =
        outcome instanceof CoordinationRunError
          ? outcome
          : !(outcome instanceof Error) && 'coordination' in outcome
            ? (outcome as CoordinatedResult)
            : undefined;
      if (coordinated) {
        nextRun.coordination = {
          ...coordinated.coordination,
          logRef: reference(card, 'coordination.json'),
        };
        nextRun.usage = totalCoordinationUsage(coordinated.coordination);
        files['coordination.json'] = JSON.stringify(nextRun.coordination);
        for (const [name, text] of Object.entries(
          coordinated.coordinationRecords,
        ))
          files[`coordination-${name}`] = text;
      }
      const live = active.get(cardKey(project, request.context.cardId));
      const owner = live?.id === request.requestId ? live.reservation : null;
      const jobLogs = live?.jobs ?? [];
      const activity = live?.activity ?? [];
      if (jobLogs.length) nextRun.jobs = jobLogs;
      if (owner) nextRun.logRef = owner.logRef;
      const timedOut =
        outcome instanceof Error && /timed out/i.test(outcome.message);
      if (activity.length) {
        nextRun.activityRef = reference(card, 'activity.json');
        nextRun.progress = activity.at(-1);
        files['activity.json'] = JSON.stringify(activity);
      }
      try {
        snapshot = await snapshotWorkspace(workingProject);
        nextRun.verificationBasis = verificationBasis(snapshot);
        refs = observedChanges(baseline, snapshot);
        files['observed-workspace.json'] = JSON.stringify(snapshot);
        const checkpointHash = await checkpointWorkspace(
          project,
          card.id,
          snapshot,
          run.parentCommit ?? card.execution!.git!.head,
          run.id,
          `Action ${run.actionId}\nRound ${run.id}\n${card.source.title}`,
        );
        nextRun = { ...nextRun, commit: checkpointHash };
        refs.push(`checkpoint:${run.id}`);
        refs = [
          ...new Set([
            ...refs,
            ...(await observedGitCommits(baseline, snapshot)),
          ]),
        ];
        if (card.execution?.workspace)
          await verifyCardWorkspace(card.execution.workspace);
        if (outcome instanceof Error) throw outcome;
        let result;
        try {
          result = parseCardHarnessResult(
            outcome.finalOutput,
            request,
            card.revision,
            refs,
          );
        } catch (error) {
          if (!(error instanceof ExecutionEvidenceError)) throw error;
          const versions = await verifiedOutputVersionRefs(
            snapshot,
            error.result.artifactRefs,
          );
          const attachments = await captureLocalAcceptanceArtifacts(
            snapshot,
            error.result.artifactRefs,
            nextRun.endedAt!,
          );
          files['local-artifacts.json'] = JSON.stringify({
            capturedAt: new Date().toISOString(),
            artifacts: attachments,
          });
          versions.push(...attachments.map((item) => item.ref));
          const verified = await verifiedGitHubArtifactRefs(
            workingProject,
            error.result.artifactRefs,
            snapshot.head,
            reader,
          );
          if (!verified.length && !versions.length) throw error;
          nextRun.verifiedExternalRefs = verified;
          nextRun.verifiedVersionRefs = versions;
          files['verified-references.json'] = JSON.stringify({
            checkedAt: new Date().toISOString(),
            external: verified,
            versions,
            meaning:
              'Verified delivery/version references, not a claim that files or commits changed during this Round.',
          });
          result = parseCardHarnessResult(
            outcome.finalOutput,
            request,
            card.revision,
            [...refs, ...verified, ...versions],
          );
        }
        if (result.stage !== 'execution')
          throw new Error('Expected an execution response.');
        const outputRef = reference(card, 'output.md');
        nextRun = {
          ...nextRun,
          status: 'succeeded',
          result,
          error: null,
          observedRefs: refs,
          outputRef,
        };
        nextRun.github = await discoverGitHubDelivery(
          workingProject,
          JSON.stringify(result),
          baseline.head,
          reader,
          snapshot.head,
          card.execution?.workspace
            ? actionPublicationBranch(
                card.execution.workspace.branch,
                run.actionId,
              )
            : undefined,
        );
        files['github-delivery.json'] = JSON.stringify(nextRun.github);
        nextRun.unverifiedCheckRefs = unverifiedCheckRefs(result, request, [
          ...refs,
          ...(nextRun.verifiedExternalRefs ?? []),
          ...(nextRun.verifiedVersionRefs ?? []),
        ]);
        nextRun.response = classifyActionRun(nextRun, {
          retained: retainedEffectsOf(nextRun, refs.length),
          overrides: card.execution?.acceptanceOverrides?.[run.actionId],
        });
        files['result.json'] = JSON.stringify(result);
        files['output.md'] =
          `# Action output\n\n${result.summary}\n\nOutcome: ${result.outcome}\n\n## Observed changes\n${refs.map((ref) => `- ${ref}`).join('\n')}\n\n## Required self-checks\n${result.checks.map((check) => `- ${check.status}: ${check.summary}`).join('\n')}\n\n## Additional checks (non-blocker)\n${(result.additionalChecks ?? []).map((check) => `- ${check.status}: ${check.summary}`).join('\n')}\n\n## Remaining\n${result.remaining.map((item) => `- ${item}`).join('\n')}`;
        await commit(
          project,
          replaceRun(card, nextRun),
          {
            kind: 'agent-note',
            stage: 'execution',
            actionId: run.actionId,
            basedOnRevision: card.revision,
            summary: result.handoffSummary.slice(0, 600),
            currentState:
              `Goal: ${card.source.title}\nPlan: finalized.\nAccepted Actions: ${card.execution?.acceptedActionIds.join(', ') || 'none'}\nCurrent Action: ${run.actionId}\nOutput: ../${String(card.revision + 1).padStart(8, '0')}/output.md\nGit checkpoint: ${nextRun.commit ?? 'unavailable'}\nGit history: ../versions.git\n${result.handoffSummary}\nNext: user validates this output or supplies follow-up. Do not start another Action.`.slice(
                0,
                6000,
              ),
          },
          files,
        );
        if (owner)
          await settleRun(owner, {
            classification: nextRun.response!,
            retained: retainedEffectsOf(nextRun, refs.length),
            jobLogs,
            endedAt: nextRun.endedAt ?? undefined,
          }).catch(() => undefined);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Execution failed.';
        const workerReport =
          error instanceof CoordinationRunError ? error.workerReport : null;
        const advisoryOnly =
          Boolean(coordinated) &&
          error instanceof ExecutionEvidenceError &&
          assessRequiredChecks(
            run.acceptanceChecklist,
            error.result.checks,
            card.execution?.acceptanceOverrides?.[run.actionId],
          ).passed;
        nextRun = {
          ...nextRun,
          status: advisoryOnly ? 'succeeded' : 'failed',
          error: advisoryOnly ? null : message,
          observedRefs: refs,
          result:
            error instanceof ExecutionEvidenceError
              ? error.result
              : workerReport,
          ...(error instanceof ExecutionEvidenceError
            ? {
                evidenceErrors: [error.message],
                unverifiedCheckRefs: unverifiedCheckRefs(
                  error.result,
                  request,
                  refs,
                ),
              }
            : {}),
        };
        if (nextRun.result)
          files[
            advisoryOnly
              ? 'result.json'
              : workerReport
                ? 'worker-report.json'
                : 'rejected-report.json'
          ] = JSON.stringify(nextRun.result);
        if (snapshot) {
          nextRun.github = await discoverGitHubDelivery(
            workingProject,
            nextRun.result ? JSON.stringify(nextRun.result) : '',
            baseline.head,
            reader,
            snapshot.head,
            card.execution?.workspace
              ? actionPublicationBranch(
                  card.execution.workspace.branch,
                  run.actionId,
                )
              : undefined,
          );
          files['github-delivery.json'] = JSON.stringify(nextRun.github);
        }
        owner?.record({
          level: 'ERROR',
          actor: 'HOST',
          phase: 'FINALIZE',
          event: advisoryOnly ? 'result.advisory' : 'result.rejected',
          message,
        });
        nextRun.response = classifyActionRun(nextRun, {
          runState: timedOut ? 'timed-out' : 'settled',
          retained: retainedEffectsOf(nextRun, refs.length),
          overrides: card.execution?.acceptanceOverrides?.[run.actionId],
          failure:
            advisoryOnly || timedOut
              ? null
              : error instanceof ExecutionEvidenceError
                ? { kind: 'host-verification', message }
                : nextRun.result
                  ? null
                  : /valid report|parse|schema|JSON/i.test(message)
                    ? { kind: 'parse', message }
                    : { kind: 'unknown', message },
        });
        await commit(
          project,
          replaceRun(card, nextRun),
          {
            kind: 'system-event',
            stage: 'execution',
            actionId: run.actionId,
            event: 'run-ended',
            text: advisoryOnly
              ? `Required checks passed. Advisory artifact verification finding retained: ${message}`
              : `${message}\nFiles may have changed; no rollback was performed.`,
            refs,
          },
          files,
        );
        if (owner)
          await settleRun(owner, {
            classification: nextRun.response,
            retained: retainedEffectsOf(nextRun, refs.length),
            jobLogs,
            endedAt: nextRun.endedAt ?? undefined,
          }).catch(() => undefined);
      }
    } finally {
      const running = active.get(cardKey(project, request.context.cardId));
      if (running?.id === request.requestId && !running.canceling) {
        if (running.timer) clearTimeout(running.timer);
        active.delete(cardKey(project, request.context.cardId));
      }
    }
  }

  async function startUnlocked(project: Project, input: ExecuteActionInput) {
    assertCardUuid(input.cardId);
    assertCardUuid(input.actionId);
    validateAgentProfile(input.profile);
    const supplemental = supplementalExecutionInput(input);
    if (input.coordination) {
      validateAgentProfile(input.coordination.profile);
    }
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      typeof input.instruction !== 'string' ||
      input.instruction.length > 20000
    )
      throw new PublicApiError('Invalid execution input.', 400);
    const settling = active.get(cardKey(project, input.cardId));
    if (
      settling?.reservation?.settled &&
      settling.reservation.stopResult !== 'unconfirmed'
    ) {
      await settling.reservation.released;
      if (active.get(cardKey(project, input.cardId)) === settling)
        active.delete(cardKey(project, input.cardId));
    }
    if (active.has(cardKey(project, input.cardId)))
      throw new PublicApiError('This Card already has a running Action.', 409);
    const reservation: Active = {
      id: randomUUID(),
      cardId: input.cardId,
      handle: null,
      timer: null,
    };
    active.set(cardKey(project, input.cardId), reservation);
    try {
      const cards = await store.list(project);
      let card = await store.read(project, input.cardId);
      if (
        (await refresh(project, card)).execution?.runs.at(-1)?.status ===
        'running'
      )
        throw new PublicApiError(
          'This Card already has a running Action.',
          409,
        );
      await assertCurrentPlanningCardSource(project, card);
      if (card.revision !== input.expectedRevision)
        throw new PublicApiError(
          'Card changed. Reload before trying again.',
          409,
        );
      if (card.run?.status === 'running')
        throw new PublicApiError('Stop planning before executing.', 400);
      const dependencyReview = await store.dependencyReview(project, card);
      if (dependencyReview.length)
        throw new Error(
          `Review unfinished lineage before execution: ${dependencyReview.map((item) => item.uid).join(', ')}`,
        );
      const coordinationSettings = {
        profile:
          input.coordination?.profile ??
          card.execution?.coordinationSettings?.profile ??
          card.run?.profile ??
          input.profile,
      };
      validateAgentProfile(coordinationSettings.profile);
      const selectedAction = card.actions.find(
        (action) => action.id === input.actionId,
      );
      const criteria = validateAcceptanceCriteria(
        selectedAction?.acceptanceCriteria,
      );
      const acceptanceChecklist = {
        version: createHash('sha256')
          .update(JSON.stringify(criteria))
          .digest('hex'),
        items: structuredClone(criteria),
      };
      const dependencyResources: Array<{ ref: string; description: string }> =
        [];
      for (const id of card.source.dependsOn) {
        const prerequisite = cards.find(
          (item) => item.source.uid === id || item.source.id === id,
        );
        if (
          !prerequisite?.actions.length ||
          prerequisite.actions.some(
            (action) =>
              !prerequisite.execution?.acceptedActionIds.includes(action.id),
          )
        )
          throw new Error(
            `Accept prerequisite ${id} before executing this goal.`,
          );
        for (const actionId of prerequisite.execution!.acceptedActionIds) {
          const run = prerequisite.execution!.runs.findLast(
            (candidate) => candidate.actionId === actionId,
          );
          if (run?.outputRef)
            dependencyResources.push({
              ref: path.join(project.planningPath, run.outputRef),
              description: `Accepted prerequisite ${prerequisite.source.title}, Action ${actionId}`,
            });
        }
      }
      card = await ensureAcceptedOutputRefs(project, card);
      const productContext = await resolveProductContextReferences(
        project,
        supplemental.contextRefs,
        ['task-execution'],
      );
      const uploadedDocuments = Object.fromEntries(
        supplemental.files.map((file, index) => [
          `input-resource-${index + 1}.md`,
          file.content,
        ]),
      );
      const uploadedResources = supplemental.files.map((file, index) => {
        const ref = reference(card, `input-resource-${index + 1}.md`);
        return {
          ref: path.join(project.planningPath, ref),
          description: `Supplemental Markdown: ${file.name}`,
        };
      });
      const log = await readCardWorklog(root(project), card.id);
      const previous = card.execution?.runs.findLast(
        (run) => run.actionId === input.actionId && run.result,
      );
      const resources = [
        {
          ref: path.join(project.planningPath, card.sourceRef),
          description: 'Retained source goal.',
        },
        ...card.resources.map((item) => ({
          ref: path.join(project.planningPath, item.ref),
          description: item.name,
        })),
        ...(card.planRef
          ? [
              {
                ref: path.join(project.planningPath, card.planRef),
                description: 'Signed-off Plan. Do not change its scope.',
              },
            ]
          : []),
        ...(log.handoffPath
          ? [
              {
                ref: log.handoffPath,
                description: 'Read the Card handoff and relevant references.',
              },
            ]
          : []),
        ...(card.execution?.acceptedActionIds ?? []).flatMap((id) => {
          const accepted = card.execution!.runs.findLast(
            (run) => run.actionId === id,
          );
          return accepted?.outputRef
            ? [
                {
                  ref: path.join(project.planningPath, accepted.outputRef),
                  description: `Accepted Action ${id}: read its output and follow handoff references for feedback.`,
                },
              ]
            : [];
        }),
        ...productContext.map((resource) => ({
          ref: path.join(project.planningPath, resource.path),
          description: `Supplemental Product Context: ${resource.fileName}`,
        })),
        ...uploadedResources,
        ...dependencyResources,
      ];
      const request = createCardHarnessRequest(
        {
          cardId: card.id,
          contextRevision: card.revision + 1,
          goal: `${card.source.title}\n${card.source.summary}\nUser requirements: ${card.requirements}`,
          moduleInstructions: await readPlanningInstructions(project),
          skills: [],
          acceptanceChecklist,
          acceptanceOverrides:
            card.execution?.acceptanceOverrides?.[input.actionId] ?? {},
          resources,
          handoffMarkdown: log.handoffMarkdown,
          plan: card.plan,
          acceptedActionIds: card.execution?.acceptedActionIds ?? [],
          currentOutput: previous
            ? {
                id: previous.id,
                actionId: input.actionId,
                refs: previous.observedRefs,
              }
            : null,
          execution: {
            running: false,
            hasOutput: Boolean(previous),
            effects: card.execution?.runs.length ? 'unknown' : 'clean',
            rollbackConfirmed: false,
            consumedByCardIds: [],
          },
        },
        'execution',
        input.instruction ||
          'Implement the selected Action and return its output for user validation.',
        input.actionId,
      );
      const workspace = await provisionWorkspace(project, card, true);
      const workingProject = workspaceProject(project, workspace);
      const environment = workspace
        ? await prepareCardEnvironment({
            cardId: card.id,
            projectId: project.id,
            workspace,
            roles: {
              commit: 'agent-bot',
              delivery: 'bot',
              approval: 'user',
            },
            outputPath: path.join(
              project.planningPath,
              'implementation/cards',
              card.id,
              'environment.json',
            ),
          })
        : undefined;
      const baseline = await snapshotWorkspace(workingProject);
      let git = card.execution?.git;
      if (!git) {
        const baselineCommit = await checkpointWorkspace(
          project,
          card.id,
          baseline,
          null,
          randomUUID(),
          `Execution baseline\n${card.source.title}`,
        );
        git = {
          baseline: baselineCommit,
          head: baselineCommit,
          firstTrackedRunId: request.requestId,
        };
      }
      if (
        !card.execution?.runs.some((run) => run.actionId === input.actionId)
      ) {
        const actionBaseline = await checkpointWorkspace(
          project,
          card.id,
          baseline,
          git.head,
          randomUUID(),
          `Action baseline\n${input.actionId}\n${card.source.title}`,
        );
        git = { ...git, head: actionBaseline };
      }
      const packetDir = path.join(
        root(project),
        card.id,
        'delivery-packets',
        git.firstTrackedRunId,
        input.actionId,
      );
      reservation.id = request.requestId;
      const retryInputs = { ...card.execution?.retryInputs };
      delete retryInputs[input.actionId];
      const run: ActionRun = {
        id: request.requestId,
        actionId: input.actionId,
        status: 'running',
        input: input.instruction,
        profile: structuredClone(input.profile),
        startedAt: new Date().toISOString(),
        endedAt: null,
        hostPid: process.pid,
        agentSessionId: null,
        usage: null,
        result: null,
        error: null,
        observedRefs: [],
        outputRef: null,
        parentCommit: git.head,
        acceptanceChecklist,
        baselineRef: reference(card, 'baseline.json'),
      };
      const runtimeInstructions = `Work only in ${baseline.root}. This is the Card-owned worktree on branch ${workspace?.branch ?? 'legacy'}. Keep all Actions and Rounds on this branch. The primary checkout ${project.codePath ?? project.rootPath} is not your editing directory. Never switch this worktree to main, reset the primary checkout, or merge into main. When the user explicitly names another local project or repository as a reference, the execution Agent may locate one unambiguous matching repository under ${path.dirname(project.codePath ?? project.rootPath)} and read or search only the files needed to understand the requested implementation style, organization or behavior. Treat that repository as a read-only example, keep the current Action and acceptance criteria authoritative, never copy it wholesale, and report a missing or ambiguous match instead of guessing a path. Repository commits and pushes belong on this Card branch; only the agreed PR delivery process may merge to main. The planning store ${project.planningPath} is host-owned; do not edit it or call Praxis mutation APIs. Preserve pre-existing user changes. The host has prepared the local repository and Card branch. Do not reinitialize Git or create a replacement branch. Creating a GitHub repository or publishing branches still requires the signed-off Action or explicit user instruction. A local empty baseline does not authorize pushing the default branch to GitHub. If initializing or publishing a project repository, exclude .praxis/ before staging; never publish the host-owned planning store or its private Git history. No automatic merge, rollback, acceptance, or next Action. Use file:relative/path for changed files, deleted:relative/path for removals, or git:full-commit-hash for a commit newly reachable from the final project HEAD in artifactRefs. Command descriptions and external URLs may be included in check evidenceRefs, but remain Agent-reported unless independently verified. Real GitHub repository or PR URLs may appear in artifactRefs; the host verifies the current origin and remote identity, and requires PR HEAD to match this output. A repository link identifies the delivery location, not proof of new files or completed work. The host checks these against before/after snapshots. artifactRefs identify the resulting deliverable or version, not a list of new changes. You may cite an existing file inside this workspace or a commit reachable from the output HEAD when validating or publishing existing work; state clearly when no code changed. Do not cite unrelated input resources, missing files or invented URLs. The host records actual changes separately. Include actual PR URLs in the output summary when PRs were produced; the host queries GitHub to verify their state. Checks are your reported evidence, not user acceptance. The host records a new local Git checkpoint for this round. You may reference checkpoint:${request.requestId} as this round's workspace snapshot when reporting checks without file changes; explicitly state that no code changed and do not invent completed functionality. If permissions prevent an operation, report blocked; never bypass sandbox restrictions. Return the required JSON, not a Markdown envelope.`;
      const usesDeliveryPacket = coordinate === startCoordinatedExecution;
      const prompt = usesDeliveryPacket
        ? workerPacketPrompt(path.join(packetDir, 'Manifest.md'), request)
        : `${buildCardHarnessPrompt(request, {
            includeHandoff: false,
            includeSkills: false,
          })}\n\nExecution runtime: ${runtimeInstructions}`;
      if (
        !workspace &&
        listActiveRuns(project.planningPath).some(
          (other) => other.owner.kind === 'card' && other.sharedCheckout,
        )
      )
        throw new PublicApiError(
          'Another Card is running in the shared checkout. Wait for it to finish.',
          409,
        );
      let saved!: PlanningCard;
      const subject = cardRunSubject(card, input.actionId);
      const logPaths = cardRunLogPaths(project, card.id, request.requestId);
      const { reservation: owner } = await beginRun({
        owner: cardOwner(project, card.id),
        runId: request.requestId,
        logFile: logPaths.logFile,
        logRef: logPaths.logRef,
        subject,
        actionId: input.actionId,
        agentProfile: input.profile,
        sharedCheckout: !workspace,
        startMessage: `${subject.label} started with ${input.profile.agent}${input.profile.model ? ` ${input.profile.model}` : ''}${input.profile.effort ? ` ${input.profile.effort}` : ''}`,
        conflictMessage: 'This Card already has a running Action.',
        phase: 'coordinating',
        actor: 'COORDINATOR',
        validate: async () => undefined,
        persist: async (started) => {
          run.logRef = started.logRef;
          saved = await commit(
            project,
            {
              ...card,
              execution: {
                ...card.execution,
                profile: input.profile,
                coordinationSettings,
                workspace,
                environment,
                runs: [...(card.execution?.runs ?? []), run],
                acceptedActionIds: card.execution?.acceptedActionIds ?? [],
                git,
                retryInputs,
              },
            },
            {
              kind: 'user-input',
              stage: 'execution',
              actionId: input.actionId,
              text: input.instruction || 'User started this Action.',
            },
            {
              ...uploadedDocuments,
              'request.json': JSON.stringify(request),
              'baseline.json': JSON.stringify(baseline),
              'prompt.txt': prompt,
            },
          );
          return async () => {
            await finish(
              project,
              request,
              baseline,
              new Error('The Running response could not be published.'),
            );
          };
        },
      });
      reservation.reservation = owner;
      reservation.jobs = [];
      try {
        const recordProgress = (progress: CoordinationProgress) => {
          if (
            active.get(cardKey(project, input.cardId)) !== reservation ||
            reservation.canceling
          )
            return;
          const entry = {
            ...progress,
            summary: redactActivity(progress.summary),
          };
          reservation.progress = entry;
          reservation.activity = [...(reservation.activity ?? []), entry].slice(
            -300,
          );
          const actor = actorForProgress(entry);
          const job = entry.job;
          if (job) {
            const known = reservation.jobs!.findIndex(
              (item) => item.jobId === job.jobId,
            );
            const ref = jobReference(project, job);
            if (known >= 0) reservation.jobs![known] = ref;
            else reservation.jobs!.push(ref);
          }
          const failedJob =
            job && job.status !== 'running' && job.exitCode !== 0;
          owner.record({
            level: failedJob ? 'ERROR' : 'INFO',
            actor,
            phase: logPhaseForProgress(entry),
            event: job
              ? job.status === 'running'
                ? 'job.started'
                : 'job.finished'
              : actor === 'JOB'
                ? 'job.progress'
                : actor === 'COORDINATOR'
                  ? 'coordinator.progress'
                  : 'worker.progress',
            message: job
              ? job.status === 'running'
                ? `${job.label} — ${job.command}`
                : `${job.label} exited ${job.exitCode ?? job.status}; job log ${job.jobId}`
              : entry.summary,
          });
          const nextPhase = runPhaseForProgress(entry);
          if (owner.phase !== nextPhase && !owner.canceling)
            owner.setPhase(nextPhase, actor === 'JOB' ? 'WORKER' : actor);
        };
        const options: Parameters<typeof transport>[1] = {
          workingDirectory: baseline.root,
          prompt,
          model: input.profile.model || undefined,
          effort: input.profile.effort || undefined,
          access: 'workspace-write',
          protectedPath: project.planningPath,
          primaryRepositoryPath: workspace?.repository,
          gitWritePaths: workspace
            ? await cardGitWritePaths(workspace)
            : undefined,
          candidatePublication: environment
            ? {
                environment,
                actionId: input.actionId,
                roundId: request.requestId,
              }
            : undefined,
          onActivity: (activity) =>
            recordProgress({
              phase: 'execute',
              summary: activity.summary,
              updatedAt: new Date().toISOString(),
              attempts: 1,
              actor: activity.job ? 'JOB' : 'WORKER',
              job: activity.job,
            }),
        };
        recordProgress({
          phase: 'prepare',
          summary: 'Preparing coordinated execution.',
          updatedAt: new Date().toISOString(),
          attempts: 0,
        });
        {
          const evidence: PriorEvidence[] =
            card.execution?.runs.flatMap((previous) =>
              previous.verificationBasis && previous.result
                ? previous.result.checks
                    .filter(
                      (check) => check.status === 'passed' && check.criterionId,
                    )
                    .map((check) => ({
                      id: `${previous.id}:${check.criterionId}`,
                      actionId: previous.actionId,
                      criterionId: check.criterionId!,
                      summary: check.summary,
                      evidenceRefs: check.evidenceRefs,
                      basis: previous.verificationBasis!,
                    }))
                : [],
            ) ?? [];
          reservation.handle = coordinate({
            request,
            workerOptions: options,
            workerAgent: input.profile.agent,
            settings: coordinationSettings,
            priorEvidence: evidence.slice(-80),
            previousContext:
              card.execution?.runs.findLast(
                (previous) => previous.coordination?.contextSummary,
              )?.coordination?.contextSummary ?? '',
            resumeWorkerSessionId: resumableWorkerSession(
              card.execution?.runs,
              input.actionId,
              input.profile,
            ),
            readBasis: async () =>
              verificationBasis(await snapshotWorkspace(workingProject)),
            onProgress: recordProgress,
            transport,
            workerTransport:
              workerTransport ??
              (transport === startLocalAgentRun
                ? startEventDrivenWorkerRun
                : transport),
            discoverSkills:
              transport === startLocalAgentRun ? readCodexSkills : undefined,
            environment,
            packetDir: usesDeliveryPacket ? packetDir : undefined,
            runtimeInstructions,
          });
          owner.attach(reservation.handle);
        }
      } catch (error) {
        await finish(
          project,
          request,
          baseline,
          error instanceof Error ? error : new Error('Could not start Agent.'),
        );
        return store.read(project, card.id);
      }
      let settled = false;
      const settle = (
        outcome: Awaited<LocalAgentRun['completion']> | Error,
      ) => {
        if (settled) return Promise.resolve();
        settled = true;
        const traced =
          outcome instanceof CoordinationRunError
            ? outcome
            : !(outcome instanceof Error) && 'coordination' in outcome
              ? (outcome as CoordinatedResult)
              : undefined;
        const finalOutcome = reservation.timeoutError
          ? traced
            ? new CoordinationRunError(
                reservation.timeoutError.message,
                traced.coordination,
                traced.coordinationRecords,
              )
            : reservation.timeoutError
          : outcome;
        return finish(project, request, baseline, finalOutcome);
      };
      reservation.timer = setTimeout(() => {
        reservation.timeoutError = new Error(
          'Execution timed out. Files were not rolled back.',
        );
        reservation.handle?.cancel();
      }, timeoutMs);
      void reservation.handle.completion
        .then(settle, (error) =>
          settle(
            error instanceof Error ? error : new Error('Execution failed.'),
          ),
        )
        .catch(() => undefined);
      return saved;
    } catch (error) {
      if (active.get(cardKey(project, input.cardId)) === reservation)
        active.delete(cardKey(project, input.cardId));
      throw error;
    }
  }

  async function update(
    project: Project,
    cardId: string,
    expectedRevision: number,
    action: 'cancel' | 'accept',
    outputId: string,
  ) {
    assertCardUuid(cardId);
    assertCardUuid(outputId);
    const card = await refresh(project, await store.read(project, cardId));
    if (card.revision !== expectedRevision)
      throw new PublicApiError(
        'Card changed. Reload before trying again.',
        409,
      );
    const run = card.execution?.runs.at(-1);
    if (!run || run.id !== outputId)
      throw new PublicApiError('The current Action output changed.', 409);
    if (action === 'cancel') {
      if (run.status !== 'running')
        throw new PublicApiError('No execution is running.', 400);
      const handle = active.get(cardKey(project, cardId));
      if (handle?.id !== run.id)
        throw new Error('Execution is owned by another server.');
      const owner = handle.reservation ?? null;
      const interruptedPhase = owner?.phase ?? 'executing';
      const interruptedActor = owner?.actor ?? 'WORKER';
      if (handle.timer) clearTimeout(handle.timer);
      handle.canceling = true;
      let stop: 'confirmed' | 'unconfirmed' = 'confirmed';
      if (owner) stop = await requestStop(owner);
      else handle.handle?.cancel();
      const termination =
        stop === 'confirmed'
          ? await handle.handle?.completion.catch((error: unknown) => error)
          : null;
      const canceledFiles: Record<string, string> = {};
      const salvage = (target: ActionRun, base: PlanningCard) => {
        if (termination instanceof CoordinationRunError) {
          target.coordination = {
            ...termination.coordination,
            logRef: reference(base, 'coordination.json'),
          };
          target.usage = totalCoordinationUsage(termination.coordination);
          canceledFiles['coordination.json'] = JSON.stringify(
            target.coordination,
          );
          for (const [name, text] of Object.entries(
            termination.coordinationRecords,
          ))
            canceledFiles[`coordination-${name}`] = text;
        }
        if (handle.activity?.length) {
          target.activityRef = reference(base, 'activity.json');
          canceledFiles['activity.json'] = JSON.stringify(handle.activity);
        }
        target.jobs = handle.jobs?.length ? handle.jobs : target.jobs;
        target.logRef = owner?.logRef ?? target.logRef;
      };
      if (stop === 'unconfirmed') {
        const classification = classifyActionRun(run, {
          runState: 'termination-unconfirmed',
          interruptedPhase,
          interruptedActor,
        });
        const failed: ActionRun = {
          ...run,
          status: 'failed',
          endedAt: new Date().toISOString(),
          stopResult: 'unconfirmed',
          error: classification.detail,
          response: classification,
        };
        salvage(failed, card);
        const saved = await commit(
          project,
          replaceRun(card, failed),
          {
            kind: 'system-event',
            stage: 'execution',
            actionId: run.actionId,
            event: 'run-ended',
            text: `${classification.title}. ${classification.detail}`,
            refs: [],
          },
          canceledFiles,
        );
        if (owner)
          await settleRun(owner, {
            classification,
            jobLogs: handle.jobs,
          }).catch(() => undefined);
        void handle.handle?.completion
          .catch(() => undefined)
          .finally(() => {
            if (active.get(cardKey(project, cardId)) === handle)
              active.delete(cardKey(project, cardId));
          });
        return saved;
      }
      const provisional = classifyActionRun(run, {
        runState: 'canceled',
        interruptedPhase,
        interruptedActor,
      });
      const saved = await commit(
        project,
        replaceRun(card, {
          ...run,
          status: 'canceled',
          endedAt: new Date().toISOString(),
          stopResult: 'confirmed',
          error: 'Canceled by user. Existing changes were not reverted.',
          response: provisional,
          logRef: owner?.logRef ?? run.logRef,
        }),
        {
          kind: 'system-event',
          stage: 'execution',
          actionId: run.actionId,
          event: 'run-ended',
          text: 'User canceled execution. Existing file and external changes were not reverted.',
          refs: [],
        },
      );
      const canceledRun = { ...saved.execution!.runs.at(-1)! };
      salvage(canceledRun, saved);
      try {
        const snapshot = await snapshotWorkspace(
          workspaceProject(project, card.execution?.workspace),
        );
        const hash = await checkpointWorkspace(
          project,
          card.id,
          snapshot,
          run.parentCommit ?? card.execution!.git!.head,
          run.id,
          `Canceled Action ${run.actionId}\nRound ${run.id}`,
        );
        let changedFiles = 0;
        try {
          changedFiles = observedChanges(
            await readActionBaseline(project, saved, run),
            snapshot,
          ).length;
        } catch {}
        const retained = retainedEffectsOf(
          { ...canceledRun, commit: hash },
          changedFiles,
        );
        const classification = classifyActionRun(canceledRun, {
          runState: 'canceled',
          interruptedPhase,
          interruptedActor,
          retained,
        });
        const result = await commit(
          project,
          replaceRun(saved, {
            ...canceledRun,
            commit: hash,
            response: classification,
          }),
          {
            kind: 'system-event',
            stage: 'execution',
            actionId: run.actionId,
            event: 'output-recorded',
            text: `Recorded canceled-round Git checkpoint ${hash}. No rollback occurred.`,
            refs: [],
          },
          canceledFiles,
        );
        if (owner)
          await settleRun(owner, {
            classification,
            retained,
            jobLogs: handle.jobs,
          }).catch(() => undefined);
        return result;
      } catch (error) {
        const classification = classifyActionRun(canceledRun, {
          runState: 'canceled',
          interruptedPhase,
          interruptedActor,
        });
        const result = await commit(
          project,
          replaceRun(saved, {
            ...canceledRun,
            response: classification,
            error: `Canceled; changes remain. Git checkpoint failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          }),
          {
            kind: 'system-event',
            stage: 'execution',
            actionId: run.actionId,
            event: 'run-ended',
            text: 'Cancellation completed but its Git checkpoint failed. Inspect the workspace before continuing.',
            refs: [],
          },
          canceledFiles,
        );
        if (owner)
          await settleRun(owner, {
            classification,
            jobLogs: handle.jobs,
          }).catch(() => undefined);
        return result;
      } finally {
        if (active.get(cardKey(project, cardId))?.id === run.id)
          active.delete(cardKey(project, cardId));
      }
    }
    if (action !== 'accept' || !hasReviewableReport(run) || !run.result)
      throw new PublicApiError(
        'A valid current Action report is required for acceptance.',
        400,
      );
    if (
      !assessRequiredChecks(
        run.acceptanceChecklist,
        run.result.checks,
        card.execution?.acceptanceOverrides?.[run.actionId],
      ).passed
    )
      throw new PublicApiError(
        'Required acceptance checks are incomplete or failed. Record an explicit user decision for any waived item.',
        400,
      );
    const accepted = card.execution!.acceptedActionIds;
    if (
      card.actions.find((item) => !accepted.includes(item.id))?.id !==
      run.actionId
    )
      throw new PublicApiError('Only the current Action can be accepted.', 400);
    const outputRef = reference(card, 'output.md');
    return commit(
      project,
      {
        ...card,
        execution: {
          ...card.execution!,
          runs: card.execution!.runs.map((item) =>
            item.id === run.id ? { ...item, outputRef } : item,
          ),
          acceptedActionIds: [...accepted, run.actionId],
        },
      },
      {
        kind: 'system-event',
        stage: 'execution',
        actionId: run.actionId,
        event: 'user-accepted',
        text: `User accepted output ${run.id}. Agent-reported checks and verification findings remain unchanged. No GitHub merge was inferred.`,
        refs: [outputRef],
      },
      { 'output.md': acceptedOutputMarkdown(card, run) },
    );
  }

  async function ensureAcceptedOutputRefs(
    project: Project,
    card: PlanningCard,
  ) {
    const missing = (card.execution?.acceptedActionIds ?? [])
      .map((id) => card.execution!.runs.findLast((run) => run.actionId === id))
      .filter((run): run is ActionRun => Boolean(run && !run.outputRef));
    if (!missing.length) return card;
    if (missing.some((run) => !hasReviewableReport(run)))
      throw new Error(
        'An accepted Action is missing its original report; restore the record before continuing.',
      );
    const files: Record<string, string> = {};
    const refs = new Map<string, string>();
    for (const run of missing) {
      const name = `accepted-${run.actionId}.md`;
      files[name] = acceptedOutputMarkdown(card, run);
      refs.set(run.id, reference(card, name));
    }
    return commit(
      project,
      {
        ...card,
        execution: {
          ...card.execution!,
          runs: card.execution!.runs.map((run) =>
            refs.has(run.id) ? { ...run, outputRef: refs.get(run.id)! } : run,
          ),
        },
      },
      {
        kind: 'system-event',
        stage: 'execution',
        actionId: null,
        event: 'output-recorded',
        text: 'Restored missing handoff references for previously accepted reports. Original results, verification findings and acceptance decisions are unchanged. No Agent was rerun.',
        refs: [...refs.values()],
      },
      files,
    );
  }

  async function bindLegacyChecklist(
    project: Project,
    cardId: string,
    expectedRevision: number,
    actionId: string,
    criteria: AcceptanceCriterion[],
    note: string,
  ) {
    assertCardUuid(cardId);
    const card = await store.read(project, cardId);
    if (card.revision !== expectedRevision)
      throw new PublicApiError(
        'Card changed. Reload before trying again.',
        409,
      );
    const action = card.actions.find((item) => item.id === actionId);
    if (
      card.plan?.status !== 'finalized' ||
      !action ||
      action.acceptanceCriteria?.length ||
      active.has(cardKey(project, cardId)) ||
      card.execution?.runs.at(-1)?.status === 'running' ||
      card.execution?.acceptedActionIds.includes(actionId)
    )
      throw new Error(
        'Only a legacy unaccepted Action without a checklist can be upgraded.',
      );
    validateAcceptanceCriteria(criteria);
    if (typeof note !== 'string' || !note.trim())
      throw new PublicApiError(
        'Record the explicit user authorization for this upgrade.',
        400,
      );
    const upgrade = (item: typeof action) =>
      item.id === actionId
        ? { ...item, acceptanceCriteria: structuredClone(criteria) }
        : item;
    return commit(
      project,
      {
        ...card,
        actions: card.actions.map(upgrade),
        plan: { ...card.plan, steps: card.plan.steps.map(upgrade) },
      },
      {
        kind: 'user-input',
        stage: 'execution',
        actionId,
        text: `User authorized a one-time legacy checklist upgrade. ${note} Historical rounds remain unchanged.`,
      },
    );
  }

  async function openWorkspace(
    project: Project,
    cardId: string,
    expectedRevision: number,
  ) {
    assertCardUuid(cardId);
    const card = await store.read(project, cardId);
    if (card.revision !== expectedRevision)
      throw new PublicApiError(
        'Card changed. Reload before trying again.',
        409,
      );
    const workspace = card.execution?.workspace;
    if (!workspace)
      throw new PublicApiError('This Card has no workspace yet.', 400);
    await verifyCardWorkspace(workspace);
    const command =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'explorer.exe'
          : process.platform === 'linux'
            ? 'xdg-open'
            : null;
    if (!command)
      throw new PublicApiError(
        'Opening the system file manager is unsupported.',
        400,
      );
    await promisify(execFile)(command, [workspace.path], { timeout: 10000 });
    return card;
  }

  async function overrideRequiredCheck(
    project: Project,
    cardId: string,
    expectedRevision: number,
    criterionId: string,
    note: string,
  ) {
    assertCardUuid(cardId);
    const card = await store.read(project, cardId);
    if (card.revision !== expectedRevision)
      throw new PublicApiError(
        'Card changed. Reload before trying again.',
        409,
      );
    const run = card.execution?.runs.at(-1);
    if (
      !run?.acceptanceChecklist ||
      run.status === 'running' ||
      active.has(cardKey(project, cardId)) ||
      card.execution!.acceptedActionIds.includes(run.actionId)
    )
      throw new PublicApiError(
        'User decisions require a finished, unaccepted Round with a fixed checklist.',
        400,
      );
    if (
      !run.acceptanceChecklist.items.some((item) => item.id === criterionId) ||
      typeof note !== 'string' ||
      !note.trim() ||
      note.length > 4000
    )
      throw new PublicApiError(
        'Select a required criterion and record the user decision.',
        400,
      );
    const decision = {
      note,
      recordedAt: new Date().toISOString(),
      checklistVersion: run.acceptanceChecklist.version,
    };
    const overrides = {
      ...card.execution?.acceptanceOverrides?.[run.actionId],
      [criterionId]: decision,
    };
    const classification = classifyActionRun(run, {
      retained: retainedEffectsOf(run, run.observedRefs.length),
      overrides,
    });
    const updated = await commit(
      project,
      {
        ...card,
        execution: {
          ...card.execution!,
          runs: card.execution!.runs.map((item) =>
            item.id === run.id ? { ...item, response: classification } : item,
          ),
          acceptanceOverrides: {
            ...card.execution?.acceptanceOverrides,
            [run.actionId]: overrides,
          },
        },
      },
      {
        kind: 'user-input',
        stage: 'execution',
        actionId: run.actionId,
        text: `User accepts required criterion ${criterionId} as passed for checklist ${decision.checklistVersion}. ${note} Actual check results remain unchanged.`,
      },
    );
    await publishRecheck(
      project,
      updated,
      { ...run, response: classification },
      classification,
      'recovery.override',
    );
    return updated;
  }

  function refreshGitHub(
    project: Project,
    cardId: string,
    expectedRevision: number,
    outputId: string,
  ) {
    assertCardUuid(cardId);
    assertCardUuid(outputId);
    return loggedCardOperation(
      project,
      { kind: 'github-refresh', label: 'Refresh pull request state', cardId },
      (operation) =>
        refreshGitHubLogged(
          project,
          cardId,
          expectedRevision,
          outputId,
          operation,
        ),
    );
  }

  async function refreshGitHubLogged(
    project: Project,
    cardId: string,
    expectedRevision: number,
    outputId: string,
    operation: CardHostOperation,
  ) {
    const card = await store.read(project, cardId);
    if (card.revision !== expectedRevision)
      throw new PublicApiError(
        'Card changed. Reload before trying again.',
        409,
      );
    if (card.execution?.runs.at(-1)?.status === 'running')
      throw new PublicApiError(
        'Wait for execution to finish before refreshing GitHub.',
        400,
      );
    const run = card.execution?.runs.find((item) => item.id === outputId);
    if (!run?.github)
      throw new PublicApiError(
        'No captured GitHub delivery for this output.',
        400,
      );
    const github = await refreshGitHubDelivery(run.github, reader);
    return commit(
      project,
      {
        ...card,
        execution: {
          ...card.execution!,
          runs: card.execution!.runs.map((item) =>
            item.id === run.id ? { ...run, github } : item,
          ),
          lastOperation: operation,
        },
      },
      {
        kind: 'system-event',
        stage: 'execution',
        actionId: run.actionId,
        event: 'output-recorded',
        text:
          github.error ??
          `GitHub status refreshed for output ${run.id}. ${github.pullRequests.map((pr) => `${pr.url}: ${pr.state}`).join('; ')} User acceptance is unchanged.`,
        refs: github.pullRequests.map((pr) => pr.url),
      },
      { 'github-delivery.json': JSON.stringify(github) },
    );
  }

  async function recheckOutput(
    project: Project,
    cardId: string,
    expectedRevision: number,
    outputId: string,
  ) {
    assertCardUuid(cardId);
    assertCardUuid(outputId);
    const settling = active.get(cardKey(project, cardId));
    if (
      settling?.reservation?.settled &&
      settling.reservation.stopResult !== 'unconfirmed'
    ) {
      if (settling.timer) clearTimeout(settling.timer);
      active.delete(cardKey(project, cardId));
    }
    if (active.has(cardKey(project, cardId)))
      throw new PublicApiError(
        'Wait for this Card to finish before rechecking.',
        400,
      );
    const reservation: Active = {
      id: randomUUID(),
      cardId,
      handle: null,
      timer: null,
    };
    active.set(cardKey(project, cardId), reservation);
    try {
      const card = await store.read(project, cardId);
      if (card.revision !== expectedRevision)
        throw new PublicApiError(
          'Card changed. Reload before trying again.',
          409,
        );
      const run = card.execution?.runs.at(-1);
      if (
        !run ||
        run.id !== outputId ||
        run.status !== 'failed' ||
        !run.evidenceErrors ||
        card.execution!.acceptedActionIds.includes(run.actionId)
      )
        throw new PublicApiError(
          'Only the latest unaccepted report rejected for evidence can be rechecked.',
          400,
        );
      if (hasUnsupportedAppArtifact(run))
        throw new Error(
          'App bundle verification is unsupported. Retrying cannot resolve this until support is added.',
        );
      if (card.execution?.workspace)
        await verifyCardWorkspace(card.execution.workspace);
      const workingProject = workspaceProject(
        project,
        card.execution?.workspace,
      );
      const log = await readCardWorklog(root(project), cardId);
      let request: CardHarnessRequest | undefined;
      let raw: string | undefined;
      let recorded: WorkspaceSnapshot | undefined;
      for (const entry of [...log.entries].reverse()) {
        if (entry.record.stage !== 'execution') continue;
        const directory = path.join(
          root(project),
          cardId,
          String(entry.revision).padStart(8, '0'),
        );
        if (!request) {
          const text = await optionalRecordFile(
            path.join(directory, 'request.json'),
          );
          if (text) {
            const candidate = JSON.parse(text);
            if (candidate.requestId === run.id) request = candidate;
          }
        }
        if (!raw) {
          const text = await optionalRecordFile(
            path.join(directory, 'raw-response.txt'),
          );
          if (text && JSON.parse(text).requestId === run.id) {
            raw = text;
            const snapshot = await optionalRecordFile(
              path.join(directory, 'observed-workspace.json'),
            );
            if (snapshot) recorded = JSON.parse(snapshot);
          }
        }
        if (request && raw && recorded) break;
      }
      if (!request || !raw || !recorded)
        throw new Error('Original report evidence is unavailable.');
      if (JSON.stringify(card.plan) !== JSON.stringify(request.context.plan))
        throw new PublicApiError('Plan changed since this report.', 409);
      const current = await snapshotWorkspace(workingProject);
      if (
        current.root !== recorded.root ||
        current.head !== recorded.head ||
        JSON.stringify(
          Object.entries(current.files).sort(([a], [b]) => a.localeCompare(b)),
        ) !==
          JSON.stringify(
            Object.entries(recorded.files).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          )
      )
        throw new PublicApiError(
          'Workspace changed since this report. Rechecking cannot certify a different output.',
          400,
        );
      let result;
      let versions: string[] = [];
      let external: string[] = [];
      let localArtifacts = JSON.stringify({ artifacts: [] });
      try {
        result = parseCardHarnessResult(
          raw,
          request,
          request.context.contextRevision,
          run.observedRefs,
        );
      } catch (error) {
        if (!(error instanceof ExecutionEvidenceError)) throw error;
        versions = await verifiedOutputVersionRefs(
          recorded,
          error.result.artifactRefs,
        );
        const attachments = await captureLocalAcceptanceArtifacts(
          recorded,
          error.result.artifactRefs,
          run.endedAt!,
        );
        localArtifacts = JSON.stringify({
          capturedAt: new Date().toISOString(),
          meaning:
            'Captured at report recheck; not proof of an original snapshot.',
          artifacts: attachments,
        });
        versions.push(...attachments.map((item) => item.ref));
        external = await verifiedGitHubArtifactRefs(
          workingProject,
          error.result.artifactRefs,
          recorded.head,
          reader,
        );
        result = parseCardHarnessResult(
          raw,
          request,
          request.context.contextRevision,
          [...run.observedRefs, ...versions, ...external],
        );
      }
      if (result.stage !== 'execution')
        throw new Error('Expected an execution report.');
      const github =
        run.github?.outputHead === recorded.head &&
        run.github.repositoryUrl === getGitHubRepositoryUrl(workingProject)
          ? await refreshGitHubDelivery(run.github, reader)
          : await discoverGitHubDelivery(
              workingProject,
              JSON.stringify(result),
              recorded.head,
              reader,
              recorded.head,
              card.execution?.workspace
                ? actionPublicationBranch(
                    card.execution.workspace.branch,
                    run.actionId,
                  )
                : undefined,
            );
      const outputRef = reference(card, 'output.md');
      const nextRun = {
        ...run,
        status: 'succeeded' as const,
        error: null,
        evidenceErrors: undefined,
        result,
        github,
        outputRef,
        verifiedExternalRefs: external,
        verifiedVersionRefs: versions,
        unverifiedCheckRefs: unverifiedCheckRefs(result, request, [
          ...run.observedRefs,
          ...external,
          ...versions,
        ]),
      };
      nextRun.response = classifyActionRun(nextRun, {
        retained: retainedEffectsOf(nextRun, nextRun.observedRefs.length),
        overrides: card.execution?.acceptanceOverrides?.[run.actionId],
      });
      const rechecked = await commit(
        project,
        replaceRun(card, nextRun),
        {
          kind: 'system-event',
          stage: 'execution',
          actionId: run.actionId,
          event: 'output-recorded',
          text: `Rechecked recorded output ${run.id} against its unchanged workspace and verified references. No Agent commands were rerun. Reported check statuses remain unchanged; no user acceptance was recorded.`,
          refs: [outputRef],
        },
        {
          'result.json': JSON.stringify(result),
          'verified-references.json': JSON.stringify({
            checkedAt: new Date().toISOString(),
            versions,
            external,
          }),
          'local-artifacts.json': localArtifacts,
          'output.md': `# Rechecked Action output\n\n${result.summary}\n\nOutcome: ${result.outcome}\n\nNo Agent commands were rerun. Reported checks and remaining limitations are unchanged.\n\n## Required self-checks\n${result.checks.map((check) => `- ${check.status}: ${check.summary}`).join('\n')}\n\n## Additional checks (non-blocker)\n${(result.additionalChecks ?? []).map((check) => `- ${check.status}: ${check.summary}`).join('\n')}\n\n## Remaining\n${result.remaining.map((item) => `- ${item}`).join('\n')}`,
        },
      );
      await publishRecheck(
        project,
        rechecked,
        rechecked.execution!.runs.at(-1)!,
        nextRun.response,
      );
      return rechecked;
    } finally {
      if (active.get(cardKey(project, cardId)) === reservation)
        active.delete(cardKey(project, cardId));
    }
  }

  async function resetWorkspace(
    project: Project,
    cardId: string,
    expectedRevision: number,
    confirmation?: string,
  ) {
    return restartFromBase(
      project,
      cardId,
      expectedRevision,
      confirmation,
      false,
    );
  }

  async function reopenPlanFromBase(
    project: Project,
    cardId: string,
    expectedRevision: number,
    confirmation?: string,
  ) {
    return restartFromBase(
      project,
      cardId,
      expectedRevision,
      confirmation,
      true,
    );
  }

  function restartFromBase(
    project: Project,
    cardId: string,
    expectedRevision: number,
    confirmation: string | undefined,
    reopenPlan: boolean,
  ) {
    assertCardUuid(cardId);
    if (confirmation === undefined)
      return restartFromBaseLogged(
        project,
        cardId,
        expectedRevision,
        confirmation,
        reopenPlan,
        undefined,
      );
    return loggedCardOperation(
      project,
      {
        kind: reopenPlan ? 'reopen-plan' : 'restart-from-base',
        label: reopenPlan ? 'Reopen the Plan' : 'Reset the workspace',
        cardId,
      },
      (operation) =>
        restartFromBaseLogged(
          project,
          cardId,
          expectedRevision,
          confirmation,
          reopenPlan,
          operation,
        ),
    );
  }

  async function restartFromBaseLogged(
    project: Project,
    cardId: string,
    expectedRevision: number,
    confirmation: string | undefined,
    reopenPlan: boolean,
    operation: CardHostOperation | undefined,
  ) {
    if (active.has(cardKey(project, cardId)))
      throw new PublicApiError('Stop this Card before resetting it.', 400);
    const reservation: Active = {
      id: randomUUID(),
      cardId,
      handle: null,
      timer: null,
    };
    active.set(cardKey(project, cardId), reservation);
    try {
      const card = await store.read(project, cardId);
      if (card.revision !== expectedRevision)
        throw new PublicApiError(
          'Card changed. Reload before trying again.',
          409,
        );
      const workspace = card.execution?.workspace;
      const last = card.execution?.runs.at(-1);
      if (
        !workspace ||
        !last ||
        (reopenPlan && card.execution!.acceptedActionIds.length === 0) ||
        (!reopenPlan && card.execution!.acceptedActionIds.length > 0) ||
        card.run?.status === 'running' ||
        !['failed', 'canceled', 'succeeded'].includes(last.status)
      )
        throw new PublicApiError(
          reopenPlan
            ? 'Only Cards with accepted work and a completed Round can return to planning.'
            : 'Only unaccepted Cards with a completed Round can restart from their base.',
          400,
        );
      await verifyCardWorkspace(workspace);
      const snapshot = await snapshotWorkspace(
        workspaceProject(project, workspace),
      );
      const repositoryUrl = getGitHubRepositoryUrl(
        workspaceProject(project, workspace),
      );
      if (repositoryUrl) {
        const prs = (
          await Promise.all(
            [
              workspace.branch,
              ...card.actions.map((action) =>
                actionPublicationBranch(workspace.branch, action.id),
              ),
            ].map((branch) =>
              reader.branchPullRequests(
                repositoryUrl.slice('https://github.com/'.length),
                branch,
              ),
            ),
          )
        ).flat();
        if (prs.some((pr) => pr.state === 'MERGED'))
          throw new PublicApiError(
            'This Card branch has a merged PR. Use a revert PR instead of a local restart.',
            400,
          );
      }
      const token = createHash('sha256')
        .update(
          JSON.stringify({
            revision: card.revision,
            workspace,
            snapshot,
            reopenPlan,
          }),
        )
        .digest('hex');
      const preview = {
        token,
        path: workspace.path,
        branch: workspace.branch,
        baseCommit: workspace.baseCommit,
        repositoryUrl,
      };
      if (confirmation === undefined) return { preview };
      if (confirmation !== token)
        throw new PublicApiError(
          'Workspace changed. Preview the reset again.',
          409,
        );
      const restarted = await restartCardWorkspace(project, card);
      try {
        const saved = await commit(
          project,
          {
            ...card,
            plan:
              reopenPlan && card.plan
                ? { ...card.plan, status: 'draft' as const }
                : card.plan,
            actions: reopenPlan ? [] : card.actions,
            finalizedAt: reopenPlan ? null : card.finalizedAt,
            execution: {
              runs: [],
              profile: last.profile,
              acceptedActionIds: [],
              workspace: restarted.workspace,
              workspaceBackups: [
                ...(card.execution?.workspaceBackups ?? []),
                restarted.backup,
              ],
              lastOperation: operation,
            },
          },
          {
            kind: 'system-event',
            stage: 'execution',
            actionId: null,
            event: 'rollback-confirmed',
            text: reopenPlan
              ? `User returned this Card to planning from base ${workspace.baseCommit}. The previous Plan is now a draft, and no Actions are accepted or running. Active worktree: ${restarted.workspace.path}. Previous workspace and branch remain at ${restarted.backup.path}. GitHub and other external effects were not reverted. Next: wait for the user to revise or regenerate the Plan.`
              : `User restarted this Card from base ${workspace.baseCommit}. The confirmed Plan is preserved. No Actions are accepted or running. Active worktree: ${restarted.workspace.path}. Previous workspace and branch remain at ${restarted.backup.path}. GitHub and other external effects were not reverted. Next: wait for the user to start the first Action.`,
            refs: [],
          },
        );
        return { card: saved };
      } catch (error) {
        await undoWorkspaceRestart(
          project,
          cardId,
          workspace,
          restarted.workspace,
          restarted.backup,
        );
        throw error;
      }
    } finally {
      if (active.get(cardKey(project, cardId)) === reservation)
        active.delete(cardKey(project, cardId));
    }
  }

  function undoAction(
    project: Project,
    cardId: string,
    actionId: string,
    expectedRevision: number,
  ) {
    assertCardUuid(cardId);
    assertCardUuid(actionId);
    return loggedCardOperation(
      project,
      {
        kind: 'undo-action',
        label: `Undo Action ${actionId.slice(0, 8)}`,
        cardId,
      },
      (operation) =>
        undoActionLogged(
          project,
          cardId,
          actionId,
          expectedRevision,
          operation,
        ),
    );
  }

  async function undoActionLogged(
    project: Project,
    cardId: string,
    actionId: string,
    expectedRevision: number,
    operation: CardHostOperation,
  ) {
    if (active.has(cardKey(project, cardId)))
      throw new PublicApiError('Stop this Card before undoing.', 400);
    const reservation: Active = {
      id: randomUUID(),
      cardId,
      handle: null,
      timer: null,
    };
    active.set(cardKey(project, cardId), reservation);
    try {
      const card = await store.read(project, cardId);
      if (card.revision !== expectedRevision)
        throw new PublicApiError(
          'Card changed. Reload before trying again.',
          409,
        );
      const current = card.actions.find(
        (item) => !card.execution?.acceptedActionIds.includes(item.id),
      );
      const runs = card.execution?.runs.filter(
        (run) => run.actionId === actionId,
      );
      const first = runs?.at(0);
      const last = runs?.at(-1);
      const workspace = card.execution?.workspace;
      if (
        current?.id !== actionId ||
        !workspace ||
        !first?.parentCommit ||
        !last ||
        last.status === 'running'
      )
        throw new PublicApiError(
          'Only the current completed Action can be undone.',
          400,
        );
      await verifyCardWorkspace(workspace);
      const repositoryUrl = getGitHubRepositoryUrl(
        workspaceProject(project, workspace),
      );
      if (repositoryUrl) {
        const prs = (
          await Promise.all(
            [
              workspace.branch,
              actionPublicationBranch(workspace.branch, actionId),
            ].map((branch) =>
              reader.branchPullRequests(
                repositoryUrl.slice('https://github.com/'.length),
                branch,
              ),
            ),
          )
        ).flat();
        if (prs.some((pr) => pr.state === 'MERGED'))
          throw new PublicApiError(
            'This Card branch has a merged PR. Use a revert PR instead.',
            400,
          );
      }
      const baseline = await readActionBaseline(project, card, first);
      if ((await realpath(baseline.root)) !== workspace.path)
        throw new Error('Action baseline belongs to another workspace.');
      const currentSnapshot = await snapshotWorkspace(
        workspaceProject(project, workspace),
      );
      const preservedFiles = Object.keys(baseline.files).filter(
        (file) => !includeInGitHistory(file),
      );
      if (
        preservedFiles.some(
          (file) => currentSnapshot.files[file] !== baseline.files[file],
        )
      )
        throw new PublicApiError(
          'This Action changed a protected local file that cannot be restored automatically.',
          400,
        );
      const restarted = await restartCardWorkspaceAt(
        project,
        card,
        baseline.head,
      );
      try {
        const workingProject = workspaceProject(project, restarted.workspace);
        const fresh = await snapshotWorkspace(workingProject);
        await restoreCheckpoint(project, card.id, first.parentCommit, fresh);
        await copyPreservedBaselineFiles(
          restarted.backup.path,
          restarted.workspace.path,
          preservedFiles,
        );
        const beforeModes = await snapshotWorkspace(workingProject);
        const trackedFiles = await trackedFilesAt(
          workspace.repository,
          baseline.head,
        );
        const omitted = new Set(
          Object.keys(baseline.files).filter(
            (file) =>
              includeInGitHistory(file) &&
              !trackedFiles.has(file) &&
              !Object.hasOwn(beforeModes.files, file),
          ),
        );
        await restoreBaselineModes(
          restarted.workspace.path,
          baseline.files,
          omitted,
        );
        const restored = await snapshotWorkspace(workingProject);
        if (
          restored.head !== baseline.head ||
          JSON.stringify(orderedFiles(restored, omitted)) !==
            JSON.stringify(orderedFiles(baseline, omitted))
        )
          throw new Error('Action baseline could not be restored exactly.');
        const retryInputs = { ...card.execution?.retryInputs };
        retryInputs[actionId] = last.input;
        const acceptanceOverrides = {
          ...card.execution?.acceptanceOverrides,
        };
        delete acceptanceOverrides[actionId];
        const verification = { ...card.execution?.verification };
        delete verification[actionId];
        const undone = await commit(
          project,
          {
            ...card,
            execution: {
              ...card.execution!,
              runs: card.execution!.runs.filter(
                (run) => run.actionId !== actionId,
              ),
              workspace: restarted.workspace,
              workspaceBackups: [
                ...(card.execution?.workspaceBackups ?? []),
                restarted.backup,
              ],
              git: {
                ...card.execution!.git!,
                head: first.parentCommit,
              },
              retryInputs,
              acceptanceOverrides,
              verification,
              environment: undefined,
              lastOperation: operation,
            },
          },
          {
            kind: 'system-event',
            stage: 'execution',
            actionId,
            event: 'rollback-confirmed',
            text: `User undid Action ${actionId}. Its Rounds remain in the worklog. The confirmed Plan and accepted Actions are unchanged. The workspace was restored to the Action baseline. External effects were not reverted.`,
            refs: [],
          },
        );
        await clearLatestResponse(cardOwner(project, cardId)).catch(
          () => undefined,
        );
        return undone;
      } catch (error) {
        await undoWorkspaceRestart(
          project,
          cardId,
          workspace,
          restarted.workspace,
          restarted.backup,
          true,
        );
        throw error;
      }
    } finally {
      if (active.get(cardKey(project, cardId)) === reservation)
        active.delete(cardKey(project, cardId));
    }
  }

  async function start(project: Project, input: ExecuteActionInput) {
    return withDeliveryState(project, () => startUnlocked(project, input));
  }

  return {
    start,
    update,
    refresh,
    refreshGitHub,
    resetWorkspace,
    reopenPlanFromBase,
    undoAction,
    recheckOutput,
    overrideRequiredCheck,
    openWorkspace,
    bindLegacyChecklist,
  };
}

async function optionalRecordFile(file: string) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8000000)
      throw new Error('Invalid recorded output file.');
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function unverifiedCheckRefs(
  result: NonNullable<ActionRun['result']>,
  request: CardHarnessRequest,
  refs: string[],
) {
  const known = new Set([
    ...refs,
    ...request.context.resources.map((item) => item.ref),
    ...(request.context.currentOutput?.refs ?? []),
  ]);
  return [
    ...new Set(
      [...result.checks, ...(result.additionalChecks ?? [])]
        .flatMap((check) => check.evidenceRefs)
        .filter((ref) => !known.has(ref)),
    ),
  ];
}

function replaceRun(card: PlanningCard, run: ActionRun): PlanningCard {
  return {
    ...card,
    execution: {
      ...card.execution!,
      ...(run.commit && card.execution?.git
        ? { git: { ...card.execution.git, head: run.commit } }
        : {}),
      runs: card.execution!.runs.map((item) =>
        item.id === run.id ? run : item,
      ),
    },
  };
}

export const executionService = createExecutionService();

function acceptedOutputMarkdown(card: PlanningCard, run: ActionRun) {
  const result = run.result!;
  const decisions = card.execution?.acceptanceOverrides?.[run.actionId] ?? {};
  const checks = result.checks
    .map(
      (check) =>
        `- ${check.criterionId ?? 'unclassified'}: ${check.status} — ${check.summary}\n${check.evidenceRefs.map((ref) => `  - ${ref}`).join('\n')}`,
    )
    .join('\n');
  const overrides = Object.entries(decisions)
    .filter(
      ([, decision]) =>
        decision.checklistVersion === run.acceptanceChecklist?.version,
    )
    .map(
      ([id, decision]) => `- ${id}: ${decision.note} (${decision.recordedAt})`,
    )
    .join('\n');
  return `# Accepted Action output\n\nAction: ${run.actionId}\nRound: ${run.id}\nChecklist: ${run.acceptanceChecklist?.version ?? 'legacy'}\n\n${result.summary}\n\n## Handoff\n${result.handoffSummary}\n\n${run.coordination ? `Coordination context: ${run.coordination.contextSummary}\nCoordination record: ${run.coordination.logRef ?? 'not available'}\nActivity record: ${run.activityRef ?? 'not available'}\n\n` : ''}## Required checks (observed results)\n${checks}\n\n## User decisions\n${overrides || 'None.'}\n\n## Delivery references (Agent-reported)\n${result.artifactRefs.map((ref) => `- ${ref}`).join('\n')}\n\n## System verification findings\n${run.evidenceErrors?.map((error) => `- ${error}`).join('\n') || 'None recorded.'}\n\nUser acceptance does not turn unverified references into verified artifacts.\n\n## Additional checks (non-blocker)\n${(result.additionalChecks ?? []).map((check) => `- ${check.status}: ${check.summary}\n${check.evidenceRefs.map((ref) => `  - ${ref}`).join('\n')}`).join('\n')}\n`;
}

function verificationBasis(snapshot: WorkspaceSnapshot) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        root: snapshot.root,
        files: Object.entries(snapshot.files).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      }),
    )
    .digest('hex');
}
