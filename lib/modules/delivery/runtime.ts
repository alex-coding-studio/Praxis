import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CodexAppServerDriver } from '../../agents/codex/app-server-driver.ts';
import { ClaudeSessionDriver } from '../../agents/claude/session-driver.ts';
import { DeepseekSessionDriver } from '../../agents/deepseek/session-driver.ts';
import { HostJobBroker } from '../../agents/host-job-broker.ts';
import type {
  AgentSessionDriver,
  AgentRuntimeThread,
  AgentRuntimeTurn,
  HostTool,
} from '../../agents/runtime-driver.ts';
import type { AgentProfile } from '../../agents/profile.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import {
  createRunLog,
  type RunLogWriter,
} from '../../execution-observability/run-log.ts';
import { PublicApiError, recordUnexpectedApiError } from '../../api-errors.ts';
import {
  deliveryDirectory,
  deliveryMessage,
  readDeliveryInstructions,
  readDeliveryRecord,
  updateDeliveryRecord,
} from './storage.ts';
import { selectDeliveryModel } from './models.ts';
import {
  publishDeliveryCandidate,
  readyDeliveryForReview,
} from './publication.ts';
import { deliveryGit, prepareDeliveryWorkspace } from './workspace.ts';
import {
  DELIVERY_PRINCIPLES,
  ORCHESTRATOR_INSTRUCTIONS,
  REVIEWER_INSTRUCTIONS,
  WORKER_INSTRUCTIONS,
} from './instructions.ts';
import {
  shouldPrepareDeliveryReview,
  type DeliveryRecord,
  type DeliveryRun,
} from './record.ts';
import { claimDeliveryTarget } from './ownership.ts';
import { recognizeExistingDelivery } from './existing-delivery.ts';

export type DeliveryDriverFactory = (
  project: RegisteredProject,
  profile: AgentProfile,
  tools: HostTool[],
) => AgentSessionDriver;

type ActiveDelivery = {
  canceled: boolean;
  turns: Set<AgentRuntimeTurn>;
  operations: Set<Promise<unknown>>;
  completion?: Promise<void>;
};
const state = globalThis as typeof globalThis & {
  deliveryRuns?: Map<string, ActiveDelivery>;
};
const activeRuns = (state.deliveryRuns ??= new Map());

function runtimeKey(project: RegisteredProject, uid: string) {
  return `${project.planningPath}:${uid}`;
}

function driverFor(
  project: RegisteredProject,
  profile: AgentProfile,
  tools: HostTool[],
): AgentSessionDriver {
  const options = {
    brokerFactory: (thread: { workingDirectory: string }) =>
      new HostJobBroker(
        thread.workingDirectory,
        path.join(project.planningPath, 'delivery/jobs'),
      ),
    hostTools: tools,
  };
  if (profile.agent === 'codex') return new CodexAppServerDriver(options);
  if (profile.agent === 'claude') return new ClaudeSessionDriver(options);
  return new DeepseekSessionDriver(options);
}

function text(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim())
    throw new PublicApiError(`${label} is required.`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new PublicApiError(`${label} must be a text list.`);
  return value;
}

function hostTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  call: HostTool['call'],
): HostTool {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties,
      required: Object.keys(properties),
    },
    call:
      name === 'dispatch_agent'
        ? async (args) => ({
            suspend: true,
            acknowledgement:
              'Specialist started. Continue when its result is delivered.',
            continuation: call(args).then(
              (result) => ({
                prompt: `Specialist result:\n${JSON.stringify(result)}`,
              }),
              (error) => ({
                prompt: `Specialist could not finish: ${String(error)}. Preserve prior work and decide the next useful action.`,
              }),
            ),
          })
        : call,
  };
}

