import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'mcp-accept-home-'));
process.env.PRAXIS_HOME = REGISTRY_HOME;

const registry = await import('../lib/project-registry.ts');
const { createStartNode } = await import('../lib/graph/task/model.ts');
const { enableMcpEndpoint, readMcpCredentials } =
  await import('../lib/mcp/credentials.ts');
const whatsNextRoute =
  await import('../app/api/projects/[projectId]/whats-next-runs/route.ts');
const { listTaskGraphNodes } = await import('../lib/graph/task/nodes.ts');
const productAcceptance =
  await import('../lib/modules/product-discovery/acceptance.ts');
const productRuns = await import('../lib/modules/product-discovery/runs.ts');
const scopeAcceptance =
  await import('../lib/modules/scope-decomposition/acceptance.ts');
const scopeRuns = await import('../lib/modules/scope-decomposition/runs.ts');
const { prepareProductExplorationOperation } =
  await import('../lib/mcp/prepare.ts');
const { submitProductExplorationResult } = await import('../lib/mcp/submit.ts');
const { prepareScopeDecompositionOperation } =
  await import('../lib/mcp/prepare-scope-decomposition.ts');
const { submitScopeDecompositionOperation } =
  await import('../lib/mcp/submit-scope-decomposition.ts');
const { startWhatsNextRun } =
  await import('../lib/modules/product-discovery/runs.ts');
const { WHATS_NEXT_HARNESS_ID, WHATS_NEXT_HARNESS_REVISION } =
  await import('../lib/modules/product-discovery/harness.ts');
const { deferredLaunch, settledRun } =
  await import('./helpers/graph-materialization-golden.ts');
const { connectMcpClient, readMcpJson } =
  await import('./helpers/mcp-sdk-host.ts');

const connect = (t: test.TestContext) =>
  connectMcpClient(t, token, 'praxis-accept-client');

test.after(() => rm(REGISTRY_HOME, { recursive: true, force: true }));

await enableMcpEndpoint();
const credentials = await readMcpCredentials();
assert.ok(credentials);
const token = credentials.token;

async function fixture(
  t: test.TestContext,
  scope: 'whats-next' | 'task-graph',
) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mcp-accept-project-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project = await registry.createProject({
    kind: 'standalone',
    name: 'Acceptance fixture',
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
    outputMarkdown: `# ${title}\n\n## Why this direction\n\n- It answers the stated need directly.\n- It can be judged without more evidence.\n\n## Assumptions\n\n- The reader already has the source material.`,
    layer: 'discovery' as const,
    artifactKind: 'mvp' as const,
  };
}

async function publishExploration(
  project: never,
  sourceNodeId: string,
  entries: Array<[string, string]>,
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
    {
      outcome: 'proposal',
      candidates: entries.map(([localKey, title]) =>
        explorationCandidate(sourceNodeId, localKey, title),
      ),
    },
  );
  return record;
}

