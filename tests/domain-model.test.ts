import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyProposedDomainModel,
  readDomainModel,
  readDomainModelView,
  undoLastDomainModelChange,
  type ProposedDomainModel,
} from '../lib/modules/domain-modeling/model.ts';
import {
  deriveDomainRelationships,
  domainModelTopologyKey,
} from '../lib/modules/domain-modeling/view.ts';
import {
  createDomainModelRequest,
  domainModelPrompt,
  parseDomainModelEnvelope,
  type DomainModelRequest,
} from '../lib/modules/domain-modeling/harness.ts';
import {
  cancelDomainModelRun,
  canContinueDomainModelSession,
  readDomainModelRun,
  startDomainModelRun,
} from '../lib/modules/domain-modeling/runs.ts';
import { toDomainModelSemanticResult } from '../lib/modules/domain-modeling/producer-adapter.ts';
import { composeDomainModel } from '../lib/modules/domain-modeling/materializer.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';
import type { startLocalAgentRun } from '../lib/agents/transport.ts';
import {
  readDomainModelInstructions,
  saveDomainModelInstructions,
} from '../lib/modules/domain-modeling/context.ts';

function composedResult(raw: string, request: DomainModelRequest) {
  const semantic = toDomainModelSemanticResult(
    parseDomainModelEnvelope(raw, request),
  );
  return semantic.outcome === 'model-change'
    ? {
        outcome: 'applied' as const,
        summary: semantic.summary,
        model: composeDomainModel(request.model, semantic),
      }
    : semantic;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'domain-model-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project: RegisteredProject = {
    id: 'domain-fixture',
    kind: 'standalone',
    name: 'Domain fixture',
    description: '',
    rootPath,
    codePath: null,
    planningPath: path.join(rootPath, '.praxis'),
    createdAt: '',
  };
  await mkdir(project.planningPath);
  return project;
}

function initialProposal(): ProposedDomainModel {
  return {
    entities: [
      {
        id: 'NEW_ENTITY_ITEM',
        name: 'Item',
        meaning: 'A physical thing the user wants to locate.',
        provenance: 'explicit',
        fields: [
          {
            id: 'NEW_FIELD_TITLE',
            name: 'title',
            meaning: 'The name shown to the user.',
            valueType: 'text',
            required: true,
            multiple: false,
            display: 'primary',
            provenance: 'explicit',
          },
        ],
      },
      {
        id: 'NEW_ENTITY_CONTAINER',
        name: 'Container',
        meaning: 'An Item that can manage child Items.',
        provenance: 'explicit',
        fields: [],
      },
    ],
    relationships: [
      {
        id: 'NEW_RELATIONSHIP_IS_A',
        sourceEntityId: 'NEW_ENTITY_CONTAINER',
        targetEntityId: 'NEW_ENTITY_ITEM',
        label: 'is a',
        meaning: 'Container shares Item identity and fields.',
        semanticRole: 'inheritance',
        direction: 'directed',
        sourceCardinality: '1',
        targetCardinality: '1',
        provenance: 'explicit',
      },
      {
        id: 'NEW_RELATIONSHIP_CONTAINS',
        sourceEntityId: 'NEW_ENTITY_CONTAINER',
        targetEntityId: 'NEW_ENTITY_ITEM',
        label: 'contains',
        meaning: 'A Container manages zero or more Items.',
        semanticRole: 'containment',
        direction: 'directed',
        sourceCardinality: '1',
        targetCardinality: '0..*',
        provenance: 'explicit',
      },
    ],
    constraints: [
      {
        id: 'NEW_CONSTRAINT_PARENT',
        target: { kind: 'model', id: null },
        text: 'An Item has at most one parent Container.',
        provenance: 'inferred',
      },
    ],
  };
}

