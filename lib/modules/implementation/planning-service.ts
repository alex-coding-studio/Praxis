import { PublicApiError } from '../../api-errors.ts';
import { validateAcceptanceCriteria } from './checklist.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import trash from 'trash';
import {
  validateAgentProfile,
  type AgentProfile,
} from '../../agents/profile.ts';
import type { CardExecution } from './execution-types.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import {
  startLocalAgentRun,
  type LocalAgentRun,
  type LocalAgentUsage,
} from '../../agents/transport.ts';
import {
  activePlanningRuns,
  assertPlanningCardRevision,
  checkPlanningCardStorageRoot,
  commitPlanningCard,
  listPlanningCards,
  loadPlanningCard,
  planningCardKey,
  planningCardRevisionRef,
  planningCardRoot,
  readPlanningCard,
  stagePlanningCardDeletion,
  type ActivePlanningRun,
} from './card-store.ts';
import { assertCardUuid } from './card-identity.ts';
import {
  createCardHarnessRequest,
  buildCardHarnessPrompt,
  parseCardHarnessResult,
  type ExecutionPlan,
  type ActionContract,
  type CardHarnessContext,
  type CardHarnessRequest,
} from './harness.ts';
import { readCardWorklog, type CardWorkRecord } from './worklog.ts';
import {
  listPlanningSources,
  snapshotPlanningSource,
  readPlanningFile,
  type PlanningSource,
} from './planning-sources.ts';
import { unmetPlanningSourceDependencies } from './source-dependencies.ts';
import { withDeliveryState } from '../../delivery-state-lock.ts';
import { resolveProductContextReferences } from '../product-context/resource.ts';

export type PlanningProfile = AgentProfile;
export type PlanningResource = { name: string; ref: string };
export type PlanningRun = {
  feedback?: string;
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  targetId: string | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  agentSessionId: string | null;
  usage: LocalAgentUsage | null;
  hostPid: number;
  profile: PlanningProfile;
};
export type PlanningCard = {
  schemaVersion: 1;
  id: string;
  revision: number;
  source: PlanningSource;
  sourceRef: string;
  requirements: string;
  resources: PlanningResource[];
  plan: ExecutionPlan | null;
  planRef?: string;
  actions: ActionContract[];
  run: PlanningRun | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  execution?: CardExecution;
  dependencyDecisions?: Record<string, 'dependency' | 'lineage-only'>;
};
export type PendingDependencyReview = {
  id: string;
  uid: string;
  title: string;
};
export type StartPlanningInput = {
  cardId: string;
  expectedRevision: number;
  feedback: string;
  targetId: string | null;
  requirements: string;
  profile: PlanningProfile;
  files: Array<{ name: string; content: string }>;
  contextRefs: string[];
  retainRefs: string[];
};
type Running = ActivePlanningRun & {
  handle: LocalAgentRun | null;
  timer: ReturnType<typeof setTimeout> | null;
};
type Transport = typeof startLocalAgentRun;
const defaultActive = activePlanningRuns<Running>();

const root = planningCardRoot;
const checkStorageRoot = checkPlanningCardStorageRoot;
const revisionRef = planningCardRevisionRef;
const key = planningCardKey;
const assertRevision = assertPlanningCardRevision;

export function validatePlanningProfile(profile: PlanningProfile) {
  validateAgentProfile(profile);
}

