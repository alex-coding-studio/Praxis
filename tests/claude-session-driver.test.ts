import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readLocalAgentActivity } from '../lib/agents/activity.ts';

void test('Claude tool activity describes commands and file paths without file bodies or command credentials', () => {
  const activity = (name: string, input: Record<string, unknown>) =>
    readLocalAgentActivity({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name, input }] },
    })!.summary;
  assert.equal(
    activity('Read', { file_path: 'Locus/ComponentsView.swift' }),
    'Running tool: Read — Locus/ComponentsView.swift',
  );
  assert.equal(
    activity('Write', {
      file_path: 'Locus/Path.swift',
      content: 'private file body',
    }),
    'Running tool: Write — Locus/Path.swift',
  );
  assert.equal(
    activity('Bash', { command: './scripts/build.sh\necho private-body' }),
    'Running tool: Bash — ./scripts/build.sh',
  );
  assert.equal(
    activity('Bash', { command: 'tool --token "private credential"' }),
    'Running tool: Bash — tool --token [redacted]',
  );
  assert.equal(activity('Unknown', {}), 'Running tool: Unknown');
});

void test('Claude error results remain errors even when their subtype is success', () => {
  assert.equal(
    readLocalAgentActivity({
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
    })?.summary,
    'Agent reported an execution error.',
  );
  assert.equal(
    readLocalAgentActivity({
      type: 'result',
      subtype: 'success',
      is_error: false,
    })?.summary,
    'Agent call completed.',
  );
});
import {
  ClaudeSessionDriver,
  buildClaudeSessionArguments,
  claudeMcpServerName,
} from '../lib/agents/claude/session-driver.ts';
import { coordinationLimits } from '../lib/modules/implementation/coordination-runner.ts';
import { coordinatorThreadInstructions } from '../lib/modules/implementation/coordinator-events.ts';
import { HostJobBroker } from '../lib/agents/host-job-broker.ts';
import { startPushCoordinatorSession } from '../lib/agents/event-driven-transport.ts';
import type {
  AgentRuntimeEvent,
  HostTool,
} from '../lib/agents/runtime-driver.ts';

const fakeClaude = path.resolve('tests/fixtures/fake-claude.mjs');

async function fixture(
  t: { after: (callback: () => Promise<void>) => void },
  scenario: string,
  hostTools: HostTool[] = [],
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-driver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'invocations.jsonl');
  const jobs: string[] = [];
  const driver = new ClaudeSessionDriver({
    command: process.execPath,
    arguments: [fakeClaude],
    suspensionGraceMs: 400,
    environment: {
      ...process.env,
      FAKE_CLAUDE_SCENARIO: scenario,
      FAKE_CLAUDE_LOG: log,
    },
    brokerFactory: (input) =>
      new HostJobBroker(
        input.workingDirectory,
        path.join(root, 'jobs'),
        (event) => jobs.push(event.status),
      ),
    hostTools,
  });
  t.after(() => driver.close());
  const invocations = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            resume: boolean;
            sessionId: string;
            prompt: string;
            args: string[];
          },
      );
  return { root, driver, jobs, invocations };
}