async function publishDecomposition(
  project: never,
  sourceNodeId: string,
  entries: Array<[string, string]>,
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
      candidates: entries.map(([localKey, title]) => ({
        localKey,
        type: 'module',
        title,
        summary: 'One bounded unit of work with a judgeable outcome.',
        derivedFrom: [{ kind: 'node' as const, id: sourceNodeId }],
        dependsOn: [],
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

type PendingCandidate = {
  runId: string;
  candidateId: string;
  revision: number;
  uid: string | null;
  title: string;
  acceptance: { acceptable: boolean; reason: string | null };
};

type ModuleState = {
  state: {
    entities: Array<{ id: string; title: string }>;
    pendingCandidates: PendingCandidate[];
    acceptanceTool: string;
  };
};

async function readModule(
  client: Awaited<ReturnType<typeof connect>>,
  projectId: string,
  module: string,
) {
  return readMcpJson<ModuleState>(
    client,
    `praxis://projects/${projectId}/modules/${module}`,
  );
}

void test(
  'a client reads a pending Candidate, accepts it and discovers the formal Node',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'whats-next');
    await publishExploration(project as never, sourceNodeId, [
      ['first', 'Import the reading list'],
      ['second', 'Show the reading list'],
    ]);
    const client = await connect(t);

    const before = await readModule(client, project.id, 'product-exploration');
    assert.equal(before.state.acceptanceTool, 'praxis_accept_candidate');
    assert.equal(before.state.pendingCandidates.length, 2);
    const pending = before.state.pendingCandidates.find(
      (candidate) => candidate.title === 'Import the reading list',
    );
    assert.ok(pending, 'the module readback must name the Candidate to accept');
    assert.match(pending.runId, /^RUN-[0-9a-f-]{36}$/);
    assert.match(pending.candidateId, /^CANDIDATE-/);
    assert.equal(pending.revision, 1);
    assert.ok(pending.uid);
    assert.deepEqual(pending.acceptance, { acceptable: true, reason: null });
    assert.equal(
      before.state.entities.filter((entity) => entity.title === pending.title)
        .length,
      0,
      'publication alone must not promote a Node',
    );

    const accepted = await client.callTool({
      name: 'praxis_accept_candidate',
      arguments: {
        projectId: project.id,
        module: 'product-exploration',
        runId: pending.runId,
        candidateId: pending.candidateId,
        expectedRevision: pending.revision,
      },
    });
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    const outcome = accepted.structuredContent as {
      created: boolean;
      node: {
        id: string;
        uid: string;
        title: string;
        status: string;
        layer: string | null;
        provenance: { candidateId: string; runId: string } | null;
        artifacts: Array<{ uri: string }>;
      };
    };
    assert.equal(outcome.created, true);
    assert.equal(outcome.node.title, 'Import the reading list');
    assert.equal(outcome.node.status, 'accepted');
    assert.equal(outcome.node.uid, pending.uid);
    assert.equal(outcome.node.provenance?.candidateId, pending.candidateId);
    assert.equal(outcome.node.provenance?.runId, pending.runId);
    assert.ok(outcome.node.artifacts.length > 0);
    for (const artifact of outcome.node.artifacts) {
      const read = await client.readResource({ uri: artifact.uri });
      assert.equal(read.contents[0]?.uri, artifact.uri);
    }

    const after = await readModule(client, project.id, 'product-exploration');
    assert.equal(
      after.state.entities.some((entity) => entity.id === outcome.node.id),
      true,
      'the accepted Node must be discoverable in the module readback',
    );
    assert.deepEqual(
      after.state.pendingCandidates.map((candidate) => candidate.title),
      ['Show the reading list'],
      'only the accepted Candidate leaves the pending list',
    );
  },
);

void test(
  'a stale expected revision refuses acceptance and changes nothing',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'whats-next');
    await publishExploration(project as never, sourceNodeId, [
      ['first', 'Import the reading list'],
      ['second', 'Show the reading list'],
    ]);
    const client = await connect(t);
    const before = await readModule(client, project.id, 'product-exploration');
    const pending = before.state.pendingCandidates[0]!;
    const nodesBefore = await listTaskGraphNodes(project, 'whats-next');

    const refused = await client.callTool({
      name: 'praxis_accept_candidate',
      arguments: {
        projectId: project.id,
        module: 'product-exploration',
        runId: pending.runId,
        candidateId: pending.candidateId,
        expectedRevision: pending.revision + 1,
      },
    });
    assert.equal(refused.isError, true);
    assert.equal(
      (refused.structuredContent as { code: string }).code,
      'RESOURCE_CHANGED',
    );
    assert.deepEqual(
      (await listTaskGraphNodes(project, 'whats-next')).map((node) => node.id),
      nodesBefore.map((node) => node.id),
      'a refused acceptance must leave every Node unchanged',
    );
    const after = await readModule(client, project.id, 'product-exploration');
    assert.equal(after.state.pendingCandidates.length, 2);
  },
);

void test(
  'a repeated acceptance returns the same Node rather than a duplicate',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'whats-next');
    await publishExploration(project as never, sourceNodeId, [
      ['first', 'Import the reading list'],
    ]);
    const client = await connect(t);
    const pending = (
      await readModule(client, project.id, 'product-exploration')
    ).state.pendingCandidates[0]!;
    const args = {
      projectId: project.id,
      module: 'product-exploration',
      runId: pending.runId,
      candidateId: pending.candidateId,
      expectedRevision: pending.revision,
    };
    const first = await client.callTool({
      name: 'praxis_accept_candidate',
      arguments: args,
    });
    const second = await client.callTool({
      name: 'praxis_accept_candidate',
      arguments: args,
    });
    assert.notEqual(second.isError, true, JSON.stringify(second));
    const firstNode = (first.structuredContent as { node: { id: string } })
      .node;
    const retried = second.structuredContent as {
      created: boolean;
      node: { id: string };
    };
    assert.equal(retried.node.id, firstNode.id);
    assert.equal(retried.created, false);
    assert.equal(
      (await listTaskGraphNodes(project, 'whats-next')).filter(
        (node) => node.provenance?.candidateId === pending.candidateId,
      ).length,
      1,
      'a retry must not promote a second Node',
    );
  },
);

