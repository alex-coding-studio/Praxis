import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { AgentProfile } from '../../agents/profile.ts';
import {
  sameModelSelection,
  validateAgentProfile,
} from '../../agents/profile.ts';
import { PublicApiError } from '../../api-errors.ts';
import {
  resolveProductContextReferences,
  type ResolvedProductContextResource,
} from '../product-context/resource.ts';
import {
  readDomainModelCommitReceipt,
  readDomainModel,
  type DomainChange,
} from './model.ts';
import { domainModelDirectory, domainModelFile } from './storage.ts';
import { readDomainModelInstructions } from './context.ts';
import {
  createDomainModelRequest,
  domainModelHarnessVersion,
  domainModelPrompt,
  parseDomainModelEnvelope,
  type DomainModelEnvelope,
  type DomainModelAgentResult,
  type DomainModelRequest,
} from './harness.ts';
import {
  assertDomainModelSelection,
  prepareDomainModelBasis,
} from './basis.ts';
import { materializationLogEntry } from '../../materialization/log.ts';
import {
  rejectionReceipt,
  type MaterializationReceipt,
} from '../../materialization/receipt.ts';
import {
  publishDomainModelResult,
  DOMAIN_MODEL_UNCHANGED_REASON,
  type PublishedDomainModel,
} from './publish.ts';
import { toDomainModelSemanticResult } from './producer-adapter.ts';
import {
  startLocalAgentRun,
  type LocalAgentUsage,
} from '../../agents/transport.ts';
import {
  redactActivity,
  redactRecord,
  type LocalAgentActivity,
} from '../../agents/activity.ts';
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
import {
  agentGraphContentPacket,
  userInputWorkspaceInput,
  writeAgentGraphContextWorkspace,
  type ContextWorkspaceInput,
} from '../../graph/agent/context-workspace.ts';

export type DomainModelRunRecord = {
  schemaVersion: 1;
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  instruction?: string;
  userInputPath?: string | null;
  selectedIds: string[];
  contextRefs?: string[];
  attachmentNames?: string[];
  profile: AgentProfile;
  baseVersion: number;
  startedAt: string;
  endedAt: string | null;
  agentSessionId: string | null;
  usage: LocalAgentUsage | null;
  sessionUsage?: LocalAgentUsage | null;
  activity: Array<{ at: string; summary: string }>;
  result: DomainModelAgentResult | null;
  change: DomainChange | null;
  materialization?: MaterializationReceipt;
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
  terminal: DomainModelRunRecord | null;
  agentOutput: string | null;
  activity: Array<{ at: string; summary: string }>;
  reservation: ActiveRunReservation | null;
};
const DOMAIN_MODEL_RETAINED = 'The Domain Model was not changed.';
const runtime = globalThis as typeof globalThis & {
  domainModelRuns?: Map<string, ActiveRun>;
};
const activeRuns = (runtime.domainModelRuns ??= new Map());