export async function startDeliveryRun(
  project: RegisteredProject,
  uid: string,
  kind: DeliveryRun['kind'],
  input: string,
  createDriver: DeliveryDriverFactory = driverFor,
) {
  const key = runtimeKey(project, uid);
  if (activeRuns.has(key))
    throw new PublicApiError('This delivery is already running.', 409);
  const release = claimDeliveryTarget(project, uid);
  const active: ActiveDelivery = {
    canceled: false,
    turns: new Set(),
    operations: new Set(),
  };
  activeRuns.set(key, active);
  let log: RunLogWriter | undefined;
  try {
    const record = await readDeliveryRecord(project, uid);
    if (!record) throw new PublicApiError('Prepare the target first.', 404);
    if (record.status === 'completed')
      throw new PublicApiError('This delivery has already completed.');
    if (kind !== 'brief' && !record.brief?.confirmedAt)
      throw new PublicApiError('Confirm the delivery brief first.');
    if (kind !== 'brief' && !record.models.workers.length)
      throw new PublicApiError(
        'Configure the Worker model pool before starting delivery.',
      );
    const run: DeliveryRun = {
      moduleInstructions: await readDeliveryInstructions(project),
      hostPid: process.pid,
      id: randomUUID(),
      kind,
      input,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'running',
      head: null,
      error: null,
    };
    log = await createRunLog(
      path.join(
        await deliveryDirectory(project, uid, true),
        'logs',
        `${run.id}.log`,
      ),
      {
        level: 'INFO',
        actor: 'HOST',
        phase: 'PREPARE',
        event: 'delivery.started',
        message: input || 'Continue delivery.',
      },
    );
    await updateDeliveryRecord(project, uid, (current) => {
      current.runs.push(run);
      current.messages.push(deliveryMessage('USER', input));
      current.status = kind === 'brief' ? 'briefing' : 'running';
      current.response = null;
      current.lastWithdrawal = undefined;
    });
    active.completion = executeDelivery(
      project,
      uid,
      run,
      active,
      log,
      createDriver,
    ).finally(() => {
      activeRuns.delete(key);
      release();
    });
    void active.completion.catch((error) =>
      recordUnexpectedApiError(run.id, 'delivery settlement', error),
    );
    return run;
  } catch (error) {
    activeRuns.delete(key);
    release();
    await log?.close();
    throw error;
  }
}

export async function cancelDeliveryRun(
  project: RegisteredProject,
  uid: string,
) {
  const active = activeRuns.get(runtimeKey(project, uid));
  if (!active) return;
  active.canceled = true;
  for (const turn of active.turns) turn.interrupt();
  await active.completion;
}

export async function waitForDeliveryRun(
  project: RegisteredProject,
  uid: string,
) {
  await activeRuns.get(runtimeKey(project, uid))?.completion;
}

export function isDeliveryRunActive(project: RegisteredProject, uid: string) {
  return activeRuns.has(runtimeKey(project, uid));
}

