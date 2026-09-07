import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'mcp-discard-home-'));
process.env.PRAXIS_HOME = REGISTRY_HOME;

const registry = await import('../lib/project-registry.ts');
const { createStartNode } = await import('../lib/graph/task/model.ts');
const { enableMcpEndpoint, readMcpCredentials } =
  await import('../lib/mcp/credentials.ts');
const whatsNextRoute =
  await import('../app/api/projects/[projectId]/whats-next-runs/route.ts');
const { listTaskGraphNodes } = await import('../lib/graph/task/nodes.ts');
const productDiscard =
  await import('../lib/modules/product-discovery/discard.ts');
const productRuns = await import('../lib/modules/product-discovery/runs.ts');
const scopeDiscard =
  await import('../lib/modules/scope-decomposition/discard.ts');
const scopeRuns = await import('../lib/modules/scope-decomposition/runs.ts');
const productAcceptance =
  await import('../lib/modules/product-discovery/acceptance.ts');
const { prepareProductExplorationOperation } =
  await import('../lib/mcp/prepare.ts');
const { submitProductExplorationResult } = await import('../lib/mcp/submit.ts');
const { prepareScopeDecompositionOperation } =
  await import('../lib/mcp/prepare-scope-decomposition.ts');
const { submitScopeDecompositionOperation } =
  await import('../lib/mcp/submit-scope-decomposition.ts');
const { connectMcpClient, readMcpJson } =
  await import('./helpers/mcp-sdk-host.ts');

test.after(() => rm(REGISTRY_HOME, { recursive: true, force: true }));

await enableMcpEndpoint();
const credentials = await readMcpCredentials();
assert.ok(credentials);
const token = credentials.token;

const connect = (t: test.TestContext) =>
  connectMcpClient(t, token, 'praxis-discard-client');

type PendingCandidate = {
  runId: string;
  candidateId: string;
  revision: number;
  title: string;
};

type ModuleState = {
  state: {
    entities: Array<{ id: string; title: string }>;
    pendingCandidates: PendingCandidate[];
    discardTool: string;
  };
};

async function fixture(
  t: test.TestContext,
  scope: 'whats-next' | 'task-graph',
) {
  const rootPath = await mkdtemp(
    path.join(os.tmpdir(), 'mcp-discard-project-'),
  );
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project = await registry.createProject({
    kind: 'standalone',
    name: 'Discard fixture',
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
    scope,
  );
  return { project, sourceNodeId: start.node.id };
}

function explorationCandidate(
  sourceNodeId: string,
  localKey: string,
  title: string,
  dependsOn: string[] = [],
) {
  return {
    localKey,
    type: 'mvp',
    title,
    summary: 'One bounded outcome the reader asked for.',
    derivedFrom: [{ kind: 'node' as const, id: sourceNodeId }],
    dependsOn: dependsOn.map((localKey) => ({
      kind: 'proposal' as const,
      localKey,
    })),
    resources: [],
    typeTemplateRef: null,
    metadata: {},
    presentation: {},
    assumptions: ['The reader already has the source material.'],
    outputMarkdown: `# ${title}\n\n## Why this direction\n\n- It answers the stated need directly.\n- It can be judged without more evidence.\n\n## Assumptions\n\n- The reader already has the source material.`,
    layer: 'discovery' as const,
    artifactKind: 'mvp' as const,
  };
}

async function publishExploration(
  project: never,
  sourceNodeId: string,
  candidates: Array<Record<string, unknown>>,
) {
  const { record } = await prepareProductExplorationOperation(project, {
    userInput: 'Explore bounded MVPs.',
    layer: 'discovery',
    sourceNodeIds: [sourceNodeId],
  });
  await submitProductExplorationResult(
    project,
    record.operationId,
    record.contract,
    { outcome: 'proposal', candidates },
  );
  return record;
}

async function publishDecomposition(
  project: never,
  sourceNodeId: string,
  entries: Array<[string, string, string[]?]>,
) {
  const { record } = await prepareScopeDecompositionOperation(project, {
    userInput: 'Break this down.',
    sourceNodeId,
  } as never);
  await submitScopeDecompositionOperation(
    project,
    record.operationId,
    record.contract,
    {
      outcome: 'proposal',
      candidates: entries.map(([localKey, title, dependsOn]) => ({
        localKey,
        type: 'module',
        title,
        summary: 'One bounded unit of work with a judgeable outcome.',
        derivedFrom: [{ kind: 'node' as const, id: sourceNodeId }],
        dependsOn: (dependsOn ?? []).map((localKey) => ({
          kind: 'proposal' as const,
          localKey,
        })),
        resources: [],
        typeTemplateRef: null,
        metadata: {},
        presentation: {},
        assumptions: [],
      })),
    },
  );
  return record;
}

const readModule = (
  client: Awaited<ReturnType<typeof connect>>,
  projectId: string,
  module: string,
) =>
  readMcpJson<ModuleState>(
    client,
    `praxis://projects/${projectId}/modules/${module}`,
  );

void test(
  'a client discards one Candidate and the other proposal survives',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'whats-next');
    await publishExploration(project as never, sourceNodeId, [
      explorationCandidate(sourceNodeId, 'first', 'Import the reading list'),
      explorationCandidate(sourceNodeId, 'second', 'Show the reading list'),
    ]);
    const client = await connect(t);
    const before = await readModule(client, project.id, 'product-exploration');
    assert.equal(before.state.discardTool, 'praxis_discard_candidate');
    assert.equal(before.state.pendingCandidates.length, 2);
    const target = before.state.pendingCandidates.find(
      (candidate) => candidate.title === 'Import the reading list',
    );
    const survivor = before.state.pendingCandidates.find(
      (candidate) => candidate.title === 'Show the reading list',
    );
    assert.ok(target && survivor);

    const discarded = await client.callTool({
      name: 'praxis_discard_candidate',
      arguments: {
        projectId: project.id,
        module: 'product-exploration',
        runId: target.runId,
        candidateId: target.candidateId,
        expectedRevision: target.revision,
      },
    });
    assert.notEqual(discarded.isError, true, JSON.stringify(discarded));
    const outcome = discarded.structuredContent as {
      discarded: boolean;
      alreadyAbsent: boolean;
      runDeleted: boolean;
      deletedRunIds: string[];
      remainingCandidates: PendingCandidate[];
    };
    assert.equal(outcome.discarded, true);
    assert.equal(outcome.alreadyAbsent, false);
    assert.equal(outcome.runDeleted, false);
    assert.deepEqual(outcome.deletedRunIds, []);
    assert.deepEqual(
      outcome.remainingCandidates.map((candidate) => candidate.candidateId),
      [survivor.candidateId],
    );

    const after = await readModule(client, project.id, 'product-exploration');
    assert.deepEqual(
      after.state.pendingCandidates.map((candidate) => candidate.title),
      ['Show the reading list'],
    );
    await assert.rejects(
      () =>
        access(
          path.join(
            project.planningPath,
            'whats-next',
            'runs',
            target.runId,
            'candidates',
            target.candidateId,
          ),
        ),
      'the discarded Candidate directory must be gone',
    );
    await access(
      path.join(
        project.planningPath,
        'whats-next',
        'runs',
        target.runId,
        'candidates',
        survivor.candidateId,
      ),
    );
  },
);

