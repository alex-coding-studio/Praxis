import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  adaptAgentGraphActivity,
  adaptCoordinationTrace,
  adaptExecutionActivity,
} from '../lib/execution-observability/legacy-log-adapters.ts';
import {
  formatRunLogLine,
  parseRunLogText,
  isReadableActivity,
  readableActivity,
  renderRunLogText,
} from '../lib/execution-observability/run-log-format.ts';
import {
  MATERIALIZATION_LOG_EVENTS,
  materializationLogEntry,
} from '../lib/materialization/log.ts';
import {
  createRunLog,
  openRunLog,
  readRunLogTail,
} from '../lib/execution-observability/run-log.ts';

const MATERIALIZATION_LOG_EVENT_NAMES = Object.keys(
  MATERIALIZATION_LOG_EVENTS,
) as Array<keyof typeof MATERIALIZATION_LOG_EVENTS>;

const LINE =
  /^\d{6} \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|WARN|ERROR) (HOST|AGENT|COORDINATOR|WORKER|JOB) (RUN|PREPARE|EXECUTE|VERIFY|PUBLISH|FINALIZE|STOP|RECOVERY) [a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+ — /;

async function temporary(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'run-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

void test('Run Log lines carry sequence, timestamp, level, actor, phase, event and message', async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, 'run.log');
  const log = await createRunLog(file, {
    level: 'INFO',
    actor: 'HOST',
    phase: 'RUN',
    event: 'run.started',
    message: 'Action 1/2 started with Codex',
  });
  log.append({
    level: 'INFO',
    actor: 'COORDINATOR',
    phase: 'PREPARE',
    event: 'assignment.started',
    message: 'Preparing the Worker assignment',
  });
  log.append({
    level: 'INFO',
    actor: 'WORKER',
    phase: 'EXECUTE',
    event: 'reference.opened',
    message: 'Read CheckMe/DesignSystem/AppColor.swift',
  });
  log.append({
    level: 'ERROR',
    actor: 'JOB',
    phase: 'VERIFY',
    event: 'job.finished',
    message: 'LocusKit unit tests exited 1; job log 300a7b4b',
  });
  log.append({
    level: 'INFO',
    actor: 'AGENT',
    phase: 'EXECUTE',
    event: 'agent.message',
    message: 'token=ghp_abcdefghijklmnop inspected the graph',
  });
  await log.flush();
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
  assert.equal(lines.length, 5);
  for (const line of lines) assert.match(line, LINE);
  assert.deepEqual(
    lines.map((line) => line.slice(0, 6)),
    ['000001', '000002', '000003', '000004', '000005'],
  );
  assert.deepEqual(
    lines.map((line) => line.split(' ')[3]),
    ['HOST', 'COORDINATOR', 'WORKER', 'JOB', 'AGENT'],
  );
  assert.match(lines[4]!, /token=\[redacted\]/);
  assert.doesNotMatch(lines[4]!, /ghp_abcdefghijklmnop/);
});

void test('embedded newlines become continuation lines and round-trip through the parser', () => {
  const line = formatRunLogLine({
    sequence: 7,
    at: '2026-09-04T23:26:45.317Z',
    level: 'ERROR',
    actor: 'JOB',
    phase: 'VERIFY',
    event: 'job.finished',
    message:
      'swift build failed\nerror: value of type X is not Sendable\n  --> Token.swift:12',
  });
  const rows = line.split('\n');
  assert.equal(rows.length, 3);
  assert.match(rows[0]!, LINE);
  assert.ok(rows[1]!.startsWith('    error:'));
  assert.ok(rows[2]!.startsWith('      --> Token'));
  const parsed = parseRunLogText(`${line}\n`);
  assert.equal(parsed.length, 1);
  assert.equal(
    parsed[0]!.message,
    'swift build failed\nerror: value of type X is not Sendable\n  --> Token.swift:12',
  );
  assert.equal(parsed[0]!.sequence, 7);
  assert.equal(parsed[0]!.event, 'job.finished');
});

