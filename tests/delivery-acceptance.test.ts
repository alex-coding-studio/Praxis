import { readDeliverySources } from '../lib/modules/delivery/sources.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acceptDelivery } from '../lib/modules/delivery/publication.ts';
import { claimDeliveryTarget } from '../lib/modules/delivery/ownership.ts';
import {
  createDeliveryRecord,
  readDeliveryRecord,
  updateDeliveryRecord,
} from '../lib/modules/delivery/storage.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';
import type { HostCommandRunner } from '../lib/card-host-operations.ts';
import { deliveryGit } from '../lib/modules/delivery/workspace.ts';
import {
  recognizeExistingDelivery,
  acceptExistingDelivery,
} from '../lib/modules/delivery/existing-delivery.ts';

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'delivery-accept-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project = {
    id: 'project',
    name: 'Fixture',
    rootPath,
    planningPath: rootPath,
    codePath: rootPath,
  } as RegisteredProject;
  const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const nodePath = path.join(
    project.planningPath,
    'whats-next/nodes/NODE-aaaaaaaa',
  );
  await mkdir(nodePath, { recursive: true });
  await writeFile(
    path.join(nodePath, 'node.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'NODE-aaaaaaaa',
      uid,
      role: 'node',
      type: 'MVP',
      title: 'Fixture',
      status: 'accepted',
      layer: 'discovery',
      artifactKind: 'mvp',
      resources: [],
      dependsOn: [],
      derivedFrom: [],
      relations: { dependsOn: [], derivedFrom: [] },
      createdAt: 'now',
      updatedAt: 'now',
    }),
  );
  await writeFile(path.join(nodePath, 'output.md'), '# Fixture');
  await createDeliveryRecord(
    project,
    (await readDeliverySources(project)).sources[0],
    {
      orchestrator: { agent: 'codex', model: '', effort: '' },
      workers: [],
      reviewers: [],
    },
  );
  const record = await updateDeliveryRecord(project, uid, (value) => {
    value.workspace = {
      path: rootPath,
      branch: 'delivery/fixture',
      base: 'base',
    };
    value.brief = {
      revision: 1,
      outcome: 'Fixture',
      included: [],
      excluded: [],
      openDecisions: [],
      confirmedAt: 'confirmed',
      criteria: [
        { id: 'AC1', description: 'Required behavior', verification: 'unit' },
      ],
    };
    value.checks = [
      {
        id: 'AC1',
        status: 'passed',
        evidence: 'unit test output',
        head: 'head',
      },
    ];
    value.review = {
      head: 'head',
      disposition: 'not-required',
      reason: 'Bounded local edit with adequate evidence',
      approved: false,
      reviewerSessionId: null,
    };
    value.publication = {
      head: 'head',
      url: 'https://github.com/fixture/repository/pull/1',
      number: 1,
      state: 'OPEN',
      draft: true,
    };
  });
  return { project, uid, record };
}

void test('acceptance merges only the verified head and tolerates a retry after GitHub already merged', async (t) => {
  const { project, uid, record } = await fixture(t);
  let state = 'OPEN';
  const calls: string[][] = [];
  const runner: HostCommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'api') return 'cunqi-bot';
    if (args[1] === 'view')
      return JSON.stringify({
        state,
        headRefOid: 'head',
        isDraft: state === 'OPEN',
      });
    if (args[1] === 'merge') {
      assert.ok(args.includes('--match-head-commit'));
      assert.equal(args.at(-1), 'head');
      state = 'MERGED';
    }
    return '';
  };
  let syncs = 0;
  const dependencies = {
    runner,
    git: async (_cwd: string, ...args: string[]) =>
      args[0] === 'status' ? '' : 'head',
    syncMain: async () => {
      syncs++;
      return { head: 'merged', updated: true, checkoutUpdated: true };
    },
  };
  const release = claimDeliveryTarget(project, uid);
  await assert.rejects(
    () => acceptDelivery(project, uid, record.revision, dependencies),
    /already running/,
  );
  assert.equal(calls.length, 0);
  release();
  const completed = await acceptDelivery(
    project,
    uid,
    record.revision,
    dependencies,
  );
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.acceptedHead, 'head');
  assert.equal(syncs, 1);
  await updateDeliveryRecord(project, uid, (value) => {
    value.status = 'waiting-for-user';
    value.publication!.state = 'OPEN';
  });
  await acceptDelivery(
    project,
    uid,
    (await readDeliveryRecord(project, uid))!.revision,
    dependencies,
  );
  assert.equal(calls.filter((args) => args[1] === 'merge').length, 1);
});