void test(
  'a repeated discard reports an already-absent result and changes nothing',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'whats-next');
    await publishExploration(project as never, sourceNodeId, [
      explorationCandidate(sourceNodeId, 'first', 'Import the reading list'),
      explorationCandidate(sourceNodeId, 'second', 'Show the reading list'),
    ]);
    const client = await connect(t);
    const target = (await readModule(client, project.id, 'product-exploration'))
      .state.pendingCandidates[0]!;
    const args = {
      projectId: project.id,
      module: 'product-exploration',
      runId: target.runId,
      candidateId: target.candidateId,
      expectedRevision: target.revision,
    };
    await client.callTool({
      name: 'praxis_discard_candidate',
      arguments: args,
    });
    const before = await readModule(client, project.id, 'product-exploration');

    const repeat = await client.callTool({
      name: 'praxis_discard_candidate',
      arguments: args,
    });
    assert.notEqual(repeat.isError, true, JSON.stringify(repeat));
    const outcome = repeat.structuredContent as {
      discarded: boolean;
      alreadyAbsent: boolean;
      remainingCandidates: PendingCandidate[];
    };
    assert.equal(outcome.discarded, false);
    assert.equal(outcome.alreadyAbsent, true);
    assert.deepEqual(
      outcome.remainingCandidates.map((candidate) => candidate.candidateId),
      before.state.pendingCandidates.map((candidate) => candidate.candidateId),
    );
    const after = await readModule(client, project.id, 'product-exploration');
    assert.deepEqual(
      after.state.pendingCandidates,
      before.state.pendingCandidates,
      'a repeated discard must not touch anything else',
    );
  },
);

void test(
  'a referenced Candidate keeps its dependency blocker and is not partially removed',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'task-graph');
    await publishDecomposition(project as never, sourceNodeId, [
      ['first', 'Import the reading list'],
      ['second', 'Show the reading list', ['first']],
    ]);
    const client = await connect(t);
    const before = await readModule(client, project.id, 'scope-decomposition');
    const prerequisite = before.state.pendingCandidates.find(
      (candidate) => candidate.title === 'Import the reading list',
    );
    const dependent = before.state.pendingCandidates.find(
      (candidate) => candidate.title === 'Show the reading list',
    );
    assert.ok(prerequisite && dependent);

    const refused = await client.callTool({
      name: 'praxis_discard_candidate',
      arguments: {
        projectId: project.id,
        module: 'scope-decomposition',
        runId: prerequisite.runId,
        candidateId: prerequisite.candidateId,
        expectedRevision: prerequisite.revision,
      },
    });
    assert.equal(refused.isError, true);
    const envelope = refused.structuredContent as {
      code: string;
      detail: string;
    };
    assert.equal(envelope.code, 'PUBLICATION_FAILED');
    assert.match(envelope.detail, new RegExp(dependent.candidateId));
    assert.match(envelope.detail, /nothing was removed/);

    const after = await readModule(client, project.id, 'scope-decomposition');
    assert.deepEqual(
      after.state.pendingCandidates.map((candidate) => candidate.candidateId),
      before.state.pendingCandidates.map((candidate) => candidate.candidateId),
      'a blocked discard must leave every Candidate in place',
    );
    for (const candidate of before.state.pendingCandidates)
      await access(
        path.join(
          project.planningPath,
          'task-decomposition',
          'runs',
          candidate.runId,
          'candidates',
          candidate.candidateId,
        ),
      );
  },
);

