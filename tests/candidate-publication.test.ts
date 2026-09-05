import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeCandidatePublication } from '../lib/agents/candidate-publication.ts';

void test('candidate publication scripts run one at a time and release the queue after failure', async () => {
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstBlock = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let running = 0;
  let maximumRunning = 0;
  let secondStarted = false;
  const first = serializeCandidatePublication(async () => {
    running += 1;
    maximumRunning = Math.max(maximumRunning, running);
    markFirstStarted();
    await firstBlock;
    running -= 1;
    return 'first';
  });
  await firstStarted;
  const second = serializeCandidatePublication(async () => {
    secondStarted = true;
    running += 1;
    maximumRunning = Math.max(maximumRunning, running);
    running -= 1;
    return 'second';
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(maximumRunning, 1);
  await assert.rejects(
    serializeCandidatePublication(async () => {
      throw new Error('publication failed');
    }),
    /publication failed/,
  );
  assert.equal(
    await serializeCandidatePublication(async () => 'released'),
    'released',
  );
});
