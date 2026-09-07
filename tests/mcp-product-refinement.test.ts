import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'mcp-refine-home-'));
process.env.PRAXIS_HOME = REGISTRY_HOME;

const registry = await import('../lib/project-registry.ts');
const { createStartNode } = await import('../lib/graph/task/model.ts');
const { enableMcpEndpoint, readMcpCredentials } =
  await import('../lib/mcp/credentials.ts');
const { connectMcpClient, readMcpJson } =
  await import('./helpers/mcp-sdk-host.ts');

test.after(() => rm(REGISTRY_HOME, { recursive: true, force: true }));

await enableMcpEndpoint();
const credentials = await readMcpCredentials();
assert.ok(credentials);
const token = credentials.token;

const connect = (t: test.TestContext) =>
  connectMcpClient(t, token, 'praxis-refine-client');

type PendingCandidate = {
  runId: string;
  candidateId: string;
  revision: number;
  uid: string | null;
  title: string;
  summary: string;
};

type ModuleState = {
  state: { pendingCandidates: PendingCandidate[] };
};

type Prepared = {
  operationId: string;
  contract: { id: string; version: number; hash: string };
  request: { operation: string; revisionCandidateId: string | null };
  refine: {
    candidateId: string;
    revision: number;
    requiredRevision: number;
    nextStep: string;
  } | null;
};

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mcp-refine-project-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project = await registry.createProject({
    kind: 'standalone',
    name: 'Refine fixture',
    description: '',
    rootPath,
  });
  const start = await createStartNode(
    project,
    {
      title: 'Ship the reading list',
      idea: 'Plan it',
      contextRefs: [],
      files: [],
    },
    'whats-next',
  );
  return { project, sourceNodeId: start.node.id };
}

function body(title: string, detail: string) {
  return `# ${title}\n\n## Why this direction\n\n- ${detail}\n- It can be judged without more evidence.\n\n## Assumptions\n\n- The reader already has the source material.`;
}

function candidate(
  sourceNodeId: string,
  localKey: string,
  title: string,
  detail = 'It answers the stated need directly.',
) {
  return {
    localKey,
    type: 'mvp',
    title,
    summary: 'One bounded outcome the reader asked for.',
    derivedFrom: [{ kind: 'node' as const, id: sourceNodeId }],
    dependsOn: [],
    resources: [],
    typeTemplateRef: null,
    metadata: {},
    presentation: {},
    assumptions: ['The reader already has the source material.'],
    outputMarkdown: body(title, detail),
    layer: 'discovery' as const,
    artifactKind: 'mvp' as const,
  };
}

const readModule = (
  client: Awaited<ReturnType<typeof connect>>,
  projectId: string,
) =>
  readMcpJson<ModuleState>(
    client,
    `praxis://projects/${projectId}/modules/product-exploration`,
  );

async function prepare(
  client: Awaited<ReturnType<typeof connect>>,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({
    name: 'praxis_prepare',
    arguments: args,
  });
  return result;
}

async function explore(
  client: Awaited<ReturnType<typeof connect>>,
  projectId: string,
  sourceNodeId: string,
  candidates: Array<Record<string, unknown>>,
) {
  const prepared = await prepare(client, {
    projectId,
    module: 'product-exploration',
    request: {
      userInput: 'Explore bounded MVPs.',
      layer: 'discovery',
      sourceNodeIds: [sourceNodeId],
    },
  });
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared));
  const operation = prepared.structuredContent as Prepared;
  const submitted = await client.callTool({
    name: 'praxis_submit_product_exploration',
    arguments: {
      operationId: operation.operationId,
      contract: operation.contract,
      result: { outcome: 'proposal', candidates },
    },
  });
  assert.notEqual(submitted.isError, true, JSON.stringify(submitted));
  return operation;
}

