import { PublicApiError } from '../api-errors.ts';
import { isStaleBasisError } from '../materialization/receipt.ts';
import path from 'node:path';
import type { LocalAgentActivity } from '../agents/activity.ts';
import type { AgentProfile } from '../agents/profile.ts';
import type { RegisteredProject } from '../project-registry.ts';
import {
  beginRun,
  getActiveRun,
  hostProcessAlive,
  requestStop,
  type ActiveRunReservation,
} from './active-runs.ts';
import {
  publishLatestResponse,
  readLatestResponse,
} from './latest-response-store.ts';
import { openRunLog } from './run-log.ts';
import { classifyResponse, type ClassificationFacts } from './status.ts';
import {
  ownerLogUrlPath,
  storedOwner,
  type LatestResponseDocument,
  type LatestResponseSubject,
  type ResponseModule,
  type ResponseOwner,
  type RunLogInput,
} from './types.ts';

export const MODULE_CONFLICT_MESSAGES: Record<ResponseModule, string> = {
  'whats-next': 'A Product Exploration and Design Run is already active.',
  'task-decomposition': 'A Scope Decomposition Run is already active.',
  'domain-model': 'A Domain Modeling Run is already active.',
  'what-to-do': 'A Delivery Planning Run is already active.',
};

export function moduleOwner(
  project: RegisteredProject,
  module: ResponseModule,
): ResponseOwner {
  return {
    kind: 'module',
    projectId: project.id,
    planningPath: project.planningPath,
    module,
  };
}

export function moduleRunLogPaths(
  project: RegisteredProject,
  module: ResponseModule,
  runId: string,
) {
  const logRef = path.posix.join(module, 'runs', runId, 'run.log');
  return {
    logRef,
    logFile: path.join(project.planningPath, module, 'runs', runId, 'run.log'),
  };
}

export type BeginModuleRunInput<T> = {
  runId: string;
  subject: LatestResponseSubject;
  layer?: 'discovery' | 'product-design';
  agentProfile?: AgentProfile;
  startMessage: string;
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

export function beginModuleRun<T>(
  project: RegisteredProject,
  module: ResponseModule,
  input: BeginModuleRunInput<T>,
) {
  const paths = moduleRunLogPaths(project, module, input.runId);
  return beginRun<T>({
    owner: moduleOwner(project, module),
    runId: input.runId,
    logFile: paths.logFile,
    logRef: paths.logRef,
    subject: input.subject,
    layer: input.layer,
    agentProfile: input.agentProfile,
    startMessage: input.startMessage,
    conflictMessage: MODULE_CONFLICT_MESSAGES[module],
    phase: 'executing',
    actor: 'AGENT',
    validate: input.validate,
    prepare: input.prepare,
    persist: input.persist,
  });
}

export function agentActivityEntry(event: LocalAgentActivity): RunLogInput {
  return {
    level: 'INFO',
    actor: 'AGENT',
    phase: 'EXECUTE',
    event:
      event.kind === 'tool'
        ? 'tool.activity'
        : event.kind === 'result'
          ? 'agent.result'
          : 'agent.message',
    message: event.summary,
  };
}

export function stopModuleRun(
  reservation: ActiveRunReservation,
  graceMs?: number,
) {
  return requestStop(reservation, graceMs);
}

export function classifyModuleRun(facts: Omit<ClassificationFacts, 'surface'>) {
  return classifyResponse({ ...facts, surface: 'module' });
}

export type LegacyModuleRun = {
  runId: string;
  startedAt: string;
  endedAt: string | null;
  profile?: AgentProfile;
};

export function legacyModuleDocument(
  project: RegisteredProject,
  module: ResponseModule,
  run: LegacyModuleRun,
  presentation: {
    status: LatestResponseDocument['status'];
    title: string;
    detail: string;
    subject: LatestResponseSubject;
    recovery: LatestResponseDocument['recovery'];
  },
): LatestResponseDocument {
  const owner = moduleOwner(project, module);
  return {
    schemaVersion: 1,
    owner: storedOwner(owner),
    projectId: project.id,
    runId: run.runId,
    revision: 0,
    status: presentation.status,
    title: presentation.title,
    detail: presentation.detail,
    subject: presentation.subject,
    supplementaryWarnings: [],
    recovery: presentation.recovery,
    startedAt: run.startedAt,
    updatedAt: run.endedAt ?? run.startedAt,
    endedAt: run.endedAt,
    logRef: moduleRunLogPaths(project, module, run.runId).logRef,
    logUrlPath: ownerLogUrlPath(owner, run.runId),
    hostPid: 0,
    agentProfile: run.profile,
    recentActivity: [],
    reconstructed: true,
  };
}

export type ReadModuleResponseOptions = {
  fallback?: () => Promise<LatestResponseDocument | null>;
  onOwnershipLost?: (document: LatestResponseDocument) => Promise<void>;
};

export async function readModuleResponse(
  project: RegisteredProject,
  module: ResponseModule,
  options: ReadModuleResponseOptions = {},
): Promise<LatestResponseDocument | null> {
  return readOwnerResponse(moduleOwner(project, module), {
    ...options,
    logFileFor: (document) =>
      moduleRunLogPaths(project, module, document.runId).logFile,
  });
}

export type ReadOwnerResponseOptions = ReadModuleResponseOptions & {
  logFileFor: (document: LatestResponseDocument) => string;
};

export async function readOwnerResponse(
  owner: ResponseOwner,
  options: ReadOwnerResponseOptions,
): Promise<LatestResponseDocument | null> {
  const current = await readLatestResponse(owner);
  if (!current) return (await options.fallback?.()) ?? null;
  if (current.status !== 'running') return current;
  const active = getActiveRun(owner);
  if (active?.runId === current.runId) return active.document();
  if (current.hostPid !== process.pid && hostProcessAlive(current.hostPid))
    return current;
  return recoverLostRun(owner, current, options);
}

async function recoverLostRun(
  owner: ResponseOwner,
  current: LatestResponseDocument,
  options: ReadOwnerResponseOptions,
) {
  try {
    const log = await openRunLog(options.logFileFor(current));
    log.append({
      level: 'ERROR',
      actor: 'HOST',
      phase: 'RECOVERY',
      event: 'recovery.ownership-lost',
      message: `Host process ${current.hostPid} no longer owns this Run; closing it as Fail`,
    });
    await log.close();
  } catch {}
  const classification = classifyResponse({
    surface: owner.kind,
    runState: 'ownership-lost',
  });
  const failed: LatestResponseDocument = {
    ...current,
    status: classification.status,
    phase: undefined,
    actor: undefined,
    title: classification.title,
    detail: classification.detail,
    supplementaryWarnings: classification.supplementaryWarnings,
    recovery: classification.recovery,
    updatedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    hostPid: process.pid,
  };
  let published: LatestResponseDocument;
  try {
    published = await publishLatestResponse(owner, failed);
  } catch {
    return (await readLatestResponse(owner)) ?? failed;
  }
  await options.onOwnershipLost?.(published).catch(() => undefined);
  return published;
}

export function moduleRunFailureKind(
  error: unknown,
  agentOutput: string | null,
): 'persistence' | 'parse' | 'transport' {
  if (
    isStaleBasisError(error) ||
    (error instanceof PublicApiError && error.status === 409)
  ) {
    return 'persistence';
  }
  return agentOutput ? 'parse' : 'transport';
}