async function executeDelivery(
  project: RegisteredProject,
  uid: string,
  run: DeliveryRun,
  active: ActiveDelivery,
  log: RunLogWriter,
  createDriver: DeliveryDriverFactory,
) {
  const drivers = new Set<AgentSessionDriver>();
  let childBusy = false;
  const record = async () => (await readDeliveryRecord(project, uid))!;
  const assertActive = () => {
    if (active.canceled) throw new Error('Delivery canceled.');
  };
  async function invoke(
    profile: AgentProfile,
    role: 'ORCHESTRATOR' | 'WORKER' | 'REVIEWER',
    prompt: string,
    sessionId: string | null,
    tools: HostTool[],
    onThread: (thread: AgentRuntimeThread) => Promise<void>,
  ) {
    assertActive();
    const current = await record();
    const driver = createDriver(project, profile, tools);
    drivers.add(driver);
    const instructions =
      role === 'ORCHESTRATOR'
        ? ORCHESTRATOR_INSTRUCTIONS
        : role === 'WORKER'
          ? WORKER_INSTRUCTIONS
          : REVIEWER_INSTRUCTIONS;
    const threadInput = {
      profile,
      workingDirectory:
        current.workspace?.path ?? project.codePath ?? project.rootPath,
      access:
        run.kind === 'brief' || role === 'REVIEWER'
          ? ('read-only' as const)
          : ('workspace-write' as const),
      instructions: `${DELIVERY_PRINCIPLES}\n\n${instructions}`,
      hostJobs: run.kind !== 'brief' && role !== 'REVIEWER',
      advertiseHostJobs: role === 'ORCHESTRATOR',
    };
    let thread: AgentRuntimeThread;
    if (sessionId) {
      try {
        thread = await driver.resumeThread({
          ...threadInput,
          threadId: sessionId,
          provider: driver.provider,
        });
      } catch (error) {
        log.append({
          level: 'WARN',
          actor: role,
          phase: 'RECOVERY',
          event: 'session.unavailable',
          message: String(error),
        });
        thread = await driver.startThread(threadInput);
      }
    } else thread = await driver.startThread(threadInput);
    await onThread(thread);
    await updateDeliveryRecord(project, uid, (value) => {
      value.actor = role;
    });
    assertActive();
    const turn = driver.startTurn(thread, {
      prompt,
      onEvent: (event) => {
        if (event.type === 'activity')
          log.append({
            level: 'INFO',
            actor: role,
            phase: 'EXECUTE',
            event: 'agent.activity',
            message: event.summary,
          });
      },
    });
    active.turns.add(turn);
    try {
      return await turn.completion;
    } finally {
      active.turns.delete(turn);
      await driver.close();
      drivers.delete(driver);
    }
  }
  const tools: HostTool[] = [
    hostTool(
      'submit_existing_delivery',
      'When current main already satisfies the confirmed target, submit its verified existing implementation for user acceptance without creating a redundant PR.',
      { reason: { type: 'string' } },
      async (args) => {
        assertActive();
        return recognizeExistingDelivery(
          project,
          uid,
          text(args.reason, 'Existing delivery reason'),
        );
      },
    ),
    hostTool(
      'report_delivery',
      'Save the concise user-facing outcome of this round. Use warning for a concrete unresolved decision or recoverable need; use fail for an execution failure. Completion of a round does not accept the target.',
      {
        status: { enum: ['completed', 'warning', 'fail'] },
        title: { type: 'string' },
        detail: { type: 'string' },
      },
      async (args) => {
        assertActive();
        if (!['completed', 'warning', 'fail'].includes(String(args.status)))
          throw new PublicApiError('Invalid delivery response status.');
        const response = {
          status: args.status as 'completed' | 'warning' | 'fail',
          title: text(args.title, 'Title'),
          detail: text(args.detail, 'Detail'),
        };
        await updateDeliveryRecord(project, uid, (current) => {
          current.response = response;
        });
        return response;
      },
    ),
    hostTool(
      'read_delivery_diff',
      'Read the current target changes against its starting commit. Supply repository-relative paths to narrow the diff, or an empty list for all changes.',
      { paths: { type: 'array', items: { type: 'string' } } },
      async (args) => {
        assertActive();
        const current = await record();
        if (!current.workspace)
          throw new PublicApiError('No implementation workspace exists yet.');
        const paths = strings(args.paths, 'Paths');
        const head = await deliveryGit(
          current.workspace.path,
          'rev-parse',
          'HEAD',
        );
        return {
          head,
          base: current.workspace.base,
          diff: await deliveryGit(
            current.workspace.path,
            'diff',
            current.workspace.base,
            head,
            '--',
            ...paths,
          ),
        };
      },
    ),
    hostTool(
      'publish_delivery',
      'Commit and publish the current target as its continuing Draft PR. Reuse this tool for corrections; publication does not imply user acceptance.',
      { title: { type: 'string' }, body: { type: 'string' } },
      async (args) => {
        assertActive();
        if (run.kind === 'brief')
          throw new PublicApiError(
            'Wait for implementation to finish before publishing.',
          );
        const result = await publishDeliveryCandidate(
          project,
          uid,
          text(args.title, 'Title'),
          text(args.body, 'Description'),
        );
        log.append({
          level: 'INFO',
          actor: 'HOST',
          phase: 'PUBLISH',
          event: 'delivery.published',
          message: `${result.pullRequest.url} at ${result.headSha}`,
        });
        return result;
      },
    ),
    hostTool(
      'record_delivery_checks',
      'Record actual technical verification for the exact current commit. Reuse evidence only when it remains applicable to this commit and inputs.',
      {
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { enum: ['passed', 'failed', 'not-run'] },
              head: { type: 'string' },
              evidence: { type: 'string' },
            },
            required: ['id', 'status', 'head', 'evidence'],
            additionalProperties: false,
          },
        },
      },
      async (args) => {
        assertActive();
        const current = await record();
        if (!current.workspace || childBusy)
          throw new PublicApiError(
            'Finish the active implementation before recording checks.',
          );
        const head = await deliveryGit(
          current.workspace.path,
          'rev-parse',
          'HEAD',
        );
        const checks = args.checks as DeliveryRecord['checks'];
        if (
          !Array.isArray(checks) ||
          checks.some(
            (check) =>
              check.head !== head ||
              !check.evidence?.trim() ||
              !['passed', 'failed', 'not-run'].includes(check.status) ||
              !current.brief?.criteria.some(
                (criterion) => criterion.id === check.id,
              ),
          ) ||
          new Set(checks.map((check) => check.id)).size !== checks.length
        )
          throw new PublicApiError(
            'Checks must identify current-commit evidence for unique brief criteria.',
          );
        await updateDeliveryRecord(project, uid, (value) => {
          value.checks = checks;
        });
        return { head, recorded: checks.length };
      },
    ),
    hostTool(
      'record_review_decision',
      'Decide whether an independent Reviewer adds value for the current change. Explain actual scope and risk; do not require review just because code changed.',
      { required: { type: 'boolean' }, reason: { type: 'string' } },
      async (args) => {
        assertActive();
        const current = await record();
        if (!current.workspace || childBusy)
          throw new PublicApiError(
            'Finish implementation before deciding review scope.',
          );
        const head = await deliveryGit(
          current.workspace.path,
          'rev-parse',
          'HEAD',
        );
        const reason = text(args.reason, 'Review reason');
        if (typeof args.required !== 'boolean')
          throw new PublicApiError(
            'Specify whether independent review is required.',
          );
        await updateDeliveryRecord(project, uid, (value) => {
          if (
            args.required &&
            value.review?.head === head &&
            value.review.approved
          )
            return;
          if (
            !args.required &&
            value.review?.head === head &&
            value.review.disposition === 'required' &&
            value.review.reviewerSessionId &&
            !value.review.approved
          )
            throw new PublicApiError(
              'Address the independent findings before changing the review disposition.',
            );
          value.review = {
            head,
            disposition: args.required ? 'required' : 'not-required',
            reason,
            approved: false,
            reviewerSessionId: null,
          };
        });
        return { head, required: args.required, reason };
      },
    ),
    hostTool(
      'save_delivery_brief',
      'Save the proposed outcome for confirmation. Criteria contain only technical checks; place subjective visual or experience judgments in userAcceptance, never in technical gates.',
      {
        outcome: { type: 'string' },
        included: { type: 'array', items: { type: 'string' } },
        excluded: { type: 'array', items: { type: 'string' } },
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              verification: { type: 'string' },
            },
            required: ['id', 'description', 'verification'],
            additionalProperties: false,
          },
        },
        openDecisions: { type: 'array', items: { type: 'string' } },
        userAcceptance: { type: 'array', items: { type: 'string' } },
      },
      async (args) => {
        assertActive();
        const criteria = args.criteria as NonNullable<
          DeliveryRecord['brief']
        >['criteria'];
        if (!Array.isArray(criteria) || !criteria.length)
          throw new PublicApiError('Provide observable acceptance criteria.');
        const ids = new Set<string>();
        for (const criterion of criteria) {
          text(criterion.id, 'Criterion id');
          text(criterion.description, 'Criterion');
          text(criterion.verification, 'Verification');
          if (ids.has(criterion.id))
            throw new PublicApiError('Duplicate criterion.');
          ids.add(criterion.id);
        }
        return updateDeliveryRecord(project, uid, (current) => {
          current.brief = {
            revision: (current.brief?.revision ?? 0) + 1,
            outcome: text(args.outcome, 'Outcome'),
            included: strings(args.included, 'Included'),
            excluded: strings(args.excluded, 'Excluded'),
            criteria,
            openDecisions: strings(args.openDecisions, 'Open decisions'),
            userAcceptance: strings(
              args.userAcceptance ?? [],
              'User acceptance',
            ),
            confirmedAt: null,
          };
          current.checks = [];
          current.review = null;
          current.existingDelivery = null;
        });
      },
    ),
    hostTool(
      'update_delivery_progress',
      'Update the observable work outline; these items are not independent delivery gates.',
      {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              status: { enum: ['pending', 'running', 'completed'] },
            },
            required: ['id', 'title', 'status'],
            additionalProperties: false,
          },
        },
      },
      async (args) => {
        assertActive();
        const items = args.items as DeliveryRecord['progress'];
        if (
          !Array.isArray(items) ||
          items.some(
            (item) =>
              !item.id ||
              !item.title ||
              !['pending', 'running', 'completed'].includes(item.status),
          )
        )
          throw new PublicApiError('Invalid progress items.');
        await updateDeliveryRecord(project, uid, (current) => {
          current.progress = items;
        });
        return { saved: true };
      },
    ),
    hostTool(
      'dispatch_agent',
      'Delegate a bounded outcome to a Worker or request independent Review. Reuse assignmentId for follow-up in the same specialist session. Choose a model from its pool.',
      {
        assignmentId: { type: 'string' },
        role: { enum: ['worker', 'reviewer'] },
        instruction: { type: 'string' },
        reason: { type: 'string' },
        profile: {
          type: 'object',
          properties: {
            agent: { enum: ['codex', 'claude', 'deepseek'] },
            model: { type: 'string' },
            effort: { type: 'string' },
          },
          required: ['agent', 'model', 'effort'],
          additionalProperties: false,
        },
      },
      async (args) => {
        assertActive();
        if (run.kind === 'brief')
          throw new PublicApiError(
            'Discuss and confirm the brief before implementation.',
          );
        if (childBusy)
          throw new PublicApiError(
            'A specialist is active in this workspace. Continue after its result.',
          );
        childBusy = true;
        try {
          const current = await record();
          const role: 'worker' | 'reviewer' =
            args.role === 'reviewer' ? 'reviewer' : 'worker';
          const profile = selectDeliveryModel(
            current.models,
            role,
            args.profile as AgentProfile,
          );
          const assignmentId = text(args.assignmentId, 'Assignment id');
          const previous = current.agents.find(
            (agent) => agent.id === assignmentId,
          );
          if (previous && previous.role !== role)
            throw new PublicApiError('An assignment cannot change role.');
          const instruction = text(args.instruction, 'Instruction');
          log.append({
            level: 'INFO',
            actor: 'ORCHESTRATOR',
            phase: 'EXECUTE',
            event: 'agent.dispatched',
            message: `${role}: ${profile.agent}/${profile.model}/${profile.effort}. ${text(args.reason, 'Selection reason')}`,
          });
          const head = current.workspace
            ? await deliveryGit(current.workspace.path, 'rev-parse', 'HEAD')
            : '';
          await updateDeliveryRecord(project, uid, (value) => {
            value.status = role === 'reviewer' ? 'reviewing' : 'running';
          });
          const result = await invoke(
            profile,
            role === 'worker' ? 'WORKER' : 'REVIEWER',
            JSON.stringify({
              instruction,
              stopAt: current.stopAt ?? 'ready-for-review',
              brief: current.brief,
              userInstructions: current.instructions,
              moduleInstructions: run.moduleInstructions,
              source: current.source,
              contextRoot: project.planningPath,
              head,
              previousResult: previous?.result,
            }),
            previous?.profile.agent === profile.agent &&
              previous.profile.model === profile.model
              ? previous.sessionId
              : null,
            tools.filter((tool) =>
              role === 'reviewer'
                ? tool.name === 'read_delivery_diff'
                : ['read_delivery_diff', 'publish_delivery'].includes(
                    tool.name,
                  ),
            ),
            async (thread) => {
              await updateDeliveryRecord(project, uid, (value) => {
                const agent = {
                  id: assignmentId,
                  role,
                  profile,
                  sessionId: thread.threadId,
                  instruction,
                  result: null,
                };
                const index = value.agents.findIndex(
                  (entry) => entry.id === assignmentId,
                );
                if (index >= 0) value.agents[index] = agent;
                else value.agents.push(agent);
              });
            },
          );
          await updateDeliveryRecord(project, uid, (value) => {
            value.agents.find((agent) => agent.id === assignmentId)!.result =
              result.finalOutput;
            value.agents.find((agent) => agent.id === assignmentId)!.usage =
              result.usage;
            value.status = 'running';
            if (role === 'reviewer') {
              let review: {
                approved?: boolean;
                summary?: string;
                findings?: Array<{ blocking?: boolean }>;
              };
              try {
                review = JSON.parse(result.finalOutput);
              } catch {
                throw new PublicApiError(
                  'Reviewer output could not be read. Resume the reviewer to return the requested result.',
                );
              }
              value.review = {
                head,
                disposition: 'required',
                reason: review.summary || 'Independent review',
                approved:
                  review.approved === true &&
                  Array.isArray(review.findings) &&
                  !review.findings.some(
                    (finding) => finding.blocking !== false,
                  ),
                reviewerSessionId: result.threadId,
              };
            }
          });
          return { assignmentId, head, result: result.finalOutput };
        } finally {
          childBusy = false;
          if (!active.canceled)
            await updateDeliveryRecord(project, uid, (value) => {
              value.actor = 'ORCHESTRATOR';
              value.status = 'running';
            });
        }
      },
    ),
  ];
  for (const tool of tools) {
    const call = tool.call;
    tool.call = async (args) => {
      const operation = call(args);
      active.operations.add(operation);
      try {
        const result = await operation;
        if (
          result &&
          typeof result === 'object' &&
          'continuation' in result &&
          result.continuation instanceof Promise
        ) {
          const continuation = result.continuation;
          active.operations.add(continuation);
          void continuation.then(
            () => active.operations.delete(continuation),
            () => active.operations.delete(continuation),
          );
        }
        return result;
      } finally {
        active.operations.delete(operation);
      }
    };
  }
  try {
    let current = await record();
    if (run.kind !== 'brief') {
      const workspace = await prepareDeliveryWorkspace(project, current);
      await updateDeliveryRecord(project, uid, (value) => {
        value.workspace = workspace;
      });
      current = await record();
    }
    const result = await invoke(
      current.models.orchestrator,
      'ORCHESTRATOR',
      JSON.stringify({
        kind: run.kind,
        stopAt: current.stopAt ?? 'ready-for-review',
        input: run.input,
        source: current.source,
        contextRoot: project.planningPath,
        brief: current.brief,
        moduleInstructions: run.moduleInstructions,
        instructions: current.instructions,
        models: current.models,
        progress: current.progress,
        recentMessages: current.messages.slice(-12),
        priorAgents: current.agents.map(
          ({ id, role, profile, sessionId, result }) => ({
            id,
            role,
            profile,
            sessionId,
            summary: result?.slice(0, 600),
          }),
        ),
        fullRecordPath: path.join(
          await deliveryDirectory(project, uid),
          'record.json',
        ),
        review: current.review,
        workspace: current.workspace,
      }),
      current.orchestratorSessionId,
      tools,
      async (thread) => {
        await updateDeliveryRecord(project, uid, (value) => {
          value.orchestratorSessionId = thread.threadId;
        });
      },
    );
    assertActive();
    const delivered = await record();
    if (run.kind !== 'brief' && shouldPrepareDeliveryReview(delivered)) {
      await readyDeliveryForReview(project, uid);
      log.append({
        level: 'INFO',
        actor: 'HOST',
        phase: 'PUBLISH',
        event: 'delivery.ready-for-review',
        message: `${delivered.publication!.url} is ready for review. User acceptance is still pending.`,
      });
    }
    assertActive();
    await updateDeliveryRecord(project, uid, (value) => {
      const storedRun = value.runs.find((entry) => entry.id === run.id)!;
      storedRun.status = 'completed';
      storedRun.usage = result.usage;
      storedRun.endedAt = new Date().toISOString();
      value.messages.push(deliveryMessage('ORCHESTRATOR', result.finalOutput));
      value.status =
        value.response?.status === 'fail' ? 'failed' : 'waiting-for-user';
      value.response ??= {
        status: 'completed',
        title:
          run.kind === 'brief' ? 'Delivery brief prepared' : 'Delivery update',
        detail: result.finalOutput,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.append({
      level: active.canceled ? 'WARN' : 'ERROR',
      actor: 'HOST',
      phase: active.canceled ? 'STOP' : 'FINALIZE',
      event: active.canceled ? 'delivery.canceled' : 'delivery.failed',
      message,
    });
    await updateDeliveryRecord(project, uid, (value) => {
      const storedRun = value.runs.find((entry) => entry.id === run.id)!;
      storedRun.status = active.canceled ? 'canceled' : 'failed';
      storedRun.error = message;
      storedRun.endedAt = new Date().toISOString();
      value.status = active.canceled ? 'warning' : 'failed';
      value.response = {
        status: active.canceled ? 'warning' : 'fail',
        title: active.canceled
          ? 'Delivery canceled'
          : 'Delivery needs attention',
        detail: message,
      };
    });
  } finally {
    while (active.operations.size) await Promise.allSettled(active.operations);
    for (const driver of drivers)
      await (
        active.canceled
          ? (driver.dispose?.('Delivery canceled.') ?? driver.close())
          : driver.close()
      ).catch(() => undefined);
    await log.close();
  }
}