void test('an applied model allocates stable identities and derives self-containment', async (t) => {
  const project = await fixture(t);
  const applied = await applyProposedDomainModel(project, {
    baseVersion: 0,
    runId: 'RUN-11111111-1111-4111-8111-111111111111',
    instruction: 'A Container is an Item and contains Items.',
    summary: 'Created Item and Container.',
    proposed: initialProposal(),
  });
  assert.equal(applied.canUndo, true);
  assert.equal(applied.model.stateVersion, 1);
  assert.deepEqual(
    applied.model.entities.map((item) => item.name),
    ['Item', 'Container'],
  );
  assert.ok(
    applied.model.entities.every((item) => item.id.startsWith('ENTITY-')),
  );
  assert.ok(
    applied.model.relationships.every(
      (item) =>
        item.id.startsWith('RELATIONSHIP-') &&
        applied.model.entities.some(
          (entity) => entity.id === item.sourceEntityId,
        ) &&
        applied.model.entities.some(
          (entity) => entity.id === item.targetEntityId,
        ),
    ),
  );
  const derived = deriveDomainRelationships(applied.model);
  assert.equal(derived.length, 1);
  assert.equal(derived[0].sourceEntityId, derived[0].targetEntityId);
  assert.equal(derived[0].label, 'contains');
  assert.equal(derived[0].provenance, 'derived');
  assert.equal(
    derived[0].meaning,
    'Container is a Item · Container contains Item',
  );
  assert.doesNotMatch(derived[0].meaning, /ENTITY-/);
  assert.deepEqual(
    new Set(derived[0].derivedFrom),
    new Set(applied.model.relationships.map((item) => item.id)),
  );
  assert.ok(applied.change);
  assert.ok(applied.change.added.length >= 6);
  assert.deepEqual(
    applied.change.items?.added
      .filter((item) => item.kind === 'card')
      .map((item) => item.label),
    ['Item', 'Container'],
  );
  assert.equal(applied.change.items?.added.length, applied.change.added.length);
  await assert.rejects(
    () =>
      applyProposedDomainModel(project, {
        baseVersion: applied.model.stateVersion,
        runId: 'RUN-22222222-2222-4222-8222-222222222222',
        instruction: 'Add an unclear relationship.',
        summary: 'Should not persist.',
        proposed: {
          entities: structuredClone(applied.model.entities),
          relationships: [
            ...structuredClone(applied.model.relationships),
            {
              id: 'NEW_RELATIONSHIP_UNCLEAR',
              sourceEntityId: applied.model.entities[0]!.id,
              targetEntityId: applied.model.entities[1]!.id,
              label: 'has',
              meaning: 'An intentionally unclear relationship.',
              semanticRole: 'association',
              direction: 'directed',
              sourceCardinality: '1',
              targetCardinality: '0..*',
              provenance: 'inferred',
            },
          ],
          constraints: structuredClone(applied.model.constraints),
        },
      }),
    /standalone product noun phrase/,
  );
});