export function createPlanningService(
  transport: Transport = startLocalAgentRun,
  active = defaultActive,
  timeoutMs = 600_000,
  trashCard: (path: string) => Promise<unknown> = trash,
) {
  const load = (project: RegisteredProject, cardId: string) =>
    loadPlanningCard<PlanningCard>(project, cardId);

  const commit = (
    project: RegisteredProject,
    previous: number,
    card: PlanningCard,
    record: CardWorkRecord,
    files: Record<string, string> = {},
  ) => commitPlanningCard(project, previous, card, record, files);

  const read = (project: RegisteredProject, cardId: string) =>
    readPlanningCard<PlanningCard>(project, cardId, active);

  const list = (project: RegisteredProject) =>
    listPlanningCards<PlanningCard>(project, active);

  async function dependencyReview(
    project: RegisteredProject,
    card: PlanningCard,
  ): Promise<PendingDependencyReview[]> {
    const [sources, cards] = await Promise.all([
      listPlanningSources(project),
      list(project),
    ]);
    return pendingDependencyReview(card, sources, cards);
  }

  async function dependencyReviews(
    project: RegisteredProject,
    cards: PlanningCard[],
    sources: PlanningSource[],
  ) {
    await checkStorageRoot(project);
    return Object.fromEntries(
      cards.map((card) => [
        card.id,
        pendingDependencyReview(card, sources, cards),
      ]),
    );
  }

  function pendingDependencyReview(
    card: PlanningCard,
    sources: PlanningSource[],
    cards: PlanningCard[],
  ) {
    const dependencies = new Set(card.source.dependsOn);
    const decisions = card.dependencyDecisions ?? {};
    return sources
      .filter(
        (source) =>
          source.uid !== card.source.uid &&
          (card.source.derivedFrom ?? []).some(
            (id) => id === source.uid || id === source.id,
          ) &&
          ![...dependencies].some(
            (id) => id === source.uid || id === source.id,
          ) &&
          decisions[source.uid] !== 'lineage-only' &&
          !sourceDelivered(cards, source),
      )
      .map(({ id, uid, title }) => ({ id, uid, title }));
  }

  async function assertDependencyReview(
    project: RegisteredProject,
    card: PlanningCard,
  ) {
    const pending = await dependencyReview(project, card);
    if (pending.length)
      throw new Error(
        `DEPENDENCY_REVIEW_REQUIRED:${pending.map((item) => item.uid).join(',')}`,
      );
  }

  async function resolveDependency(
    project: RegisteredProject,
    cardId: string,
    expectedRevision: number,
    sourceUid: string,
    decision: 'dependency' | 'lineage-only',
  ) {
    assertCardUuid(cardId);
    assertCardUuid(sourceUid);
    assertRevision(expectedRevision);
    if (!['dependency', 'lineage-only'].includes(decision))
      throw new PublicApiError('Invalid dependency decision.', 400);
    const card = await read(project, cardId);
    if (card.revision !== expectedRevision)
      throw new PublicApiError(
        'Card changed. Reload before trying again.',
        409,
      );
    if (card.run?.status === 'running')
      throw new PublicApiError(
        'Stop the Planning Agent before reviewing dependencies.',
        400,
      );
    if (card.plan?.status === 'finalized' || card.execution?.runs.length)
      throw new PublicApiError(
        'Dependency review is locked after execution is confirmed.',
        400,
      );
    const pending = await dependencyReview(project, card);
    const source = pending.find((item) => item.uid === sourceUid);
    if (!source)
      throw new PublicApiError(
        'Dependency candidate is no longer pending.',
        400,
      );
    const next: PlanningCard = {
      ...card,
      source: {
        ...card.source,
        dependsOn:
          decision === 'dependency'
            ? [...new Set([...card.source.dependsOn, source.uid])]
            : card.source.dependsOn,
      },
      dependencyDecisions: {
        ...card.dependencyDecisions,
        [source.uid]: decision,
      },
      plan: null,
      planRef: undefined,
      actions: [],
      run: null,
      finalizedAt: null,
    };
    return commit(project, card.revision, next, {
      kind: 'user-input',
      stage: 'planning',
      actionId: null,
      text:
        decision === 'dependency'
          ? `User marked ${source.title} as an execution prerequisite.`
          : `User marked ${source.title} as conceptual lineage only.`,
    });
  }

  async function deleteCard(
    project: RegisteredProject,
    cardId: string,
    expectedRevision: number,
  ) {
    const staged = await stageDeleteCard(project, cardId, expectedRevision);
    try {
      await staged.finalize();
    } catch (error) {
      await staged.rollback().catch(() => undefined);
      throw error;
    }
    return { deleted: true as const, cardId };
  }

  const stageDeleteCard = (
    project: RegisteredProject,
    cardId: string,
    expectedRevision: number,
  ) =>
    stagePlanningCardDeletion(
      project,
      cardId,
      expectedRevision,
      trashCard,
      active,
    );

  async function importSourceUnlocked(
    project: RegisteredProject,
    module: string,
    uid: string,
  ) {
    if (!['whats-next', 'task-graph', 'what-to-do'].includes(module))
      throw new PublicApiError('Unknown source module.', 400);
    assertCardUuid(uid);
    await checkStorageRoot(project);
    const existing = await readCardWorklog(root(project), uid);
    if (existing.revision) {
      const card = await read(project, uid);
      await assertCurrentPlanningCardSource(project, card);
      return card;
    }
    let snapshot: Awaited<ReturnType<typeof snapshotPlanningSource>>;
    try {
      snapshot = await snapshotPlanningSource(project, module, uid);
    } catch (error) {
      if (/Formal source Node not found/.test(String(error)))
        throw new PublicApiError(
          'This source is not available in Just Do It.',
          409,
        );
      throw error;
    }
    const { source, markdown } = snapshot;
    const [cards, sources] = await Promise.all([
      list(project),
      listPlanningSources(project),
    ]);
    const unmet = unmetPlanningSourceDependencies(source, cards, sources);
    if (source.module === 'what-to-do' && unmet.length)
      throw new PublicApiError(
        `Complete ${unmet.map((dependency) => dependency.title).join(', ')} before adding this Delivery Contract.`,
        409,
      );
    const now = new Date().toISOString();
    const card: PlanningCard = {
      schemaVersion: 1,
      id: uid,
      revision: 0,
      source,
      sourceRef: revisionRef(uid, 1, 'source.md'),
      requirements: '',
      resources: [],
      plan: null,
      actions: [],
      run: null,
      createdAt: now,
      updatedAt: now,
      finalizedAt: null,
      dependencyDecisions: {},
    };
    try {
      return await commit(
        project,
        0,
        card,
        {
          kind: 'user-input',
          stage: 'planning',
          actionId: null,
          text: `Imported goal: ${source.title}\nSource: ${source.module}/${source.id}`,
        },
        { 'source.md': markdown },
      );
    } catch (error) {
      if (/revision conflict/.test(String(error))) return read(project, uid);
      throw error;
    }
  }

  async function finishUnlocked(
    project: RegisteredProject,
    request: CardHarnessRequest,
    outcome: Awaited<LocalAgentRun['completion']> | Error,
  ) {
    const cardKey = key(project, request.context.cardId);
    try {
      const { card, log } = await load(project, request.context.cardId);
      if (
        card.run?.id !== request.requestId ||
        card.run.status !== 'running' ||
        log.revision !== request.context.contextRevision
      )
        return;
      let raw = '';
      try {
        if (outcome instanceof Error) throw outcome;
        raw = outcome.finalOutput;
        const result = parseCardHarnessResult(raw, request, log.revision);
        if (result.stage !== 'planning')
          throw new Error('Expected a Planning response.');
        const next: PlanningCard = {
          ...card,
          planRef: revisionRef(card.id, card.revision + 1, 'plan.md'),
          plan: {
            status: 'draft',
            overview: result.overview,
            steps: result.steps,
          },
          actions: [],
          run: {
            ...card.run,
            status: 'succeeded',
            endedAt: new Date().toISOString(),
            error: null,
            agentSessionId: outcome.agentSessionId,
            usage: outcome.usage,
          },
        };
        await commit(
          project,
          card.revision,
          next,
          {
            kind: 'agent-note',
            stage: 'planning',
            actionId: request.actionId,
            basedOnRevision: log.revision,
            summary: result.handoffSummary.slice(0, 600),
            currentState:
              `Goal: ${card.source.title}\nPlan: draft, not finalized.\nPlan document: ../${String(card.revision + 1).padStart(8, '0')}/plan.md\n${result.handoffSummary}\nNext: user reviews the current Plan. No Action has executed.`.slice(
                0,
                6000,
              ),
          },
          {
            'result.json': JSON.stringify(result),
            'raw-response.txt': raw,
            'plan.md': renderPlan(next.plan!),
          },
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Planning failed.';
        const next: PlanningCard = {
          ...card,
          run: {
            ...card.run,
            status: 'failed',
            endedAt: new Date().toISOString(),
            error: message,
            agentSessionId:
              outcome instanceof Error ? null : outcome.agentSessionId,
            usage: outcome instanceof Error ? null : outcome.usage,
          },
        };
        await commit(
          project,
          card.revision,
          next,
          {
            kind: 'system-event',
            stage: 'planning',
            actionId: request.actionId,
            event: 'run-ended',
            text: message,
            refs: [],
          },
          raw ? { 'raw-response.txt': raw.slice(0, 500_000) } : {},
        );
      }
    } finally {
      const running = active.get(cardKey);
      if (running?.id === request.requestId) {
        if (running.timer) clearTimeout(running.timer);
        active.delete(cardKey);
      }
    }
  }

  async function finish(
    project: RegisteredProject,
    request: CardHarnessRequest,
    outcome: Awaited<LocalAgentRun['completion']> | Error,
  ) {
    return withDeliveryState(project, () =>
      finishUnlocked(project, request, outcome),
    );
  }

  async function startUnlocked(
    project: RegisteredProject,
    input: StartPlanningInput,
  ) {
    assertCardUuid(input.cardId);
    assertRevision(input.expectedRevision);
    validatePlanningProfile(input.profile);
    if (
      typeof input.feedback !== 'string' ||
      input.feedback.length > 20_000 ||
      typeof input.requirements !== 'string' ||
      input.requirements.length > 20_000 ||
      !Array.isArray(input.files) ||
      !Array.isArray(input.contextRefs) ||
      !Array.isArray(input.retainRefs) ||
      (input.targetId !== null && typeof input.targetId !== 'string')
    )
      throw new PublicApiError('Invalid planning input.', 400);
    const card = await read(project, input.cardId);
    await assertCurrentPlanningCardSource(project, card);
    if (card.revision !== input.expectedRevision)
      throw new PublicApiError(
        'Card changed. Reload before trying again.',
        409,
      );
    if (card.execution?.runs.length)
      throw new PublicApiError(
        'Execution has started. Clean rollback is required before changing the Plan; rollback is not connected yet.',
        400,
      );
    if (card.run?.status === 'running')
      throw new PublicApiError('This Card already has a running Agent.', 409);
    if (card.plan?.status === 'finalized')
      throw new PublicApiError(
        'The finalized Plan and acceptance checklist are locked.',
        400,
      );
    await assertDependencyReview(project, card);
    const { log } = await load(project, input.cardId);
    if (
      input.targetId &&
      (input.requirements !== card.requirements ||
        input.files.length ||
        input.contextRefs.length ||
        input.retainRefs.length !== card.resources.length ||
        card.resources.some((item) => !input.retainRefs.includes(item.ref)))
    ) {
      throw new PublicApiError(
        'Single-step feedback cannot change shared requirements or resources.',
        400,
      );
    }
    const retained = card.resources.filter((item) =>
      input.retainRefs.includes(item.ref),
    );
    if (
      input.retainRefs.some(
        (ref) => !card.resources.some((item) => item.ref === ref),
      )
    )
      throw new PublicApiError('Unknown retained resource.', 400);
    if (retained.length + input.files.length + input.contextRefs.length > 5)
      throw new PublicApiError('Attach no more than five resources.', 400);
    const uploads = input.files.map((file) => {
      if (
        !file ||
        typeof file.name !== 'string' ||
        !/^[^/\\]{1,160}\.(md|markdown|txt|html|htm)$/i.test(file.name) ||
        typeof file.content !== 'string' ||
        Buffer.byteLength(file.content) > 262_144
      )
        throw new PublicApiError(
          'Invalid resource; use text/Markdown up to 256 KB.',
          400,
        );
      return { ...file };
    });
    const contextResources = await resolveProductContextReferences(
      project,
      input.contextRefs,
      ['task-execution'],
    );
    for (const resource of contextResources) {
      uploads.push({
        name: resource.fileName,
        content: resource.markdown,
      });
    }
    let size = uploads.reduce(
      (total, file) => total + Buffer.byteLength(file.content),
      0,
    );
    for (const resource of retained)
      size += Buffer.byteLength(await readPlanningFile(project, resource.ref));
    if (size > 1_048_576)
      throw new PublicApiError('Resources exceed 1 MB.', 400);
    const files: Record<string, string> = {};
    const resources = [...retained];
    for (const file of uploads) {
      const name = `resource-${randomUUID()}.md`;
      files[name] = file.content;
      resources.push({
        name: file.name,
        ref: revisionRef(card.id, card.revision + 1, name),
      });
    }
    const instructions = await readPlanningInstructions(project);
    const context: CardHarnessContext = {
      cardId: card.id,
      contextRevision: card.revision + 1,
      goal: `${card.source.title}\n${card.source.summary}\nUser requirements: ${input.requirements}\nPrerequisites (not yet verified): ${card.source.dependsOn.join(', ') || 'none'}`,
      moduleInstructions: instructions,
      skills: [],
      resources: [
        {
          ref: path.join(project.planningPath, card.sourceRef),
          description: 'Retained source output; read before planning.',
        },
        ...resources.map((item) => ({
          ref: path.join(project.planningPath, item.ref),
          description: item.name,
        })),
        ...(log.handoffPath
          ? [
              {
                ref: log.handoffPath,
                description:
                  'Card handoff: read references relative to this file as needed.',
              },
            ]
          : []),
      ],
      handoffMarkdown: log.handoffMarkdown,
      plan: card.plan,
      acceptedActionIds: [],
      currentOutput: null,
      execution: {
        running: false,
        hasOutput: false,
        effects: 'clean',
        rollbackConfirmed: false,
        consumedByCardIds: [],
      },
    };
    const request = createCardHarnessRequest(
      context,
      'planning',
      input.feedback ||
        input.requirements ||
        'Create the initial execution Plan.',
      input.targetId,
    );
    const now = new Date().toISOString();
    const next: PlanningCard = {
      ...card,
      requirements: input.requirements,
      resources,
      run: {
        id: request.requestId,
        feedback: input.feedback,
        status: 'running',
        targetId: input.targetId,
        startedAt: now,
        endedAt: null,
        error: null,
        agentSessionId: null,
        usage: null,
        hostPid: process.pid,
        profile: input.profile,
      },
    };
    const prompt = `${buildCardHarnessPrompt(request)}\nPlanning-only runtime: read relevant source and selected resources. Never write project files, run implementation, create Issues/PRs, or execute shell commands with external side effects. Return all user-facing plan text in the language of the user's goal and feedback. The host persists the Plan. Use UUID-form step IDs. Project directory: ${project.rootPath}`;
    const runKey = key(project, card.id);
    if (active.has(runKey))
      throw new PublicApiError('This Card already has a running Agent.', 409);
    active.set(runKey, { id: request.requestId, handle: null, timer: null });
    let saved: PlanningCard;
    try {
      saved = await commit(
        project,
        card.revision,
        next,
        {
          kind: 'user-input',
          stage: 'planning',
          actionId: input.targetId,
          text: JSON.stringify({
            requirements: input.requirements,
            feedback: input.feedback,
            profile: input.profile,
            targetId: input.targetId,
            resourceNames: resources.map((item) => item.name),
          }),
        },
        {
          ...files,
          'request.json': JSON.stringify(request),
          'prompt.txt': prompt,
        },
      );
    } catch (error) {
      if (active.get(runKey)?.id === request.requestId) active.delete(runKey);
      throw error;
    }
    if (active.get(runKey)?.id !== request.requestId)
      return (await load(project, card.id)).card;
    let handle: LocalAgentRun;
    try {
      handle = transport(input.profile.agent, {
        workingDirectory: project.rootPath,
        prompt,
        model: input.profile.model || undefined,
        effort: input.profile.effort || undefined,
      });
    } catch (error) {
      await finish(
        project,
        request,
        error instanceof Error ? error : new Error('Could not start Agent.'),
      );
      return (await load(project, card.id)).card;
    }
    const timer = setTimeout(() => {
      handle.cancel();
      void finish(
        project,
        request,
        new Error(
          'Planning timed out. Your input and previous Plan are retained.',
        ),
      ).catch(() => undefined);
    }, timeoutMs);
    timer.unref();
    active.set(key(project, card.id), { id: request.requestId, handle, timer });
    void handle.completion
      .then(
        (result) => finish(project, request, result),
        (error) =>
          finish(
            project,
            request,
            error instanceof Error ? error : new Error(String(error)),
          ),
      )
      .catch(() => undefined);
    return saved;
  }

  async function updateUnlocked(
    project: RegisteredProject,
    cardId: string,
    expectedRevision: number,
    action: 'finalize' | 'reopen' | 'cancel',
  ) {
    if (!['finalize', 'reopen', 'cancel'].includes(action))
      throw new PublicApiError('Unknown Planning operation.', 400);
    assertRevision(expectedRevision);
    const card = await read(project, cardId);
    if (card.revision !== expectedRevision)
      throw new PublicApiError(
        'Card changed. Reload before trying again.',
        409,
      );
    if (action === 'cancel') {
      if (card.run?.status !== 'running') return card;
      const running = active.get(key(project, cardId));
      if (running?.id !== card.run.id)
        throw new Error('This run is owned by another server process.');
      const next = {
        ...card,
        run: {
          ...card.run,
          status: 'canceled' as const,
          endedAt: new Date().toISOString(),
          error: null,
        },
      };
      const saved = await commit(project, card.revision, next, {
        kind: 'system-event',
        stage: 'planning',
        actionId: card.run.targetId,
        event: 'run-ended',
        text: 'User canceled planning; previous draft retained.',
        refs: [],
      });
      if (running.timer) clearTimeout(running.timer);
      running.handle?.cancel();
      active.delete(key(project, cardId));
      return saved;
    }
    if (card.run?.status === 'running')
      throw new PublicApiError(
        'Stop the current Agent before changing Plan state.',
        400,
      );
    if (card.execution?.runs.length)
      throw new PublicApiError(
        'Execution has started. Clean rollback is required before changing the Plan; rollback is not connected yet.',
        400,
      );
    if (!card.plan) throw new PublicApiError('Generate a Plan first.', 400);
    if (action === 'reopen') {
      if (card.plan.status !== 'finalized') return card;
      if (card.execution?.acceptedActionIds.length)
        throw new PublicApiError(
          'Clean rollback is required before reopening an accepted Plan.',
          400,
        );
      return commit(
        project,
        card.revision,
        {
          ...card,
          plan: { ...card.plan, status: 'draft' },
          actions: [],
          finalizedAt: null,
        },
        {
          kind: 'system-event',
          stage: 'planning',
          actionId: null,
          event: 'plan-reopened',
          text: 'User reopened the confirmed Plan before execution. The previous draft remains available for adjustment.',
          refs: [],
        },
      );
    }
    if (action === 'finalize') {
      await assertDependencyReview(project, card);
      for (const step of card.plan.steps)
        validateAcceptanceCriteria(step.acceptanceCriteria);
      if (card.run?.status !== 'succeeded')
        throw new PublicApiError(
          'Only a successful current Plan can be finalized.',
          400,
        );
      return commit(
        project,
        card.revision,
        {
          ...card,
          plan: { ...card.plan, status: 'finalized' },
          actions: structuredClone(card.plan.steps),
          finalizedAt: new Date().toISOString(),
        },
        {
          kind: 'system-event',
          stage: 'planning',
          actionId: null,
          event: 'plan-finalized',
          text: 'User confirmed the entire Plan. Actions are ready for manual execution.',
          refs: [],
        },
      );
    }
    return commit(
      project,
      card.revision,
      {
        ...card,
        plan: { ...card.plan, status: 'draft' },
        actions: [],
        finalizedAt: null,
      },
      {
        kind: 'user-input',
        stage: 'planning',
        actionId: null,
        text: 'User reopened the Plan before any Action execution or output.',
      },
    );
  }

  async function importSource(
    project: RegisteredProject,
    module: string,
    uid: string,
  ) {
    return withDeliveryState(project, () =>
      importSourceUnlocked(project, module, uid),
    );
  }

  async function start(project: RegisteredProject, input: StartPlanningInput) {
    return withDeliveryState(project, () => startUnlocked(project, input));
  }

  async function update(
    project: RegisteredProject,
    cardId: string,
    expectedRevision: number,
    action: 'finalize' | 'reopen' | 'cancel',
  ) {
    return withDeliveryState(project, () =>
      updateUnlocked(project, cardId, expectedRevision, action),
    );
  }
  return {
    list,
    read,
    importSource,
    dependencyReview,
    dependencyReviews,
    resolveDependency,
    deleteCard,
    stageDeleteCard,
    start,
    update,
    sources: listPlanningSources,
  };
}

export const planningService = createPlanningService();

export async function assertCurrentPlanningCardSource(
  project: RegisteredProject,
  card: PlanningCard,
) {
  if (card.source.module !== 'what-to-do') return;
  const current = (await listPlanningSources(project)).find(
    (source) =>
      source.module === 'what-to-do' && source.uid === card.source.uid,
  );
  if (
    !current ||
    !card.source.version ||
    current.version !== card.source.version ||
    current.id !== card.source.id
  )
    throw new PublicApiError(
      'This Delivery Contract is no longer current. Return to What to Do before continuing.',
      409,
    );
}

function sourceDelivered(cards: PlanningCard[], source: PlanningSource) {
  const card = cards.find(
    (item) => item.source.uid === source.uid || item.source.id === source.id,
  );
  return Boolean(
    card?.actions.length &&
    card.actions.every((action) =>
      card.execution?.acceptedActionIds.includes(action.id),
    ),
  );
}

export async function readPlanningInstructions(project: RegisteredProject) {
  try {
    const value = await readPlanningFile(
      project,
      'implementation/instructions.md',
      80_000,
    );
    if (value.length > 20_000)
      throw new PublicApiError('Instructions exceed 20000 characters.', 400);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export async function savePlanningInstructions(
  project: RegisteredProject,
  value: string,
) {
  if (typeof value !== 'string' || value.length > 20_000)
    throw new PublicApiError(
      'Instructions must contain at most 20000 characters.',
      400,
    );
  const directory = path.join(project.planningPath, 'implementation');
  await mkdir(directory, { recursive: true });
  const actual = await realpath(directory);
  if (!actual.startsWith((await realpath(project.planningPath)) + path.sep))
    throw new Error('Instructions directory escapes the project.');
  const temp = path.join(directory, `instructions-${randomUUID()}.tmp`);
  await writeFile(temp, value, { flag: 'wx' });
  await rename(temp, path.join(directory, 'instructions.md'));
}

function renderPlan(plan: ExecutionPlan) {
  return `# Plan\n\n${plan.overview}\n\n${plan.steps.map((step) => `## ${step.title}\n\nID: ${step.id}\n\n### Input\n${step.input}\n\n### Output\n${step.output}\n\n### Validation\n${step.validation}\n\n### Required acceptance checklist\n${(step.acceptanceCriteria ?? []).map((item) => `- ${item.id}: ${item.criterion}\n  Pass: ${item.passCondition}\n  Evidence: ${item.evidence}`).join('\n')}`).join('\n\n')}\n`;
}