void test('Claude session arguments keep the read-only coordinator without Bash and resume by session id', () => {
  const readOnly = buildClaudeSessionArguments({
    access: 'read-only',
    sessionId: 'session-1',
    resume: false,
    mcpUrl: 'http://127.0.0.1:1/mcp/session-1',
    token: 'secret',
    toolNames: ['dispatch_worker'],
  });
  assert.ok(readOnly.includes('--restricted'));
  assert.ok(
    !readOnly.includes('--safe-mode'),
    'safe mode disables every customization including our own MCP server',
  );
  assert.equal(
    readOnly[readOnly.indexOf('--setting-sources') + 1],
    '',
    'project, user and local settings stay disabled without safe mode',
  );
  assert.equal(readOnly[readOnly.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(!readOnly.includes('--permission-mode'));
  assert.ok(readOnly.includes('--strict-mcp-config'));
  assert.equal(
    readOnly[readOnly.indexOf('--allowedTools') + 1],
    `mcp__${claudeMcpServerName}__dispatch_worker`,
  );
  assert.deepEqual(readOnly.slice(-2), ['--session-id', 'session-1']);
  const config = JSON.parse(readOnly[readOnly.indexOf('--mcp-config') + 1]);
  assert.equal(config.mcpServers[claudeMcpServerName].type, 'http');
  assert.match(
    config.mcpServers[claudeMcpServerName].headers.Authorization,
    /^Bearer secret$/,
  );
  const resumed = buildClaudeSessionArguments({
    access: 'workspace-write',
    sessionId: 'session-1',
    resume: true,
    mcpUrl: 'http://127.0.0.1:1/mcp/session-1',
    token: 'secret',
    toolNames: ['run_job', 'publish_candidate'],
  });
  assert.equal(
    resumed[resumed.indexOf('--tools') + 1],
    'Read,Glob,Grep,Edit,Write,Bash',
  );
  assert.equal(
    resumed[resumed.indexOf('--permission-mode') + 1],
    'acceptEdits',
  );
  assert.deepEqual(resumed.slice(-2), ['--resume', 'session-1']);
});

void test('a suspending Host tool over loopback MCP ends the physical turn and resumes the same Claude session', async (t) => {
  let resolveWorker!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveWorker = resolve;
  });
  let calls = 0;
  const f = await fixture(t, 'dispatch', [
    {
      name: 'dispatch_worker',
      description: 'Dispatch',
      inputSchema: { type: 'object' },
      call: async (arguments_) => {
        calls++;
        assert.deepEqual(arguments_, { decision: { decision: 'dispatch' } });
        return {
          suspend: true as const,
          acknowledgement: 'Worker dispatched.',
          continuation: settled.then(() => ({
            prompt: 'WORKER_COMPLETED {"checks":[]}',
          })),
        };
      },
    },
  ]);
  const thread = await f.driver.startThread({
    profile: { agent: 'claude', model: 'fixture', effort: 'low' },
    workingDirectory: f.root,
    access: 'read-only',
    hostJobs: false,
  });
  const events: AgentRuntimeEvent['type'][] = [];
  const perTurnUsage: Array<number | null> = [];
  const turn = f.driver.startTurn(thread, {
    prompt: 'prepare',
    onEvent: (event) => {
      events.push(event.type);
      if (event.type === 'turn-completed')
        perTurnUsage.push(event.usage?.inputTokens ?? null);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls, 1);
  assert.ok(events.includes('tool-suspended'));
  assert.equal(events.at(-1), 'turn-completed');
  assert.ok(!events.includes('tool-resumed'));
  resolveWorker();
  const result = await turn.completion;
  assert.equal(result.threadId, thread.threadId);
  assert.equal(result.finalOutput, 'RESUMED:WORKER_COMPLETED {"checks":[]}');
  assert.deepEqual(
    perTurnUsage,
    [10, 10],
    'each physical turn reports its own usage',
  );
  assert.equal(
    result.usage?.inputTokens,
    20,
    'the logical result accumulates every physical turn',
  );
  assert.equal(result.usage?.cachedInputTokens, 8);
  const resumed = events.indexOf('tool-resumed');
  assert.ok(resumed > events.indexOf('turn-completed'));
  assert.equal(events[resumed + 1], 'turn-started');
  assert.equal(events.at(-1), 'turn-completed');
  assert.equal(events.filter((type) => type === 'turn-started').length, 2);
  const runs = await f.invocations();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].resume, false);
  assert.equal(runs[0].sessionId, thread.threadId);
  assert.equal(runs[0].prompt, 'prepare');
  assert.ok(!runs[0].args.join(' ').includes('mcp__praxis__run_job'));
  assert.equal(runs[1].resume, true);
  assert.equal(runs[1].sessionId, thread.threadId);
  assert.ok(runs[1].prompt.startsWith('WORKER_COMPLETED'));
});

void test('Claude run_job goes through the Host broker and the job result resumes the session', async (t) => {
  const f = await fixture(t, 'job');
  const thread = await f.driver.startThread({
    profile: { agent: 'claude', model: 'fixture', effort: 'low' },
    workingDirectory: f.root,
    access: 'workspace-write',
  });
  const events: AgentRuntimeEvent['type'][] = [];
  const result = await f.driver.startTurn(thread, {
    prompt: 'build',
    onEvent: (event) => events.push(event.type),
  }).completion;
  assert.ok(result.finalOutput.startsWith('RESUMED:HOST_JOB_COMPLETED'));
  assert.deepEqual(f.jobs, ['running', 'completed']);
  assert.ok(events.includes('job-started'));
  assert.ok(events.includes('job-completed'));
  const runs = await f.invocations();
  assert.equal(runs.length, 2);
  assert.match(runs[1].prompt, /"status":"completed"/);
  assert.ok(runs[0].args.join(' ').includes('mcp__praxis__run_job'));
});

