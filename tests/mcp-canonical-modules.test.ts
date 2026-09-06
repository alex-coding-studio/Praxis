import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'mcp-canon-home-'));
process.env.PRAXIS_HOME = REGISTRY_HOME;

const registry = await import('../lib/project-registry.ts');
const { prepareDomainModelOperation } =
  await import('../lib/mcp/prepare-domain-model.ts');
const { submitDomainModelOperation, domainPublicationBoundary } =
  await import('../lib/mcp/submit-domain-model.ts');
const { PublicApiError } = await import('../lib/api-errors.ts');
const { MaterializationError } =
  await import('../lib/materialization/receipt.ts');
const { findMcpOperation, writeMcpOperation } =
  await import('../lib/mcp/operations.ts');
const { isMcpRequestError } = await import('../lib/mcp/errors.ts');
const catalog = await import('../lib/mcp/catalog.ts');
const { readDomainModelView } =
  await import('../lib/modules/domain-modeling/model.ts');

test.after(() => rm(REGISTRY_HOME, { recursive: true, force: true }));

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mcp-canon-project-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  return registry.createProject({
    kind: 'standalone',
    name: 'Canonical fixture',
    description: '',
    rootPath,
  });
}

function modelChange(name: string) {
  return {
    outcome: 'model-change',
    summary: `Adds the ${name} entity.`,
    change: {
      kind: 'patch',
      patch: {
        upsertEntities: [
          {
            id: 'NEW_ENTITY_READING_LIST',
            name,
            meaning: 'The list a reader keeps.',
            fields: [
              {
                id: 'NEW_FIELD_READING_LIST_NAME',
                name: 'name',
                meaning: 'Display name.',
                valueType: 'text',
                required: true,
                multiple: false,
                display: 'primary',
                provenance: 'explicit',
              },
            ],
            provenance: 'explicit',
          },
        ],
        removeEntityIds: [],
        removeFieldIds: [],
        upsertRelationships: [],
        removeRelationshipIds: [],
        upsertConstraints: [],
        removeConstraintIds: [],
      },
    },
  };
}

void test('a Domain Model operation prepares against the current state version', async (t) => {
  const project = await fixture(t);
  const { record, basis } = await prepareDomainModelOperation(project, {
    userInput: 'Name the reading list.',
  });
  const view = await readDomainModelView(project);
  assert.equal(basis.stateVersion, view.model.stateVersion);
  assert.equal(record.module, 'domain-modeling');
  assert.equal(record.request.operation, 'change-model');
  assert.deepEqual(record.request.selectionIds, []);
});

void test('a Domain Model submission publishes through the canonical service', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDomainModelOperation(project, {
    userInput: 'Name the reading list.',
  });
  const outcome = await submitDomainModelOperation(
    project,
    record.operationId,
    record.contract,
    modelChange('Reading list'),
  );
  assert.equal(outcome.record.status, 'completed');
  assert.equal(outcome.record.outcome?.kind, 'model-change');
  const view = await readDomainModelView(project);
  assert.equal(
    view.model.entities.some((entity) => entity.name === 'Reading list'),
    true,
    'the canonical model must carry the published change',
  );
  assert.equal(
    outcome.record.logUrlPath,
    `/projects/${project.id}/logs/domain-model/${record.runId}`,
  );
});

void test('a Domain Model conflict is a stale Basis, not a publication failure', async (t) => {
  const project = await fixture(t);
  const stale = await prepareDomainModelOperation(project, {
    userInput: 'Name the reading list.',
  });
  const fresh = await prepareDomainModelOperation(project, {
    userInput: 'Name it first.',
  });
  await submitDomainModelOperation(
    project,
    fresh.record.operationId,
    fresh.record.contract,
    modelChange('Reading list'),
  );
  await assert.rejects(
    () =>
      submitDomainModelOperation(
        project,
        stale.record.operationId,
        stale.record.contract,
        modelChange('Another name'),
      ),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'STALE_BASIS',
  );
  const after = await findMcpOperation(project, stale.record.operationId);
  assert.equal(after?.status, 'prepared');
});

void test('a selection that no longer exists is refused as a stale Basis at preparation', async (t) => {
  const project = await fixture(t);
  await assert.rejects(
    () =>
      prepareDomainModelOperation(project, {
        userInput: 'Change it.',
        selectionIds: ['ENTITY-does-not-exist'],
      }),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'STALE_BASIS',
  );
});

void test('an exact Domain retry replays without a second canonical publication', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDomainModelOperation(project, {
    userInput: 'Name the reading list.',
  });
  const result = modelChange('Reading list');
  const first = await submitDomainModelOperation(
    project,
    record.operationId,
    record.contract,
    result,
  );
  const before = await readDomainModelView(project);
  const retry = await submitDomainModelOperation(
    project,
    record.operationId,
    record.contract,
    result,
  );
  assert.equal(retry.replayed, true);
  assert.equal(retry.record.settledAt, first.record.settledAt);
  const after = await readDomainModelView(project);
  assert.equal(
    after.model.stateVersion,
    before.model.stateVersion,
    'a retry must not advance the canonical state version',
  );
  assert.equal(after.model.entities.length, before.model.entities.length);
});

