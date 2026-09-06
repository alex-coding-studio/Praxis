import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  startDeliveryRun,
  waitForDeliveryRun,
  type DeliveryDriverFactory,
} from '../lib/modules/delivery/runtime.ts';
import {
  createDeliveryRecord,
  readDeliveryRecord,
} from '../lib/modules/delivery/storage.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';
import type {
  AgentRuntimeThread,
  AgentRuntimeTurnResult,
} from '../lib/agents/runtime-driver.ts';
import { selectDeliveryModel } from '../lib/modules/delivery/models.ts';

void test('briefing persists its result, excludes implementation delegation, and resumes the same Orchestrator next round', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-runtime-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const project = {
    id: 'project',
    name: 'Fixture',
    rootPath: root,
    codePath: root,
    planningPath: root,
  } as RegisteredProject;
  const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const profile = {
    agent: 'codex' as const,
    model: 'gpt-6',
    effort: 'low' as const,
  };
  await createDeliveryRecord(
    project,
    {
      sourceUid: uid,
      sourceId: 'NODE-aaaaaaaa',
      sourceKind: 'mvp',
      sourceModule: 'whats-next',
      title: 'Fixture',
      summary: '',
      dependsOn: [],
      outputPaths: [],
      sourceFingerprint: 'source',
    },
    { orchestrator: profile, workers: [], reviewers: [] },
  );
  let starts = 0;
  let resumes = 0;
  const driver: DeliveryDriverFactory = (_project, _profile, tools) => ({
    provider: 'codex',
    capabilities: {
      persistentThreads: true,
      pushToolResults: true,
      turnResume: true,
      turnInterrupt: true,
    },
    async startThread(input) {
      starts++;
      assert.equal(input.access, 'read-only');
      return {
        ...input,
        provider: 'codex',
        threadId: 'persistent-session',
      } as AgentRuntimeThread;
    },
    async resumeThread(thread) {
      resumes++;
      assert.equal(thread.threadId, 'persistent-session');
      return thread;
    },
    startTurn(thread) {
      const completion = (async (): Promise<AgentRuntimeTurnResult> => {
        await tools
          .find((tool) => tool.name === 'save_delivery_brief')!
          .call({
            outcome: 'Deliver the fixture',
            included: ['Fixture'],
            excluded: [],
            criteria: [
              {
                id: 'AC1',
                description: 'A useful outcome',
                verification: 'unit test',
              },
            ],
            openDecisions: [],
          });
        return {
          threadId: thread.threadId,
          turnId: 'turn',
          finalOutput: 'Please confirm this delivery brief.',
          usage: null,
        };
      })();
      return { completion, interrupt() {} };
    },
    async close() {},
  });
  const run = await startDeliveryRun(
    project,
    uid,
    'brief',
    'Prepare my brief',
    driver,
  );
  await waitForDeliveryRun(project, uid);
  const record = await readDeliveryRecord(project, uid);
  assert.equal(record?.brief?.outcome, 'Deliver the fixture');
  assert.equal(record?.brief?.confirmedAt, null);
  assert.equal(record?.orchestratorSessionId, 'persistent-session');
  assert.equal(record?.runs[0].status, 'completed');
  assert.equal(record?.workspace, null);
  assert.match(
    await readFile(
      path.join(root, 'delivery/targets', uid, 'logs', `${run.id}.log`),
      'utf8',
    ),
    /HOST/,
  );
  await startDeliveryRun(project, uid, 'brief', 'Tighten the scope', driver);
  await waitForDeliveryRun(project, uid);
  assert.equal(starts, 1);
  assert.equal(resumes, 1);
});

void test('model selection can adjust effort within a configured model but cannot promote itself outside the pool', () => {
  const orchestrator = {
    agent: 'codex' as const,
    model: 'gpt-6',
    effort: 'low' as const,
  };
  const worker = {
    agent: 'codex' as const,
    model: 'gpt-5.6-luna',
    effort: 'medium' as const,
  };
  const models = { orchestrator, workers: [worker], reviewers: [] };
  assert.equal(
    selectDeliveryModel(models, 'worker', { ...worker, effort: 'high' }).effort,
    'high',
  );
  assert.throws(
    () => selectDeliveryModel(models, 'worker', orchestrator),
    /outside/,
  );
  assert.throws(
    () => selectDeliveryModel(models, 'reviewer', worker),
    /outside/,
  );
});
