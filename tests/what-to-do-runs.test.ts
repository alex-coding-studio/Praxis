import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { WHAT_TO_DO_HARNESS_REVISION } from '../lib/modules/delivery-planning/harness.ts';
import {
  cancelWhatToDoRun,
  listLatestWhatToDoRuns,
  readWhatToDoRun,
  startWhatToDoRun,
  whatToDoAgentEnvironment,
} from '../lib/modules/delivery-planning/runs.ts';
import { publishDeliveryMap } from '../lib/modules/delivery-planning/publish.ts';
import { deliveryPublicationHost } from '../lib/modules/delivery-planning/publication-host.ts';
import { readWhatToDoCurrentMap } from '../lib/modules/delivery-planning/storage.ts';
import { readWhatToDoRunDraft } from '../lib/modules/delivery-planning/run-draft.ts';
import { planningService } from '../lib/modules/implementation/planning-service.ts';
import { appendCardWorkRecord } from '../lib/modules/implementation/worklog.ts';

import {
  clarificationResult,
  featureUid,
  controlled,
  fixture,
  input,
  replacementResult,
  result,
  retainedResult,
  settled,
} from './helpers/what-to-do-fixture.ts';

void test('What to Do Agent environment excludes unrelated credentials', () => {
  assert.deepEqual(
    whatToDoAgentEnvironment({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      GH_TOKEN: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
    }),
    { PATH: '/usr/bin', HOME: '/tmp/home' },
  );
});

void test('a real What to Do Run persists the frozen request and Agent result', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const run = await startWhatToDoRun(project, input(), control.transport);
  assert.equal(run.status, 'running');
  assert.equal(control.calls.length, 1);
  assert.equal(control.calls[0]!.agent, 'codex');
  assert.equal(control.calls[0]!.input.access, 'read-only');
  assert.equal(control.calls[0]!.input.disableDelegation, true);
  assert.equal(control.calls[0]!.input.model, 'gpt-5.6-luna');
  assert.equal(control.calls[0]!.input.effort, 'high');
  assert.equal(control.calls[0]!.input.environment?.GH_TOKEN, undefined);
  assert.match(control.calls[0]!.input.prompt, /praxis\.what-to-do/);
  assert.match(control.calls[0]!.input.prompt, /OUTPUT SCHEMA/);
  await assert.rejects(
    startWhatToDoRun(project, input(), control.transport),
    /already active/,
  );

  control.calls[0]!.resolve({
    agentSessionId: 'agent-session-1',
    finalOutput: JSON.stringify(result(run)),
    usage: null,
  });
  const completed = await settled(project, run.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result?.outcome, 'map-proposal');
  assert.equal(completed.map?.contracts.length, 1);
  assert.match(completed.map?.contracts[0]?.id ?? '', /^NODE-[0-9a-f]{8,32}$/);
  assert.equal('candidateId' in completed.map!.contracts[0]!, false);
  assert.equal(completed.agentSessionId, 'agent-session-1');
  const runPath = path.join(planningPath, 'what-to-do/runs', run.id);
  assert.match(
    await readFile(path.join(runPath, 'summary.md'), 'utf8'),
    /1 Contract/,
  );
  assert.match(
    await readFile(path.join(runPath, 'response.md'), 'utf8'),
    /ready for review/,
  );
  assert.match(
    await readFile(
      path.join(planningPath, completed.map!.contracts[0]!.outputPath),
      'utf8',
    ),
    /Deliver accepted behavior/,
  );
  assert.deepEqual(
    (await listLatestWhatToDoRuns(project)).map((item) => item.id),
    [run.id],
  );
  const currentSummary = await readFile(
    path.join(planningPath, 'what-to-do/repository-context/summary.md'),
    'utf8',
  );
  assert.match(currentSummary, new RegExp(run.request.repository.fingerprint));
});

