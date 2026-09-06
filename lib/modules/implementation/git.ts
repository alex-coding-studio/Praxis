import { includeInGitHistory } from '../../repository-file-policy.ts';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, readlink, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RegisteredProject } from '../../project-registry.ts';
import { assertCardUuid } from './harness.ts';
import type { WorkspaceSnapshot } from './artifacts.ts';

const exec = promisify(execFile);
const sha = /^[0-9a-f]{40}$/;
function environment() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_')) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return env;
}

async function repository(
  project: RegisteredProject,
  cardId: string,
  create: boolean,
) {
  assertCardUuid(cardId);
  const planning = await realpath(project.planningPath);
  const parent = path.join(planning, 'implementation/cards', cardId);
  if ((await realpath(parent)) !== parent)
    throw new Error('Git history parent must not be linked.');
  const directory = path.join(parent, 'versions.git');
  let existed = true;
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Invalid Git history directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create)
      throw error;
    existed = false;
    await mkdir(directory);
  }
  if (!existed)
    await exec(
      'git',
      [
        'init',
        '--bare',
        '--initial-branch=history',
        '--object-format=sha1',
        '--template=',
        directory,
      ],
      { env: environment(), timeout: 10000 },
    );
  return directory;
}

export { includeInGitHistory } from '../../repository-file-policy.ts';

function quotePath(file: string) {
  return (
    '"' +
    [...Buffer.from(file)]
      .map((byte) =>
        byte >= 33 && byte <= 126 && byte !== 34 && byte !== 92
          ? String.fromCharCode(byte)
          : `\\${byte.toString(8).padStart(3, '0')}`,
      )
      .join('') +
    '"'
  );
}

export async function checkpointWorkspace(
  project: RegisteredProject,
  cardId: string,
  snapshot: WorkspaceSnapshot,
  parent: string | null,
  checkpointId: string,
  message: string,
) {
  assertCardUuid(checkpointId);
  if (parent && !sha.test(parent)) throw new Error('Invalid parent commit.');
  const directory = await repository(project, cardId, true);
  const ref = `refs/checkpoints/${checkpointId}`;
  const child = spawn(
    'git',
    ['--git-dir', directory, 'fast-import', '--quiet', '--done'],
    { env: environment(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stdout.resume();
  child.stderr.resume();
  const completion = new Promise<void>((resolve, reject) => {
    child.on('error', () =>
      reject(new Error('Could not start Git checkpoint writer.')),
    );
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('Git checkpoint failed.')),
    );
  });
  void completion.catch(() => undefined);
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const write = (value: string | Buffer) =>
    new Promise<void>((resolve, reject) =>
      child.stdin.write(value, (error) => (error ? reject(error) : resolve())),
    );
  child.stdin.on('error', () => undefined);
  try {
    let totalBytes = 0;
    const title = Buffer.from(message);
    await write(
      `commit ${ref}\ncommitter Praxis <praxis@localhost> ${Math.floor(Date.now() / 1000)} +0000\ndata ${title.length}\n`,
    );
    await write(title);
    await write('\n');
    if (parent) await write(`from ${parent}\n`);
    await write('deleteall\n');
    for (const file of Object.keys(snapshot.files).sort()) {
      if (!includeInGitHistory(file)) continue;
      const absolute = path.resolve(snapshot.root, file);
      if (
        !absolute.startsWith(snapshot.root + path.sep) ||
        (await realpath(path.dirname(absolute))) !== path.dirname(absolute)
      )
        throw new Error('Unsafe Git snapshot file.');
      if ((await lstat(absolute)).isSymbolicLink()) {
        const target = await readlink(absolute, { encoding: 'buffer' });
        if (
          snapshot.files[file] !==
          `link:${createHash('sha256').update(target).digest('hex')}`
        )
          throw new Error(
            'Workspace changed during checkpoint; retry after inspecting changes.',
          );
        await write(
          `M 120000 inline ${quotePath(file)}\ndata ${target.length}\n`,
        );
        await write(target);
        await write('\n');
        continue;
      }
      const handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Snapshot entry is not a file.');
        totalBytes += stat.size;
        if (totalBytes > 256000000)
          throw new Error('Git snapshot exceeds the size limit.');
        const bytes = await handle.readFile();
        const fingerprint = `${stat.mode & 0o777}:${createHash('sha256').update(bytes).digest('hex')}`;
        if (snapshot.files[file] !== fingerprint)
          throw new Error(
            'Workspace changed during checkpoint; retry after inspecting changes.',
          );
        const mode = stat.mode & 0o111 ? '100755' : '100644';
        await write(
          `M ${mode} inline ${quotePath(file)}\ndata ${bytes.length}\n`,
        );
        await write(bytes);
        await write('\n');
      } finally {
        await handle.close();
      }
    }
    await write('\ndone\n');
    child.stdin.end();
    await completion;
    const hash = (
      await exec(
        'git',
        ['--git-dir', directory, 'rev-parse', '--verify', ref],
        { env: environment(), timeout: 5000 },
      )
    ).stdout.trim();
    if (!sha.test(hash)) throw new Error('Git did not return a commit.');
    await exec(
      'git',
      ['--git-dir', directory, 'update-ref', 'refs/heads/history', hash],
      { env: environment(), timeout: 5000 },
    );
    return hash;
  } catch (error) {
    child.kill('SIGKILL');
    await completion.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function readCheckpointDiff(
  project: RegisteredProject,
  cardId: string,
  parent: string,
  commit: string,
) {
  if (!sha.test(parent) || !sha.test(commit))
    throw new Error('Invalid checkpoint commit.');
  const directory = await repository(project, cardId, false);
  return (
    await exec(
      'git',
      [
        '--git-dir',
        directory,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--stat',
        '--patch',
        parent,
        commit,
        '--',
      ],
      { env: environment(), timeout: 10000, maxBuffer: 2000000 },
    )
  ).stdout;
}

export async function restoreCheckpoint(
  project: RegisteredProject,
  cardId: string,
  commit: string,
  snapshot: WorkspaceSnapshot,
) {
  if (!sha.test(commit)) throw new Error('Invalid checkpoint commit.');
  const root = await realpath(snapshot.root);
  const directory = await repository(project, cardId, false);
  for (const file of Object.keys(snapshot.files)) {
    if (!includeInGitHistory(file)) continue;
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(root + path.sep))
      throw new Error('Unsafe checkpoint restore path.');
    await rm(absolute, { force: true });
  }
  await exec('git', ['--git-dir', directory, 'read-tree', commit], {
    env: environment(),
    timeout: 10000,
  });
  await exec(
    'git',
    [
      '--git-dir',
      directory,
      '--work-tree',
      root,
      'checkout-index',
      '--all',
      '--force',
    ],
    { env: environment(), timeout: 30000, maxBuffer: 2000000 },
  );
}