void test('the Domain Model Harness composes one incremental patch', () => {
  const proposal = initialProposal();
  const current = {
    schemaVersion: 1 as const,
    stateVersion: 4,
    ...proposal,
    entities: [
      {
        ...proposal.entities[0]!,
        fields: [
          ...proposal.entities[0]!.fields,
          {
            ...proposal.entities[0]!.fields[0]!,
            id: 'NEW_FIELD_NOTE',
            name: 'note',
          },
        ],
      },
      proposal.entities[1]!,
    ],
    lastRunId: 'RUN-current',
    updatedAt: '2026-09-03T00:00:00.000Z',
  };
  const request = createDomainModelRequest({
    requestId: 'RUN-22222222-2222-4222-8222-222222222222',
    content: { input: null, references: [], external: [] },
    selectedIds: [current.entities[0]!.id],
    model: current,
    previousSummary: 'Current model.',
  });
  const updatedItem = {
    ...structuredClone(current.entities[0]!),
    meaning: 'A physical thing with a durable identity.',
  };
  const output = {
    harnessVersion: 2,
    requestId: request.requestId,
    baseVersion: request.baseVersion,
    inputFingerprint: request.inputFingerprint,
    outcome: 'applied',
    summary: 'Clarified Item identity.',
    patch: {
      upsertEntities: [updatedItem],
      removeEntityIds: [],
      removeFieldIds: [],
      upsertRelationships: [],
      removeRelationshipIds: [],
      upsertConstraints: [],
      removeConstraintIds: [],
    },
  };

  const result = composedResult(JSON.stringify(output), request);

  assert.equal(result.outcome, 'applied');
  if (result.outcome === 'applied') {
    assert.equal(result.model.entities.length, 2);
    assert.equal(result.model.entities[0]!.meaning, updatedItem.meaning);
    assert.equal(
      result.model.entities[1]!.meaning,
      current.entities[1]!.meaning,
    );
    assert.deepEqual(result.model.relationships, current.relationships);
    assert.deepEqual(result.model.constraints, current.constraints);
  }
  assert.match(domainModelPrompt(request), /return only a patch/i);
  assert.match(domainModelPrompt(request), /omit every unchanged Entity/i);
  assert.throws(
    () =>
      composedResult(
        JSON.stringify({ ...output, model: initialProposal() }),
        request,
      ),
    /exactly one model or patch/,
  );
  assert.throws(
    () =>
      composedResult(
        JSON.stringify({
          ...output,
          patch: {
            ...output.patch,
            upsertEntities: [
              { ...updatedItem, fields: updatedItem.fields.slice(0, 1) },
            ],
          },
        }),
        request,
      ),
    /preserve every Field/,
  );
  const removedField = composedResult(
    JSON.stringify({
      ...output,
      patch: {
        ...output.patch,
        upsertEntities: [
          { ...updatedItem, fields: updatedItem.fields.slice(0, 1) },
        ],
        removeFieldIds: [updatedItem.fields[1]!.id],
      },
    }),
    request,
  );
  assert.equal(removedField.outcome, 'applied');
  if (removedField.outcome === 'applied')
    assert.equal(removedField.model.entities[0]!.fields.length, 1);
  assert.throws(
    () =>
      composedResult(
        JSON.stringify({
          ...output,
          patch: {
            ...output.patch,
            upsertEntities: [
              {
                ...proposal.entities[1]!,
                id: 'NEW_ENTITY_ARCHIVE',
                name: 'Archive',
                fields: [updatedItem.fields[1]!],
              },
            ],
            removeFieldIds: [updatedItem.fields[1]!.id],
          },
        }),
        request,
      ),
    /updated and removed together/,
  );
  assert.throws(
    () =>
      composedResult(
        JSON.stringify({
          ...output,
          patch: undefined,
          model: {
            entities: [updatedItem],
            relationships: current.relationships,
            constraints: current.constraints,
          },
        }),
        request,
      ),
    /cannot omit an existing Entity/,
  );
});

void test('Domain Model continuation uses the provider Session and a compact model index', async (t) => {
  const project = await fixture(t);
  const calls: Parameters<typeof startLocalAgentRun>[1][] = [];
  const transport: typeof startLocalAgentRun = (_agent, options) => {
    calls.push(options);
    const request = JSON.parse(
      options.prompt.split('\nREQUEST:\n')[1],
    ) as DomainModelRequest;
    return {
      completion: Promise.resolve({
        agentSessionId: `fixture-session-${calls.length}`,
        usage: null,
        finalOutput: JSON.stringify(
          calls.length === 1
            ? {
                harnessVersion: 2,
                requestId: request.requestId,
                baseVersion: request.baseVersion,
                inputFingerprint: request.inputFingerprint,
                outcome: 'applied',
                summary: 'Created Item and Container.',
                model: initialProposal(),
              }
            : {
                harnessVersion: 2,
                requestId: request.requestId,
                baseVersion: request.baseVersion,
                inputFingerprint: request.inputFingerprint,
                outcome: 'no-change',
                summary: 'The model already contains this meaning.',
                reason: 'No model change is required.',
              },
        ),
      }),
      cancel: () => {},
    };
  };
  const profile = {
    agent: 'codex' as const,
    model: 'gpt-5.6-sol',
    effort: 'high' as const,
  };
  const first = await startDomainModelRun(
    project,
    { instruction: 'Create the model.', selectedIds: [], profile },
    transport,
  );
  let firstTerminal = await readDomainModelRun(project, first.id);
  for (
    let attempt = 0;
    firstTerminal.status === 'running' && attempt < 30;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    firstTerminal = await readDomainModelRun(project, first.id);
  }
  assert.equal(firstTerminal.status, 'succeeded');
  const model = await readDomainModel(project);
  assert.equal(
    canContinueDomainModelSession(firstTerminal, model, profile),
    true,
  );
  assert.equal(
    canContinueDomainModelSession(firstTerminal, model, {
      ...profile,
      model: 'gpt-5.6-luna',
    }),
    false,
  );

  const second = await startDomainModelRun(
    project,
    { instruction: 'Keep the current meaning.', selectedIds: [], profile },
    transport,
  );

  assert.equal(calls[1]!.resumeSessionId, 'fixture-session-1');
  const continuedRequest = JSON.parse(
    calls[1]!.prompt.split('\nREQUEST:\n')[1],
  ) as DomainModelRequest;
  assert.equal('meaning' in continuedRequest.model.entities[0]!, false);
  let secondTerminal = await readDomainModelRun(project, second.id);
  for (
    let attempt = 0;
    secondTerminal.status === 'running' && attempt < 30;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    secondTerminal = await readDomainModelRun(project, second.id);
  }
  assert.equal(secondTerminal.status, 'succeeded');
});