void test('a Clarification Answer amends the frozen request and resumes its Session', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const firstInput = {
    ...input(),
    instruction:
      'Create delivery boundaries and later build Design Tokens from the supplied Design.',
    files: [new File(['# Original design note\n'], 'original.md')],
  };
  const first = await startWhatToDoRun(project, firstInput, control.transport);
  control.calls[0]!.resolve({
    agentSessionId: 'clarification-session',
    finalOutput: JSON.stringify(clarificationResult(first)),
    usage: null,
  });
  const clarification = await settled(project, first.id);
  assert.equal(clarification.result?.outcome, 'clarification');

  const featureOutput = path.join(
    planningPath,
    'whats-next/nodes/NODE-00000001/output.md',
  );
  await writeFile(featureOutput, '# Accepted Feature\n\nChanged meaning.\n');
  await assert.rejects(
    startWhatToDoRun(
      project,
      {
        ...input(),
        instruction: 'Use iOS 26.',
        clarificationRunId: first.id,
        sourceUids: [],
      },
      control.transport,
    ),
    /frozen Clarification Context changed/,
  );
  await writeFile(
    featureOutput,
    '# Accepted Feature\n\n## Behavior\n\nDeliver this behavior.\n',
  );

  const second = await startWhatToDoRun(
    project,
    {
      ...input(),
      instruction: 'Use iOS 26.',
      clarificationRunId: first.id,
      sourceUids: [],
      files: [new File(['# New evidence\n'], 'new.md')],
    },
    control.transport,
  );

  assert.equal(second.clarificationRunId, first.id);
  assert.equal(
    second.request.request.sessionId,
    first.request.request.sessionId,
  );
  assert.equal(
    control.calls[1]!.input.resumeSessionId,
    'clarification-session',
  );
  assert.deepEqual(second.sourceUids, [featureUid]);
  assert.deepEqual(second.attachmentNames, ['original.md', 'new.md']);
  const inputEntry = second.request.content.input!;
  const amendedInput = await readFile(
    path.join(
      planningPath,
      'what-to-do/runs',
      second.id,
      'context',
      inputEntry.workspacePath,
    ),
    'utf8',
  );
  assert.match(amendedInput, /later build Design Tokens/);
  assert.match(amendedInput, /Which deployment target/);
  assert.match(amendedInput, /Use iOS 26\./);
  assert.ok(
    amendedInput.indexOf('later build Design Tokens') <
      amendedInput.indexOf('Use iOS 26.'),
  );
  assert.deepEqual(
    (await readWhatToDoRunDraft(project, second)).files.map(
      (file) => file.name,
    ),
    ['original.md', 'new.md'],
  );
  await cancelWhatToDoRun(project, second.id);
  control.calls[1]!.reject(new Error('canceled'));
});

void test('a legacy Clarification keeps frozen Context but starts a current Harness Session', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const first = await startWhatToDoRun(project, input(), control.transport);
  control.calls[0]!.resolve({
    agentSessionId: 'legacy-session',
    finalOutput: JSON.stringify(clarificationResult(first)),
    usage: null,
  });
  const clarification = await settled(project, first.id);
  const runPath = path.join(
    planningPath,
    'what-to-do/runs',
    clarification.id,
    'run.json',
  );
  await writeFile(
    runPath,
    `${JSON.stringify(
      {
        ...clarification,
        request: {
          ...clarification.request,
          harness: { ...clarification.request.harness, revision: 1 },
        },
        result: {
          ...clarification.result,
          harness: { ...clarification.result!.harness, revision: 1 },
        },
      },
      null,
      2,
    )}\n`,
  );

  const continued = await startWhatToDoRun(
    project,
    {
      ...input(),
      instruction: 'Use the recommended option.',
      clarificationRunId: first.id,
      sourceUids: [],
    },
    control.transport,
  );

  assert.equal(control.calls[1]!.input.resumeSessionId, undefined);
  assert.equal(continued.request.harness.revision, WHAT_TO_DO_HARNESS_REVISION);
  assert.equal(
    continued.request.request.sessionId,
    first.request.request.sessionId,
  );
  const draft = await readWhatToDoRunDraft(project, continued);
  assert.match(draft.instruction, /Turn this accepted design/);
  assert.match(draft.instruction, /Use the recommended option/);
  await cancelWhatToDoRun(project, continued.id);
  control.calls[1]!.reject(new Error('canceled'));
});

