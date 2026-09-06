import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type test from 'node:test';
import { createStartNode } from '../../lib/graph/task/model.ts';
import { readWhatsNextRun } from '../../lib/modules/product-discovery/runs.ts';
import { readTaskDecompositionRun } from '../../lib/modules/scope-decomposition/runs.ts';
import { listActiveRuns } from '../../lib/execution-observability/active-runs.ts';
import type { RegisteredProject } from '../../lib/project-registry.ts';

type LaunchOptions = Parameters<
  typeof import('../../lib/agents/transport.ts').startLocalAgentRun
>[1];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ALIAS = /\b(NODE|CANDIDATE)-([0-9a-f]{8,32})\b/g;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z/g;
const SHA256 = /\b[0-9a-f]{64}\b/g;
const HOST_PID = /"hostPid": \d+/g;
const HOST_PID_COMPACT = /"hostPid":\d+/g;

export type GoldenCanonicalizer = (value: string) => string;

export function createCanonicalizer(): GoldenCanonicalizer {
  const uids = new Map<string, string>();
  const hashes = new Map<string, string>();
  const orphanAliases = new Map<string, string>();
  const placeholderFor = (uid: string) => {
    const existing = uids.get(uid);
    if (existing) return existing;
    const placeholder = `U${uids.size}`;
    uids.set(uid, placeholder);
    return placeholder;
  };
  return (value: string) =>
    value
      .replace(SHA256, (hash) => {
        const existing = hashes.get(hash);
        if (existing) return existing;
        const placeholder = `H${hashes.size}`;
        hashes.set(hash, placeholder);
        return placeholder;
      })
      .replace(UUID, (uid) => placeholderFor(uid))
      .replace(ALIAS, (alias, prefix: string, suffix: string) => {
        for (const [uid, placeholder] of uids) {
          if (uid.replaceAll('-', '').endsWith(suffix))
            return `${prefix}-${placeholder}`;
        }
        const existing = orphanAliases.get(alias);
        if (existing) return existing;
        const placeholder = `${prefix}-X${orphanAliases.size}`;
        orphanAliases.set(alias, placeholder);
        return placeholder;
      })
      .replace(TIMESTAMP, 'T')
      .replace(HOST_PID, '"hostPid": 0')
      .replace(HOST_PID_COMPACT, '"hostPid":0');
}

export async function createGoldenProject(
  t: test.TestContext,
  title = 'Build my local website',
  scope: 'whats-next' | 'task-graph' = 'whats-next',
) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'graph-golden-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project: RegisteredProject = {
    id: 'golden-project',
    name: 'Golden fixture',
    kind: 'standalone',
    rootPath,
    codePath: null,
    planningPath: path.join(rootPath, '.praxis'),
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await mkdir(project.planningPath);
  const created = await createStartNode(
    project,
    { title, idea: 'Build it', contextRefs: [], files: [] },
    scope,
  );
  return { project, source: created.node };
}

export function deferredLaunch() {
  const calls: LaunchOptions[] = [];
  let resolveCompletion!: (finalOutput: string) => void;
  const completion = new Promise<{
    agentSessionId: string | null;
    finalOutput: string;
    usage: null;
  }>((resolve) => {
    resolveCompletion = (finalOutput: string) =>
      resolve({ agentSessionId: null, finalOutput, usage: null });
  });
  const launch = (
    _agent: 'codex' | 'claude' | 'deepseek',
    options: LaunchOptions,
  ) => {
    calls.push(options);
    return { completion, cancel: () => undefined };
  };
  return {
    calls,
    launch: launch as never,
    respond: (finalOutput: string) => resolveCompletion(finalOutput),
  };
}

async function settledGraphRun<T extends { status: string }>(
  project: RegisteredProject,
  runId: string,
  read: (project: RegisteredProject, runId: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read(project, runId);
    if (!['running', 'validating'].includes(value.status)) {
      const active = listActiveRuns(project.planningPath).find(
        (candidate) => candidate.runId === runId,
      );
      if (active) await active.released;
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The fixture Run did not settle.');
}

export function settledRun(project: RegisteredProject, runId: string) {
  return settledGraphRun(project, runId, readWhatsNextRun);
}

export function settledTaskDecompositionRun(
  project: RegisteredProject,
  runId: string,
) {
  return settledGraphRun(project, runId, readTaskDecompositionRun);
}

async function readTree(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  )) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await readTree(root, next)));
    else files.push(next);
  }
  return files;
}

