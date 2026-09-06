import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RegisteredProject } from '../../project-registry.ts';
import type { DeliveryRecord } from './record.ts';
import { PublicApiError } from '../../api-errors.ts';

const execute = promisify(execFile);

export async function deliveryGit(directory: string, ...args: string[]) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT')
      delete (env as NodeJS.ProcessEnv)[key];
  return (
    await execute('git', ['-C', directory, ...args], {
      env,
      timeout: 60000,
      maxBuffer: 2_000_000,
    })
  ).stdout.trim();
}

export async function prepareDeliveryWorkspace(
  project: RegisteredProject,
  record: DeliveryRecord,
) {
  if (record.workspace) {
    if (
      (await deliveryGit(record.workspace.path, 'branch', '--show-current')) !==
      record.workspace.branch
    )
      throw new PublicApiError('Delivery workspace branch changed.');
    return record.workspace;
  }
  const repository = await realpath(project.codePath ?? project.rootPath);
  if (
    (await realpath(
      await deliveryGit(repository, 'rev-parse', '--show-toplevel'),
    )) !== repository
  )
    throw new PublicApiError('The delivery project must own its repository.');
  let base = await deliveryGit(repository, 'rev-parse', 'HEAD');
  const remote = await deliveryGit(
    repository,
    'remote',
    'get-url',
    'origin',
  ).catch(() => null);
  if (remote) {
    await deliveryGit(repository, 'fetch', 'origin');
    const advertisement = await deliveryGit(
      repository,
      'ls-remote',
      '--symref',
      'origin',
      'HEAD',
    );
    const branch = advertisement.match(
      /^ref: refs\/heads\/([^\s]+)\s+HEAD$/m,
    )?.[1];
    if (!branch)
      throw new PublicApiError('The remote default branch is unavailable.');
    base = await deliveryGit(
      repository,
      'rev-parse',
      `refs/remotes/origin/${branch}`,
    );
  }
  const branch = `delivery/${record.sourceUid}`;
  const workspace = path.join(
    path.dirname(repository),
    `.praxis-delivery-${project.id}-${record.sourceUid}`,
  );
  await deliveryGit(
    repository,
    'worktree',
    'add',
    '-b',
    branch,
    workspace,
    base,
  );
  return { path: workspace, branch, base };
}