void test('a Claude thread without Host jobs does not list run_job', async (t) => {
  const f = await fixture(t, 'nojobs');
  const thread = await f.driver.startThread({
    profile: { agent: 'claude', model: 'fixture', effort: 'low' },
    workingDirectory: f.root,
    access: 'read-only',
    hostJobs: false,
  });
  const result = await f.driver.startTurn(thread, { prompt: 'x' }).completion;
  assert.equal(result.finalOutput, 'REJECTED');
  assert.deepEqual(f.jobs, []);
});

void test('interrupting a Claude turn kills the process and rejects the logical turn', async (t) => {
  const f = await fixture(t, 'hang');
  const thread = await f.driver.startThread({
    profile: { agent: 'claude', model: 'fixture', effort: 'low' },
    workingDirectory: f.root,
    access: 'read-only',
  });
  const turn = f.driver.startTurn(thread, { prompt: 'wait' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  turn.interrupt();
  await assert.rejects(() => turn.completion, /interrupted/);
});

void test('a Claude error result rejects the turn with the reported message', async (t) => {
  const f = await fixture(t, 'error');
  const thread = await f.driver.startThread({
    profile: { agent: 'claude', model: 'fixture', effort: 'low' },
    workingDirectory: f.root,
    access: 'read-only',
  });
  await assert.rejects(
    () => f.driver.startTurn(thread, { prompt: 'x' }).completion,
    /boom/,
  );
});

void test('the loopback MCP endpoint requires the per-thread bearer token and a known thread', async (t) => {
  const f = await fixture(t, 'echo');
  const thread = await f.driver.startThread({
    profile: { agent: 'claude', model: 'fixture', effort: 'low' },
    workingDirectory: f.root,
    access: 'read-only',
  });
  const result = await f.driver.startTurn(thread, { prompt: 'hello' })
    .completion;
  assert.equal(result.finalOutput, 'ECHO:hello');
  const [run] = await f.invocations();
  const config = JSON.parse(run.args[run.args.indexOf('--mcp-config') + 1]);
  const server = config.mcpServers[claudeMcpServerName];
  const call = (headers: Record<string, string>, url = server.url) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  assert.equal((await call({})).status, 401);
  assert.equal((await call({ Authorization: 'Bearer wrong' })).status, 401);
  assert.equal(
    (
      await call(
        server.headers,
        server.url.replace(
          /[0-9a-f-]{36}$/,
          '00000000-0000-4000-8000-000000000000',
        ),
      )
    ).status,
    404,
  );
  const listed = await (await call(server.headers)).json();
  assert.deepEqual(
    listed.result.tools.map((tool: { name: string }) => tool.name),
    ['run_job'],
  );
  const outsideTurn = await (
    await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...server.headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'run_job', arguments: {} },
      }),
    })
  ).json();
  assert.equal(outsideTurn.result.isError, true);
  assert.match(outsideTurn.result.content[0].text, /No active Claude turn/);
});

void test('a Claude coordinator profile receives the push driver without touching Codex', async () => {
  const session = await startPushCoordinatorSession({
    profile: { agent: 'claude', model: 'opus', effort: 'low' },
    workingDirectory: os.tmpdir(),
    hostTools: [],
  });
  assert.ok(session);
  assert.ok(session.driver instanceof ClaudeSessionDriver);
  assert.equal(session.driver.capabilities.pushToolResults, true);
  assert.equal(session.decoratePrompt('p'), 'p');
  await session.driver.close();
});

