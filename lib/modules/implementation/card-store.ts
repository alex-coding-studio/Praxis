import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import trash from 'trash';
import { PublicApiError } from '../../api-errors.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import { assertCardUuid } from './card-identity.ts';
import {
  appendCardWorkRecord,
  readCardWorklog,
  readCardWorkDocument,
  type CardWorkRecord,
} from './worklog.ts';

export type StoredPlanningCardSource = {
  module: string;
  uid: string;
  id: string;
  title: string;
  version?: string;
  dependsOn: string[];
  derivedFrom?: string[];
};

export type StoredPlanningCardRun = {
  id: string;
  status: string;
  hostPid: number;
  endedAt: string | null;
  error: string | null;
};

export type StoredPlanningCard = {
  schemaVersion: 1;
  id: string;
  revision: number;
  source: StoredPlanningCardSource;
  actions: unknown[];
  resources: unknown[];
  run: StoredPlanningCardRun | null;
  plan?: { status: string } | null;
  execution?: { runs: unknown[] } | null;
  createdAt: string;
  updatedAt: string;
};

export type ActivePlanningRun = { id: string };

export type PlanningCardDeletion = {
  cardId: string;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
};

const RUN_INTERRUPTED =
  'Planning was interrupted. Your previous plan and input are retained; retry when ready.';

const runtimeGlobal = globalThis as typeof globalThis & {
  jdiPlanningActive?: Map<string, ActivePlanningRun>;
};

export function activePlanningRuns<T extends ActivePlanningRun>() {
  return (runtimeGlobal.jdiPlanningActive ??= new Map()) as Map<string, T>;
}

export function planningCardRoot(project: RegisteredProject) {
  return path.join(project.planningPath, 'implementation', 'cards');
}

export function planningCardKey(project: RegisteredProject, cardId: string) {
  return `${project.planningPath}:${cardId}`;
}

export function planningCardRevisionRef(
  cardId: string,
  revision: number,
  name: string,
) {
  return `implementation/cards/${cardId}/${String(revision).padStart(8, '0')}/${name}`;
}

export function assertPlanningCardRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new PublicApiError('Invalid expected revision.', 400);
}

export async function checkPlanningCardStorageRoot(
  project: RegisteredProject,
  create = false,
) {
  let directory = await realpath(project.planningPath);
  for (const part of ['implementation', 'cards']) {
    directory = path.join(directory, part);
    if (create)
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Invalid Planning storage directory.');
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

export async function loadPlanningCard<T extends StoredPlanningCard>(
  project: RegisteredProject,
  cardId: string,
) {
  await checkPlanningCardStorageRoot(project);
  const log = await readCardWorklog(planningCardRoot(project), cardId);
  if (!log.revision) throw new PublicApiError('Planning Card not found.', 400);
  const card = JSON.parse(
    await readCardWorkDocument(
      planningCardRoot(project),
      cardId,
      log.revision,
      'planning-state.json',
    ),
  ) as T;
  if (
    card.schemaVersion !== 1 ||
    card.id !== cardId ||
    card.revision !== log.revision ||
    !card.source ||
    !Array.isArray(card.actions) ||
    !Array.isArray(card.resources)
  )
    throw new Error('Invalid Planning Card state.');
  return { card, log };
}

export async function commitPlanningCard<T extends StoredPlanningCard>(
  project: RegisteredProject,
  previous: number,
  card: T,
  record: CardWorkRecord,
  files: Record<string, string> = {},
) {
  await checkPlanningCardStorageRoot(project, true);
  const next = {
    ...card,
    revision: previous + 1,
    updatedAt: new Date().toISOString(),
  };
  await appendCardWorkRecord(
    planningCardRoot(project),
    card.id,
    previous,
    record,
    {
      ...files,
      'planning-state.json': JSON.stringify(next),
    },
  );
  return next;
}

export async function readPlanningCard<T extends StoredPlanningCard>(
  project: RegisteredProject,
  cardId: string,
  active: Map<string, ActivePlanningRun> = activePlanningRuns(),
): Promise<T> {
  const { card } = await loadPlanningCard<T>(project, cardId);
  if (
    card.run?.status === 'running' &&
    active.get(planningCardKey(project, cardId))?.id !== card.run.id
  ) {
    if (card.run.hostPid !== process.pid) {
      try {
        process.kill(card.run.hostPid, 0);
        return card;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const next = {
      ...card,
      run: {
        ...card.run,
        status: 'failed',
        endedAt: new Date().toISOString(),
        error: RUN_INTERRUPTED,
      },
    } as T;
    try {
      return await commitPlanningCard(project, card.revision, next, {
        kind: 'system-event',
        stage: 'planning',
        actionId: null,
        event: 'run-ended',
        text: RUN_INTERRUPTED,
        refs: [],
      });
    } catch (error) {
      if (/revision conflict/.test(String(error)))
        return (await loadPlanningCard<T>(project, cardId)).card;
      throw error;
    }
  }
  return card;
}

export async function listPlanningCards<T extends StoredPlanningCard>(
  project: RegisteredProject,
  active: Map<string, ActivePlanningRun> = activePlanningRuns(),
): Promise<T[]> {
  await checkPlanningCardStorageRoot(project);
  const names = await readdir(planningCardRoot(project)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const cards: T[] = [];
  for (const name of names) {
    try {
      assertCardUuid(name);
    } catch {
      continue;
    }
    cards.push(await readPlanningCard<T>(project, name, active));
  }
  return cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function stagePlanningCardDeletion(
  project: RegisteredProject,
  cardId: string,
  expectedRevision: number,
  trashCard: (target: string) => Promise<unknown> = trash,
  active: Map<string, ActivePlanningRun> = activePlanningRuns(),
): Promise<PlanningCardDeletion> {
  assertCardUuid(cardId);
  assertPlanningCardRevision(expectedRevision);
  const card = await readPlanningCard(project, cardId, active);
  if (card.revision !== expectedRevision)
    throw new PublicApiError('Card changed. Reload before trying again.', 409);
  if (card.run?.status === 'running')
    throw new PublicApiError(
      'Stop the Planning Agent before deleting this Card.',
      400,
    );
  if (
    card.plan?.status === 'finalized' ||
    card.actions.length ||
    card.execution?.runs.length
  )
    throw new PublicApiError(
      'Only a Card without a confirmed Plan or execution may be deleted.',
      400,
    );
  const directory = path.join(planningCardRoot(project), cardId);
  const actualRoot = await realpath(planningCardRoot(project));
  const actualDirectory = await realpath(directory);
  const info = await lstat(actualDirectory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !actualDirectory.startsWith(actualRoot + path.sep)
  )
    throw new Error('Card storage ownership changed.');
  const stagingRoot = path.join(actualRoot, '.superseded');
  await mkdir(stagingRoot, { recursive: true });
  const stagingInfo = await lstat(stagingRoot);
  if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink())
    throw new Error('Invalid Card removal staging directory.');
  const stagedDirectory = path.join(stagingRoot, `${cardId}-${randomUUID()}`);
  await rename(actualDirectory, stagedDirectory);
  let settled = false;
  return {
    cardId,
    async rollback() {
      if (settled) return;
      await rename(stagedDirectory, actualDirectory);
      settled = true;
    },
    async finalize() {
      if (settled) return;
      await trashCard(stagedDirectory);
      settled = true;
    },
  };
}
