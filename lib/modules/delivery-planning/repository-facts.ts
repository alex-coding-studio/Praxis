import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { lstat, open, opendir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { includeInGitHistory } from '../../repository-file-policy.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import { PublicApiError } from '../../api-errors.ts';

const execute = promisify(execFile);
const MAX_FILES = 5_000;
const MAX_TOP_LEVEL = 200;
const MAX_EVIDENCE_FILES = 100;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_DIRTY_FILES = 200;
const MAX_DIRTY_BYTES = 32 * 1024 * 1024;
const ignoredDirectories = new Set([
  '.git',
  '.praxis',
  'node_modules',
  '.next',
  'DerivedData',
  'build',
  'dist',
  'coverage',
]);

export type WhatToDoRepositoryFacts = {
  schemaVersion: 1;
  root: string;
  reusable: boolean;
  git: null | {
    objectFormat: string;
    branch: string | null;
    head: string | null;
    dirty: boolean;
    dirtyFingerprint: string;
    dirtyFingerprintTruncated: boolean;
  };
  containsSourceMaterial: boolean;
  observedFileCount: number;
  fileInventoryTruncated: boolean;
  topLevelTruncated: boolean;
  topLevel: Array<{ name: string; kind: 'directory' | 'file' | 'symlink' }>;
  extensions: Record<string, number>;
  paths: {
    manifests: string[];
    projects: string[];
    configuration: string[];
    documentation: string[];
  };
  packageScripts: Record<string, string>;
  evidence: Array<{ path: string; size: number; sha256: string }>;
  fingerprint: string;
};

export async function collectWhatToDoRepositoryFacts(
  project: RegisteredProject,
): Promise<WhatToDoRepositoryFacts> {
  const root = await realpath(project.codePath ?? project.rootPath);
  const git = await readGitFacts(root);
  const [topLevelResult, inventory] = await Promise.all([
    readTopLevel(root),
    readInventory(root, git !== null),
  ]);
  const topLevel = topLevelResult.entries;
  const paths = classifyPaths(inventory.paths, topLevel);
  const evidence = await readEvidence(root, [
    ...paths.manifests,
    ...paths.projects,
    ...paths.configuration,
    ...paths.documentation,
  ]);
  const packageScripts = await readPackageScripts(root, inventory.paths);
  const facts = {
    schemaVersion: 1 as const,
    root,
    reusable:
      !inventory.truncated &&
      !topLevelResult.truncated &&
      !(git?.dirtyFingerprintTruncated ?? false),
    git,
    containsSourceMaterial: inventory.paths.length > 0,
    observedFileCount: inventory.paths.length,
    fileInventoryTruncated: inventory.truncated,
    topLevelTruncated: topLevelResult.truncated,
    topLevel,
    extensions: extensionCounts(inventory.paths),
    paths,
    packageScripts,
    evidence,
  };
  return {
    ...facts,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(facts))
      .digest('hex'),
  };
}

export async function readWhatToDoRepositoryEvidence(
  project: RegisteredProject,
  facts: WhatToDoRepositoryFacts,
) {
  const root = await realpath(project.codePath ?? project.rootPath);
  if (root !== facts.root)
    throw new Error('What to Do repository evidence root changed.');
  return Promise.all(
    facts.evidence.map(async (entry) => {
      const content = await readOwnedFile(root, entry.path, MAX_EVIDENCE_BYTES);
      if (
        !content ||
        content.length !== entry.size ||
        createHash('sha256').update(content).digest('hex') !== entry.sha256
      )
        throw new Error('What to Do repository evidence changed.');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        throw new Error('What to Do repository evidence is not UTF-8 text.');
      }
      return { path: entry.path, content: text };
    }),
  );
}