void test('an empty applied result preserves the one available undo', async (t) => {
  const project = await fixture(t);
  const first = await applyProposedDomainModel(project, {
    baseVersion: 0,
    runId: 'RUN-11111111-1111-4111-8111-111111111111',
    instruction: 'Create Item and Container.',
    summary: 'Initial model.',
    proposed: initialProposal(),
  });
  const repeated = await applyProposedDomainModel(project, {
    baseVersion: first.model.stateVersion,
    runId: 'RUN-22222222-2222-4222-8222-222222222222',
    instruction: 'Do the same thing again.',
    summary: 'No effective change.',
    proposed: {
      entities: structuredClone(first.model.entities),
      relationships: structuredClone(first.model.relationships),
      constraints: structuredClone(first.model.constraints),
    },
  });
  assert.equal(repeated.change, null);
  assert.equal(repeated.model.stateVersion, first.model.stateVersion);
  assert.equal(repeated.canUndo, true);
  const restored = await undoLastDomainModelChange(project);
  assert.equal(restored.model.entities.length, 0);
  assert.deepEqual(
    restored.change.items?.removed
      .filter((item) => item.kind === 'card')
      .map((item) => item.label),
    ['Item', 'Container'],
  );
});

void test('an unchanged legacy relationship label remains readable but cannot be newly introduced', async (t) => {
  const project = await fixture(t);
  const first = await applyProposedDomainModel(project, {
    baseVersion: 0,
    runId: 'RUN-11111111-1111-4111-8111-111111111111',
    instruction: 'Create Item and Container.',
    summary: 'Initial model.',
    proposed: initialProposal(),
  });
  const statePath = path.join(
    project.planningPath,
    'domain-model',
    'state.json',
  );
  const stored = JSON.parse(await readFile(statePath, 'utf8'));
  stored.model.relationships[0].label = 'from';
  await writeFile(statePath, `${JSON.stringify(stored, null, 2)}\n`);
  const legacy = await readDomainModel(project);
  const repeated = await applyProposedDomainModel(project, {
    baseVersion: first.model.stateVersion,
    runId: 'RUN-22222222-2222-4222-8222-222222222222',
    instruction: 'Keep the current model.',
    summary: 'No effective change.',
    proposed: {
      entities: structuredClone(legacy.entities),
      relationships: structuredClone(legacy.relationships),
      constraints: structuredClone(legacy.constraints),
    },
  });
  assert.equal(repeated.change, null);
  assert.equal(repeated.model.relationships[0]?.label, 'from');
});

void test('Domain Model storage rejects a linked module directory', async (t) => {
  const project = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'domain-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(project.planningPath, 'domain-model'));
  await assert.rejects(
    () => readDomainModel(project),
    /storage is not available/,
  );
});

