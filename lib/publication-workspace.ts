import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';

const exec = promisify(execFile);
export type CardWorkspace = {
  path: string;
  repository: string;
  branch: string;
  baseCommit: string;
  gitDirectory: string;
};
function environment() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_')) delete env[key];
  return env;
}
async function git(directory: string, ...args: string[]) {
  return (
    await exec('git', ['-C', directory, ...args], {
      timeout: 20000,
      maxBuffer: 2000000,
      env: environment(),
    })
  ).stdout.trim();
}
async function regularDirectory(directory: string) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Workspace ownership requires regular directories.');
}
export async function verifyCardWorkspace(workspace: CardWorkspace) {
  await regularDirectory(workspace.path);
  const top = await git(workspace.path, 'rev-parse', '--show-toplevel');
  const common = await git(
    workspace.path,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  );
  if (
    (await realpath(top)) !== workspace.path ||
    (await realpath(common)) !== workspace.gitDirectory ||
    (await git(workspace.path, 'symbolic-ref', '--short', 'HEAD')) !==
      workspace.branch
  )
    throw new Error(
      'Card worktree identity changed. Restore its recorded branch and path before continuing.',
    );
  const repositoryCommon = await git(
    workspace.repository,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  );
  if ((await realpath(repositoryCommon)) !== workspace.gitDirectory)
    throw new Error('Card repository identity changed.');
}

export function actionPublicationBranch(cardBranch: string, actionId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(actionId))
    throw new Error('Invalid publication Action identity.');
  return `${cardBranch}--action-${actionId}`;
}
