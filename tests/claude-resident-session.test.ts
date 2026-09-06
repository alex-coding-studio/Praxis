import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ClaudeSessionDriver,
  configurationArguments,
} from '../lib/agents/claude/session-driver.ts';
import { ClaudeHostBridge } from '../lib/agents/claude/host-bridge.ts';
import { ClaudeSessionPool } from '../lib/agents/claude/session-pool.ts';
import { ClaudeResidentProcess } from '../lib/agents/claude/resident-process.ts';
import { HostJobBroker } from '../lib/agents/host-job-broker.ts';

const fakeClaude = path.resolve('tests/fixtures/fake-claude.mjs');
const profile = {
  agent: 'claude' as const,
  model: 'fixture',
  effort: 'low' as const,
};

async function bench(
  t: { after: (callback: () => Promise<void>) => void },
  scenario = 'echo',
  pool = new ClaudeSessionPool(60_000, 12),
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-'));
  const log = path.join(root, 'invocations.jsonl');
  const bridge = new ClaudeHostBridge();
  t.after(async () => {
    await pool.disposeAll('test teardown');
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  });
  const makeDriver = () =>
    new ClaudeSessionDriver({
      command: process.execPath,
      arguments: [fakeClaude],
      suspensionGraceMs: 2000,
      environment: {
        ...process.env,
        FAKE_CLAUDE_SCENARIO: scenario,
        FAKE_CLAUDE_LOG: log,
      },
      brokerFactory: (input) =>
        new HostJobBroker(
          input.workingDirectory,
          path.join(root, 'jobs'),
          () => {},
        ),
      bridge,
      pool,
    });
  const invocations = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            prompt: string;
            pid: number;
            turn: number;
            resume: boolean;
          },
      );
  return { root, bridge, pool, makeDriver, invocations };
}

void test('a later delivery invoke reuses the resident process that the previous invoke released', async (t) => {
  const b = await bench(t);
  const first = b.makeDriver();
  const thread = await first.startThread({
    profile,
    workingDirectory: b.root,
    access: 'read-only',
    hostJobs: false,
  });
  await first.startTurn(thread, { prompt: 'one' }).completion;
  await first.close();
  assert.equal(b.pool.leasesOf(thread.threadId), 0);
  assert.ok(
    b.pool.has(thread.threadId),
    'releasing a turn must not tear down a session the next feedback still needs',
  );
  const second = b.makeDriver();
  const resumed = await second.resumeThread(thread);
  const outcome = await second.startTurn(resumed, { prompt: 'two' }).completion;
  assert.equal(outcome.finalOutput, 'CONTINUED:two');
  const runs = await b.invocations();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].pid, runs[1].pid, 'both invokes reach one process');
  await second.dispose();
  assert.equal(b.pool.has(thread.threadId), false);
});

void test('a Host job that finishes before the physical turn still resumes the same process exactly once', async (t) => {
  const b = await bench(t, 'jobslow');
  const driver = b.makeDriver();
  const thread = await driver.startThread({
    profile,
    workingDirectory: b.root,
    access: 'workspace-write',
  });
  t.after(() => driver.dispose());
  const jobIds: string[] = [];
  const result = await driver.startTurn(thread, {
    prompt: 'build',
    onEvent: (event) => {
      if (event.type === 'job-completed') jobIds.push(event.jobId);
    },
  }).completion;
  assert.ok(result.finalOutput.startsWith('CONTINUED:HOST_JOB_COMPLETED'));
  assert.equal(
    jobIds.length,
    1,
    'the completion is delivered once, not replayed',
  );
  const runs = await b.invocations();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].pid, runs[1].pid);
  assert.equal(
    runs[1].turn,
    2,
    'the continuation is the second turn of one process',
  );
});

