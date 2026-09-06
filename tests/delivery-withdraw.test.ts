import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withdrawDelivery } from '../lib/modules/delivery/withdraw.ts';
import {
  createDeliveryRecord,
  readDeliveryRecord,
  updateDeliveryRecord,
} from '../lib/modules/delivery/storage.ts';
import {
  deliveryGit,
  prepareDeliveryWorkspace,
} from '../lib/modules/delivery/workspace.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-withdraw-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'project');
  await mkdir(repository);
  await deliveryGit(repository, 'init', '-b', 'main');
  await deliveryGit(repository, 'config', 'user.name', 'Fixture');
  await deliveryGit(repository, 'config', 'user.email', 'fixture@example.test');
  await deliveryGit(repository, 'commit', '--allow-empty', '-m', 'Base');
  const project = {
    id: 'fixture',
    name: 'Fixture',
    rootPath: repository,
    codePath: repository,
    planningPath: path.join(repository, '.praxis'),
  } as RegisteredProject;
  await mkdir(project.planningPath);
  await createDeliveryRecord(
    project,
    {
      sourceUid: uid,
      sourceKind: 'mvp',
      sourceModule: 'whats-next',
      sourceId: 'NODE-aaaaaaaa',
      title: 'Fixture',
      summary: '',
      dependsOn: [],
      outputPaths: [],
      sourceFingerprint: 'v1',
    },
    {
      orchestrator: { agent: 'codex', model: 'fixture', effort: 'low' },
      workers: [],
      reviewers: [],
    },
  );
  return project;
}

void test('withdrawal stops the attempt, closes its open PR, removes only its dirty worktree and restarts from updated main', async (t) => {
  const project = await fixture(t);
  const workspace = await prepareDeliveryWorkspace(
    project,
    (await readDeliveryRecord(project, uid))!,
  );
  await writeFile(path.join(workspace.path, 'unfinished.txt'), 'unfinished');
  const other = path.join(path.dirname(project.rootPath), 'other');
  await deliveryGit(
    project.rootPath,
    'worktree',
    'add',
    '-b',
    'other',
    other,
    'main',
  );
  await writeFile(path.join(other, 'keep.txt'), 'keep');
  const record = await updateDeliveryRecord(project, uid, (current) => {
    current.workspace = workspace;
    current.orchestratorSessionId = 'old-session';
    current.publication = {
      url: 'https://github.com/fixture/project/pull/1',
      number: 1,
      head: 'candidate',
      state: 'OPEN',
      draft: true,
    };
  });
  let stopped = false,
    closed = false;
  await withdrawDelivery(project, uid, record.revision, {
    cancel: async () => {
      stopped = true;
    },
    runner: async (_command, args) => {
      assert.equal(stopped, true);
      if (args[0] === 'api') return 'cunqi-bot';
      if (args[1] === 'view') return JSON.stringify({ state: 'OPEN' });
      if (args[1] === 'close') closed = true;
      return '';
    },
  });
  assert.equal(closed, true);
  await assert.rejects(access(workspace.path));
  await access(path.join(other, 'keep.txt'));
  const clean = (await readDeliveryRecord(project, uid))!;
  assert.equal(clean.workspace, null);
  assert.equal(clean.publication, null);
  assert.equal(clean.orchestratorSessionId, null);
  assert.equal(clean.status, 'ready');
  assert.equal(clean.source.sourceUid, uid);
  assert.ok(clean.lastWithdrawal?.logUrlPath.includes('/logs/host/'));
  await writeFile(path.join(project.rootPath, 'new-main.txt'), 'latest');
  await deliveryGit(project.rootPath, 'add', 'new-main.txt');
  await deliveryGit(project.rootPath, 'commit', '-m', 'Advance main');
  const next = await prepareDeliveryWorkspace(project, clean);
  assert.notEqual(next.branch, workspace.branch);
  assert.equal(
    next.base,
    await deliveryGit(project.rootPath, 'rev-parse', 'main'),
  );
  await access(path.join(next.path, 'new-main.txt'));
  assert.equal(await deliveryGit(next.path, 'status', '--porcelain'), '');
});

void test('accepted delivery cannot be withdrawn, and a PR close failure retains the unaccepted workspace', async (t) => {
  const project = await fixture(t);
  const workspace = await prepareDeliveryWorkspace(
    project,
    (await readDeliveryRecord(project, uid))!,
  );
  let record = await updateDeliveryRecord(project, uid, (current) => {
    current.workspace = workspace;
    current.acceptedHead = 'accepted';
  });
  await assert.rejects(
    withdrawDelivery(project, uid, record.revision),
    /accepted delivery/,
  );
  record = await updateDeliveryRecord(project, uid, (current) => {
    current.acceptedHead = null;
    current.publication = {
      url: 'https://github.com/fixture/project/pull/1',
      number: 1,
      head: 'candidate',
      state: 'OPEN',
      draft: true,
    };
  });
  await assert.rejects(
    withdrawDelivery(project, uid, record.revision, {
      runner: async (_command, args) => {
        if (args[0] === 'api') return 'cunqi-bot';
        if (args[1] === 'view') return JSON.stringify({ state: 'OPEN' });
        throw new Error('GitHub unavailable');
      },
    }),
    /GitHub unavailable/,
  );
  await access(workspace.path);
  assert.equal(
    (await readDeliveryRecord(project, uid))!.workspace!.path,
    workspace.path,
  );
});

void test('a canceled briefing can be withdrawn without GitHub or a worktree', async (t) => {
  const project = await fixture(t);
  const record = await updateDeliveryRecord(project, uid, (current) => {
    current.status = 'warning';
    current.orchestratorSessionId = 'canceled-brief';
  });
  await withdrawDelivery(project, uid, record.revision, {
    runner: async () => {
      throw new Error('Unexpected GitHub call');
    },
  });
  const fresh = (await readDeliveryRecord(project, uid))!;
  assert.equal(fresh.status, 'ready');
  assert.equal(fresh.orchestratorSessionId, null);
  assert.equal(fresh.workspace, null);
  assert.equal(fresh.models.orchestrator.model, 'fixture');
});
