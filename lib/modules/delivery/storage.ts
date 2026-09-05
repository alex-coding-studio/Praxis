import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  createJsonStore,
  writeFileAtomically,
} from '../../atomic-json-store.ts';
import { PublicApiError } from '../../api-errors.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import type { DeliveryRecord } from './record.ts';
import type { DeliveryModels, DeliverySource } from './types.ts';

export function assertTargetUid(uid: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid)
  )
    throw new PublicApiError('Invalid delivery target.', 400);
}

export async function deliveryDirectory(
  project: RegisteredProject,
  uid?: string,
  create = false,
) {
  if (uid) assertTargetUid(uid);
  let directory = await realpath(project.planningPath);
  for (const part of ['delivery', ...(uid ? ['targets', uid] : [])]) {
    directory = path.join(directory, part);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new PublicApiError('Invalid delivery storage directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (create)
        await mkdir(directory).catch((failure: NodeJS.ErrnoException) => {
          if (failure.code !== 'EEXIST') throw failure;
        });
    }
  }
  return directory;
}

async function recordStore(
  project: RegisteredProject,
  uid: string,
  create = false,
) {
  const directory = await deliveryDirectory(project, uid, create);
  return createJsonStore<DeliveryRecord | null>(
    path.join(directory, 'record.json'),
    () => null,
  );
}

export async function readDeliveryRecord(
  project: RegisteredProject,
  uid: string,
) {
  return (await recordStore(project, uid)).read();
}

export async function listDeliveryRecords(project: RegisteredProject) {
  const directory = await deliveryDirectory(project);
  const entries = await readdir(path.join(directory, 'targets'), {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readDeliveryRecord(project, entry.name)),
  );
  return records.filter((record): record is DeliveryRecord => record !== null);
}

export async function createDeliveryRecord(
  project: RegisteredProject,
  source: DeliverySource,
  models: DeliveryModels,
) {
  const store = await recordStore(project, source.sourceUid, true);
  return store.update(async (existing) => {
    if (existing) return { next: existing, result: existing };
    const at = new Date().toISOString();
    const record: DeliveryRecord = {
      schemaVersion: 1,
      revision: 0,
      source,
      sourceUid: source.sourceUid,
      sourceFingerprint: source.sourceFingerprint,
      status: 'ready',
      createdAt: at,
      updatedAt: at,
      brief: null,
      models,
      instructions: '',
      orchestratorSessionId: null,
      messages: [],
      runs: [],
      agents: [],
      progress: [],
      checks: [],
      review: null,
      workspace: null,
      publication: null,
      response: null,
      acceptedHead: null,
    };
    return { next: record, result: record };
  });
}

export async function updateDeliveryRecord(
  project: RegisteredProject,
  uid: string,
  mutate: (record: DeliveryRecord) => void | Promise<void>,
  expectedRevision?: number,
) {
  return (await recordStore(project, uid)).update(async (record) => {
    if (!record)
      throw new PublicApiError('Delivery target has not been prepared.', 404);
    if (expectedRevision !== undefined && record.revision !== expectedRevision)
      throw new PublicApiError(
        'Delivery changed. Refresh before continuing.',
        409,
      );
    await mutate(record);
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    return { next: record, result: record };
  });
}

export async function readDeliveryInstructions(project: RegisteredProject) {
  return readFile(
    path.join(await deliveryDirectory(project), 'instructions.md'),
    'utf8',
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
}

export async function writeDeliveryInstructions(
  project: RegisteredProject,
  instructions: string,
) {
  await writeFileAtomically(
    path.join(
      await deliveryDirectory(project, undefined, true),
      'instructions.md',
    ),
    instructions,
  );
}

export function deliveryMessage(
  actor: DeliveryRecord['messages'][number]['actor'],
  content: string,
) {
  return { id: randomUUID(), actor, content, at: new Date().toISOString() };
}