const CAPTURED =
  /(?:^|\/)(?:run\.json|semantic-result\.json|node\.json|identities\.json|output\.md)$/;

type CapturedFile = { key: string; text: string };

function seedOrder(files: CapturedFile[]) {
  const seeds: string[] = [];
  const startNode = files.find(
    (file) =>
      file.key.endsWith('/node.json') && file.text.includes('"role": "start"'),
  );
  if (startNode) seeds.push(startNode.text);
  const runs = files
    .filter((file) => file.key.endsWith('/run.json'))
    .map((file) => ({ file, record: JSON.parse(file.text) }))
    .sort(
      (left, right) =>
        String(left.record.startedAt).localeCompare(
          String(right.record.startedAt),
          'en',
        ) ||
        String(left.record.runId).localeCompare(
          String(right.record.runId),
          'en',
        ),
    );
  for (const { record } of runs) {
    for (const candidate of record.result?.candidates ?? [])
      seeds.push(JSON.stringify(candidate.uid ?? candidate.candidateId));
    seeds.push(
      JSON.stringify([record.runId, record.sessionId, record.requestId]),
    );
  }
  return seeds;
}

export async function captureGraphState(
  project: RegisteredProject,
  canonicalize: GoldenCanonicalizer = createCanonicalizer(),
) {
  const files: CapturedFile[] = [];
  for (const scope of ['whats-next', 'task-graph', 'task-decomposition']) {
    const root = path.join(project.planningPath, scope);
    for (const relative of await readTree(root)) {
      if (!CAPTURED.test(relative)) continue;
      files.push({
        key: `${scope}/${relative}`,
        text: await readFile(path.join(root, relative), 'utf8'),
      });
    }
  }
  for (const seed of seedOrder(files)) canonicalize(seed);
  const captured: Record<string, unknown> = {};
  for (const file of [...files].sort((left, right) =>
    canonicalize(left.key).localeCompare(canonicalize(right.key), 'en'),
  )) {
    const key = canonicalize(file.key);
    captured[key] = file.key.endsWith('.json')
      ? withSortedIdentitySet(JSON.parse(canonicalize(file.text)))
      : canonicalize(file.text);
  }
  return captured;
}

function sortStrings(value: unknown) {
  return Array.isArray(value)
    ? [...(value as string[])].sort((left, right) =>
        String(left).localeCompare(String(right), 'en'),
      )
    : value;
}

function withSortedIdentitySet(value: unknown) {
  if (!value || typeof value !== 'object') return value;
  const record = value as {
    formalAliases?: unknown;
    input?: { resourcePaths?: unknown };
  };
  if (Array.isArray(record.formalAliases))
    record.formalAliases = sortStrings(record.formalAliases) as string[];
  if (record.input && Array.isArray(record.input.resourcePaths))
    record.input.resourcePaths = sortStrings(
      record.input.resourcePaths,
    ) as string[];
  return value;
}

const DOMAIN_CAPTURED =
  /(?:^|\/)(?:state\.json|run\.json|semantic-result\.json|request\.json|change\.json|summary\.md)$/;

export async function captureDomainModelState(
  project: RegisteredProject,
  canonicalize: GoldenCanonicalizer = createCanonicalizer(),
) {
  const root = path.join(project.planningPath, 'domain-model');
  const files: CapturedFile[] = [];
  for (const relative of await readTree(root)) {
    if (!DOMAIN_CAPTURED.test(relative)) continue;
    files.push({
      key: `domain-model/${relative}`,
      text: await readFile(path.join(root, relative), 'utf8'),
    });
  }
  const stateFile = files.find((file) => file.key.endsWith('/state.json'));
  if (stateFile) canonicalize(stateFile.text);
  const captured: Record<string, unknown> = {};
  for (const file of [...files].sort((left, right) =>
    canonicalize(left.key).localeCompare(canonicalize(right.key), 'en'),
  )) {
    captured[canonicalize(file.key)] = file.key.endsWith('.json')
      ? JSON.parse(canonicalize(file.text))
      : canonicalize(file.text);
  }
  return captured;
}