void test('the current formal Map is default Context and focus is optional emphasis', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const first = await startWhatToDoRun(project, input(), control.transport);
  control.calls[0]!.resolve({
    agentSessionId: 'agent-session-1',
    finalOutput: JSON.stringify(result(first)),
    usage: null,
  });
  const completed = await settled(project, first.id);
  const contract = completed.map!.contracts[0]!;
  const second = await startWhatToDoRun(
    project,
    {
      ...input(),
      sourceUids: [],
      focusContractIds: [contract.id],
    },
    control.transport,
  );
  assert.equal(
    second.request.request.sessionId,
    first.request.request.sessionId,
  );
  assert.equal(control.calls[1]!.input.resumeSessionId, 'agent-session-1');
  assert.deepEqual(second.request.sourceFeatures, []);
  assert.equal(
    second.request.content.references.some(
      (entry) =>
        entry.kind === 'delivery-contract' ||
        entry.kind === 'delivery-map-source',
    ),
    false,
  );
  const mapEntry = second.request.content.references.find(
    (entry) => entry.kind === 'delivery-map',
  );
  assert.ok(mapEntry);
  const promptMap = await readFile(
    path.join(
      planningPath,
      'what-to-do/runs',
      second.id,
      'context',
      mapEntry.workspacePath,
    ),
    'utf8',
  );
  assert.doesNotMatch(promptMap, /"anchor"|"sourceSha256"/);
  assert.equal(second.request.operation, 'adjust-map');
  assert.deepEqual(second.request.focusCandidateIds, [
    `CANDIDATE-${contract.id.slice(5)}`,
  ]);
  control.calls[1]!.resolve({
    agentSessionId: 'agent-session-2',
    finalOutput: JSON.stringify(retainedResult(second, completed.map!)),
    usage: null,
  });
  const adjusted = await settled(project, second.id);
  assert.equal(adjusted.status, 'succeeded');
  assert.equal(adjusted.map?.contracts[0]?.id, contract.id);
  assert.equal(adjusted.map?.contracts[0]?.uid, contract.uid);
  assert.equal((await readWhatToDoCurrentMap(project))?.runId, second.id);
  assert.deepEqual(await listLatestWhatToDoRuns(project, 0), []);
  assert.equal(
    (await readWhatToDoCurrentMap(project))?.contracts[0]?.id,
    contract.id,
  );
  const changedProfile = await startWhatToDoRun(
    project,
    {
      ...input(),
      sourceUids: [],
      profile: { ...input().profile, model: 'gpt-5.6-sol' },
    },
    control.transport,
  );
  assert.notEqual(
    changedProfile.request.request.sessionId,
    second.request.request.sessionId,
  );
  assert.equal(control.calls[2]!.input.resumeSessionId, undefined);
  await cancelWhatToDoRun(project, changedProfile.id);
  control.calls[2]!.reject(new Error('canceled'));
  await assert.rejects(
    startWhatToDoRun(project, input(), control.transport),
    /already part of the current Delivery Map/,
  );
});

void test('a dependency-only Map update reports the retained Contract change', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const first = await startWhatToDoRun(project, input(), control.transport);
  control.calls[0]!.resolve({
    agentSessionId: 'agent-session-1',
    finalOutput: JSON.stringify(result(first)),
    usage: null,
  });
  const completed = await settled(project, first.id);
  const candidateId = `CANDIDATE-${completed.map!.contracts[0]!.id.slice(5)}`;
  const second = await startWhatToDoRun(
    project,
    { ...input(), sourceUids: [] },
    control.transport,
  );
  control.calls[1]!.resolve({
    agentSessionId: 'agent-session-2',
    finalOutput: JSON.stringify({
      ...retainedResult(second, completed.map!),
      contractDependencyUpdates: [{ candidateId, dependsOn: [] }],
    }),
    usage: null,
  });
  const adjusted = await settled(project, second.id);

  assert.equal(adjusted.status, 'succeeded');
  assert.match(
    await readFile(
      path.join(planningPath, 'what-to-do/runs', second.id, 'summary.md'),
      'utf8',
    ),
    /Applied 1 Contract changes: 0 new or replacement boundaries and 1 dependency-only updates/,
  );
});

void test('Map replacement and Contract import leave no deletable stale Card', async (t) => {
  const { project } = await fixture(t);
  const control = controlled();
  const first = await startWhatToDoRun(project, input(), control.transport);
  const firstResult = result(first);
  control.calls[0]!.resolve({
    agentSessionId: 'agent-session-1',
    finalOutput: JSON.stringify(firstResult),
    usage: null,
  });
  const completed = await settled(project, first.id);
  const contract = completed.map!.contracts[0]!;
  await planningService.importSource(project, 'what-to-do', contract.uid);
  const second = await startWhatToDoRun(
    project,
    { ...input(), sourceUids: [], focusContractIds: [contract.id] },
    control.transport,
  );
  control.calls[1]!.resolve({
    agentSessionId: 'agent-session-2',
    finalOutput: JSON.stringify(
      replacementResult(second, completed.map!, firstResult),
    ),
    usage: null,
  });
  const repeatedImport = planningService
    .importSource(project, 'what-to-do', contract.uid)
    .then(
      () => 'imported',
      () => 'rejected',
    );
  const adjusted = await settled(project, second.id);
  await repeatedImport;
  assert.equal(adjusted.status, 'succeeded');
  assert.notEqual(adjusted.map?.contracts[0]?.uid, contract.uid);
  await assert.rejects(
    planningService.read(project, contract.uid),
    /not found/,
  );
});