void test(
  'an unknown Candidate and an unserved module are refused without a change',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'whats-next');
    const record = await publishExploration(project as never, sourceNodeId, [
      ['first', 'Import the reading list'],
    ]);
    const client = await connect(t);
    const missing = await client.callTool({
      name: 'praxis_accept_candidate',
      arguments: {
        projectId: project.id,
        module: 'product-exploration',
        runId: record.runId,
        candidateId: 'CANDIDATE-ffffffff',
        expectedRevision: 1,
      },
    });
    assert.equal(missing.isError, true);
    assert.equal(
      (missing.structuredContent as { code: string }).code,
      'RESOURCE_NOT_FOUND',
    );

    const unserved = await client.callTool({
      name: 'praxis_accept_candidate',
      arguments: {
        projectId: project.id,
        module: 'domain-modeling',
        runId: record.runId,
        candidateId: 'CANDIDATE-ffffffff',
        expectedRevision: 1,
      },
    });
    assert.equal(unserved.isError, true);
    assert.match(JSON.stringify(unserved), /module/);
    assert.equal(
      (await listTaskGraphNodes(project, 'whats-next')).length,
      1,
      'only the source Node exists after two refusals',
    );
  },
);

void test(
  'Scope Decomposition Candidates are accepted through the same tool',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'task-graph');
    await publishDecomposition(project as never, sourceNodeId, [
      ['first', 'Import the reading list'],
      ['second', 'Show the reading list'],
    ]);
    const client = await connect(t);
    const before = await readModule(client, project.id, 'scope-decomposition');
    assert.equal(before.state.pendingCandidates.length, 2);
    const pending = before.state.pendingCandidates[0]!;
    const accepted = await client.callTool({
      name: 'praxis_accept_candidate',
      arguments: {
        projectId: project.id,
        module: 'scope-decomposition',
        runId: pending.runId,
        candidateId: pending.candidateId,
        expectedRevision: pending.revision,
      },
    });
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    const node = (accepted.structuredContent as { node: { id: string } }).node;
    const after = await readModule(client, project.id, 'scope-decomposition');
    assert.equal(
      after.state.entities.some((entity) => entity.id === node.id),
      true,
    );
    assert.equal(after.state.pendingCandidates.length, 1);
  },
);

void test(
  'the existing UI acceptance route promotes through the same service',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'whats-next');
    await publishExploration(project as never, sourceNodeId, [
      ['first', 'Import the reading list'],
    ]);
    assert.equal(
      productRuns.acceptWhatsNextCandidate,
      productAcceptance.acceptProductExplorationCandidate,
      'the UI export and the MCP service must be the same function',
    );
    assert.equal(
      scopeRuns.acceptTaskDecompositionCandidate,
      scopeAcceptance.acceptScopeDecompositionCandidate,
    );
    const pending = (
      await productAcceptance.listPendingProductExplorationCandidates(project)
    )[0]!;
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
            action: 'accept',
            runId: pending.runId,
            candidateId: pending.candidateId,
          }),
        },
      ),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { node: { id: string } };
    const client = await connect(t);
    const after = await readModule(client, project.id, 'product-exploration');
    assert.equal(
      after.state.entities.some((entity) => entity.id === body.node.id),
      true,
      'a UI acceptance must be visible through the MCP readback',
    );
    assert.deepEqual(after.state.pendingCandidates, []);
  },
);

void test(
  'a superseded Scope Run cannot accept the revision it published',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'task-graph');
    await publishDecomposition(project as never, sourceNodeId, [
      ['first', 'Import the reading list'],
    ]);
    const client = await connect(t);
    const original = (
      await readModule(client, project.id, 'scope-decomposition')
    ).state.pendingCandidates[0]!;

    const { record } = await prepareScopeDecompositionOperation(project, {
      userInput: 'Sharpen the first unit.',
      sourceNodeId,
      operation: 'revise-candidate',
      candidateIds: [original.candidateId],
    } as never);
    await submitScopeDecompositionOperation(
      project,
      record.operationId,
      record.contract,
      {
        outcome: 'proposal',
        candidates: [
          {
            localKey: original.candidateId,
            type: 'module',
            title: 'Import the reading list, precisely',
            summary: 'One bounded unit of work with a judgeable outcome.',
            derivedFrom: [{ kind: 'node' as const, id: sourceNodeId }],
            dependsOn: [],
            resources: [],
            typeTemplateRef: null,
            metadata: {},
            presentation: {},
            assumptions: [],
          },
        ],
      },
    );

    const current = (
      await readModule(client, project.id, 'scope-decomposition')
    ).state.pendingCandidates[0]!;
    assert.equal(current.candidateId, original.candidateId);
    assert.equal(current.revision, original.revision + 1);
    assert.notEqual(current.runId, original.runId);

    const stale = await client.callTool({
      name: 'praxis_accept_candidate',
      arguments: {
        projectId: project.id,
        module: 'scope-decomposition',
        runId: original.runId,
        candidateId: original.candidateId,
        expectedRevision: original.revision,
      },
    });
    assert.equal(stale.isError, true, JSON.stringify(stale));
    assert.equal(
      (stale.structuredContent as { code: string }).code,
      'RESOURCE_CHANGED',
    );
    assert.deepEqual(
      (await listTaskGraphNodes(project)).map((node) => node.role),
      ['start'],
      'a superseded Run must promote no formal Node',
    );

    const accepted = await client.callTool({
      name: 'praxis_accept_candidate',
      arguments: {
        projectId: project.id,
        module: 'scope-decomposition',
        runId: current.runId,
        candidateId: current.candidateId,
        expectedRevision: current.revision,
      },
    });
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    const node = (
      accepted.structuredContent as {
        node: {
          id: string;
          title: string;
          provenance: { revision: number } | null;
        };
      }
    ).node;
    assert.equal(node.title, 'Import the reading list, precisely');
    assert.equal(node.provenance?.revision, current.revision);
  },
);

