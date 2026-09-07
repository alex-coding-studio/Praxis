import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'mcp-accept-home-'));
process.env.PRAXIS_HOME = REGISTRY_HOME;

const registry = await import('../lib/project-registry.ts');
const { createStartNode } = await import('../lib/graph/task/model.ts');
const { enableMcpEndpoint, readMcpCredentials } =
  await import('../lib/mcp/credentials.ts');
const route = await import('../app/api/mcp/route.ts');
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
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } =
  await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

test.after(() => rm(REGISTRY_HOME, { recursive: true, force: true }));

await enableMcpEndpoint();
const credentials = await readMcpCredentials();
assert.ok(credentials);
const token = credentials.token;

async function listen(t: test.TestContext) {
  const server: HttpServer = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      void (async () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (typeof value === 'string') headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(','));
        const method = incoming.method ?? 'GET';
        const request = new Request(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}${incoming.url ?? '/'}`,
          {
            method,
            headers,
            body:
              method === 'GET' || method === 'HEAD' || chunks.length === 0
                ? undefined
                : Buffer.concat(chunks),
          },
        );
        const handler =
          method === 'POST'
            ? route.POST
            : method === 'DELETE'
              ? route.DELETE
              : route.GET;
        const response = await handler(request);
        outgoing.statusCode = response.status;
        response.headers.forEach((value, name) =>
          outgoing.setHeader(name, value),
        );
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`;
}

async function connect(t: test.TestContext) {
  const client = new Client({ name: 'praxis-accept-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(await listen(t)),
    {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    },
  );
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

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
  const read = await client.readResource({
    uri: `praxis://projects/${projectId}/modules/${module}`,
  });
  return JSON.parse((read.contents[0] as { text: string }).text) as ModuleState;
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