export async function startDomainModelRun(
  project: RegisteredProject,
  input: {
    instruction: string;
    selectedIds: string[];
    profile: AgentProfile;
    contextRefs?: string[];
    files?: File[];
  },
  transport = startLocalAgentRun,
) {
  validateAgentProfile(input.profile);
  const instruction = input.instruction.trim();
  if (!instruction)
    throw new PublicApiError('A Domain Model User Input is required.', 400);
  if (input.selectedIds.length > 20)
    throw new PublicApiError('Select no more than 20 Domain elements.', 400);
  const contextRefs = [...new Set(input.contextRefs ?? [])];
  const files = input.files ?? [];
  if (contextRefs.length > 50)
    throw new PublicApiError('Select no more than 50 Context documents.', 400);
  if (files.length > 20)
    throw new PublicApiError('Attach no more than 20 Markdown files.', 400);
  const contextResources = await resolveProductContextReferences(
    project,
    contextRefs,
    ['domain-model'],
  );
  const key = project.planningPath;
  const runId = `RUN-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const activity: ActiveRun['activity'] = [
    { at: startedAt, summary: 'Generating the Domain Model.' },
  ];
  const active: ActiveRun = {
    runId,
    cancel: () => undefined,
    canceled: false,
    settling: false,
    terminal: null,
    agentOutput: null,
    activity,
    reservation: null,
  };
  let run!: DomainModelRunRecord;
  let request!: DomainModelRequest;
  let coordinatorRun: DomainModelRunRecord | undefined;
  const { reservation } = await beginModuleRun(project, 'domain-model', {
    runId,
    subject: { kind: 'module', label: 'Domain Model' },
    agentProfile: input.profile,
    startMessage: `Domain Modeling Run started with ${input.profile.agent}`,
    validate: async () => {
      const model = await readDomainModel(project);
      const selectedIds = [...new Set(input.selectedIds)];
      assertDomainModelSelection(model, selectedIds);
      const previousSummary = await latestSummary(project);
      coordinatorRun = (await listLatestDomainModelRuns(project, 20)).find(
        (candidate) =>
          canContinueDomainModelSession(candidate, model, input.profile),
      );
      const savedInstructions = await readDomainModelInstructions(project);
      return { model, selectedIds, previousSummary, savedInstructions };
    },
    persist: async (reservation, validated) => {
      const { model, selectedIds, previousSummary, savedInstructions } =
        validated;
      const contextPath = path.join(await runPath(project, runId), 'context');
      const userInput = userInputWorkspaceInput(
        `domain-model/runs/${runId}/context/input/user-input.md`,
        instruction,
      );
      const moduleInstructions: ContextWorkspaceInput | null =
        savedInstructions.trim()
          ? {
              role: 'related',
              kind: 'module-instructions',
              logicalPath: 'domain-model/instructions.md',
              content: savedInstructions,
            }
          : null;
      const workspace = await writeAgentGraphContextWorkspace(
        await runPath(project, runId),
        [
          ...(userInput ? [userInput] : []),
          ...(moduleInstructions ? [moduleInstructions] : []),
          ...(await domainModelContextInputs(runId, contextResources, files)),
        ],
      );
      const content = agentGraphContentPacket(workspace.manifest);
      request = createDomainModelRequest({
        requestId: runId,
        content,
        selectedIds,
        model,
        previousSummary,
        contextRoot: await relativeContextRoot(project, contextPath),
      });
      run = {
        schemaVersion: 1,
        id: runId,
        status: 'running',
        userInputPath: content.input?.workspacePath ?? null,
        selectedIds,
        contextRefs,
        attachmentNames: files.map((file) => file.name),
        profile: structuredClone(input.profile),
        baseVersion: model.stateVersion,
        startedAt,
        endedAt: null,
        agentSessionId: null,
        usage: null,
        sessionUsage: null,
        activity,
        result: null,
        change: null,
        error: null,
        logRef: reservation.logRef,
        hostPid: process.pid,
      };
      await writeRun(project, run, {
        'request.json': JSON.stringify(request),
      });
      return async () => {
        await rm(await runPath(project, runId, false), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      };
    },
  });
  active.reservation = reservation;
  activeRuns.set(key, active);
  const agentRun = transport(input.profile.agent, {
    workingDirectory: project.rootPath,
    protectedPath: project.planningPath,
    prompt: domainModelPrompt(request, {
      continuesExistingSession: Boolean(coordinatorRun),
    }),
    model: input.profile.model || undefined,
    effort: input.profile.effort || undefined,
    resumeSessionId: coordinatorRun?.agentSessionId ?? undefined,
    sessionUsageBaseline:
      coordinatorRun?.sessionUsage ?? coordinatorRun?.usage ?? undefined,
    access: 'read-only',
    disableDelegation: true,
    isolatedProcessGroup: true,
    onActivity: (event) => {
      recordActivity(activity, event);
      reservation.record(agentActivityEntry(event));
    },
  });
  active.cancel = agentRun.cancel;
  reservation.attach(agentRun);
  void agentRun.completion
    .then((result) => settle(project, request, run, active, result))
    .catch((error: unknown) => fail(project, run, active, error))
    .finally(() => {
      if (!active.canceled && activeRuns.get(key) === active)
        activeRuns.delete(key);
    });
  return run;
}

export function canContinueDomainModelSession(
  run: DomainModelRunRecord,
  model: Awaited<ReturnType<typeof readDomainModel>>,
  profile: AgentProfile,
) {
  if (
    run.status !== 'succeeded' ||
    !run.agentSessionId ||
    run.profile.agent !== profile.agent ||
    !sameModelSelection(run.profile, profile) ||
    run.result?.harnessVersion !== domainModelHarnessVersion
  )
    return false;
  return run.result.outcome === 'applied'
    ? model.lastRunId === run.id && model.stateVersion === run.baseVersion + 1
    : model.stateVersion === run.baseVersion;
}

export async function cancelDomainModelRun(
  project: RegisteredProject,
  runId: string,
) {
  const active = activeRuns.get(project.planningPath);
  if (!active || active.runId !== runId)
    throw new PublicApiError('The Domain Model Run is not active.', 400);
  if (active.settling)
    throw new PublicApiError('The Domain Model Run is already finishing.', 409);
  active.canceled = true;
  const reservation = active.reservation;
  const interruptedPhase = reservation?.phase ?? 'executing';
  const stop = reservation ? await stopModuleRun(reservation) : 'confirmed';
  if (!reservation) active.cancel();
  const run = await readDomainModelRun(project, runId);
  const classification = classifyModuleRun(
    stop === 'confirmed'
      ? {
          runState: 'canceled',
          interruptedPhase,
          interruptedActor: 'AGENT',
          retainedNote: DOMAIN_MODEL_RETAINED,
        }
      : { runState: 'termination-unconfirmed', interruptedActor: 'AGENT' },
  );
  const canceled: DomainModelRunRecord = {
    ...run,
    status: stop === 'confirmed' ? 'canceled' : 'failed',
    endedAt: new Date().toISOString(),
    activity: [...active.activity],
    error: stop === 'confirmed' ? null : classification.detail,
    response: classification,
  };
  active.terminal = canceled;
  await writeRun(project, canceled, {
    'activity.jsonl': activityJsonl(canceled.activity),
    'summary.md': `# ${classification.title}\n\n${classification.detail}\n`,
  });
  if (reservation) await settleRun(reservation, { classification });
  if (activeRuns.get(project.planningPath) === active)
    activeRuns.delete(project.planningPath);
  return canceled;
}