void test(
  'a stale expected revision is refused and an accepted Candidate is not discardable',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'whats-next');
    await publishExploration(project as never, sourceNodeId, [
      explorationCandidate(sourceNodeId, 'first', 'Import the reading list'),
      explorationCandidate(sourceNodeId, 'second', 'Show the reading list'),
    ]);
    const client = await connect(t);
    const before = await readModule(client, project.id, 'product-exploration');
    const target = before.state.pendingCandidates[0]!;

    const stale = await client.callTool({
      name: 'praxis_discard_candidate',
      arguments: {
        projectId: project.id,
        module: 'product-exploration',
        runId: target.runId,
        candidateId: target.candidateId,
        expectedRevision: target.revision + 1,
      },
    });
    assert.equal(stale.isError, true);
    assert.equal(
      (stale.structuredContent as { code: string }).code,
      'RESOURCE_CHANGED',
    );
    assert.equal(
      (await readModule(client, project.id, 'product-exploration')).state
        .pendingCandidates.length,
      2,
      'a stale discard must remove nothing',
    );

    await productAcceptance.acceptProductExplorationCandidate(
      project,
      target.runId,
      target.candidateId,
      { expectedRevision: target.revision },
    );
    const accepted = await client.callTool({
      name: 'praxis_discard_candidate',
      arguments: {
        projectId: project.id,
        module: 'product-exploration',
        runId: target.runId,
        candidateId: target.candidateId,
        expectedRevision: target.revision,
      },
    });
    assert.equal(accepted.isError, true);
    assert.match(
      (accepted.structuredContent as { detail: string }).detail,
      /formal Node/,
    );
    assert.equal(
      (await listTaskGraphNodes(project, 'whats-next')).filter(
        (node) => node.provenance?.candidateId === target.candidateId,
      ).length,
      1,
      'the accepted Node must survive a refused discard',
    );
  },
);

void test(
  'discarding the last Candidate removes its Run and reports it',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'task-graph');
    await publishDecomposition(project as never, sourceNodeId, [
      ['only', 'Import the reading list'],
    ]);
    const client = await connect(t);
    const target = (await readModule(client, project.id, 'scope-decomposition'))
      .state.pendingCandidates[0]!;
    const discarded = await client.callTool({
      name: 'praxis_discard_candidate',
      arguments: {
        projectId: project.id,
        module: 'scope-decomposition',
        runId: target.runId,
        candidateId: target.candidateId,
        expectedRevision: target.revision,
      },
    });
    assert.notEqual(discarded.isError, true, JSON.stringify(discarded));
    const outcome = discarded.structuredContent as {
      runDeleted: boolean;
      deletedRunIds: string[];
      remainingCandidates: PendingCandidate[];
    };
    assert.equal(outcome.runDeleted, true);
    assert.deepEqual(outcome.deletedRunIds, [target.runId]);
    assert.deepEqual(outcome.remainingCandidates, []);
    await assert.rejects(
      () =>
        access(
          path.join(
            project.planningPath,
            'task-decomposition',
            'runs',
            target.runId,
          ),
        ),
      'the emptied Run must be removed',
    );
  },
);

void test(
  'the existing UI discard route uses the same service',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'whats-next');
    await publishExploration(project as never, sourceNodeId, [
      explorationCandidate(sourceNodeId, 'first', 'Import the reading list'),
      explorationCandidate(sourceNodeId, 'second', 'Show the reading list'),
    ]);
    assert.equal(
      productRuns.discardWhatsNextCandidate,
      productDiscard.discardProductExplorationCandidate,
      'the UI export and the MCP service must be the same function',
    );
    assert.equal(
      scopeRuns.discardTaskDecompositionCandidate,
      scopeDiscard.discardScopeDecompositionCandidate,
    );
    const client = await connect(t);
    const target = (await readModule(client, project.id, 'product-exploration'))
      .state.pendingCandidates[0]!;
    const response = await whatsNextRoute.PATCH(
      new Request(
        `http://localhost:3000/api/projects/${project.id}/whats-next-runs`,
        {
          method: 'PATCH',
          headers: {
            host: 'localhost:3000',
            origin: 'http://localhost:3000',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            action: 'discard',
            runId: target.runId,
            candidateId: target.candidateId,
          }),
        },
      ),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { candidateId: string };
    assert.equal(body.candidateId, target.candidateId);
    const after = await readModule(client, project.id, 'product-exploration');
    assert.equal(
      after.state.pendingCandidates.some(
        (candidate) => candidate.candidateId === target.candidateId,
      ),
      false,
      'a UI discard must be visible through the MCP readback',
    );
  },
);