void test('a staged Card transition failure restores the prior Map and Cards', async (t) => {
  const { project } = await fixture(t);
  const control = controlled();
  const first = await startWhatToDoRun(project, input(), control.transport);
  control.calls[0]!.resolve({
    agentSessionId: 'agent-session-1',
    finalOutput: JSON.stringify(result(first)),
    usage: null,
  });
  const completed = await settled(project, first.id);
  const contract = completed.map!.contracts[0]!;
  const card = await planningService.importSource(
    project,
    'what-to-do',
    contract.uid,
  );
  const secondCard = {
    ...card,
    id: '11111111-1111-4111-8111-111111111111',
    source: {
      ...card.source,
      uid: '11111111-1111-4111-8111-111111111111',
    },
  };
  let transitionCount = 0;
  await assert.rejects(
    publishDeliveryMap(
      project,
      {
        ...completed.map!,
        runId: 'RUN-22222222-2222-4222-8222-222222222222',
        contracts: [],
      },
      {
        ...deliveryPublicationHost,
        list: async () => [card, secondCard],
        stageDeleteCard: async (targetProject, cardId, revision) => {
          transitionCount += 1;
          if (transitionCount === 2)
            throw new Error('Injected Card transition failure.');
          return planningService.stageDeleteCard(
            targetProject,
            cardId,
            revision,
          );
        },
      },
    ),
    /Injected Card transition failure/,
  );
  assert.equal((await readWhatToDoCurrentMap(project))?.runId, first.id);
  assert.equal((await planningService.read(project, card.id)).id, card.id);
});

void test('Map replacement is blocked by a Contract Card with a confirmed Plan', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const first = await startWhatToDoRun(project, input(), control.transport);
  const firstResult = result(first);
  control.calls[0]!.resolve({
    agentSessionId: 'agent-session-1',
    finalOutput: JSON.stringify(firstResult),
    usage: null,
  });
  const completed = await settled(project, first.id);
  const contract = completed.map!.contracts[0]!;
  const card = await planningService.importSource(
    project,
    'what-to-do',
    contract.uid,
  );
  const protectedCard = {
    ...card,
    revision: card.revision + 1,
    plan: { status: 'finalized' as const, overview: 'Confirmed.', steps: [] },
    finalizedAt: '2026-09-02T01:00:00.000Z',
  };
  await appendCardWorkRecord(
    path.join(planningPath, 'implementation/cards'),
    card.id,
    card.revision,
    {
      kind: 'system-event',
      stage: 'planning',
      actionId: null,
      event: 'plan-finalized',
      text: 'The Plan was confirmed for this test.',
      refs: [],
    },
    { 'planning-state.json': JSON.stringify(protectedCard) },
  );
  const second = await startWhatToDoRun(
    project,
    { ...input(), sourceUids: [], focusContractIds: [contract.id] },
    control.transport,
  );
  control.calls[1]!.resolve({
    agentSessionId: 'agent-session-2',
    finalOutput: JSON.stringify(
      replacementResult(second, completed.map!, firstResult),
    ),
    usage: null,
  });
  const adjusted = await settled(project, second.id);
  assert.equal(adjusted.status, 'failed');
  assert.match(adjusted.error ?? '', /already in progress/);
  assert.equal((await readWhatToDoCurrentMap(project))?.runId, first.id);
  assert.equal(
    (await planningService.read(project, contract.uid)).plan?.status,
    'finalized',
  );
});

