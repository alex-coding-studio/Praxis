import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { RegisteredProject } from '../../project-registry.ts';
import type { WhatToDoDeliveryMap } from './map.ts';

const runIdPattern = /^RUN-[0-9a-f-]{36}$/;

export function assertWhatToDoRunId(runId: string) {
  if (!runIdPattern.test(runId)) throw new Error('Invalid What to Do Run.');
}

export async function whatToDoDirectory(
  project: RegisteredProject,
  parts: string[] = [],
  create = false,
) {
  let current = await realpath(project.planningPath);
  const segments = ['what-to-do', ...parts];
  for (const [index, part] of segments.entries()) {
    if (!/^[a-zA-Z0-9._-]+$/.test(part) || part === '.' || part === '..')
      throw new Error('Invalid What to Do storage path.');
    const next = path.join(current, part);
    try {
      const info = await lstat(next);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Invalid What to Do storage directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return path.join(next, ...segments.slice(index + 1));
      await mkdir(next);
    }
    current = next;
  }
  return current;
}

export async function readWhatToDoRepositorySummary(
  project: RegisteredProject,
) {
  const directory = await whatToDoDirectory(project, ['repository-context']);
  const file = path.join(directory, 'summary.md');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024)
      throw new Error('Invalid What to Do Repository Summary.');
    const stored = await readFile(file, 'utf8');
    const match = stored.match(
      /^---\nrepositoryFingerprint: ([0-9a-f]{64})\nmarkdownSha256: ([0-9a-f]{64})\n---\n\n([\s\S]+)$/,
    );
    if (!match)
      throw new Error('Invalid What to Do Repository Summary metadata.');
    const markdown = match[3]!;
    if (createHash('sha256').update(markdown).digest('hex') !== match[2])
      throw new Error('Invalid What to Do Repository Summary metadata.');
    return { markdown, repositoryFingerprint: match[1]! };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function whatToDoRunDirectory(
  project: RegisteredProject,
  runId: string,
  create = false,
) {
  assertWhatToDoRunId(runId);
  return whatToDoDirectory(project, ['runs', runId], create);
}

export async function stageWhatToDoRunDirectory(
  project: RegisteredProject,
  runId: string,
) {
  assertWhatToDoRunId(runId);
  const parent = await whatToDoDirectory(project, ['runs'], true);
  const finalPath = path.join(parent, runId);
  const stagingPath = path.join(
    parent,
    `.${runId}-${randomUUID().slice(0, 8)}.tmp`,
  );
  await mkdir(stagingPath);
  let published = false;
  return {
    stagingPath,
    finalPath,
    async publish() {
      await rename(stagingPath, finalPath);
      published = true;
      return finalPath;
    },
    async cleanup() {
      if (!published) await rm(stagingPath, { recursive: true, force: true });
    },
  };
}

export async function writeWhatToDoRepositorySummary(
  project: RegisteredProject,
  markdown: string,
  repositoryFingerprint: string,
) {
  if (!markdown.trim() || !/^[0-9a-f]{64}$/.test(repositoryFingerprint))
    throw new Error('Invalid What to Do Repository Summary update.');
  const directory = await whatToDoDirectory(
    project,
    ['repository-context'],
    true,
  );
  const markdownSha256 = createHash('sha256').update(markdown).digest('hex');
  await atomicText(
    path.join(directory, 'summary.md'),
    `---\nrepositoryFingerprint: ${repositoryFingerprint}\nmarkdownSha256: ${markdownSha256}\n---\n\n${markdown}`,
  );
}

export async function readWhatToDoCurrentMapWithFingerprint(
  project: RegisteredProject,
): Promise<{ map: WhatToDoDeliveryMap | null; fingerprint: string }> {
  const directory = await whatToDoDirectory(project);
  const file = path.join(directory, 'current-map.json');
  const text = await readFile(file, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  return {
    map: await readWhatToDoCurrentMap(project),
    fingerprint:
      text === null
        ? 'absent'
        : createHash('sha256').update(text).digest('hex'),
  };
}

export async function readWhatToDoCurrentMap(
  project: RegisteredProject,
): Promise<WhatToDoDeliveryMap | null> {
  const directory = await whatToDoDirectory(project);
  const file = path.join(directory, 'current-map.json');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
      throw new Error('Invalid What to Do current Map.');
    const map = JSON.parse(await readFile(file, 'utf8')) as WhatToDoDeliveryMap;
    if (
      map.schemaVersion !== 1 ||
      !/^RUN-[0-9a-f-]{36}$/.test(map.runId) ||
      !Array.isArray(map.contracts) ||
      !Array.isArray(map.sourceClaims) ||
      !Array.isArray(map.sourceSnapshots)
    )
      throw new Error('Invalid What to Do current Map.');
    return map;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeWhatToDoCurrentMap(
  project: RegisteredProject,
  map: WhatToDoDeliveryMap,
) {
  const directory = await whatToDoDirectory(project, [], true);
  await atomicText(
    path.join(directory, 'current-map.json'),
    `${JSON.stringify(map, null, 2)}\n`,
  );
}

export async function atomicWhatToDoText(file: string, content: string) {
  await atomicText(file, content);
}

async function atomicText(file: string, content: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx' });
  await rename(temporary, file);
}