export async function readDomainModelRun(
  project: RegisteredProject,
  runId: string,
) {
  if (!/^RUN-[0-9a-f-]{36}$/.test(runId))
    throw new PublicApiError('Invalid Domain Model Run.', 400);
  const run = JSON.parse(
    await readFile(
      await domainModelFile(project, ['runs', runId], 'run.json'),
      'utf8',
    ),
  ) as DomainModelRunRecord;
  const active = activeRuns.get(project.planningPath);
  if (active?.runId === run.id && active.settling)
    return {
      ...run,
      status: 'running' as const,
      endedAt: null,
      result: null,
      change: null,
      error: null,
      activity: [...active.activity],
    };
  if (active?.runId === run.id && active.terminal) return active.terminal;
  if (run.status === 'running' && active?.runId === run.id)
    return { ...run, activity: [...active.activity] };
  if (run.status === 'running') {
    const receipt = await readDomainModelCommitReceipt(project, run.id);
    if (receipt)
      return {
        ...run,
        status: 'succeeded' as const,
        endedAt: receipt.committedAt,
        error:
          'The Domain Model was updated, but some Run evidence could not be saved.',
      };
    return {
      ...run,
      status: 'failed' as const,
      endedAt: new Date().toISOString(),
      error: 'The Agent Run was interrupted. The Domain Model was not changed.',
    };
  }
  return run;
}

export async function listLatestDomainModelRuns(
  project: RegisteredProject,
  limit = 12,
) {
  const entries = await readdir(await runsRoot(project), {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const runs = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && /^RUN-[0-9a-f-]{36}$/.test(entry.name),
      )
      .map((entry) => readDomainModelRun(project, entry.name)),
  );
  return runs
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit);
}

function settledDomainModelResult(
  envelope: DomainModelEnvelope,
  published: PublishedDomainModel,
): DomainModelAgentResult {
  const identity = {
    harnessVersion: envelope.harnessVersion,
    requestId: envelope.requestId,
    baseVersion: envelope.baseVersion,
    inputFingerprint: envelope.inputFingerprint,
    summary: published.summary,
  };
  if (published.outcome === 'clarification')
    return {
      ...identity,
      outcome: 'clarification',
      question: envelope.outcome === 'clarification' ? envelope.question : '',
    };
  if (published.outcome === 'no-change')
    return {
      ...identity,
      outcome: 'no-change',
      reason:
        envelope.outcome === 'no-change'
          ? envelope.reason
          : DOMAIN_MODEL_UNCHANGED_REASON,
    };
  if (published.outcome !== 'model-change')
    throw new Error('A settled Domain Model result must carry its model.');
  return { ...identity, outcome: 'applied', model: published.model };
}