void test('a committed current Map completes an interrupted terminal Run publication', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const run = await startWhatToDoRun(project, input(), control.transport);
  control.calls[0]!.resolve({
    agentSessionId: 'agent-session-1',
    finalOutput: JSON.stringify(result(run)),
    usage: null,
  });
  const completed = await settled(project, run.id);
  await new Promise((resolve) => setImmediate(resolve));
  const directory = path.join(planningPath, 'what-to-do/runs', run.id);
  await writeFile(
    path.join(directory, 'run.json'),
    `${JSON.stringify(
      {
        ...completed,
        status: 'running',
        endedAt: null,
        result: null,
        map: null,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(directory, 'terminal.json'),
    `${JSON.stringify(completed, null, 2)}\n`,
  );
  const successor = await startWhatToDoRun(
    project,
    { ...input(), sourceUids: [] },
    control.transport,
  );
  const recovered = await readWhatToDoRun(project, run.id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.map?.runId, run.id);
  await assert.rejects(
    readFile(path.join(directory, 'terminal.json')),
    /ENOENT/,
  );
  await cancelWhatToDoRun(project, successor.id);
  control.calls[1]!.reject(new Error('canceled'));
});

void test('an uncommitted terminal record rolls back to an interrupted Run', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const run = await startWhatToDoRun(project, input(), control.transport);
  control.calls[0]!.resolve({
    agentSessionId: 'agent-session-1',
    finalOutput: JSON.stringify(result(run)),
    usage: null,
  });
  const completed = await settled(project, run.id);
  await new Promise((resolve) => setImmediate(resolve));
  const directory = path.join(planningPath, 'what-to-do/runs', run.id);
  await rm(path.join(planningPath, 'what-to-do/current-map.json'));
  await writeFile(
    path.join(directory, 'run.json'),
    `${JSON.stringify(
      {
        ...completed,
        status: 'running',
        endedAt: null,
        result: null,
        map: null,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(directory, 'terminal.json'),
    `${JSON.stringify(completed, null, 2)}\n`,
  );
  const recovered = await readWhatToDoRun(project, run.id);
  assert.equal(recovered.status, 'failed');
  assert.match(recovered.error ?? '', /interrupted/);
  await assert.rejects(
    readFile(path.join(directory, 'terminal.json')),
    /ENOENT/,
  );
});

void test('invalid Agent output fails while preserving the raw response', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const run = await startWhatToDoRun(
    project,
    {
      ...input(),
      files: [new File(['# Retry evidence\n'], 'retry-evidence.md')],
    },
    control.transport,
  );
  control.calls[0]!.resolve({
    agentSessionId: null,
    finalOutput: '{"not":"a delivery map"}',
    usage: null,
  });
  const failed = await settled(project, run.id);
  assert.equal(failed.status, 'failed');
  assert.match(
    await readFile(
      path.join(planningPath, 'what-to-do/runs', run.id, 'agent-output.txt'),
      'utf8',
    ),
    /not.*delivery map/,
  );
  assert.deepEqual(await readWhatToDoRunDraft(project, failed), {
    instruction: input().instruction,
    files: [
      {
        name: 'retry-evidence.md',
        mediaType: 'text/markdown',
        content: '# Retry evidence\n',
      },
    ],
  });
});

void test('cancel releases the project and rejects late completion', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const run = await startWhatToDoRun(project, input(), control.transport);
  control.calls[0]!.lateOutput = JSON.stringify(result(run));
  const canceled = await cancelWhatToDoRun(project, run.id);
  assert.equal(canceled.status, 'canceled');
  assert.match(
    await readFile(
      path.join(planningPath, 'what-to-do/runs', run.id, 'response.md'),
      'utf8',
    ),
    /canceled/,
  );
  assert.equal(control.calls[0]!.canceled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await readWhatToDoRun(project, run.id)).status, 'canceled');
  assert.equal(await readWhatToDoCurrentMap(project), null);
  const retry = await startWhatToDoRun(project, input(), control.transport);
  assert.equal(retry.status, 'running');
  await cancelWhatToDoRun(project, retry.id);
  control.calls[1]!.reject(new Error('canceled'));
});

void test('an orphaned running record is persisted as interrupted once', async (t) => {
  const { project, planningPath } = await fixture(t);
  const control = controlled();
  const run = await startWhatToDoRun(project, input(), control.transport);
  control.calls[0]!.resolve({
    agentSessionId: null,
    finalOutput: JSON.stringify(result(run)),
    usage: null,
  });
  const completed = await settled(project, run.id);
  await new Promise((resolve) => setImmediate(resolve));
  const runFile = path.join(
    planningPath,
    'what-to-do/runs',
    run.id,
    'run.json',
  );
  await writeFile(
    runFile,
    `${JSON.stringify(
      {
        ...completed,
        status: 'running',
        endedAt: null,
        result: null,
      },
      null,
      2,
    )}\n`,
  );
  const recovered = await readWhatToDoRun(project, run.id);
  assert.equal(recovered.status, 'failed');
  assert.match(recovered.error ?? '', /interrupted/);
  const persisted = JSON.parse(await readFile(runFile, 'utf8'));
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.endedAt, recovered.endedAt);
  assert.match(
    await readFile(path.join(path.dirname(runFile), 'summary.md'), 'utf8'),
    /Interrupted/,
  );
  assert.match(
    await readFile(path.join(path.dirname(runFile), 'response.md'), 'utf8'),
    /Interrupted/,
  );
  assert.doesNotMatch(
    await readFile(path.join(path.dirname(runFile), 'response.md'), 'utf8'),
    /ready for review/,
  );
});
