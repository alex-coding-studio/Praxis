import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const MCP_TOKEN_BYTES = 32;

export type McpCredentials = {
  schemaVersion: 1;
  enabled: boolean;
  token: string;
  createdAt: string;
  rotatedAt: string | null;
};

export function praxisHome() {
  return process.env.PRAXIS_HOME
    ? path.resolve(process.env.PRAXIS_HOME)
    : path.join(homedir(), '.praxis');
}

export function mcpCredentialPath(home = praxisHome()) {
  return path.join(home, 'mcp', 'credentials.json');
}

function isCredentials(value: unknown): value is McpCredentials {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.enabled === 'boolean' &&
    typeof record.token === 'string' &&
    record.token.length >= MCP_TOKEN_BYTES &&
    typeof record.createdAt === 'string' &&
    (record.rotatedAt === null || typeof record.rotatedAt === 'string')
  );
}

export async function readMcpCredentials(
  home = praxisHome(),
): Promise<McpCredentials | null> {
  let raw: string;
  try {
    raw = await readFile(mcpCredentialPath(home), 'utf8');
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
  return isCredentials(parsed) ? parsed : null;
}

async function writeCredentials(home: string, credentials: McpCredentials) {
  const file = mcpCredentialPath(home);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return file;
}

function newToken() {
  return randomBytes(MCP_TOKEN_BYTES).toString('base64url');
}

export async function enableMcpEndpoint(home = praxisHome()) {
  const existing = await readMcpCredentials(home);
  const credentials: McpCredentials = existing
    ? { ...existing, enabled: true }
    : {
        schemaVersion: 1,
        enabled: true,
        token: newToken(),
        createdAt: new Date().toISOString(),
        rotatedAt: null,
      };
  return {
    file: await writeCredentials(home, credentials),
    issued: existing === null,
  };
}

export async function disableMcpEndpoint(home = praxisHome()) {
  const existing = await readMcpCredentials(home);
  if (!existing) return { file: mcpCredentialPath(home), changed: false };
  await writeCredentials(home, { ...existing, enabled: false });
  return { file: mcpCredentialPath(home), changed: existing.enabled };
}

export async function rotateMcpToken(home = praxisHome()) {
  const existing = await readMcpCredentials(home);
  const credentials: McpCredentials = {
    schemaVersion: 1,
    enabled: existing?.enabled ?? true,
    token: newToken(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    rotatedAt: new Date().toISOString(),
  };
  return { file: await writeCredentials(home, credentials) };
}

export async function forgetMcpCredentials(home = praxisHome()) {
  await rm(mcpCredentialPath(home), { force: true });
}

export function matchesMcpToken(expected: string, presented: string) {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
