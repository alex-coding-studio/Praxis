import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishDeliveryMap } from '../lib/modules/delivery-planning/runs.ts';
import { startWhatToDoRun } from '../lib/modules/delivery-planning/runs.ts';
import { createCanonicalizer } from './helpers/graph-materialization-golden.ts';
import {
  controlled,
  fixture,
  input,
  replacementResult,
  result,
  retainedResult,
  settled,
} from './helpers/what-to-do-fixture.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

const GOLDENS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/materialization/delivery-map',
);
const UPDATE = process.env.PRAXIS_UPDATE_GOLDENS === '1';

const CAPTURED = /(?:^|\/)(?:current-map\.json|output\.md)$/;

async function tree(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  )) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await tree(root, next)));
    else files.push(next);
  }
  return files;
}

async function captureDeliveryState(project: RegisteredProject) {
  const canonicalize = createCanonicalizer();
  const root = path.join(project.planningPath, 'what-to-do');
  const files: Array<{ key: string; text: string }> = [];
  for (const relative of await tree(root)) {
    if (!CAPTURED.test(relative)) continue;
    files.push({
      key: `what-to-do/${relative}`,
      text: await readFile(path.join(root, relative), 'utf8'),
    });
  }
  const map = files.find((file) => file.key.endsWith('/current-map.json'));
  if (map) canonicalize(map.text);
  const captured: Record<string, unknown> = {};
  for (const file of [...files].sort((left, right) =>
    canonicalize(left.key).localeCompare(canonicalize(right.key), 'en'),
  )) {
    captured[canonicalize(file.key)] = file.key.endsWith('.json')
      ? JSON.parse(canonicalize(file.text))
      : canonicalize(file.text);
  }
  return captured;
}

async function assertGolden(name: string, captured: Record<string, unknown>) {
  const file = path.join(GOLDENS, `${name}.json`);
  if (UPDATE) {
    await mkdir(GOLDENS, { recursive: true });
    await writeFile(file, `${JSON.stringify(captured, null, 2)}\n`);
    return;
  }
  const expected = await readFile(file, 'utf8').catch(() => null);
  assert.ok(
    expected !== null,
    `missing golden ${name}; regenerate with PRAXIS_UPDATE_GOLDENS=1`,
  );
  assert.deepEqual(captured, JSON.parse(expected));
}

async function settleRun(
  project: RegisteredProject,
  control: ReturnType<typeof controlled>,
  runInput: Parameters<typeof startWhatToDoRun>[1],
  build: (run: Awaited<ReturnType<typeof startWhatToDoRun>>) => unknown,
) {
  const call = control.calls.length;
  const run = await startWhatToDoRun(project, runInput, control.transport);
  control.calls[call]!.resolve({
    agentSessionId: `session-${call + 1}`,
    finalOutput: JSON.stringify(build(run)),
    usage: null,
  });
  const completed = await settled(project, run.id);
  assert.equal(completed.status, 'succeeded', completed.error ?? undefined);
  assert.ok(completed.map);
  return completed;
}

void test('a created Delivery Map publishes its Contracts and their output', async (t) => {
  const { project } = await fixture(t);
  const control = controlled();
  const created = await settleRun(project, control, input(), result);
  await publishDeliveryMap(project, created.map!);
  await assertGolden('create-map', await captureDeliveryState(project));
});

void test('a retained Contract keeps its identity across an adjusted Map', async (t) => {
  const { project } = await fixture(t);
  const control = controlled();
  const created = await settleRun(project, control, input(), result);
  await publishDeliveryMap(project, created.map!);
  const adjusted = await settleRun(
    project,
    control,
    { ...input(), sourceUids: [] },
    (run) => retainedResult(run, created.map!),
  );
  await publishDeliveryMap(project, adjusted.map!);
  assert.equal(adjusted.map!.contracts[0]!.id, created.map!.contracts[0]!.id);
  await assertGolden('retain-contract', await captureDeliveryState(project));
});

void test('a replaced Contract supersedes the previous one', async (t) => {
  const { project } = await fixture(t);
  const control = controlled();
  const created = await settleRun(project, control, input(), result);
  const firstResult = result(created);
  await publishDeliveryMap(project, created.map!);
  const replaced = await settleRun(
    project,
    control,
    { ...input(), sourceUids: [] },
    (run) => replacementResult(run, created.map!, firstResult),
  );
  await publishDeliveryMap(project, replaced.map!);
  assert.notEqual(
    replaced.map!.contracts[0]!.id,
    created.map!.contracts[0]!.id,
  );
  await assertGolden('replace-contract', await captureDeliveryState(project));
});