export async function readWhatToDoTargetedRepositoryEvidence(
  project: RegisteredProject,
  facts: WhatToDoRepositoryFacts,
  paths: string[],
) {
  const root = await realpath(project.codePath ?? project.rootPath);
  if (root !== facts.root)
    throw new Error('What to Do repository evidence root changed.');
  return Promise.all(
    [...new Set(paths)].map(async (relative) => {
      if (
        facts.git &&
        !(
          await git(root, [
            'ls-files',
            '--cached',
            '--others',
            '--exclude-standard',
            '-z',
            '--',
            relative,
          ])
        )
          .split('\0')
          .includes(relative)
      )
        throw new Error(
          'Requested What to Do repository evidence is not in the Git inventory.',
        );
      const content = await readOwnedFile(root, relative, MAX_EVIDENCE_BYTES);
      if (!content)
        throw new Error(
          'Requested What to Do repository evidence is unavailable.',
        );
      const text = decodeRepositoryText(content);
      if (text === null)
        throw new PublicApiError(
          'Selected repository evidence must be UTF-8 text. Images and other binary files cannot be used as text evidence.',
          400,
        );
      return { path: relative, content: text };
    }),
  );
}

async function readGitFacts(root: string) {
  const top = await git(root, ['rev-parse', '--show-toplevel']).catch(() => '');
  if (!top || (await realpath(top).catch(() => '')) !== root) return null;
  const [objectFormat, branch, head, status] = await Promise.all([
    git(root, ['rev-parse', '--show-object-format']),
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
    git(
      root,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      true,
    ),
  ]);
  const dirty = Buffer.byteLength(status) > 0;
  const dirtyEvidence = dirty
    ? await dirtyFileEvidence(root, status)
    : { values: [] as string[], truncated: false };
  return {
    objectFormat,
    branch: branch || null,
    head: /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(head) ? head : null,
    dirty,
    dirtyFingerprint: createHash('sha256')
      .update(status)
      .update(JSON.stringify(dirtyEvidence.values))
      .digest('hex'),
    dirtyFingerprintTruncated: dirtyEvidence.truncated,
  };
}

async function readTopLevel(root: string) {
  const directory = await opendir(root);
  const entries: Dirent[] = [];
  let count = 0;
  for await (const entry of directory) {
    if (!includeRepositoryPath(entry.name)) continue;
    count += 1;
    const index = entries.findIndex((current) => entry.name < current.name);
    if (entries.length < MAX_TOP_LEVEL)
      entries.splice(index < 0 ? entries.length : index, 0, entry);
    else if (index >= 0) {
      entries.splice(index, 0, entry);
      entries.pop();
    }
  }
  return {
    entries: entries
      .map((entry) => ({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? ('symlink' as const)
          : entry.isDirectory()
            ? ('directory' as const)
            : ('file' as const),
      }))
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
    truncated: count > MAX_TOP_LEVEL,
  };
}

async function readInventory(root: string, isGitRepository: boolean) {
  if (isGitRepository) {
    const [tracked, deleted] = await Promise.all([
      git(root, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ]),
      git(root, ['ls-files', '--deleted', '-z']),
    ]);
    const missing = new Set(deleted.split('\0').filter(Boolean));
    const all = tracked
      .split('\0')
      .filter(Boolean)
      .filter((relative) => !missing.has(relative))
      .filter(includeRepositoryPath)
      .sort();
    return {
      paths: all.slice(0, MAX_FILES),
      truncated: all.length > MAX_FILES,
    };
  }

  const files: string[] = [];
  let truncated = false;
  async function visit(relative: string) {
    if (truncated) return;
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(child);
      } else if (entry.isFile() && includeRepositoryPath(child)) {
        files.push(child);
      }
    }
  }
  await visit('');
  return { paths: files, truncated };
}

function classifyPaths(
  files: string[],
  topLevel: WhatToDoRepositoryFacts['topLevel'],
) {
  const manifests = files.filter((file) =>
    /(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod|package\.swift|podfile|gemfile|composer\.json|requirements[^/]*\.txt)$/i.test(
      file,
    ),
  );
  const projects = [
    ...files.filter((file) =>
      /\.(xcodeproj|xcworkspace|sln|code-workspace)$/i.test(file),
    ),
    ...topLevel
      .filter(
        (entry) =>
          entry.kind === 'directory' &&
          /\.(xcodeproj|xcworkspace)$/i.test(entry.name),
      )
      .map((entry) => entry.name),
  ];
  const configuration = files.filter((file) => {
    const name = path.posix.basename(file);
    return (
      /(?:^|[._-])config(?:[._-]|$)/i.test(name) ||
      /^\.(?:editorconfig|swiftlint|swiftformat|eslintrc|prettierrc)/i.test(
        name,
      ) ||
      /\.(?:xcconfig|toml|yaml|yml)$/i.test(name)
    );
  });
  const documentation = files.filter(
    (file) =>
      /(^|\/)(docs?|documentation)\//i.test(file) ||
      /(^|\/)(readme|contributing|architecture|license|agents|claude)(?:\.[^/]*)?$/i.test(
        file,
      ),
  );
  return {
    manifests: unique(manifests),
    projects: unique(projects),
    configuration: unique(configuration),
    documentation: unique(documentation),
  };
}

