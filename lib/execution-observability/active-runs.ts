import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { PublicApiError } from '../api-errors.ts';
import type { AgentProfile } from '../agents/profile.ts';
import {
  StaleResponseError,
  publishLatestResponse,
} from './latest-response-store.ts';
import { readableActivity } from './run-log-format.ts';
import { createRunLog, type RunLogWriter } from './run-log.ts';
import {
  ownerKey,
  ownerLogUrlPath,
  storedOwner,
  type JobLogReference,
  type LatestResponseDocument,
  type LatestResponseSubject,
  type LogActor,
  type ResponseClassification,
  type ResponseOwner,
  type RetainedEffects,
  type RunLogEntry,
  type RunLogInput,
  type RunPhase,
} from './types.ts';

export const STOP_GRACE_MS =
  Number(process.env.PRAXIS_STOP_GRACE_MS) > 0
    ? Number(process.env.PRAXIS_STOP_GRACE_MS)
    : 15_000;
const RUNNING_PUBLISH_THROTTLE_MS = 1_000;

export type StopResult = 'confirmed' | 'unconfirmed';

export type ActiveRunHandle = {
  cancel: () => void;
  completion: Promise<unknown>;
};

export type ActiveRunReservation = {
  readonly key: string;
  readonly owner: ResponseOwner;
  readonly runId: string;
  readonly startedAt: string;
  readonly hostPid: number;
  readonly subject: LatestResponseSubject;
  readonly agentProfile: AgentProfile | undefined;
  readonly layer: 'discovery' | 'product-design' | undefined;
  readonly actionId: string | undefined;
  readonly logFile: string;
  readonly logRef: string;
  readonly sharedCheckout: boolean;
  log: RunLogWriter;
  phase: RunPhase;
  actor: LogActor;
  canceling: boolean;
  stopResult: StopResult | null;
  settled: boolean;
  released: Promise<void>;
  attach: (handle: ActiveRunHandle) => void;
  setPhase: (phase: RunPhase, actor?: LogActor) => void;
  record: (input: RunLogInput) => RunLogEntry;
  document: () => LatestResponseDocument;
  publishRunning: () => Promise<void>;
  flushPublish: () => Promise<void>;
};

export class ActiveRunConflictError extends PublicApiError {
  constructor(message: string) {
    super(message, 409, 'active-run-conflict');
    this.name = 'ActiveRunConflictError';
  }
}

const state = globalThis as typeof globalThis & {
  __praxisActiveRuns?: Map<string, ActiveRunReservation>;
  __praxisActiveRunsOwner?: string;
};
const registry = (state.__praxisActiveRuns ??= new Map());
const moduleInstanceId = randomUUID();
state.__praxisActiveRunsOwner ??= moduleInstanceId;
const handles = new WeakMap<ActiveRunReservation, ActiveRunHandle>();

export type ActiveRunRegistryOwnership = {
  hostPid: number;
  moduleInstanceId: string;
  registryOwnerId: string;
  shared: boolean;
  activeOwners: number;
};

export function activeRunRegistryOwnership(): ActiveRunRegistryOwnership {
  const registryOwnerId = state.__praxisActiveRunsOwner as string;
  return {
    hostPid: process.pid,
    moduleInstanceId,
    registryOwnerId,
    shared: moduleInstanceId === registryOwnerId,
    activeOwners: registry.size,
  };
}

export function getActiveRun(owner: ResponseOwner) {
  return registry.get(ownerKey(owner)) ?? null;
}

export function listActiveRuns(planningPath: string) {
  return [...registry.values()].filter(
    (reservation) => reservation.owner.planningPath === planningPath,
  );
}

export function isCurrentRun(reservation: ActiveRunReservation) {
  return registry.get(reservation.key) === reservation;
}

const releases = new WeakMap<ActiveRunReservation, () => void>();

export function releaseRun(reservation: ActiveRunReservation) {
  if (registry.get(reservation.key) === reservation)
    registry.delete(reservation.key);
  releases.get(reservation)?.();
}

export function hostProcessAlive(pid: number) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export type BeginRunInput<T> = {
  owner: ResponseOwner;
  runId: string;
  logFile: string;
  logRef: string;
  subject: LatestResponseSubject;
  agentProfile?: AgentProfile;
  layer?: 'discovery' | 'product-design';
  actionId?: string;
  sharedCheckout?: boolean;
  startMessage: string;
  conflictMessage?: string;
  phase?: RunPhase;
  actor?: LogActor;
  validate: () => Promise<T>;
  prepare?: (
    reservation: ActiveRunReservation,
    validated: T,
  ) => Promise<() => Promise<void>>;
  persist: (
    reservation: ActiveRunReservation,
    validated: T,
  ) => Promise<() => Promise<void>>;
};

