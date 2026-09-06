import { PublicApiError } from './api-errors.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

const execute = promisify(execFile);
const syncing = new Set<string>();
export async function syncProjectMain(directory: string) {
  const root = await realpath(directory);
  if (syncing.has(root))
    throw new PublicApiError('Main sync is already running.', 409);
  syncing.add(root);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT')
      delete env[key];
  const git = async (...args: string[]) =>
    (
      await execute('git', ['-C', root, ...args], {
        env,
        timeout: 60000,
        maxBuffer: 2000000,
      })
    ).stdout.trim();
  try {
    if ((await realpath(await git('rev-parse', '--show-toplevel'))) !== root)
      throw new PublicApiError(
        'The project directory is not a repository root.',
        409,
      );
    const before = await git(
      'rev-parse',
      '--verify',
      'refs/remotes/origin/main',
    ).catch(() => null);
    await git('fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main');
    const target = await git('rev-parse', 'refs/remotes/origin/main');
    let checkoutUpdated = false;
    if (
      (await git('branch', '--show-current')) === 'main' &&
      !(await git('status', '--porcelain', '--untracked-files=all'))
    ) {
      const localHead = await git('rev-parse', 'HEAD');
      const canFastForward = await git(
        'merge-base',
        '--is-ancestor',
        localHead,
        target,
      )
        .then(() => true)
        .catch(() => false);
      if (localHead !== target && canFastForward) {
        await git('merge', '--ff-only', target);
        checkoutUpdated = true;
      }
    }
    return {
      updated: before !== target || checkoutUpdated,
      head: target,
      checkoutUpdated,
    };
  } finally {
    syncing.delete(root);
  }
}