void test('a later change preserves Entity identity and undo restores the previous model atomically', async (t) => {
  const project = await fixture(t);
  const first = (
    await applyProposedDomainModel(project, {
      baseVersion: 0,
      runId: 'RUN-11111111-1111-4111-8111-111111111111',
      instruction: 'Create Item and Container.',
      summary: 'Initial model.',
      proposed: initialProposal(),
    })
  ).model;
  const item = first.entities.find((entity) => entity.name === 'Item')!;
  const container = first.entities.find(
    (entity) => entity.name === 'Container',
  )!;
  const secondProposal: ProposedDomainModel = {
    entities: [
      {
        id: item.id,
        name: item.name,
        meaning: item.meaning,
        provenance: item.provenance,
        fields: [
          ...item.fields,
          {
            id: 'NEW_FIELD_NOTE',
            name: 'note',
            meaning: 'An optional user note.',
            valueType: 'text',
            required: false,
            multiple: false,
            display: 'secondary',
            provenance: 'explicit',
          },
        ],
      },
      {
        id: container.id,
        name: container.name,
        meaning: container.meaning,
        fields: [],
        provenance: container.provenance,
      },
    ],
    relationships: first.relationships,
    constraints: first.constraints,
  };
  const second = (
    await applyProposedDomainModel(project, {
      baseVersion: 1,
      runId: 'RUN-22222222-2222-4222-8222-222222222222',
      instruction: 'Item also has an optional note.',
      summary: 'Added Item note.',
      proposed: secondProposal,
    })
  ).model;
  assert.equal(second.entities[0].id, item.id);
  assert.ok(second.entities[0].fields.some((field) => field.name === 'note'));
  const restored = await undoLastDomainModelChange(project);
  assert.equal(restored.model.stateVersion, 3);
  assert.equal(restored.canUndo, false);
  assert.equal(
    restored.model.entities
      .find((entity) => entity.id === item.id)!
      .fields.some((field) => field.name === 'note'),
    false,
  );
  assert.equal((await readDomainModel(project)).stateVersion, 3);
  assert.equal(
    (await readDomainModelView(project)).lastChange?.kind,
    'restored',
  );
  await assert.rejects(
    () => undoLastDomainModelChange(project),
    /no Domain Model change to undo/i,
  );
});

void test('stale and cyclic changes fail without replacing the current model', async (t) => {
  const project = await fixture(t);
  const current = (
    await applyProposedDomainModel(project, {
      baseVersion: 0,
      runId: 'RUN-11111111-1111-4111-8111-111111111111',
      instruction: 'Create Item and Container.',
      summary: 'Initial model.',
      proposed: initialProposal(),
    })
  ).model;
  await assert.rejects(
    () =>
      applyProposedDomainModel(project, {
        baseVersion: 0,
        runId: 'RUN-22222222-2222-4222-8222-222222222222',
        instruction: 'Stale change.',
        summary: 'Stale.',
        proposed: initialProposal(),
      }),
    /changed while the Agent was running/,
  );
  const [item, container] = current.entities;
  const cycle = initialProposal();
  cycle.entities = structuredClone(current.entities);
  cycle.relationships = [
    {
      id: 'NEW_RELATIONSHIP_CYCLE_A',
      sourceEntityId: item.id,
      targetEntityId: container.id,
      label: 'is a',
      meaning: '',
      semanticRole: 'inheritance',
      direction: 'directed',
      sourceCardinality: '1',
      targetCardinality: '1',
      provenance: 'inferred',
    },
    {
      id: 'NEW_RELATIONSHIP_CYCLE_B',
      sourceEntityId: container.id,
      targetEntityId: item.id,
      label: 'is a',
      meaning: '',
      semanticRole: 'inheritance',
      direction: 'directed',
      sourceCardinality: '1',
      targetCardinality: '1',
      provenance: 'inferred',
    },
  ];
  cycle.constraints = [];
  await assert.rejects(
    () =>
      applyProposedDomainModel(project, {
        baseVersion: 1,
        runId: 'RUN-33333333-3333-4333-8333-333333333333',
        instruction: 'Create an invalid cycle.',
        summary: 'Cycle.',
        proposed: cycle,
      }),
    /inheritance cannot contain a cycle/,
  );
  assert.equal((await readDomainModel(project)).stateVersion, 1);
});

void test('the Harness binds responses to one exact model state', () => {
  const request = createDomainModelRequest({
    requestId: 'RUN-11111111-1111-4111-8111-111111111111',
    content: {
      input: {
        role: 'primary',
        kind: 'user-input',
        logicalPath: 'domain-model/runs/RUN-test/context/input/user-input.md',
        workspacePath: 'input/user-input.md',
        sha256: 'fixture',
      },
      references: [],
      external: [],
    },
    selectedIds: [],
    model: {
      schemaVersion: 1,
      stateVersion: 0,
      entities: [],
      relationships: [],
      constraints: [],
      lastRunId: null,
      updatedAt: null,
    },
    previousSummary: '',
  });
  const result = composedResult(
    JSON.stringify({
      harnessVersion: 2,
      requestId: request.requestId,
      baseVersion: 0,
      inputFingerprint: request.inputFingerprint,
      outcome: 'applied',
      summary: 'Created the model.',
      model: initialProposal(),
    }),
    request,
  );
  assert.equal(result.outcome, 'applied');
  assert.throws(
    () =>
      composedResult(JSON.stringify({ ...result, baseVersion: 1 }), request),
    /does not match/,
  );
});