function running(
  input: Omit<BeginRunInput<unknown>, 'validate' | 'prepare' | 'persist'>,
  startedAt: string,
): ActiveRunReservation {
  const key = ownerKey(input.owner);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let publishing: Promise<void> = Promise.resolve();
  let markReleased: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    markReleased = resolve;
  });
  const reservation: ActiveRunReservation = {
    key,
    owner: input.owner,
    runId: input.runId,
    startedAt,
    hostPid: process.pid,
    subject: input.subject,
    agentProfile: input.agentProfile,
    layer: input.layer,
    actionId: input.actionId,
    logFile: input.logFile,
    logRef: input.logRef,
    sharedCheckout: input.sharedCheckout ?? false,
    log: null as unknown as RunLogWriter,
    phase: input.phase ?? 'executing',
    actor: input.actor ?? 'AGENT',
    canceling: false,
    stopResult: null,
    settled: false,
    released,
    attach(next) {
      handles.set(reservation, next);
    },
    setPhase(phase, actor) {
      if (reservation.settled) return;
      reservation.phase = phase;
      if (actor) reservation.actor = actor;
      reservation.log.append({
        level: 'INFO',
        actor: 'HOST',
        phase: phase === 'stopping' ? 'STOP' : 'RUN',
        event: `phase.${phase}`,
        message: `${actor ?? reservation.actor} · ${phase}`,
      });
      void reservation.publishRunning();
    },
    record(entry) {
      const recorded = reservation.log.append(entry);
      if (!reservation.settled) schedule();
      return recorded;
    },
    document() {
      const recent = readableActivity(reservation.log.recent(), 3);
      return {
        schemaVersion: 1,
        owner: storedOwner(input.owner),
        projectId: input.owner.projectId,
        runId: input.runId,
        revision: 0,
        status: 'running',
        phase: reservation.phase,
        actor: reservation.actor,
        title: reservation.phase === 'stopping' ? 'Stopping' : 'Running',
        detail: recent.at(-1)?.message ?? input.startMessage,
        subject: input.subject,
        supplementaryWarnings: [],
        recovery: ['log'],
        startedAt,
        updatedAt: new Date().toISOString(),
        endedAt: null,
        logRef: input.logRef,
        logUrlPath: ownerLogUrlPath(input.owner, input.runId),
        hostPid: process.pid,
        agentProfile: input.agentProfile,
        layer: input.layer,
        actionId: input.actionId,
        recentActivity: recent,
      };
    },
    publishRunning() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      publishing = publishing
        .catch(() => undefined)
        .then(async () => {
          if (reservation.settled || !isCurrentRun(reservation)) return;
          await publishLatestResponse(input.owner, reservation.document());
        })
        .catch((error: unknown) => {
          if (reservation.settled) return;
          reservation.log.append({
            level: 'WARN',
            actor: 'HOST',
            phase: 'RUN',
            event: 'response.publish-failed',
            message:
              error instanceof StaleResponseError
                ? error.message
                : `Running response could not be written: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
      return publishing;
    },
    flushPublish() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        return reservation.publishRunning();
      }
      return publishing;
    },
  };
  releases.set(reservation, markReleased);
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void reservation.publishRunning();
    }, RUNNING_PUBLISH_THROTTLE_MS);
    timer.unref();
  }
  return reservation;
}

function handleOf(reservation: ActiveRunReservation) {
  return handles.get(reservation) ?? null;
}

export async function beginRun<T>(input: BeginRunInput<T>) {
  const key = ownerKey(input.owner);
  const settling = registry.get(key);
  if (settling?.settled && settling.stopResult !== 'unconfirmed')
    await settling.released;
  const existing = registry.get(key);
  if (existing)
    throw new ActiveRunConflictError(
      existing.stopResult === 'unconfirmed'
        ? 'The previous Run could not be stopped. Inspect the workspace before starting another Run.'
        : (input.conflictMessage ?? 'A Run is already active for this owner.'),
    );
  const reservation = running(input, new Date().toISOString());
  registry.set(key, reservation);
  let validated: T;
  try {
    validated = await input.validate();
  } catch (error) {
    releaseRun(reservation);
    throw error;
  }
  const rollbacks: Array<() => Promise<void>> = [];
  let logCreated = false;
  try {
    if (input.prepare)
      rollbacks.push(await input.prepare(reservation, validated));
    reservation.log = await createRunLog(input.logFile, {
      level: 'INFO',
      actor: 'HOST',
      phase: 'RUN',
      event: 'run.started',
      message: input.startMessage,
    });
    logCreated = true;
    rollbacks.push(await input.persist(reservation, validated));
    await publishLatestResponse(input.owner, reservation.document());
  } catch (error) {
    releaseRun(reservation);
    if (logCreated)
      await rm(input.logFile, { force: true }).catch(() => undefined);
    for (const rollback of rollbacks.reverse())
      await rollback().catch(() => undefined);
    throw error;
  }
  return { reservation, validated };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export async function requestStop(
  reservation: ActiveRunReservation,
  graceMs = STOP_GRACE_MS,
): Promise<StopResult> {
  if (reservation.stopResult) return reservation.stopResult;
  reservation.canceling = true;
  reservation.record({
    level: 'INFO',
    actor: 'HOST',
    phase: 'STOP',
    event: 'cancel.requested',
    message: `Cancellation requested during ${reservation.phase}; stopping the active process`,
  });
  reservation.setPhase('stopping', 'HOST');
  await reservation.flushPublish();
  const handle = handleOf(reservation);
  try {
    handle?.cancel();
  } catch (error) {
    reservation.record({
      level: 'WARN',
      actor: 'HOST',
      phase: 'STOP',
      event: 'cancel.signal-failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const completion = handle?.completion ?? Promise.resolve();
  const exited = completion.then(
    () => 'confirmed' as const,
    () => 'confirmed' as const,
  );
  const result = await Promise.race([
    exited,
    sleep(graceMs).then(() => 'unconfirmed' as const),
  ]);
  reservation.stopResult = result;
  if (result === 'confirmed') {
    reservation.log.append({
      level: 'INFO',
      actor: 'HOST',
      phase: 'STOP',
      event: 'cancel.confirmed',
      message: 'The active process exited',
    });
  } else {
    reservation.log.append({
      level: 'ERROR',
      actor: 'HOST',
      phase: 'STOP',
      event: 'cancel.unconfirmed',
      message: `The active process did not exit within ${Math.round(graceMs / 1000)}s`,
    });
    void exited.then(async () => {
      try {
        reservation.log.append({
          level: 'WARN',
          actor: 'HOST',
          phase: 'STOP',
          event: 'process.exited-late',
          message:
            'The active process exited after cancellation was reported as unconfirmed',
        });
        await reservation.log.close();
      } catch {}
      releaseRun(reservation);
    });
  }
  return result;
}

export type SettleInput = {
  classification: ResponseClassification;
  endedAt?: string;
  retained?: RetainedEffects;
  jobLogs?: JobLogReference[];
  accepted?: boolean;
  allowTerminalReplace?: boolean;
};

const terminalEvents = {
  completed: { level: 'INFO', event: 'run.completed' },
  warning: { level: 'WARN', event: 'run.warning' },
  fail: { level: 'ERROR', event: 'run.failed' },
} as const;

export function terminalDocument(
  reservation: ActiveRunReservation,
  input: SettleInput,
): LatestResponseDocument {
  const { classification } = input;
  const recent = readableActivity(reservation.log.recent(), 3);
  return {
    schemaVersion: 1,
    owner: storedOwner(reservation.owner),
    projectId: reservation.owner.projectId,
    runId: reservation.runId,
    revision: 0,
    status: classification.status,
    title: classification.title,
    detail: classification.detail,
    subject: reservation.subject,
    supplementaryWarnings: classification.supplementaryWarnings,
    recovery: classification.recovery,
    startedAt: reservation.startedAt,
    updatedAt: new Date().toISOString(),
    endedAt: input.endedAt ?? new Date().toISOString(),
    logRef: reservation.logRef,
    logUrlPath: ownerLogUrlPath(reservation.owner, reservation.runId),
    hostPid: reservation.hostPid,
    agentProfile: reservation.agentProfile,
    layer: reservation.layer,
    actionId: reservation.actionId,
    retained: input.retained,
    jobLogs: input.jobLogs,
    recentActivity: recent,
    accepted: input.accepted,
  };
}

export async function settleRun(
  reservation: ActiveRunReservation,
  input: SettleInput,
): Promise<LatestResponseDocument | null> {
  const current = isCurrentRun(reservation);
  reservation.settled = true;
  await reservation.flushPublish();
  if (!current) {
    try {
      reservation.log.append({
        level: 'WARN',
        actor: 'HOST',
        phase: 'RUN',
        event: 'response.rejected',
        message:
          'The Run no longer owns the Latest Response; its result was not published',
      });
    } catch {}
    await reservation.log.close();
    return null;
  }
  const terminal = terminalEvents[input.classification.status];
  reservation.log.append({
    level: terminal.level,
    actor: 'HOST',
    phase: 'RUN',
    event: terminal.event,
    message: `${input.classification.title} — ${statusLabel(input.classification.status)} response published`,
  });
  let published: LatestResponseDocument | null = null;
  let failure: unknown = null;
  try {
    published = await publishLatestResponse(
      reservation.owner,
      terminalDocument(reservation, input),
      { allowTerminalReplace: input.allowTerminalReplace },
    );
  } catch (error) {
    if (error instanceof StaleResponseError)
      reservation.log.append({
        level: 'WARN',
        actor: 'HOST',
        phase: 'RUN',
        event: 'response.rejected',
        message: error.message,
      });
    else {
      failure = error;
      reservation.log.append({
        level: 'ERROR',
        actor: 'HOST',
        phase: 'RUN',
        event: 'response.publish-failed',
        message: `The terminal response could not be written: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (reservation.stopResult !== 'unconfirmed') {
    await reservation.log.close();
    releaseRun(reservation);
  }
  if (failure) throw failure;
  return published;
}

function statusLabel(status: ResponseClassification['status']) {
  return status === 'completed'
    ? 'Completed'
    : status === 'warning'
      ? 'Warning'
      : 'Fail';
}
