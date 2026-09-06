import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startWhatToDoRun } from '../lib/modules/delivery-planning/runs.ts';
import { publishDeliveryMap } from '../lib/modules/delivery-planning/publish.ts';
import { deliveryPublicationHost } from '../lib/modules/delivery-planning/publication-host.ts';
import { prepareDeliveryMapBasis } from '../lib/modules/delivery-planning/basis.ts';
import {
  readWhatToDoCurrentMap,
  readWhatToDoCurrentMapWithFingerprint,
  writeWhatToDoCurrentMap,
} from '../lib/modules/delivery-planning/storage.ts';
import { MaterializationError } from '../lib/materialization/receipt.ts';
import { materializeDeliveryMapProposal } from '../lib/modules/delivery-planning/validation.ts';
import {
  controlled,
  fixture,
  input,
  result,
  retainedResult,
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
    currentMap: captured.map,
    currentMapFingerprint: captured.fingerprint,
  });
  await writeWhatToDoCurrentMap(project, { ...map, contracts: [] });
  const overtaken = await readWhatToDoCurrentMap(project);
  await assert.rejects(
    () => publishDeliveryMap(project, map, deliveryPublicationHost, basis),
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
    currentMap: captured.map,
    currentMapFingerprint: captured.fingerprint,
  });
  await publishDeliveryMap(project, map, deliveryPublicationHost, basis);
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
    { currentMap: captured.map, currentMapFingerprint: captured.fingerprint },
    () => '2026-09-05T00:00:00.000Z',
  );
  assert.equal(basis.operation, 'adjust-map');
  assert.equal(basis.preparedAt, '2026-09-05T00:00:00.000Z');
  assert.equal(basis.currentMapFingerprint, captured.fingerprint);
  assert.throws(() => {
    (basis as { preparedAt: string }).preparedAt = 'changed';
  });
  assert.equal(
    prepareDeliveryMapBasis(project, {
      currentMap: null,
      currentMapFingerprint: 'absent',
    }).operation,
    'create-map',
  );
});

void test('a Run whose Map moved underneath reports the conflict, not a bad result', async (t) => {
  const { project } = await fixture(t);
  const control = controlled();
  const first = await settledMap(project, control);
  const call = control.calls.length;
  const run = await startWhatToDoRun(
    project,
    { ...input(), sourceUids: [] },
    control.transport,
  );
  await writeWhatToDoCurrentMap(project, { ...first, contracts: [] });
  control.calls[call]!.resolve({
    agentSessionId: 'session-overtaken',
    finalOutput: JSON.stringify(retainedResult(run, first)),
    usage: null,
  });
  const completed = await settled(project, run.id);
  assert.equal(completed.status, 'failed');
  assert.match(completed.error ?? '', /changed after this Run was prepared/);
  assert.equal(
    (completed.response?.recovery ?? []).includes('reread'),
    false,
    'a changed Map must not offer to re-read valid Agent output',
  );
  assert.doesNotMatch(completed.response?.title ?? '', /could not be verified/);
  assert.match(completed.response?.detail ?? '', /could not persist/);
});

void test('normalization returns a new proposal and leaves the caller its own', async (t) => {
  const { project } = await fixture(t);
  const control = controlled();
  const call = control.calls.length;
  const run = await startWhatToDoRun(project, input(), control.transport);
  const envelope = result(run);
  const source = run.request.sourceFeatures[0]!;
  const proposal = {
    outcome: 'map-proposal' as const,
    candidates: envelope.candidates.map((candidate) => ({
      ...structuredClone(candidate),
      sourceClaimIds: [],
    })),
    sourceClaims: structuredClone(envelope.sourceClaims),
  };
  const before = structuredClone(proposal);
  const normalized = materializeDeliveryMapProposal(
    proposal,
    {
      operation: 'create-map',
      knownSources: {
        [source.outputPath]: {
          sha256: source.outputSha256,
          content: '## Behavior\n\nThe accepted behavior must be delivered.\n',
        },
      },
      userInput: { path: 'input.md', sha256: 'sha', content: '' },
    },
    new Set(envelope.candidates[0]!.domainImpact.evidencePaths),
  );
  assert.deepEqual(
    normalized.candidates[0]!.sourceClaimIds,
    [envelope.sourceClaims[0]!.claimId],
    'normalization must assign the in-scope claim to its Contract',
  );
  assert.deepEqual(proposal, before);
  assert.notEqual(normalized.candidates[0], proposal.candidates[0]);
  control.calls[call]!.resolve({
    agentSessionId: 'session-normalized',
    finalOutput: JSON.stringify(envelope),
    usage: null,
  });
  await settled(project, run.id);
});

void test('the basis freezes the Map that computation and the guard both use', async (t) => {
  const { project } = await fixture(t);
  const control = controlled();
  const map = await settledMap(project, control);
  const captured = await readWhatToDoCurrentMapWithFingerprint(project);
  const basis = prepareDeliveryMapBasis(project, {
    currentMap: captured.map,
    currentMapFingerprint: captured.fingerprint,
  });
  assert.equal(basis.currentMap?.runId, map.runId);
  assert.notEqual(basis.currentMap, captured.map);
  captured.map!.contracts.length = 0;
  assert.equal(basis.currentMap?.contracts.length, map.contracts.length);
  await writeWhatToDoCurrentMap(project, { ...map, contracts: [] });
  const reread = await readWhatToDoCurrentMapWithFingerprint(project);
  assert.notEqual(reread.fingerprint, basis.currentMapFingerprint);
  assert.equal(basis.currentMap?.contracts.length, map.contracts.length);
  assert.throws(() => {
    basis.currentMap!.contracts.length = 0;
  }, 'the basis Map must not be reachable for mutation');
  assert.throws(() => {
    basis.currentMap!.contracts[0]!.title = 'changed';
  });
});