void test('a changed Domain result on an admitted operation conflicts', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDomainModelOperation(project, {
    userInput: 'Name the reading list.',
  });
  await submitDomainModelOperation(
    project,
    record.operationId,
    record.contract,
    modelChange('Reading list'),
  );
  await assert.rejects(
    () =>
      submitDomainModelOperation(
        project,
        record.operationId,
        record.contract,
        modelChange('A different name'),
      ),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'SUBMISSION_CONFLICT',
  );
});

void test('a committed Domain receipt settles an operation whose status write was lost', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDomainModelOperation(project, {
    userInput: 'Name the reading list.',
  });
  await submitDomainModelOperation(
    project,
    record.operationId,
    record.contract,
    modelChange('Reading list'),
  );
  const published = (await findMcpOperation(project, record.operationId))!;
  assert.equal(published.status, 'completed');
  await writeMcpOperation(project, {
    ...published,
    status: 'running',
    settledAt: null,
    outcome: null,
    receipt: null,
  });
  const recovered = JSON.parse(
    (await catalog.readOperationResource(project.id, record.operationId)).text,
  ) as Record<string, unknown>;
  assert.equal(
    recovered.status,
    'completed',
    'recovery must read the Domain receipt document, not a graph Run record',
  );
  assert.equal((recovered.receipt as { outcome: string }).outcome, 'canonical');
  const before = await readDomainModelView(project);
  const retry = await submitDomainModelOperation(
    project,
    record.operationId,
    record.contract,
    modelChange('Reading list'),
  );
  assert.equal(retry.replayed, true);
  assert.equal(retry.record.status, 'completed');
  assert.equal(
    (await readDomainModelView(project)).model.stateVersion,
    before.model.stateVersion,
    'recovery must not republish',
  );
});

void test('a publication conflict is classified as a stale Basis, not a failure', () => {
  assert.equal(
    domainPublicationBoundary(new PublicApiError('conflict', 409)),
    'stale-basis',
    'the module preserves a 409 from applyProposedDomainModel and it must keep that meaning',
  );
  assert.equal(
    domainPublicationBoundary(new PublicApiError('bad request', 400)),
    'publication',
  );
  assert.equal(
    domainPublicationBoundary(
      new MaterializationError('stale-basis', 'changed'),
    ),
    'stale-basis',
  );
  assert.equal(
    domainPublicationBoundary(
      new MaterializationError('validation', 'invalid'),
    ),
    'validation',
  );
  assert.equal(
    domainPublicationBoundary(new Error('anything else')),
    'publication',
  );
});

void test('a lost materialization receipt still recovers from the committed state', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDomainModelOperation(project, {
    userInput: 'Name the reading list.',
  });
  await submitDomainModelOperation(
    project,
    record.operationId,
    record.contract,
    modelChange('Reading list'),
  );
  const published = (await findMcpOperation(project, record.operationId))!;

  await rm(
    path.join(
      project.planningPath,
      'domain-model',
      'runs',
      record.runId,
      'materialization.json',
    ),
    { force: true },
  );
  await writeMcpOperation(project, {
    ...published,
    status: 'running',
    settledAt: null,
    outcome: null,
    receipt: null,
  });

  const recovered = JSON.parse(
    (await catalog.readOperationResource(project.id, record.operationId)).text,
  ) as Record<string, unknown>;
  assert.equal(
    recovered.status,
    'completed',
    'the canonical committed state must settle the operation when its best-effort receipt is gone',
  );
  assert.equal(recovered.receipt, null);
  assert.match(
    (recovered.outcome as { summary: string }).summary,
    /recovered from the committed state/,
    'the projection must say the receipt was missing rather than imply one exists',
  );
});

void test('an operation whose Run never committed stays unsettled', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDomainModelOperation(project, {
    userInput: 'Name the reading list.',
  });
  await writeMcpOperation(project, {
    ...record,
    status: 'running',
    admittedAt: new Date().toISOString(),
    admittedHostPid: 2 ** 22,
    semanticResultHash: 'never-committed',
  });
  const projection = JSON.parse(
    (await catalog.readOperationResource(project.id, record.operationId)).text,
  ) as Record<string, unknown>;
  assert.equal(projection.status, 'interrupted');
  assert.equal(projection.receipt, null);
  assert.equal(projection.outcome, null);
});

void test('a Domain operation cannot be submitted through another module tool', async (t) => {
  const project = await fixture(t);
  const { submitScopeDecompositionOperation } =
    await import('../lib/mcp/submit-scope-decomposition.ts');
  const { record } = await prepareDomainModelOperation(project, {
    userInput: 'Name the reading list.',
  });
  await assert.rejects(
    () =>
      submitScopeDecompositionOperation(
        project,
        record.operationId,
        record.contract,
        { outcome: 'no-change' },
      ),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'CONTRACT_MISMATCH',
  );
});

void test('the operation resource reports each canonical module by name', async (t) => {
  const project = await fixture(t);
  const { record } = await prepareDomainModelOperation(project, {
    userInput: 'Name the reading list.',
  });
  const projection = JSON.parse(
    (await catalog.readOperationResource(project.id, record.operationId)).text,
  ) as Record<string, unknown>;
  assert.equal(projection.module, 'domain-modeling');
  assert.equal(projection.status, 'prepared');
  assert.equal(
    projection.moduleUri,
    `praxis://projects/${project.id}/modules/domain-modeling`,
  );
});
