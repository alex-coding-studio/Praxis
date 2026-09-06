import assert from 'node:assert/strict';
import test from 'node:test';
import { agentRunLogEntry } from '../lib/modules/delivery/agent-log.ts';
import {
  LOG_EVENT_PATTERN,
  formatRunLogLine,
  parseRunLogText,
} from '../lib/execution-observability/run-log-format.ts';
import type { AgentRuntimeEvent } from '../lib/agents/runtime-driver.ts';

const at = '2026-09-06T00:00:00.000Z';

void test('per-request usage becomes one readable Run Log line that carries its process and turn', () => {
  const entry = agentRunLogEntry('ORCHESTRATOR', {
    type: 'request-usage',
    threadId: 'thread-1',
    turnId: 'thread-1:ab12cd34',
    requestKey: 'req_01|msg_01',
    pid: 4242,
    launch: 2,
    inputTokens: 3,
    cachedInputTokens: 205_397,
    cacheWriteInputTokens: 118,
    outputTokens: 91,
    at,
  })!;
  assert.equal(entry.event, 'agent.request-usage');
  assert.ok(
    LOG_EVENT_PATTERN.test(entry.event),
    'the event name must survive the log parser',
  );
  assert.equal(
    entry.message,
    'session=thread-1 turn=thread-1:ab12cd34 request=req_01|msg_01 pid=4242 launch=2 input=3 cache-read=205397 cache-write=118 output=91',
  );
  const parsed = parseRunLogText(
    formatRunLogLine({ sequence: 1, at, ...entry }),
  );
  assert.equal(
    parsed.length,
    1,
    'the line round-trips through the Run Log format',
  );
  assert.equal(parsed[0].event, 'agent.request-usage');
  assert.equal(parsed[0].message, entry.message);
});

void test('a session process reports its identity and configuration digests, never the instructions themselves', () => {
  const entry = agentRunLogEntry('WORKER', {
    type: 'session-process',
    threadId: 'thread-2',
    pid: 77,
    launch: 1,
    cliVersion: '2.1.263',
    model: 'opus[1m]',
    effort: 'medium',
    resumed: true,
    instructionsHash: '0123456789abcdef',
    toolsHash: 'fedcba9876543210',
    at,
  })!;
  assert.equal(entry.event, 'agent.session-process');
  assert.ok(LOG_EVENT_PATTERN.test(entry.event));
  assert.equal(
    entry.message,
    'session=thread-2 pid=77 launch=1 cli=2.1.263 model=opus[1m] effort=medium resumed=true instructions=0123456789abcdef tools=fedcba9876543210',
  );
  assert.equal(
    parseRunLogText(formatRunLogLine({ sequence: 2, at, ...entry })).length,
    1,
  );
});

void test('an unknown process id degrades to a marker instead of breaking the line', () => {
  const entry = agentRunLogEntry('REVIEWER', {
    type: 'session-process',
    threadId: 'thread-3',
    pid: undefined,
    launch: 1,
    resumed: false,
    instructionsHash: 'a'.repeat(16),
    toolsHash: 'b'.repeat(16),
    at,
  })!;
  assert.match(
    entry.message,
    /pid=unknown launch=1 cli=unknown model=default effort=default/,
  );
  assert.equal(
    parseRunLogText(formatRunLogLine({ sequence: 3, at, ...entry })).length,
    1,
  );
});

void test('lifecycle events that carry no observation are not logged', () => {
  const ignored: AgentRuntimeEvent[] = [
    { type: 'turn-started', threadId: 't', turnId: 'u', at },
    { type: 'turn-completed', threadId: 't', turnId: 'u', usage: null, at },
    {
      type: 'tool-suspended',
      threadId: 't',
      turnId: 'u',
      tool: 'dispatch_worker',
      at,
    },
  ];
  for (const event of ignored)
    assert.equal(
      agentRunLogEntry('ORCHESTRATOR', event),
      undefined,
      event.type,
    );
});