void test(
  'a client refines one Candidate in place, keeping its identity and leaving its sibling untouched',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t);
    const client = await connect(t);
    await explore(client, project.id, sourceNodeId, [
      candidate(sourceNodeId, 'first', 'Import the reading list'),
      candidate(sourceNodeId, 'second', 'Show the reading list'),
    ]);
    const before = await readModule(client, project.id);
    const target = before.state.pendingCandidates.find(
      (entry) => entry.title === 'Import the reading list',
    );
    const sibling = before.state.pendingCandidates.find(
      (entry) => entry.title === 'Show the reading list',
    );
    assert.ok(target && sibling);
    assert.equal(target.revision, 1);

    const prepared = await prepare(client, {
      projectId: project.id,
      module: 'product-exploration',
      request: {
        userInput: 'Sharpen the outcome statement.',
        layer: 'discovery',
        sourceNodeIds: [sourceNodeId],
        operation: 'refine-candidate',
        candidateIds: [target.candidateId],
      },
    });
    assert.notEqual(prepared.isError, true, JSON.stringify(prepared));
    const operation = prepared.structuredContent as Prepared;
    assert.equal(operation.request.operation, 'refine-candidate');
    assert.equal(operation.request.revisionCandidateId, target.candidateId);
    assert.equal(operation.refine?.candidateId, target.candidateId);
    assert.equal(operation.refine?.revision, 1);
    assert.equal(operation.refine?.requiredRevision, 2);
    assert.match(operation.refine?.nextStep ?? '', /praxis_accept_candidate/);

    const refined = {
      ...candidate(
        sourceNodeId,
        target.candidateId,
        'Import the reading list',
        'It states the outcome the reader asked for.',
      ),
      summary: 'Import the reading list with one stated outcome.',
    };
    const submitted = await client.callTool({
      name: 'praxis_submit_product_exploration',
      arguments: {
        operationId: operation.operationId,
        contract: operation.contract,
        result: { outcome: 'proposal', candidates: [refined] },
      },
    });
    assert.notEqual(submitted.isError, true, JSON.stringify(submitted));

    const after = await readModule(client, project.id);
    assert.equal(after.state.pendingCandidates.length, 2);
    const revised = after.state.pendingCandidates.find(
      (entry) => entry.candidateId === target.candidateId,
    );
    assert.ok(revised);
    assert.equal(revised.uid, target.uid, 'refinement keeps the stable uid');
    assert.equal(revised.revision, 2, 'refinement advances the revision');
    assert.equal(
      revised.summary,
      'Import the reading list with one stated outcome.',
    );
    const untouched = after.state.pendingCandidates.find(
      (entry) => entry.candidateId === sibling.candidateId,
    );
    assert.deepEqual(
      untouched,
      sibling,
      'an unrelated Candidate must not change',
    );

    const widened = await prepare(client, {
      projectId: project.id,
      module: 'product-exploration',
      request: {
        userInput: 'Change what this Candidate is.',
        layer: 'discovery',
        sourceNodeIds: [sourceNodeId],
        operation: 'refine-candidate',
        candidateIds: [target.candidateId],
      },
    });
    const widenedOperation = widened.structuredContent as Prepared;
    const refused = await client.callTool({
      name: 'praxis_submit_product_exploration',
      arguments: {
        operationId: widenedOperation.operationId,
        contract: widenedOperation.contract,
        result: {
          outcome: 'proposal',
          candidates: [{ ...refined, type: 'feature' }],
        },
      },
    });
    assert.equal(refused.isError, true, JSON.stringify(refused));
    assert.match(
      (refused.structuredContent as { detail: string }).detail,
      /Refine cannot change Candidate type/,
    );
    assert.equal(
      (await readModule(client, project.id)).state.pendingCandidates.find(
        (entry) => entry.candidateId === target.candidateId,
      )?.revision,
      2,
      'a refused refinement leaves the Candidate at its published revision',
    );
  },
);