void test(
  'a superseded Product Exploration Run cannot accept the revision it published',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t, 'whats-next');
    await publishExploration(project as never, sourceNodeId, [
      ['first', 'Import the reading list'],
    ]);
    const original = (
      await productAcceptance.listPendingProductExplorationCandidates(project)
    )[0]!;

    const refine = deferredLaunch();
    const refined = await startWhatsNextRun(
      project,
      {
        sourceNodeIds: [sourceNodeId],
        agent: 'codex' as const,
        instruction: 'Sharpen the outcome statement.',
        contextRefs: [],
        files: [],
        intention: 'mvp-exploration' as const,
        revisionRunId: original.runId,
        revisionCandidateId: original.candidateId,
      },
      refine.launch,
    );
    refine.respond(
      JSON.stringify({
        schemaVersion: 1,
        harness: {
          id: WHATS_NEXT_HARNESS_ID,
          revision: WHATS_NEXT_HARNESS_REVISION,
        },
        request: {
          sessionId: refined.sessionId,
          requestId: refined.requestId,
          inputFingerprint: refined.inputFingerprint,
        },
        reflection: {
          markdown: 'The direction now states one outcome.',
          continuationAdvice: {
            action: 'continue',
            recommendedFocus: 'concretize',
            reason: 'Turn the chosen direction into a bounded outcome.',
          },
        },
        exploration: { consideredNodeIds: [sourceNodeId], notes: [] },
        outcome: 'proposal',
        candidates: [
          {
            candidateId: original.candidateId,
            revision: original.revision + 1,
            type: 'mvp',
            title: 'Import the reading list, precisely',
            summary: 'One bounded outcome the reader asked for.',
            derivedFrom: [sourceNodeId],
            dependsOn: [],
            resources: [],
            typeTemplateRef: null,
            metadata: {},
            presentation: {},
            assumptions: ['The reader already has the source material.'],
            outputMarkdown:
              '# Import the reading list, precisely\n\n## Why this direction\n\n- It states the outcome the reader asked for.\n- It remains judgeable without more evidence.\n\n## Assumptions\n\n- The reader already has the source material.\n',
            layer: 'discovery',
            artifactKind: 'mvp',
          },
        ],
      }),
    );
    const settled = await settledRun(project, refined.runId);
    assert.equal(settled.status, 'proposal', settled.error ?? undefined);

    const current = (
      await productAcceptance.listPendingProductExplorationCandidates(project)
    )[0]!;
    assert.equal(current.candidateId, original.candidateId);
    assert.equal(current.revision, original.revision + 1);
    assert.notEqual(current.runId, original.runId);

    await assert.rejects(
      () =>
        productAcceptance.acceptProductExplorationCandidate(
          project,
          original.runId,
          original.candidateId,
          { expectedRevision: original.revision },
        ),
      (error: Error) => {
        assert.match(error.message, /revision/);
        return true;
      },
    );
    assert.deepEqual(
      (await listTaskGraphNodes(project, 'whats-next')).map(
        (node) => node.role,
      ),
      ['start'],
      'a superseded Run must promote no formal Node',
    );

    const accepted = await productAcceptance.acceptProductExplorationCandidate(
      project,
      current.runId,
      current.candidateId,
      { expectedRevision: current.revision },
    );
    assert.equal(accepted.created, true);
    assert.equal(accepted.node.title, 'Import the reading list, precisely');
    assert.equal(accepted.node.provenance?.revision, current.revision);
  },
);