void test('a changed remote head does not merge or erase the existing candidate', async (t) => {
  const { project, uid, record } = await fixture(t);
  const runner: HostCommandRunner = async (_command, args) => {
    if (args[0] === 'api') return 'cunqi-bot';
    assert.equal(args[1], 'view');
    return JSON.stringify({
      state: 'OPEN',
      headRefOid: 'other',
      isDraft: true,
    });
  };
  await assert.rejects(
    () =>
      acceptDelivery(project, uid, record.revision, {
        runner,
        git: async (_cwd, ...args) => (args[0] === 'status' ? '' : 'head'),
      }),
    /pull request changed/,
  );
  const after = await readDeliveryRecord(project, uid);
  assert.deepEqual(after?.publication, record.publication);
  assert.deepEqual(after?.checks, record.checks);
});

void test('user can accept verified current-main work without a new commit or pull request', async (t) => {
  const { project, uid } = await fixture(t);
  await deliveryGit(project.rootPath, 'init', '--initial-branch=main');
  await deliveryGit(
    project.rootPath,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'Existing implementation',
  );
  const head = await deliveryGit(project.rootPath, 'rev-parse', 'HEAD');
  await writeFile(path.join(project.rootPath, '.git/info/exclude'), '*\n');
  await updateDeliveryRecord(project, uid, (record) => {
    record.publication = null;
    record.workspace = { path: project.rootPath, branch: 'main', base: head };
    record.checks[0].head = head;
    record.review!.head = head;
  });
  await recognizeExistingDelivery(
    project,
    uid,
    'Current main already implements the required behavior.',
  );
  const proposed = (await readDeliveryRecord(project, uid))!;
  assert.notEqual(proposed.status, 'completed');
  const accepted = await acceptExistingDelivery(
    project,
    uid,
    proposed.revision,
  );
  assert.equal(accepted.status, 'completed');
  assert.equal(accepted.publication, null);
  assert.equal(accepted.acceptedHead, head);
  assert.equal(await deliveryGit(project.rootPath, 'rev-parse', 'HEAD'), head);
});

void test('changed or removed source prevents both acceptance paths before GitHub or completion', async (t) => {
  const { project, uid, record } = await fixture(t);
  await updateDeliveryRecord(project, uid, (current) => {
    current.existingDelivery = { head: 'head', reason: 'Already implemented' };
  });
  await writeFile(
    path.join(project.planningPath, 'whats-next/nodes/NODE-aaaaaaaa/output.md'),
    '# Changed requirements',
  );
  let current = (await readDeliveryRecord(project, uid))!;
  await assert.rejects(
    acceptDelivery(project, uid, current.revision, {
      runner: async () => {
        throw new Error('Unexpected GitHub call');
      },
    }),
    /source changed/,
  );
  await assert.rejects(
    acceptExistingDelivery(project, uid, current.revision),
    /source changed/,
  );
  assert.equal((await readDeliveryRecord(project, uid))!.acceptedHead, null);
  await rm(path.join(project.planningPath, 'whats-next/nodes/NODE-aaaaaaaa'), {
    recursive: true,
  });
  current = (await readDeliveryRecord(project, uid))!;
  await assert.rejects(
    acceptDelivery(project, uid, current.revision),
    /source changed/,
  );
  await assert.rejects(
    acceptExistingDelivery(project, uid, current.revision),
    /source changed/,
  );
  assert.equal(
    (await readDeliveryRecord(project, uid))!.publication!.head,
    record.publication!.head,
  );
});
