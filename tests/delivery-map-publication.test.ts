import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  publishDeliveryMap,
  startWhatToDoRun,
} from '../lib/modules/delivery-planning/runs.ts';
import { prepareDeliveryMapBasis } from '../lib/modules/delivery-planning/basis.ts';
import {
  readWhatToDoCurrentMap,
  readWhatToDoCurrentMapWithFingerprint,
  writeWhatToDoCurrentMap,
} from '../lib/modules/delivery-planning/storage.ts';
import { MaterializationError } from '../lib/materialization/receipt.ts';
import {
  controlled,
  fixture,
  input,
  result,
  settled,
} from './helpers/what-to-do-fixture.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

async function settledMap(
  project: RegisteredProject,
  control: ReturnType<typeof controlled>,
) {
  const call = control.calls.length;
  const run = await startWhatToDoRun(project, input(), control.transport);
  control.calls[call]!.resolve({
    agentSessionId: `session-${call + 1}`,
    finalOutput: JSON.stringify(result(run)),
    usage: null,
  });
  const completed = await settled(project, run.id);
  assert.equal(completed.status, 'succeeded', completed.error ?? undefined);
  assert.ok(completed.map);
  return completed.map;
}

void test('the fingerprint reports an absent Map and tracks its bytes', async (t) => {
  const { project } = await fixture(t);
  const before = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.equal(before.map, null);
  assert.equal(before.fingerprint, 'absent');
  const control = controlled();
  const map = await settledMap(project, control);
  const after = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.match(after.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(after.map?.runId, map.runId);
  await writeWhatToDoCurrentMap(project, { ...map, contracts: [] });
  const changed = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.notEqual(changed.fingerprint, after.fingerprint);
});

void test('publishing against a Map that changed underneath is refused', async (t) => {
  const { project } = await fixture(t);
  const control = controlled();
  const map = await settledMap(project, control);
  const captured = await readWhatToDoCurrentMapWithFingerprint(project);
  const basis = prepareDeliveryMapBasis(project, {
    currentMapFingerprint: captured.fingerprint,
  });
  await writeWhatToDoCurrentMap(project, { ...map, contracts: [] });
  const overtaken = await readWhatToDoCurrentMap(project);
  await assert.rejects(
    () => publishDeliveryMap(project, map, undefined, basis),
    (error: unknown) =>
      error instanceof MaterializationError &&
      error.boundary === 'stale-basis' &&
      error.status === 409,
  );
  assert.deepEqual(await readWhatToDoCurrentMap(project), overtaken);
});

void test('publishing against the Map it was prepared from succeeds', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const map = await settledMap(project, control);
  const captured = await readWhatToDoCurrentMapWithFingerprint(project);
  const basis = prepareDeliveryMapBasis(project, {
    currentMapFingerprint: captured.fingerprint,
  });
  await publishDeliveryMap(project, map, undefined, basis);
  const published = await readWhatToDoCurrentMap(project);
  assert.equal(published?.runId, map.runId);
  assert.equal(published?.contracts.length, map.contracts.length);
  await readFile(path.join(planningPath, map.contracts[0]!.outputPath), 'utf8');
});

void test('the basis records whether a Map already existed', async (t) => {
  const { project } = await fixture(t);
  const control = controlled();
  await settledMap(project, control);
  const captured = await readWhatToDoCurrentMapWithFingerprint(project);
  const basis = prepareDeliveryMapBasis(
    project,
    { currentMapFingerprint: captured.fingerprint },
    () => '2026-09-05T00:00:00.000Z',
  );
  assert.equal(basis.operation, 'adjust-map');
  assert.equal(basis.preparedAt, '2026-09-05T00:00:00.000Z');
  assert.equal(basis.currentMapFingerprint, captured.fingerprint);
  assert.throws(() => {
    (basis as { preparedAt: string }).preparedAt = 'changed';
  });
  assert.equal(
    prepareDeliveryMapBasis(project, { currentMapFingerprint: 'absent' })
      .operation,
    'create-map',
  );
});