void test('the topology key ignores equivalent Entity and relationship ordering', () => {
  const model = {
    schemaVersion: 1 as const,
    stateVersion: 1,
    ...initialProposal(),
    lastRunId: null,
    updatedAt: null,
  };
  const reordered = {
    ...model,
    entities: [...model.entities].reverse(),
    relationships: [...model.relationships].reverse(),
  };
  assert.equal(
    domainModelTopologyKey(model),
    domainModelTopologyKey(reordered),
  );
});

void test('a controlled Agent Run applies one model and cancellation changes nothing', async (t) => {
  const project = await fixture(t);
  const transport: typeof startLocalAgentRun = (_agent, options) => {
    const request = JSON.parse(
      options.prompt.split('\nREQUEST:\n')[1],
    ) as DomainModelRequest;
    return {
      completion: Promise.resolve({
        agentSessionId: 'fixture-session',
        usage: null,
        finalOutput: JSON.stringify({
          harnessVersion: 2,
          requestId: request.requestId,
          baseVersion: request.baseVersion,
          inputFingerprint: request.inputFingerprint,
          outcome: 'applied',
          summary: 'Created Item and Container.',
          model: initialProposal(),
        }),
      }),
      cancel: () => {},
    };
  };
  const started = await startDomainModelRun(
    project,
    {
      instruction: 'Create Item and Container.',
      selectedIds: [],
      profile: { agent: 'codex', model: '', effort: '' },
    },
    transport,
  );
  let run = await readDomainModelRun(project, started.id);
  for (let attempt = 0; attempt < 50 && run.status === 'running'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    run = await readDomainModelRun(project, started.id);
  }
  assert.equal(run.status, 'succeeded', run.error ?? '');
  assert.equal((await readDomainModel(project)).stateVersion, 1);
  const summary = await readFile(
    path.join(
      project.planningPath,
      'domain-model/runs',
      started.id,
      'summary.md',
    ),
    'utf8',
  );
  assert.match(summary, /Added: 2 Cards · \d+ model entries · Item, Container/);
  assert.doesNotMatch(summary, /ENTITY-|FIELD-|RELATIONSHIP-|CONSTRAINT-/);

  let reject!: (error: Error) => void;
  let canceled = false;
  const hanging: typeof startLocalAgentRun = () => ({
    completion: new Promise((_, fail) => {
      reject = fail;
    }),
    cancel: () => {
      canceled = true;
      reject(new Error('canceled'));
    },
  });
  const second = await startDomainModelRun(
    project,
    {
      instruction: 'Add a quantity.',
      selectedIds: [],
      profile: { agent: 'codex', model: '', effort: '' },
    },
    hanging,
  );
  const cancellation = cancelDomainModelRun(project, second.id);
  await Promise.resolve();
  await Promise.resolve();
  await assert.rejects(
    startDomainModelRun(
      project,
      {
        instruction: 'Start before cancellation is durable.',
        selectedIds: [],
        profile: { agent: 'codex', model: '', effort: '' },
      },
      hanging,
    ),
    /already active/,
  );
  const stopped = await cancellation;
  assert.equal(canceled, true);
  assert.equal(stopped.status, 'canceled');
  assert.equal((await readDomainModel(project)).stateVersion, 1);
  assert.equal((await readDomainModelView(project)).canUndo, true);
  assert.match(
    await readFile(
      path.join(
        project.planningPath,
        'domain-model/runs',
        second.id,
        'summary.md',
      ),
      'utf8',
    ),
    /not changed/,
  );
  const afterCancellation = await startDomainModelRun(
    project,
    {
      instruction: 'Start after cancellation is durable.',
      selectedIds: [],
      profile: { agent: 'codex', model: '', effort: '' },
    },
    hanging,
  );
  await cancelDomainModelRun(project, afterCancellation.id);
});

