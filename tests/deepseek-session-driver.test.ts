import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeepseekSessionDriver,
  type SessionModules,
} from '../lib/agents/deepseek/session-driver.ts';
import type { HostJobBroker } from '../lib/agents/host-job-broker.ts';

type RegisteredTool = {
  name: string;
  execute: (
    args: Record<string, unknown>,
    exec: { concludeTurn: () => void },
  ) => Promise<{ message: string }>;
};

function makeFakeModules(hangTurn: boolean) {
  const messages: unknown[] = [];
  let bootPatches: unknown[] = [];
  const registered: RegisteredTool[] = [];
  let resolveTurn: (() => void) | undefined;
  let followed = false;
  const events = [
    { seq: 0, type: 'turn/start' },
    {
      seq: 1,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'done' }] } },
    },
  ];
  const agent = {
    session: { id: 'session-1', seq: 0, events },
    whenIdle: () => {
      if (!followed) return Promise.resolve();
      if (!hangTurn) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveTurn = resolve;
      });
    },
    followup: () => {
      followed = true;
    },
    cancel: () => resolveTurn?.(),
  };
  const handle = { agent, dispose: async () => {} };
  let runCalls = 0;
  const broker = {
    run: async (request: { label: string }) => {
      runCalls += 1;
      return {
        id: `job-${request.label}`,
        completion: new Promise<never>(() => {}),
      };
    },
    cancelAll: () => {},
  } as unknown as HostJobBroker;
  const ctx = {
    fiber: { dispose: async () => {} },
    get: (name: string) =>
      name === 'agents'
        ? { create: async () => handle, resume: async () => handle }
        : name === 'sessions'
          ? { flush: async () => {} }
          : name === 'tools'
            ? {
                register: (def: RegisteredTool) => (
                  registered.push(def),
                  () => {}
                ),
              }
            : undefined,
  };
  const modules: SessionModules = {
    boot: async (_name, _config, patches) => {
      bootPatches = patches;
      return ctx;
    },
    loadOverlayPatches: () => [],
    SessionId: (id) => id,
    createUserMessage: (message) => {
      messages.push(message);
      return message;
    },
    ReasoningEffortId: (effort) => effort,
    installModelSelection: () => {},
  };
  return {
    modules,
    broker,
    registered,
    releaseTurn: () => resolveTurn?.(),
    runCalls: () => runCalls,
    messages,
    patches: () => bootPatches,
  };
}

void test('a DeepSeek session turn keeps its generated output', async () => {
  const fake = makeFakeModules(false);
  const driver = new DeepseekSessionDriver({
    brokerFactory: () => fake.broker,
    load: async () => fake.modules,
  });
  const thread = await driver.startThread({
    profile: { agent: 'deepseek', model: '', effort: '' },
    workingDirectory: '/tmp/project',
    access: 'workspace-write',
  });
  const result = await driver.startTurn(thread, { prompt: 'do it' }).completion;
  assert.equal(result.finalOutput, 'done');
  await driver.close();
});

void test('a DeepSeek reviewer receives role instructions without write tools or Host jobs', async () => {
  const fake = makeFakeModules(false);
  const driver = new DeepseekSessionDriver({
    brokerFactory: () => fake.broker,
    load: async () => fake.modules,
  });
  const thread = await driver.startThread({
    profile: { agent: 'deepseek', model: '', effort: '' },
    workingDirectory: '/tmp/project',
    access: 'read-only',
    hostJobs: false,
    instructions: 'Review the agreed delivery only.',
  });
  await driver.startTurn(thread, { prompt: 'Inspect the current candidate.' })
    .completion;
  assert.equal(
    fake.registered.some((tool) => tool.name === 'run_job'),
    false,
  );
  assert.deepEqual(
    fake
      .patches()
      .find((value) => (value as { id: string }).id === 'sandbox-policy'),
    {
      id: 'sandbox-policy',
      config: { mode: 'read-only', workspaceRoot: '/tmp/project' },
    },
  );
  assert.match(
    JSON.stringify(fake.messages),
    /Review the agreed delivery only/,
  );
  await driver.close();
});

void test('a second Host operation is rejected while one is pending', async () => {
  const fake = makeFakeModules(true);
  const driver = new DeepseekSessionDriver({
    brokerFactory: () => fake.broker,
    load: async () => fake.modules,
  });
  const thread = await driver.startThread({
    profile: { agent: 'deepseek', model: '', effort: '' },
    workingDirectory: '/tmp/project',
    access: 'workspace-write',
  });
  const turn = driver.startTurn(thread, { prompt: 'build it' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const runJob = fake.registered.find((tool) => tool.name === 'run_job');
  assert.ok(runJob);
  let concludes = 0;
  const exec = {
    concludeTurn: () => {
      concludes += 1;
      fake.releaseTurn();
    },
  };
  const first = await runJob.execute(
    { label: 'build', executable: 'make', arguments: [] },
    exec,
  );
  assert.match(first.message, /started/);
  assert.equal(concludes, 1);
  await assert.rejects(
    runJob.execute(
      { label: 'second', executable: 'make', arguments: [] },
      exec,
    ),
    /pending/,
  );
  assert.equal(fake.runCalls(), 1);
  turn.completion.catch(() => {});
  await driver.close();
});