function extensionCounts(files: string[]) {
  const counts = new Map<string, number>();
  for (const file of files) {
    const extension = path.posix.extname(file).toLowerCase() || '[none]';
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts].sort(
      ([left, leftCount], [right, rightCount]) =>
        rightCount - leftCount || left.localeCompare(right),
    ),
  );
}

async function readEvidence(root: string, files: string[]) {
  const evidence: WhatToDoRepositoryFacts['evidence'] = [];
  for (const relative of unique(files).slice(0, MAX_EVIDENCE_FILES)) {
    const content = await readOwnedFile(root, relative, MAX_EVIDENCE_BYTES);
    if (!content || decodeRepositoryText(content) === null) continue;
    evidence.push({
      path: relative,
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return evidence;
}

function decodeRepositoryText(content: Uint8Array): string | null {
  if (content.some((byte) => byte < 32 && ![9, 10, 12, 13].includes(byte)))
    return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

async function readPackageScripts(root: string, files: string[]) {
  if (!files.includes('package.json')) return {};
  try {
    const content = await readOwnedFile(
      root,
      'package.json',
      MAX_EVIDENCE_BYTES,
    );
    if (!content) return {};
    const value = JSON.parse(content.toString('utf8'));
    if (!value.scripts || typeof value.scripts !== 'object') return {};
    return Object.fromEntries(
      Object.entries(value.scripts)
        .filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  } catch {
    return {};
  }
}

async function dirtyFileEvidence(root: string, status: string) {
  const paths = dirtyPaths(status);
  const values: string[] = [];
  let bytes = 0;
  let truncated = paths.length > MAX_DIRTY_FILES;
  for (const relative of unique(paths).slice(0, MAX_DIRTY_FILES)) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) {
      values.push(`${relative}:missing`);
      continue;
    }
    if (bytes + info.size > MAX_DIRTY_BYTES) {
      truncated = true;
      values.push(`${relative}:unhashed:${info.size}:${info.mtimeMs}`);
      continue;
    }
    const content = await readOwnedFile(root, relative, info.size);
    if (!content) {
      values.push(`${relative}:missing`);
      continue;
    }
    bytes += content.length;
    values.push(
      `${relative}:${createHash('sha256').update(content).digest('hex')}`,
    );
  }
  return { values, truncated };
}

function dirtyPaths(status: string) {
  const entries = status.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? '';
    if (entry.length <= 3) continue;
    const current = entry.slice(3);
    if (includeRepositoryPath(current)) paths.push(current);
    if (/[RC]/.test(entry.slice(0, 2))) index += 1;
  }
  return paths;
}

function safeRelativePath(value: string) {
  return (
    Boolean(value) &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).some((segment) => segment === '..')
  );
}

function includeRepositoryPath(value: string) {
  if (!safeRelativePath(value) || !includeInGitHistory(value)) return false;
  return !ignoredDirectories.has(value.split(/[\\/]/)[0] ?? '');
}

async function readOwnedFile(root: string, relative: string, maxBytes: number) {
  if (!includeRepositoryPath(relative)) return null;
  const absolute = path.join(root, relative);
  const parent = await realpath(path.dirname(absolute)).catch(() => '');
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) return null;
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function unique(values: string[]) {
  return [...new Set(values)].sort();
}

async function git(root: string, args: string[], preserveNul = false) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith('GIT_')) delete environment[key];
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL =
    process.platform === 'win32' ? 'NUL' : '/dev/null';
  const result = await execute('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: environment,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return preserveNul ? result.stdout : result.stdout.trim();
}
