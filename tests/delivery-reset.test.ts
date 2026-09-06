import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { RegisteredProject } from '../lib/project-registry.ts';
import { deliveryGit } from '../lib/modules/delivery/workspace.ts';
import {
  previewLegacyDeliveryReset,
  resetLegacyDelivery,
} from '../lib/modules/delivery/reset.ts';

void test('legacy reset removes only owned execution worktrees and state while keeping source data and other worktrees', async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'delivery-reset-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'project');
  const planningPath = path.join(repository, '.praxis');
  const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await mkdir(path.join(planningPath, 'implementation/cards', uid), {
    recursive: true,
  });
  await mkdir(path.join(planningPath, 'whats-next'), { recursive: true });
  await writeFile(
    path.join(planningPath, 'whats-next', 'source.md'),
    'Preserve product meaning.',
  );
  await deliveryGit(repository, 'init', '--initial-branch=main');
  await deliveryGit(
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'Baseline',
  );
  const head = await deliveryGit(repository, 'rev-parse', 'HEAD');
  const owned = path.join(root, `.praxis-project-${uid}-12345678`);
  const unrelated = path.join(root, 'unrelated');
  await deliveryGit(
    repository,
    'worktree',
    'add',
    '-b',
    `praxis/card-${uid}-12345678`,
    owned,
    head,
  );
  await deliveryGit(
    repository,
    'worktree',
    'add',
    '-b',
    'other-work',
    unrelated,
    head,
  );
  await writeFile(
    path.join(owned, 'old-uncommitted.txt'),
    'Authorized old work.',
  );
  const project = {
    id: 'fixture',
    rootPath: repository,
    codePath: repository,
    planningPath,
  } as RegisteredProject;
  assert.deepEqual((await previewLegacyDeliveryReset(project)).worktrees, [
    owned,
  ]);
  await resetLegacyDelivery(project);
  await assert.rejects(access(owned));
  await assert.rejects(access(path.join(planningPath, 'implementation/cards')));
  await access(unrelated);
  assert.equal(await deliveryGit(repository, 'rev-parse', 'HEAD'), head);
  assert.equal(
    await readFile(path.join(planningPath, 'whats-next/source.md'), 'utf8'),
    'Preserve product meaning.',
  );
});
