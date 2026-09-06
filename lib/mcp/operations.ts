import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomically } from '../atomic-json-store.ts';
import type { MaterializationReceipt } from '../materialization/receipt.ts';
import type { RegisteredProject } from '../project-registry.ts';
import type { McpErrorEnvelope } from './errors.ts';
import { resourceNotFound } from './errors.ts';
import type { McpModule } from './modules.ts';

export const MCP_OPERATION_ID_PATTERN = /^MCPOP-[0-9a-f-]{36}$/;

export const MCP_OPERATION_STATUSES = [
  'prepared',
  'running',
  'completed',
  'rejected',
  'interrupted',
] as const;

export type McpOperationStatus = (typeof MCP_OPERATION_STATUSES)[number];

export type McpOperationSource = {
  logicalPath: string;
  sha256: string;
  byteLength: number;
};

export type McpOperationRecord = {
  schemaVersion: 1;
  operationId: string;
  projectId: string;
  module: McpModule;
  status: McpOperationStatus;
  transport: 'mcp';
  clientInfo: { name: string; version: string } | null;
  contract: { id: string; version: number; hash: string };
  basis: { fingerprint: string; preparedAt: string };
  runId: string;
  request: Record<string, unknown>;
  userInputPath: string;
  basisPath: string;
  sources: McpOperationSource[];
  preparedAt: string;
  admittedAt: string | null;
  admittedHostPid: number | null;
  semanticResultHash: string | null;
  settledAt: string | null;
  outcome: { kind: string; summary: string } | null;
  receipt: MaterializationReceipt | null;
  logRef: string | null;
  logUrlPath: string | null;
  error: McpErrorEnvelope | null;
};

export function newMcpOperationId() {
  return `MCPOP-${randomUUID()}`;
}

export function isMcpOperationId(value: unknown): value is string {
  return typeof value === 'string' && MCP_OPERATION_ID_PATTERN.test(value);
}

export function mcpOperationsDirectory(project: RegisteredProject) {
  return path.join(project.planningPath, 'mcp', 'operations');
}

export function mcpOperationPaths(
  project: RegisteredProject,
  operationId: string,
) {
  const directory = path.join(mcpOperationsDirectory(project), operationId);
  return {
    directory,
    json: path.join(directory, 'operation.json'),
    basis: path.join(directory, 'basis.json'),
    userInput: path.join(directory, 'user-input.md'),
    userInputRef: path.posix.join(
      'mcp',
      'operations',
      operationId,
      'user-input.md',
    ),
  };
}

export async function writeMcpOperation(
  project: RegisteredProject,
  record: McpOperationRecord,
) {
  const paths = mcpOperationPaths(project, record.operationId);
  await mkdir(paths.directory, { recursive: true });
  await writeFileAtomically(paths.json, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function writeMcpOperationBasis(
  project: RegisteredProject,
  operationId: string,
  basis: unknown,
) {
  const paths = mcpOperationPaths(project, operationId);
  await mkdir(paths.directory, { recursive: true });
  await writeFileAtomically(paths.basis, `${JSON.stringify(basis, null, 2)}\n`);
  return path.posix.join('mcp', 'operations', operationId, 'basis.json');
}

export async function readMcpOperationBasis<T>(
  project: RegisteredProject,
  operationId: string,
): Promise<T> {
  const paths = mcpOperationPaths(project, operationId);
  try {
    return JSON.parse(await readFile(paths.basis, 'utf8')) as T;
  } catch {
    throw resourceNotFound(
      `The frozen Basis for operation ${JSON.stringify(operationId)} is not readable. Prepare a new operation.`,
    );
  }
}

export async function writeMcpOperationUserInput(
  project: RegisteredProject,
  operationId: string,
  userInput: string,
) {
  const paths = mcpOperationPaths(project, operationId);
  await mkdir(paths.directory, { recursive: true });
  await writeFile(paths.userInput, `${userInput.trimEnd()}\n`, 'utf8');
  return paths.userInputRef;
}

function isRecord(value: unknown): value is McpOperationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    isMcpOperationId(record.operationId) &&
    typeof record.projectId === 'string' &&
    typeof record.runId === 'string' &&
    (MCP_OPERATION_STATUSES as readonly string[]).includes(
      record.status as string,
    )
  );
}

export async function findMcpOperation(
  project: RegisteredProject,
  operationId: string,
): Promise<McpOperationRecord | null> {
  if (!isMcpOperationId(operationId)) return null;
  let raw: string;
  try {
    raw = await readFile(mcpOperationPaths(project, operationId).json, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

export async function requireMcpOperation(
  project: RegisteredProject,
  operationId: string,
) {
  const record = await findMcpOperation(project, operationId);
  if (!record)
    throw resourceNotFound(
      `No prepared operation ${JSON.stringify(operationId)} exists in this project. Prepare again with praxis_prepare.`,
    );
  return record;
}

export async function listMcpOperations(project: RegisteredProject) {
  const entries = await readdir(mcpOperationsDirectory(project), {
    withFileTypes: true,
  }).catch(() => []);
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isMcpOperationId(entry.name))
      .map((entry) => findMcpOperation(project, entry.name)),
  );
  return records
    .filter((record): record is McpOperationRecord => record !== null)
    .sort((left, right) => left.preparedAt.localeCompare(right.preparedAt));
}

const lockRuntime = globalThis as typeof globalThis & {
  __praxisMcpOperationLocks?: Map<string, Promise<unknown>>;
};
const locks = (lockRuntime.__praxisMcpOperationLocks ??= new Map());

export function withMcpOperationLock<T>(
  operationId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(operationId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  const settled = next.catch(() => undefined);
  locks.set(operationId, settled);
  void settled.then(() => {
    if (locks.get(operationId) === settled) locks.delete(operationId);
  });
  return next;
}