void test(
  'refine preparation refuses an unknown, accepted or ambiguous target',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t);
    const client = await connect(t);
    await explore(client, project.id, sourceNodeId, [
      candidate(sourceNodeId, 'first', 'Import the reading list'),
      candidate(sourceNodeId, 'second', 'Show the reading list'),
    ]);
    const pending = (await readModule(client, project.id)).state
      .pendingCandidates;
    const base = {
      projectId: project.id,
      module: 'product-exploration',
      request: {
        userInput: 'Sharpen it.',
        layer: 'discovery',
        sourceNodeIds: [sourceNodeId],
        operation: 'refine-candidate',
      },
    };

    const unknown = await prepare(client, {
      ...base,
      request: { ...base.request, candidateIds: ['CANDIDATE-ffffffff'] },
    });
    assert.equal(unknown.isError, true);
    assert.equal(
      (unknown.structuredContent as { code: string }).code,
      'INVALID_ARGUMENT',
    );

    const none = await prepare(client, base);
    assert.equal(none.isError, true);
    assert.match(JSON.stringify(none), /exactly one open Candidate/);

    const two = await prepare(client, {
      ...base,
      request: {
        ...base.request,
        candidateIds: pending.map((entry) => entry.candidateId),
      },
    });
    assert.equal(two.isError, true);

    const promoted = await client.callTool({
      name: 'praxis_accept_candidate',
      arguments: {
        projectId: project.id,
        module: 'product-exploration',
        runId: pending[0]!.runId,
        candidateId: pending[0]!.candidateId,
        expectedRevision: pending[0]!.revision,
      },
    });
    assert.notEqual(promoted.isError, true, JSON.stringify(promoted));
    const accepted = await prepare(client, {
      ...base,
      request: {
        ...base.request,
        candidateIds: [pending[0]!.candidateId],
      },
    });
    assert.equal(accepted.isError, true);
    assert.match(
      (accepted.structuredContent as { detail: string }).detail,
      /formal Node/,
    );
  },
);

void test(
  'a refine prepared against an older revision is refused at submission',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t);
    const client = await connect(t);
    await explore(client, project.id, sourceNodeId, [
      candidate(sourceNodeId, 'first', 'Import the reading list'),
      candidate(sourceNodeId, 'second', 'Show the reading list'),
    ]);
    const target = (await readModule(client, project.id)).state
      .pendingCandidates[0]!;
    const refineArgs = {
      projectId: project.id,
      module: 'product-exploration',
      request: {
        userInput: 'Sharpen the outcome statement.',
        layer: 'discovery',
        sourceNodeIds: [sourceNodeId],
        operation: 'refine-candidate',
        candidateIds: [target.candidateId],
      },
    };
    const stale = (await prepare(client, refineArgs))
      .structuredContent as Prepared;
    const fresh = (await prepare(client, refineArgs))
      .structuredContent as Prepared;

    const refined = (detail: string) => ({
      ...candidate(sourceNodeId, target.candidateId, target.title, detail),
      summary: target.summary,
    });
    const first = await client.callTool({
      name: 'praxis_submit_product_exploration',
      arguments: {
        operationId: fresh.operationId,
        contract: fresh.contract,
        result: {
          outcome: 'proposal',
          candidates: [refined('It states the outcome the reader asked for.')],
        },
      },
    });
    assert.notEqual(first.isError, true, JSON.stringify(first));
    assert.equal(
      (await readModule(client, project.id)).state.pendingCandidates.find(
        (entry) => entry.candidateId === target.candidateId,
      )?.revision,
      2,
    );

    const second = await client.callTool({
      name: 'praxis_submit_product_exploration',
      arguments: {
        operationId: stale.operationId,
        contract: stale.contract,
        result: {
          outcome: 'proposal',
          candidates: [refined('It restates the outcome a second time.')],
        },
      },
    });
    assert.equal(second.isError, true);
    assert.equal(
      (second.structuredContent as { code: string }).code,
      'STALE_BASIS',
    );
    assert.equal(
      (await readModule(client, project.id)).state.pendingCandidates.find(
        (entry) => entry.candidateId === target.candidateId,
      )?.revision,
      2,
      'the refused submission must not advance the revision again',
    );
  },
);

void test(
  'capabilities advertise refine-candidate as a served preparation operation',
  { timeout: 20_000 },
  async (t) => {
    const client = await connect(t);
    const capabilities = await readMcpJson<{
      modules: Array<{ module: string; preparationOperations: string[] }>;
    }>(client, 'praxis://capabilities');
    const exploration = capabilities.modules.find(
      (entry) => entry.module === 'product-exploration',
    );
    assert.deepEqual(exploration?.preparationOperations, [
      'explore',
      'refine-candidate',
    ]);
  },
);