void test('a model that never ends its physical turn after a suspension fails on the Host grace deadline', async (t) => {
  const f = await fixture(t, 'nofinish', [
    {
      name: 'dispatch_worker',
      description: 'Dispatch',
      inputSchema: { type: 'object' },
      call: async () => ({
        suspend: true as const,
        acknowledgement: 'Worker dispatched.',
        continuation: Promise.resolve({ prompt: 'WORKER_COMPLETED' }),
      }),
    },
  ]);
  const thread = await f.driver.startThread({
    profile: { agent: 'claude', model: 'fixture', effort: 'low' },
    workingDirectory: f.root,
    access: 'read-only',
    hostJobs: false,
  });
  const started = Date.now();
  await assert.rejects(
    () => f.driver.startTurn(thread, { prompt: 'prepare' }).completion,
    /did not end its physical turn/,
  );
  assert.ok(
    Date.now() - started < 5000,
    'the Host bounds the wait instead of hanging until the Action deadline',
  );
  const runs = await f.invocations();
  assert.equal(runs.length, 1, 'no continuation process is started');
});

void test('every Claude Host-tool call emits activity before validation so the coordinator cap applies', async (t) => {
  const f = await fixture(t, 'cap', [
    {
      name: 'dispatch_worker',
      description: 'Dispatch',
      inputSchema: { type: 'object' },
      call: async () => {
        throw new Error('Coordinator response does not match its contract.');
      },
    },
  ]);
  const thread = await f.driver.startThread({
    profile: { agent: 'claude', model: 'fixture', effort: 'low' },
    workingDirectory: f.root,
    access: 'read-only',
    hostJobs: false,
  });
  const activity: string[] = [];
  const turn = f.driver.startTurn(thread, {
    prompt: 'prepare',
    onEvent: (event) => {
      if (event.type === 'activity') activity.push(event.summary);
      if (
        activity.filter(
          (summary) => summary === 'Running tool: dispatch_worker',
        ).length > coordinationLimits.maxCoordinatorToolCalls
      )
        turn.interrupt();
    },
  });
  await assert.rejects(() => turn.completion, /interrupted/);
  assert.equal(
    activity.filter((summary) => summary === 'Running tool: dispatch_worker')
      .length,
    coordinationLimits.maxCoordinatorToolCalls + 1,
    'a rejected Host-tool call still counts against the cap',
  );
  assert.equal(
    activity.filter((summary) => summary.includes('mcp__praxis__')).length,
    0,
    'the model-reported MCP call is not counted a second time',
  );
});

void test('coordinator thread instructions reach the real CLI arguments and only the first process', async (t) => {
  const f = await fixture(t, 'echo');
  const thread = await f.driver.startThread({
    profile: { agent: 'claude', model: 'fixture', effort: 'low' },
    workingDirectory: f.root,
    access: 'read-only',
    hostJobs: false,
    instructions: coordinatorThreadInstructions,
  });
  await f.driver.startTurn(thread, { prompt: 'prepare' }).completion;
  await f.driver.startTurn(thread, { prompt: 'qualify' }).completion;
  const runs = await f.invocations();
  assert.equal(runs.length, 2);
  assert.equal(
    runs[0].args[runs[0].args.indexOf('--append-system-prompt') + 1],
    coordinatorThreadInstructions,
    'the first process carries the exact coordinator instruction',
  );
  assert.match(coordinatorThreadInstructions, /dispatch_worker/);
  assert.equal(
    runs[0].args[runs[0].args.indexOf('--setting-sources') + 1],
    '',
    'project and user customizations stay disabled',
  );
  assert.ok(!runs[0].args.includes('--safe-mode'));
  assert.ok(
    !runs[1].args.includes('--append-system-prompt'),
    'a resumed session already carries its instructions',
  );
});

void test('a second logical turn resumes the same Claude session instead of recreating it', async (t) => {
  const f = await fixture(t, 'echo');
  const thread = await f.driver.startThread({
    profile: { agent: 'claude', model: 'fixture', effort: 'low' },
    workingDirectory: f.root,
    access: 'read-only',
    hostJobs: false,
  });
  const first = await f.driver.startTurn(thread, { prompt: 'one' }).completion;
  const second = await f.driver.startTurn(thread, { prompt: 'two' }).completion;
  assert.equal(first.finalOutput, 'ECHO:one');
  assert.equal(second.finalOutput, 'RESUMED:two');
  const runs = await f.invocations();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].resume, false);
  assert.deepEqual(runs[0].args.slice(-2), ['--session-id', thread.threadId]);
  assert.equal(runs[1].resume, true);
  assert.deepEqual(runs[1].args.slice(-2), ['--resume', thread.threadId]);
  assert.equal(runs[0].sessionId, runs[1].sessionId);
});