void test('a Run Log is created exactly once and can be reopened to continue the sequence', async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, 'nested', 'run.log');
  const first = await createRunLog(file, {
    level: 'INFO',
    actor: 'HOST',
    phase: 'RUN',
    event: 'run.started',
    message: 'started',
  });
  first.append({
    level: 'INFO',
    actor: 'AGENT',
    phase: 'EXECUTE',
    event: 'agent.message',
    message: 'working',
  });
  await first.close();
  await assert.rejects(
    createRunLog(file, {
      level: 'INFO',
      actor: 'HOST',
      phase: 'RUN',
      event: 'run.started',
      message: 'again',
    }),
    /EEXIST/,
  );
  const reopened = await openRunLog(file);
  assert.equal(reopened.sequence(), 2);
  reopened.append({
    level: 'INFO',
    actor: 'HOST',
    phase: 'RECOVERY',
    event: 'recovery.reread',
    message: 'Re-reading the saved result',
  });
  await reopened.flush();
  const entries = parseRunLogText(await readFile(file, 'utf8'));
  assert.deepEqual(
    entries.map((entry) => entry.sequence),
    [1, 2, 3],
  );
  assert.equal(entries[2]!.phase, 'RECOVERY');
  assert.throws(
    () =>
      first.append({
        level: 'INFO',
        actor: 'HOST',
        phase: 'RUN',
        event: 'x.y',
        message: 'closed',
      }),
    /closed/,
  );
  assert.throws(
    () =>
      reopened.append({
        level: 'INFO',
        actor: 'HOST',
        phase: 'RUN',
        event: 'NotAnEvent',
        message: 'bad',
      }),
    /Invalid Run Log event/,
  );
});

void test('tail reads return only appended, complete lines and recover from truncation', async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, 'run.log');
  const log = await createRunLog(file, {
    level: 'INFO',
    actor: 'HOST',
    phase: 'RUN',
    event: 'run.started',
    message: 'started',
  });
  await log.flush();
  const first = await readRunLogTail(file, 0);
  assert.equal(first.offset, 0);
  assert.equal(first.next, first.size);
  assert.match(first.text, /run\.started/);
  const idle = await readRunLogTail(file, first.next);
  assert.equal(idle.text, '');
  assert.equal(idle.next, first.next);
  log.append({
    level: 'INFO',
    actor: 'WORKER',
    phase: 'EXECUTE',
    event: 'worker.progress',
    message: 'second',
  });
  await log.flush();
  const second = await readRunLogTail(file, first.next);
  assert.doesNotMatch(second.text, /run\.started/);
  assert.match(second.text, /worker\.progress — second\n$/);
  const partial = await readRunLogTail(file, 0, 20);
  assert.equal(partial.text, '');
  assert.equal(partial.next, 0);
  const capped = await readRunLogTail(file, 0, first.size + 5);
  assert.equal(capped.next, first.size);
  await writeFile(file, '');
  const reset = await readRunLogTail(file, second.next);
  assert.equal(reset.offset, 0);
  assert.equal(reset.size, 0);
});

void test('readable activity drops job noise and keeps the latest three entries', () => {
  const entries = parseRunLogText(
    renderRunLogText([
      {
        sequence: 1,
        at: '2026-09-04T00:00:00.000Z',
        level: 'INFO',
        actor: 'AGENT',
        phase: 'EXECUTE',
        event: 'agent.message',
        message: 'one',
      },
      {
        sequence: 2,
        at: '2026-09-04T00:00:01.000Z',
        level: 'INFO',
        actor: 'AGENT',
        phase: 'EXECUTE',
        event: 'tool.activity',
        message: 'Running: swift build',
      },
      {
        sequence: 3,
        at: '2026-09-04T00:00:02.000Z',
        level: 'INFO',
        actor: 'AGENT',
        phase: 'EXECUTE',
        event: 'agent.message',
        message: 'Agent report received.',
      },
      {
        sequence: 4,
        at: '2026-09-04T00:00:03.000Z',
        level: 'INFO',
        actor: 'JOB',
        phase: 'VERIFY',
        event: 'job.progress',
        message: 'compiling',
      },
      {
        sequence: 5,
        at: '2026-09-04T00:00:04.000Z',
        level: 'INFO',
        actor: 'WORKER',
        phase: 'EXECUTE',
        event: 'worker.progress',
        message: 'two',
      },
      {
        sequence: 6,
        at: '2026-09-04T00:00:05.000Z',
        level: 'INFO',
        actor: 'WORKER',
        phase: 'EXECUTE',
        event: 'worker.progress',
        message: 'three',
      },
      {
        sequence: 7,
        at: '2026-09-04T00:00:06.000Z',
        level: 'INFO',
        actor: 'WORKER',
        phase: 'EXECUTE',
        event: 'worker.progress',
        message: 'four',
      },
    ]),
  );
  assert.deepEqual(
    readableActivity(entries).map((entry) => entry.message),
    ['two', 'three', 'four'],
  );
});