async function settle(
  project: RegisteredProject,
  request: DomainModelRequest,
  original: DomainModelRunRecord,
  active: ActiveRun,
  agent: {
    agentSessionId: string | null;
    finalOutput: string;
    usage: LocalAgentUsage | null;
    sessionUsage?: LocalAgentUsage | null;
  },
) {
  if (active.canceled) return;
  active.settling = true;
  active.agentOutput = agent.finalOutput;
  active.reservation?.setPhase('finalizing', 'HOST');
  const envelope = parseDomainModelEnvelope(agent.finalOutput, request);
  const basis = prepareDomainModelBasis(project, {
    model: request.model,
    selectedIds: request.selectedIds,
  });
  if (active.reservation)
    active.reservation.record(
      materializationLogEntry(
        'materialization.basis.prepared',
        `Prepared the Domain Model Basis at fingerprint ${basis.fingerprint.slice(0, 12)}.`,
      ),
    );
  const semantic = toDomainModelSemanticResult(envelope);
  const published = await publishDomainModelResult(
    project,
    basis,
    semantic,
    {
      kind: 'agent-run',
      runId: original.id,
      userInputPath: original.userInputPath ?? null,
      harness: {
        id: 'praxis.domain-model',
        revision: envelope.harnessVersion,
      },
    },
    undefined,
    active.reservation
      ? (entry) => active.reservation?.record(entry)
      : () => undefined,
  );
  const change = published.change;
  const result = settledDomainModelResult(envelope, published);
  const classification = classifyModuleRun(
    result.outcome === 'applied'
      ? { runState: 'settled', outcome: 'applied', summary: result.summary }
      : result.outcome === 'no-change'
        ? {
            runState: 'settled',
            outcome: 'no-change',
            summary: result.summary,
            reason: result.reason,
          }
        : {
            runState: 'settled',
            outcome: 'clarification',
            question: result.question,
            summary: result.summary,
          },
  );
  const run: DomainModelRunRecord = {
    ...original,
    status: 'succeeded',
    endedAt: new Date().toISOString(),
    agentSessionId: agent.agentSessionId,
    usage: agent.usage,
    sessionUsage: agent.sessionUsage ?? agent.usage,
    activity: [...active.activity],
    result,
    change,
    materialization: published.receipt,
    error: null,
    response: classification,
  };
  active.terminal = run;
  await writeRun(project, run, {
    'activity.jsonl': activityJsonl(run.activity),
    'agent-output.txt': redactRecord(agent.finalOutput).slice(0, 1_500_000),
    'change.json': JSON.stringify(change),
    'summary.md': summaryMarkdown(result, change),
  });
  if (active.reservation)
    await settleRun(active.reservation, {
      classification,
      endedAt: run.endedAt ?? undefined,
    });
}