void test('a second logical turn is refused while one is still running on the session', async (t) => {
  const b = await bench(t, 'hang');
  const driver = b.makeDriver();
  const thread = await driver.startThread({
    profile,
    workingDirectory: b.root,
    access: 'read-only',
    hostJobs: false,
  });
  t.after(() => driver.dispose());
  const running = driver.startTurn(thread, { prompt: 'one' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(
    driver.startTurn(thread, { prompt: 'two' }).completion,
    /A Claude turn is already running/,
  );
  running.interrupt();
  await assert.rejects(running.completion, /interrupted/);
});

void test('disposing a resident process settles every waiting turn instead of leaving them pending', async () => {
  const resident = new ClaudeResidentProcess({
    command: process.execPath,
    arguments: ['-e', 'setInterval(() => {}, 1000)'],
    environment: { ...process.env },
    workingDirectory: os.tmpdir(),
    signature: 'settle-all',
  }).start();
  const outcomes: string[] = [];
  const first = resident
    .send({ prompt: 'one' })
    .then(() => outcomes.push('one-resolved'))
    .catch(() => outcomes.push('one-rejected'));
  const second = resident
    .send({ prompt: 'two' })
    .then(() => outcomes.push('two-resolved'))
    .catch(() => outcomes.push('two-rejected'));
  await resident.dispose('cancelled by the test');
  await Promise.all([first, second]);
  assert.deepEqual(
    outcomes.sort(),
    ['one-rejected', 'two-rejected'],
    'the active turn and every queued turn reject; none is left dangling',
  );
  await assert.rejects(
    resident.send({ prompt: 'three' }),
    /cancelled by the test/,
  );
});

void test('a resident process that exits on its own rejects the waiting turn rather than hanging', async () => {
  const resident = new ClaudeResidentProcess({
    command: process.execPath,
    arguments: [
      '-e',
      'process.stderr.write("fixture stopped"); process.exit(3)',
    ],
    environment: { ...process.env },
    workingDirectory: os.tmpdir(),
    signature: 'exit-early',
  }).start();
  await assert.rejects(resident.send({ prompt: 'one' }), /fixture stopped/);
});

void test('a changed session configuration recycles the process instead of reusing a stale one', async (t) => {
  const b = await bench(t);
  const driver = b.makeDriver();
  const readOnly = await driver.startThread({
    profile,
    workingDirectory: b.root,
    access: 'read-only',
    hostJobs: false,
  });
  await driver.startTurn(readOnly, { prompt: 'one' }).completion;
  await driver.close();
  const escalated = await driver.resumeThread({
    ...readOnly,
    access: 'workspace-write',
  });
  await driver.startTurn(escalated, { prompt: 'two' }).completion;
  t.after(() => driver.dispose());
  const runs = await b.invocations();
  assert.equal(runs.length, 2);
  assert.notEqual(
    runs[0].pid,
    runs[1].pid,
    'a session may not keep running with the permissions of the previous configuration',
  );
  assert.equal(
    runs[1].resume,
    true,
    'the replacement process resumes the same session id',
  );
});

void test('an idle session is reclaimed after its deadline and a released one is not', async (t) => {
  const pool = new ClaudeSessionPool(120, 12);
  const b = await bench(t, 'echo', pool);
  const driver = b.makeDriver();
  const thread = await driver.startThread({
    profile,
    workingDirectory: b.root,
    access: 'read-only',
    hostJobs: false,
  });
  await driver.startTurn(thread, { prompt: 'one' }).completion;
  assert.equal(pool.leasesOf(thread.threadId), 1);
  await driver.close();
  assert.ok(
    pool.has(thread.threadId),
    'a just-released session is still available',
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(
    pool.has(thread.threadId),
    false,
    'an idle session is reclaimed on its deadline',
  );
});

void test('the process signature ignores the session flag and the loopback port', () => {
  const base = ['--print', '--mcp-config', 'http://127.0.0.1:1234/mcp/x'];
  assert.deepEqual(
    configurationArguments([...base, '--session-id', 'abc']),
    configurationArguments([...base, '--resume', 'abc']),
    'resuming the same configuration must not look like a configuration change',
  );
  assert.notDeepEqual(
    configurationArguments(['--tools', 'Read', '--session-id', 'abc']),
    configurationArguments(['--tools', 'Read,Write', '--session-id', 'abc']),
  );
});
