import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { redactRecord } from '../agents/activity.ts';
import { writeFileAtomically } from '../atomic-json-store.ts';
import { createRunLog, type RunLogWriter } from './run-log.ts';
import { hostOperationLogUrlPath } from './types.ts';

export const HOST_OPERATION_KINDS = [
  'sync-main',
  'undo-action',
  'reread-result',
  'restart-from-base',
  'reopen-plan',
  'workspace-create',
  'github-refresh',
  'candidate-publish',
  'acceptance',
  'withdraw-delivery',
] as const;
export type HostOperationKind = (typeof HOST_OPERATION_KINDS)[number];

export const HOST_OPERATION_ID_PATTERN = /^OP-[0-9a-f-]{36}$/i;

export type HostOperationRecord = {
  schemaVersion: 1;
  id: string;
  kind: HostOperationKind;
  label: string;
  projectId: string;
  cardId: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'fail';
  title: string;
  detail: string;
  logRef: string;
};

export type HostOperationOutcome<T> = {
  operationId: string;
  logRef: string;
  logUrlPath: string;
  result: T;
};

export function hostOperationPaths(planningPath: string, operationId: string) {
  const directory = path.join(planningPath, 'host/operations');
  return {
    directory,
    log: path.join(directory, `${operationId}.log`),
    json: path.join(directory, `${operationId}.json`),
    logRef: `host/operations/${operationId}.log`,
  };
}

async function writeRecord(file: string, record: HostOperationRecord) {
  await writeFileAtomically(file, `${JSON.stringify(record, null, 2)}\n`);
}

export type HostOperationContext = {
  log: RunLogWriter;
  operationId: string;
  logRef: string;
  logUrlPath: string;
};

export async function runHostOperation<T>(
  project: { id: string; planningPath: string },
  input: { kind: HostOperationKind; label: string; cardId?: string },
  work: (context: HostOperationContext) => Promise<T>,
): Promise<HostOperationOutcome<T>> {
  const operationId = `OP-${randomUUID()}`;
  const paths = hostOperationPaths(project.planningPath, operationId);
  const startedAt = new Date().toISOString();
  const record: HostOperationRecord = {
    schemaVersion: 1,
    id: operationId,
    kind: input.kind,
    label: input.label,
    projectId: project.id,
    cardId: input.cardId ?? null,
    startedAt,
    endedAt: null,
    status: 'running',
    title: input.label,
    detail: `${input.label} started`,
    logRef: paths.logRef,
  };
  const log = await createRunLog(paths.log, {
    level: 'INFO',
    actor: 'HOST',
    phase: 'RUN',
    event: 'operation.started',
    message: `${input.kind}: ${input.label}`,
  });
  await writeRecord(paths.json, record);
  const logUrlPath = hostOperationLogUrlPath(project.id, operationId);
  try {
    const result = await work({
      log,
      operationId,
      logRef: paths.logRef,
      logUrlPath,
    });
    log.append({
      level: 'INFO',
      actor: 'HOST',
      phase: 'FINALIZE',
      event: 'operation.completed',
      message: `${input.label} completed`,
    });
    await log.close();
    await writeRecord(paths.json, {
      ...record,
      endedAt: new Date().toISOString(),
      status: 'completed',
      detail: `${input.label} completed`,
    });
    return { operationId, logRef: paths.logRef, logUrlPath, result };
  } catch (error) {
    const message = redactRecord(
      error instanceof Error ? error.message : String(error),
    );
    log.append({
      level: 'ERROR',
      actor: 'HOST',
      phase: 'FINALIZE',
      event: 'operation.failed',
      message,
    });
    await log.close().catch(() => undefined);
    await writeRecord(paths.json, {
      ...record,
      endedAt: new Date().toISOString(),
      status: 'fail',
      title: `${input.label} failed`,
      detail: message,
    }).catch(() => undefined);
    throw error;
  }
}