async function fail(
  project: RegisteredProject,
  original: DomainModelRunRecord,
  active: ActiveRun,
  error: unknown,
) {
  if (active.canceled) return;
  active.settling = true;
  if (active.terminal?.status === 'succeeded') {
    const terminal = active.terminal;
    await writeRun(project, active.terminal, {
      'activity.jsonl': activityJsonl(terminal.activity),
      'summary.md': terminal.result
        ? summaryMarkdown(terminal.result, terminal.change)
        : '# Completed\n\nThe Agent Run completed.\n',
    }).catch(() => undefined);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  active.reservation?.record({
    level: 'ERROR',
    actor: 'HOST',
    phase: 'FINALIZE',
    event: active.agentOutput ? 'result.rejected' : 'agent.failed',
    message,
  });
  const classification = classifyModuleRun({
    runState: 'settled',
    failure: {
      kind: moduleRunFailureKind(error, active.agentOutput),
      message,
    },
  });
  const receipt = rejectionReceipt(error);
  const run: DomainModelRunRecord = {
    ...original,
    status: 'failed',
    endedAt: new Date().toISOString(),
    activity: [...active.activity],
    ...(receipt && { materialization: receipt }),
    error: `${classification.detail} ${DOMAIN_MODEL_RETAINED}`,
    response: classification,
  };
  active.terminal = run;
  const files: Record<string, string> = {
    'activity.jsonl': activityJsonl(run.activity),
    'failure.txt': redactActivity(String(error)).slice(0, 100_000),
    'summary.md': `# ${classification.title}\n\n${run.error}\n`,
  };
  if (active.agentOutput)
    files['agent-output.txt'] = redactRecord(active.agentOutput).slice(
      0,
      1_500_000,
    );
  await writeRun(project, run, files).catch(() => undefined);
  if (active.reservation)
    await settleRun(active.reservation, { classification }).catch(
      () => undefined,
    );
}

async function domainModelContextInputs(
  runId: string,
  contextResources: ResolvedProductContextResource[],
  files: File[],
): Promise<ContextWorkspaceInput[]> {
  const references = contextResources.map((resource) => ({
    role: 'primary' as const,
    kind: 'context',
    logicalPath: resource.path,
    content: resource.markdown,
  }));
  const uploads = await Promise.all(
    files.map(async (file, index) => {
      if (!/\.(md|markdown|txt|html|htm)$/i.test(file.name))
        throw new PublicApiError(
          'Only Markdown files can be attached to a Domain Model Run.',
          400,
        );
      if (file.size > 2 * 1024 * 1024)
        throw new PublicApiError(
          'Each Domain Model attachment must be 2 MB or smaller.',
          400,
        );
      return {
        role: 'primary' as const,
        kind: 'run-attachment',
        logicalPath: path.posix.join(
          'domain-model',
          'runs',
          runId,
          'attachments',
          `${String(index + 1).padStart(3, '0')}-${file.name}`,
        ),
        content: await file.text(),
      };
    }),
  );
  return [...references, ...uploads];
}

async function relativeContextRoot(
  project: RegisteredProject,
  contextPath: string,
) {
  const relative = path.relative(await realpath(project.rootPath), contextPath);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new PublicApiError(
      'Domain Model Context must remain inside the project.',
      400,
    );
  return relative.split(path.sep).join('/');
}

function recordActivity(
  target: ActiveRun['activity'],
  event: LocalAgentActivity,
) {
  const summary = event.summary.trim().slice(0, 600);
  if (!summary) return;
  target.push({ at: new Date().toISOString(), summary });
  if (target.length > 300) target.splice(0, target.length - 300);
}

function activityJsonl(activity: DomainModelRunRecord['activity']) {
  return activity.map((item) => JSON.stringify(item)).join('\n') + '\n';
}

function summaryMarkdown(
  result: DomainModelAgentResult,
  change: DomainChange | null,
) {
  const details = change
    ? `\n## Change summary\n\n${(['added', 'updated', 'removed'] as const)
        .map((kind) => {
          const entries = change[kind];
          const cards = change.items?.[kind].filter(
            (item) => item.kind === 'card',
          );
          const cardNames = cards?.map((item) => item.label).join(', ');
          const label = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
          return `- ${label}: ${cards?.length ?? 0} Cards · ${entries.length} model entries${cardNames ? ` · ${cardNames}` : ''}`;
        })
        .join('\n')}\n`
    : '';
  const attention =
    result.outcome === 'clarification'
      ? `\n## Question\n\n${result.question}\n`
      : result.outcome === 'no-change'
        ? `\n## Reason\n\n${result.reason}\n`
        : '';
  return `# ${result.outcome === 'applied' ? 'Applied' : result.outcome === 'clarification' ? 'Clarification' : 'No change'}\n\n${result.summary}\n${details}${attention}`;
}

async function latestSummary(project: RegisteredProject) {
  const runs = await listLatestDomainModelRuns(project, 20);
  const latest = runs.find((run) => run.status === 'succeeded');
  if (!latest) return '';
  return readFile(
    await domainModelFile(project, ['runs', latest.id], 'summary.md'),
    'utf8',
  ).catch(() => '');
}

async function writeRun(
  project: RegisteredProject,
  run: DomainModelRunRecord,
  files: Record<string, string>,
) {
  const directory = await runPath(project, run.id);
  await atomicText(
    path.join(directory, 'run.json'),
    `${JSON.stringify(run, null, 2)}\n`,
  );
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await atomicText(target, content.endsWith('\n') ? content : `${content}\n`);
  }
}

async function atomicText(file: string, content: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx' });
  await rename(temporary, file);
}

function runsRoot(project: RegisteredProject) {
  return domainModelDirectory(project, ['runs']);
}
function runPath(project: RegisteredProject, runId: string, create = true) {
  return domainModelDirectory(project, ['runs', runId], create);
}
