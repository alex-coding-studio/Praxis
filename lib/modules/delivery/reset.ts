import path from 'node:path';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import type { RegisteredProject } from '../../project-registry.ts';
import { PublicApiError } from '../../api-errors.ts';
import { deliveryGit } from './workspace.ts';
import { deliveryDirectory } from './storage.ts';
import { writeFileAtomically } from '../../atomic-json-store.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function previewLegacyDeliveryReset(project: RegisteredProject) {
  const planning = await realpath(project.planningPath);
  const repository = await realpath(project.codePath ?? project.rootPath);
  const cardsRoot = path.join(planning, 'implementation', 'cards');
  const info = await lstat(cardsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink()))
    throw new PublicApiError('Legacy cards must be a regular owned directory.');
  const cardIds = info
    ? (await readdir(cardsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && uuid.test(entry.name))
        .map((entry) => entry.name)
    : [];
  const runtimeJobs = new Set<string>();
  const jobRoot = path.join(planning, 'runtime', 'jobs');
  for (const id of cardIds) {
    const revisions = (await readdir(path.join(cardsRoot, id)))
      .filter((name) => /^\d{8}$/.test(name))
      .sort();
    if (!revisions.length) continue;
    const state = JSON.parse(
      await readFile(
        path.join(cardsRoot, id, revisions.at(-1)!, 'planning-state.json'),
        'utf8',
      ),
    );
    for (const run of state.execution?.runs ?? []) {
      for (const job of run.jobs ?? []) {
        if (typeof job.ref !== 'string') continue;
        const relative = path.relative(
          jobRoot,
          path.resolve(planning, job.ref),
        );
        const jobId = relative.split(path.sep)[0];
        if (uuid.test(jobId)) runtimeJobs.add(path.join(jobRoot, jobId));
      }
    }
    const runs = [state.run, state.execution?.runs?.at(-1)];
    for (const run of runs) {
      if (run?.status !== 'running' || !run.hostPid) continue;
      let alive = false;
      try {
        process.kill(run.hostPid, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (alive)
        throw new PublicApiError(
          `Stop the active legacy execution for Card ${id} before resetting.`,
        );
    }
  }
  const registered = (
    await deliveryGit(repository, 'worktree', 'list', '--porcelain')
  )
    .split('\n\n')
    .map((entry) => ({
      path: entry.match(/^worktree (.+)$/m)?.[1],
      branch: entry.match(/^branch (.+)$/m)?.[1],
    }));
  const worktrees = registered
    .filter(
      (entry) =>
        entry.path &&
        entry.path !== repository &&
        path.dirname(entry.path) === path.dirname(repository) &&
        cardIds.some(
          (id) =>
            path
              .basename(entry.path!)
              .startsWith(`.praxis-${path.basename(repository)}-${id}-`) &&
            entry.branch?.startsWith(`refs/heads/praxis/card-${id}-`),
        ),
    )
    .map((entry) => entry.path!);
  return {
    projectId: project.id,
    repository,
    cardsRoot,
    cardIds,
    worktrees,
    runtimeJobs: [...runtimeJobs],
  };
}

export async function resetLegacyDelivery(project: RegisteredProject) {
  const plan = await previewLegacyDeliveryReset(project);
  for (const workspace of plan.worktrees)
    await deliveryGit(
      plan.repository,
      'worktree',
      'remove',
      '--force',
      workspace,
    );
  for (const directory of plan.runtimeJobs)
    await rm(directory, { recursive: true, force: true });
  await rm(plan.cardsRoot, { recursive: true, force: true });
  await writeFileAtomically(
    path.join(await deliveryDirectory(project, undefined, true), 'schema.json'),
    `${JSON.stringify({ version: 1, legacyResetAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return plan;
}
