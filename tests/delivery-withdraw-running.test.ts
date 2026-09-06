import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createDeliveryRecord,
  readDeliveryRecord,
  updateDeliveryRecord,
} from '../lib/modules/delivery/storage.ts';
import { deliveryGit } from '../lib/modules/delivery/workspace.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';
import type { DeliveryDriverFactory } from '../lib/modules/delivery/runtime.ts';
import type { AgentRuntimeTurnResult } from '../lib/agents/runtime-driver.ts';

void test('withdrawal drains publication after provider interruption before closing the resulting PR and deleting its worktree', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'withdraw-running-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo');
  await mkdir(repository);
  await deliveryGit(repository, 'init', '-b', 'main');
  await deliveryGit(repository, 'config', 'user.name', 'Fixture');
  await deliveryGit(repository, 'config', 'user.email', 'fixture@example.test');
  await deliveryGit(repository, 'commit', '--allow-empty', '-m', 'Base');
  const project = {
    id: 'fixture',
    rootPath: repository,
    codePath: repository,
    planningPath: path.join(repository, '.praxis'),
  } as RegisteredProject;
  await mkdir(project.planningPath);
  const uid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const profile = {
    agent: 'codex' as const,
    model: 'fixture',
    effort: 'low' as const,
  };
  await createDeliveryRecord(
    project,
    {
      sourceUid: uid,
      sourceId: 'NODE-bbbbbbbb',
      sourceKind: 'mvp',
      sourceModule: 'whats-next',
      title: 'Fixture',
      summary: '',
      outputPaths: [],
      dependsOn: [],
      sourceFingerprint: 'v1',
    },
    { orchestrator: profile, workers: [profile], reviewers: [] },
  );
  await updateDeliveryRecord(project, uid, (r) => {
    r.brief = {
      revision: 1,
      outcome: 'Fixture',
      included: [],
      excluded: [],
      criteria: [{ id: 'A', description: 'Fixture', verification: 'unit' }],
      openDecisions: [],
      confirmedAt: 'confirmed',
    };
  });
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.mock.module('../lib/modules/delivery/publication.ts', {
    namedExports: {
      publishDeliveryCandidate: async () => {
        started.resolve();
        await finish.promise;
        await updateDeliveryRecord(project, uid, (r) => {
          r.publication = {
            url: 'https://github.com/fixture/repo/pull/1',
            number: 1,
            head: 'head',
            state: 'OPEN',
            draft: true,
          };
        });
        return {
          pullRequest: { url: 'https://github.com/fixture/repo/pull/1' },
          headSha: 'head',
        };
      },
    },
  });
  const { startDeliveryRun } =
    await import('../lib/modules/delivery/runtime.ts');
  const { withdrawDelivery } =
    await import('../lib/modules/delivery/withdraw.ts');
  const driver: DeliveryDriverFactory = (_project, _profile, tools) => ({
    provider: 'codex',
    capabilities: {
      persistentThreads: true,
      pushToolResults: true,
      turnResume: true,
      turnInterrupt: true,
    },
    async startThread(input) {
      return { ...input, provider: 'codex', threadId: 'session' };
    },
    async resumeThread(thread) {
      return thread;
    },
    startTurn(thread) {
      const stopped = Promise.withResolvers<AgentRuntimeTurnResult>();
      void tools
        .find((tool) => tool.name === 'publish_delivery')!
        .call({ title: 'Fixture', body: 'Fixture' })
        .catch(() => undefined);
      return {
        completion: stopped.promise,
        interrupt() {
          stopped.resolve({
            threadId: thread.threadId,
            turnId: 'turn',
            finalOutput: '',
            usage: null,
          });
        },
      };
    },
    async close() {},
  });
  await startDeliveryRun(project, uid, 'execution', 'Deliver', driver);
  await started.promise;
  const before = (await readDeliveryRecord(project, uid))!;
  let settled = false,
    closed = false;
  const withdrawal = withdrawDelivery(project, uid, before.revision, {
    runner: async (_command, args) => {
      if (args[0] === 'api') return 'cunqi-bot';
      if (args[1] === 'view') return JSON.stringify({ state: 'OPEN' });
      if (args[1] === 'close') closed = true;
      return '';
    },
  }).then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  await access(before.workspace!.path);
  finish.resolve();
  await withdrawal;
  assert.equal(closed, true);
  assert.equal((await readDeliveryRecord(project, uid))!.publication, null);
  await assert.rejects(access(before.workspace!.path));
});