void test('a Domain Model Run packages User Input, references and external files', async (t) => {
  const project = await fixture(t);
  await saveDomainModelInstructions(
    project,
    'Use product-facing names and concise relationship labels.',
  );
  assert.equal(
    await readDomainModelInstructions(project),
    'Use product-facing names and concise relationship labels.',
  );
  const contextPath = path.join(
    project.planningPath,
    'context',
    'Product',
    'item.md',
  );
  await mkdir(path.dirname(contextPath), { recursive: true });
  await writeFile(contextPath, '# Item\n\nAn Item has a title.\n');
  const productDesignPath = path.join(
    project.planningPath,
    'whats-next/nodes/NODE-abcdef12/output.md',
  );
  await mkdir(path.dirname(productDesignPath), { recursive: true });
  await writeFile(
    productDesignPath,
    '# Search Feature\n\nUsers can find stored Items.\n',
  );
  await writeFile(
    path.join(path.dirname(productDesignPath), 'node.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'NODE-abcdef12',
      role: 'node',
      status: 'accepted',
      layer: 'product-design',
      resources: [
        {
          kind: 'output',
          path: 'whats-next/nodes/NODE-abcdef12/output.md',
        },
      ],
    }),
  );
  let rejectCompletion!: (error: Error) => void;
  let request!: DomainModelRequest;
  const hanging: typeof startLocalAgentRun = (_agent, options) => {
    request = JSON.parse(
      options.prompt.split('\nREQUEST:\n')[1],
    ) as DomainModelRequest;
    return {
      completion: new Promise((_, reject) => {
        rejectCompletion = reject;
      }),
      cancel: () => rejectCompletion(new Error('canceled')),
    };
  };
  const started = await startDomainModelRun(
    project,
    {
      instruction: `Use the supplied product rules.\n\n${'x'.repeat(25_000)}`,
      selectedIds: [],
      profile: { agent: 'codex', model: '', effort: '' },
      contextRefs: [
        'context/Product/item.md',
        'whats-next/nodes/NODE-abcdef12/output.md',
      ],
      files: [new File(['# Lifecycle'], 'lifecycle.md')],
    },
    hanging,
  );
  assert.equal(request.content.input?.kind, 'user-input');
  assert.deepEqual(
    request.content.references.map((item) => item.kind),
    ['context', 'context', 'module-instructions'],
  );
  assert.deepEqual(
    request.content.external.map((item) => item.kind),
    ['run-attachment'],
  );
  const packagedUserInput = await readFile(
    path.join(
      project.rootPath,
      request.contextRoot,
      request.content.input!.workspacePath,
    ),
    'utf8',
  );
  assert.ok(packagedUserInput.length > 25_000);
  assert.doesNotMatch(JSON.stringify(request), /xxxxxxxxxxxxxxxx/);
  assert.doesNotMatch(
    JSON.stringify(request),
    /Use product-facing names and concise relationship labels/,
  );
  for (const item of [
    request.content.input!,
    ...request.content.references,
    ...request.content.external,
  ]) {
    assert.ok(
      (
        await readFile(
          path.join(project.rootPath, request.contextRoot, item.workspacePath),
          'utf8',
        )
      ).length > 0,
    );
  }
  await cancelDomainModelRun(project, started.id);
});