void test('legacy Graph activity arrays adapt into actor-separated lines', () => {
  const entries = adaptAgentGraphActivity({
    runId: 'RUN-1',
    startedAt: '2026-09-01T00:00:00.000Z',
    endedAt: '2026-09-01T00:01:00.000Z',
    status: 'clarification',
    activity: [
      { at: '2026-09-01T00:00:10.000Z', summary: 'Reading the Product Source' },
      { at: '2026-09-01T00:00:20.000Z', summary: 'Running: rg TODO' },
    ],
  });
  assert.deepEqual(
    entries.map((entry) => `${entry.actor} ${entry.phase} ${entry.event}`),
    [
      'HOST RUN run.started',
      'AGENT EXECUTE agent.message',
      'AGENT EXECUTE tool.activity',
      'HOST RUN run.warning',
    ],
  );
  assert.deepEqual(
    entries.map((entry) => entry.sequence),
    [1, 2, 3, 4],
  );
  for (const line of renderRunLogText(entries).trimEnd().split('\n'))
    assert.match(line, LINE);
});

void test('legacy execution activity and coordination traces adapt with Host, Coordinator, Worker and Job actors', () => {
  const entries = adaptExecutionActivity(
    {
      id: 'run-1',
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:05:00.000Z',
      status: 'failed',
      error: 'Worker did not return a valid report.',
    },
    [
      {
        phase: 'prepare',
        summary: 'Preparing the Worker assignment',
        updatedAt: '2026-09-01T00:00:05.000Z',
        attempts: 1,
      },
      {
        phase: 'execute',
        summary: 'Editing AppColor.swift',
        updatedAt: '2026-09-01T00:01:00.000Z',
        attempts: 1,
      },
      {
        phase: 'execute',
        summary: 'Running job: LocusKit unit tests',
        updatedAt: '2026-09-01T00:02:00.000Z',
        attempts: 1,
      },
      {
        phase: 'execute',
        summary: 'Finished: swift test (exit 1)',
        updatedAt: '2026-09-01T00:03:00.000Z',
        attempts: 1,
      },
      {
        phase: 'qualify',
        summary: 'Qualifying the Worker result',
        updatedAt: '2026-09-01T00:04:00.000Z',
        attempts: 2,
      },
    ],
  );
  assert.deepEqual(
    entries.map(
      (entry) => `${entry.level} ${entry.actor} ${entry.phase} ${entry.event}`,
    ),
    [
      'INFO HOST RUN run.started',
      'INFO COORDINATOR PREPARE assignment.progress',
      'INFO WORKER EXECUTE worker.progress',
      'INFO JOB VERIFY job.started',
      'ERROR JOB VERIFY job.finished',
      'INFO COORDINATOR FINALIZE qualification.progress',
      'ERROR HOST RUN run.failed',
    ],
  );
  assert.equal(entries[4]!.message, 'swift test exited 1');
  const trace = adaptCoordinationTrace({
    attempts: [
      {
        id: 'a1',
        role: 'coordinator',
        phase: 'prepare',
        startedAt: '2026-09-01T00:00:00.000Z',
        endedAt: '2026-09-01T00:00:30.000Z',
        summary: 'Dispatch prepared',
      },
      {
        id: 'a2',
        role: 'worker',
        phase: 'execute',
        startedAt: '2026-09-01T00:00:31.000Z',
        endedAt: null,
        summary: 'Worker started',
        error: 'interrupted',
      },
    ],
    decisions: [{ decision: 'needs-user', summary: 'Choose a target.' }],
  });
  assert.deepEqual(
    trace.map(
      (entry) => `${entry.level} ${entry.actor} ${entry.phase} ${entry.event}`,
    ),
    [
      'INFO COORDINATOR PREPARE coordinator.started',
      'INFO COORDINATOR PREPARE coordinator.finished',
      'INFO WORKER EXECUTE worker.started',
      'ERROR WORKER EXECUTE worker.finished',
      'WARN COORDINATOR FINALIZE decision.recorded',
    ],
  );
});

void test('HOST materialization events stay out of the readable activity strip', () => {
  const entries = MATERIALIZATION_LOG_EVENT_NAMES.map((event, index) => ({
    sequence: index + 1,
    at: '2026-09-04T00:00:00.000Z',
    ...materializationLogEntry(event, `${event} happened`),
  }));
  assert.ok(entries.length > 0);
  assert.deepEqual(entries.filter(isReadableActivity), []);
  assert.deepEqual(
    [
      ...entries,
      {
        sequence: entries.length + 1,
        at: '2026-09-04T00:00:09.000Z',
        level: 'INFO' as const,
        actor: 'AGENT' as const,
        phase: 'EXECUTE' as const,
        event: 'agent.progress',
        message: 'visible',
      },
    ]
      .filter(isReadableActivity)
      .map((entry) => entry.message),
    ['visible'],
  );
});