void test('concurrent starts reserve one Agent Run slot before asynchronous setup', async (t) => {
  const project = await fixture(t);
  let transports = 0;
  let rejectCompletion!: (error: Error) => void;
  const hanging: typeof startLocalAgentRun = () => {
    transports += 1;
    return {
      completion: new Promise((_, reject) => {
        rejectCompletion = reject;
      }),
      cancel: () => rejectCompletion(new Error('canceled')),
    };
  };
  const input = {
    instruction: 'Create Item.',
    selectedIds: [],
    profile: { agent: 'codex' as const, model: '', effort: '' as const },
  };
  const [first, second] = await Promise.allSettled([
    startDomainModelRun(project, input, hanging),
    startDomainModelRun(project, input, hanging),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.match(String(second.reason), /already active/);
  assert.equal(transports, 1);
  if (first.status === 'fulfilled')
    await cancelDomainModelRun(project, first.value.id);
});

void test('a committed model is never reported as unchanged when Run evidence fails', async (t) => {
  const project = await fixture(t);
  let resolveCompletion!: (value: {
    agentSessionId: string | null;
    usage: null;
    finalOutput: string;
  }) => void;
  let request!: DomainModelRequest;
  const deferred: typeof startLocalAgentRun = (_agent, options) => {
    request = JSON.parse(
      options.prompt.split('\nREQUEST:\n')[1],
    ) as DomainModelRequest;
    return {
      completion: new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
      cancel: () => {},
    };
  };
  const started = await startDomainModelRun(
    project,
    {
      instruction: 'Create Item and Container.',
      selectedIds: [],
      profile: { agent: 'codex', model: '', effort: '' },
    },
    deferred,
  );
  const directory = path.join(
    project.planningPath,
    'domain-model',
    'runs',
    started.id,
  );
  await chmod(directory, 0o500);
  try {
    resolveCompletion({
      agentSessionId: 'fixture-session',
      usage: null,
      finalOutput: JSON.stringify({
        harnessVersion: 2,
        requestId: request.requestId,
        baseVersion: request.baseVersion,
        inputFingerprint: request.inputFingerprint,
        outcome: 'applied',
        summary: 'Created Item and Container.',
        model: initialProposal(),
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
  } finally {
    await chmod(directory, 0o700);
  }
  const model = await readDomainModel(project);
  const immediate = await readDomainModelRun(project, started.id);
  assert.equal(model.lastRunId, started.id);
  assert.equal(immediate.status, 'succeeded');
  assert.doesNotMatch(immediate.error ?? '', /not changed/i);
  const revised: ProposedDomainModel = {
    entities: structuredClone(model.entities),
    relationships: structuredClone(model.relationships),
    constraints: structuredClone(model.constraints),
  };
  revised.entities[0].meaning = 'A physical thing with a durable identity.';
  await applyProposedDomainModel(project, {
    baseVersion: model.stateVersion,
    runId: 'RUN-99999999-9999-4999-8999-999999999999',
    instruction: 'Clarify Item identity.',
    summary: 'Clarified Item.',
    proposed: revised,
  });
  await undoLastDomainModelChange(project);
  const historical = await readDomainModelRun(project, started.id);
  assert.equal(historical.status, 'succeeded');
  assert.doesNotMatch(historical.error ?? '', /not changed/i);
});

void test('a rejected Agent model retains the raw response for diagnosis', async (t) => {
  const project = await fixture(t);
  const transport: typeof startLocalAgentRun = (_agent, options) => {
    const request = JSON.parse(
      options.prompt.split('\nREQUEST:\n')[1],
    ) as DomainModelRequest;
    const model = initialProposal();
    model.constraints[0].target = {
      kind: 'field' as never,
      id: 'NEW_FIELD_TITLE',
    };
    return {
      completion: Promise.resolve({
        agentSessionId: 'fixture-session',
        usage: null,
        finalOutput: JSON.stringify({
          harnessVersion: 2,
          requestId: request.requestId,
          baseVersion: request.baseVersion,
          inputFingerprint: request.inputFingerprint,
          outcome: 'applied',
          summary:
            'Returned an invalid field constraint with token=ghp_abcdefghijklmnop.',
          model,
        }),
      }),
      cancel: () => {},
    };
  };
  const started = await startDomainModelRun(
    project,
    {
      instruction: 'Create an invalid field constraint.',
      selectedIds: [],
      profile: { agent: 'codex', model: '', effort: '' },
    },
    transport,
  );
  let run = await readDomainModelRun(project, started.id);
  for (let attempt = 0; attempt < 50 && run.status === 'running'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    run = await readDomainModelRun(project, started.id);
  }
  assert.equal(run.status, 'failed');
  const output = path.join(
    project.planningPath,
    'domain-model',
    'runs',
    started.id,
    'agent-output.txt',
  );
  let raw = '';
  for (let attempt = 0; attempt < 50 && !raw; attempt++) {
    raw = await readFile(output, 'utf8').catch(() => '');
    if (!raw) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(raw, /invalid field constraint/);
  assert.doesNotMatch(raw, /ghp_abcdefghijklmnop/);
  assert.match(raw, /token=\[redacted\]/);
  assert.equal((await readDomainModel(project)).stateVersion, 0);
});
