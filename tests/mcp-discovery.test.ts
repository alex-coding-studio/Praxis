import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'mcp-discovery-home-'));
process.env.PRAXIS_HOME = home;
const { createProject } = await import('../lib/project-registry.ts');
const { createStartNode } = await import('../lib/graph/task/model.ts');
const { enableMcpEndpoint, readMcpCredentials } =
  await import('../lib/mcp/credentials.ts');
const { connectMcpClient } = await import('./helpers/mcp-sdk-host.ts');
await enableMcpEndpoint();
const token = (await readMcpCredentials())!.token;
test.after(() => rm(home, { recursive: true, force: true }));

type Client = Awaited<ReturnType<typeof connectMcpClient>>;
async function call<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent as T;
}
type Prepared = {
  operationId: string;
  contract: { id: string; version: number; hash: string };
};
type Candidate = {
  candidateId: string;
  revision: number;
  runId: string;
  title: string;
  documentUri: string;
};
type Page<T> = { items: T[]; nextCursor: string | null; revision: string };
type Document = {
  title: string;
  artifactId: string;
  uri: string;
  section: string;
};
type ReadPage = { text: string; nextCursor: string | null; revision: string };
async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(
    path.join(os.tmpdir(), 'mcp-discovery-project-'),
  );
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project = await createProject({
    kind: 'standalone',
    name: 'Discovery',
    description: '',
    rootPath,
  });
  return { project, client: await connectMcpClient(t, token) };
}

void test('SDK discovers current context handles, pages UTF-8 text and freezes returned handles without paths', async (t) => {
  const { project, client } = await fixture(t);
  const directory = path.join(project.planningPath, 'context', 'rules');
  await mkdir(directory, { recursive: true });
  const body = '# Pricing\n\n' + '领料价格。'.repeat(50);
  await writeFile(path.join(directory, 'pricing.md'), body);
  await writeFile(path.join(directory, 'tax.md'), '# Tax\n\nTax rules.');
  const first = await call<Page<Document>>(client, 'praxis_list_context', {
    projectId: project.id,
    limit: 1,
  });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await call<Page<Document>>(client, 'praxis_list_context', {
    projectId: project.id,
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.notEqual(first.items[0]!.artifactId, second.items[0]!.artifactId);
  assert.equal(second.nextCursor, null);
  const pricing = [...first.items, ...second.items].find(
    (d) => d.title === 'Pricing',
  )!;
  let cursor: string | undefined;
  let text = '';
  do {
    const page = await call<ReadPage>(client, 'praxis_read_resource', {
      uri: pricing.uri,
      limitBytes: 37,
      ...(cursor ? { cursor } : {}),
    });
    text += page.text;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(text, body);
  const prepared = await call<
    Prepared & { context: { resources: Array<{ uri: string }> } }
  >(client, 'praxis_prepare', {
    projectId: project.id,
    module: 'domain-modeling',
    request: {
      userInput: 'Use pricing rules',
      contextIds: [pricing.artifactId],
    },
  });
  assert.ok(prepared.operationId);
  await writeFile(path.join(directory, 'pricing.md'), '# Changed');
  const frozen = await call<ReadPage>(client, 'praxis_read_resource', {
    uri: prepared.context.resources[0]!.uri,
  });
  assert.equal(frozen.text, body);
  const stale = await client.callTool({
    name: 'praxis_list_context',
    arguments: { projectId: project.id, cursor: first.nextCursor },
  });
  assert.equal(stale.isError, true);
  assert.equal(
    (stale.structuredContent as { code?: string })?.code,
    'RESOURCE_CHANGED',
  );
  const other = await fixture(t);
  const isolated = await call<Page<Document>>(
    other.client,
    'praxis_list_context',
    { projectId: other.project.id },
  );
  assert.deepEqual(isolated.items, []);
  const otherRead = await other.client.callTool({
    name: 'praxis_read_resource',
    arguments: { uri: pricing.uri.replace(project.id, other.project.id) },
  });
  assert.equal(otherRead.isError, true);
  const crossProject = await other.client.callTool({
    name: 'praxis_list_context',
    arguments: { projectId: other.project.id, cursor: first.nextCursor },
  });
  assert.equal(crossProject.isError, true);
});

function proposal(sourceId: string, localKey: string, title: string) {
  return {
    localKey,
    type: 'module',
    title,
    summary: `${title} scope`,
    derivedFrom: [{ kind: 'node', id: sourceId }],
    dependsOn: [],
    resources: [],
    typeTemplateRef: null,
    metadata: {},
    presentation: {},
    assumptions: [],
  };
}
void test('SDK discovers pending Candidates and recomposes split, retain and merge without disturbing unselected work', async (t) => {
  const { project, client } = await fixture(t);
  const start = await createStartNode(
    project,
    { title: 'Source', idea: 'A module', contextRefs: [], files: [] },
    'task-graph',
  );
  const run = async (request: Record<string, unknown>, result: unknown) => {
    const prepared = await call<Prepared>(client, 'praxis_prepare', {
      projectId: project.id,
      module: 'scope-decomposition',
      request: {
        userInput: 'Reorganize the scope',
        sourceNodeId: start.node.id,
        ...request,
      },
    });
    return call(client, 'praxis_submit_scope_decomposition', {
      operationId: prepared.operationId,
      contract: prepared.contract,
      result,
    });
  };
  const list = () =>
    call<Page<Candidate>>(client, 'praxis_list_candidates', {
      projectId: project.id,
      module: 'scope-decomposition',
    });
  await run(
    {},
    {
      outcome: 'proposal',
      candidates: ['Combined', 'Keep', 'Untouched'].map((title) =>
        proposal(start.node.id, title.toLowerCase(), title),
      ),
    },
  );
  const initial = (await list()).items;
  const combined = initial.find((c) => c.title === 'Combined')!;
  const keep = initial.find((c) => c.title === 'Keep')!;
  const untouched = initial.find((c) => c.title === 'Untouched')!;
  const firstPage = await call<Page<Candidate>>(
    client,
    'praxis_list_candidates',
    { projectId: project.id, module: 'scope-decomposition', limit: 1 },
  );
  assert.ok(firstPage.nextCursor);
  const remaining = await call<Page<Candidate>>(
    client,
    'praxis_list_candidates',
    {
      projectId: project.id,
      module: 'scope-decomposition',
      cursor: firstPage.nextCursor,
    },
  );
  assert.deepEqual([...firstPage.items, ...remaining.items], initial);
  const body = await call<ReadPage>(client, 'praxis_read_resource', {
    uri: combined.documentUri,
  });
  assert.match(body.text, /Combined/);
  await run(
    {
      operation: 'recompose-candidates',
      candidateIds: [combined.candidateId, keep.candidateId],
    },
    {
      outcome: 'proposal',
      candidates: [
        proposal(start.node.id, 'input', 'Input'),
        proposal(start.node.id, 'output', 'Output'),
      ],
      recomposition: {
        effects: [
          {
            kind: 'split',
            from: [{ kind: 'candidate', id: combined.candidateId }],
            to: [
              { kind: 'proposal', localKey: 'input' },
              { kind: 'proposal', localKey: 'output' },
            ],
          },
          {
            kind: 'retain',
            from: [{ kind: 'candidate', id: keep.candidateId }],
            to: [{ kind: 'candidate', id: keep.candidateId }],
          },
        ],
      },
    },
  );
  const obsolete = await client.callTool({
    name: 'praxis_list_candidates',
    arguments: {
      projectId: project.id,
      module: 'scope-decomposition',
      cursor: firstPage.nextCursor,
    },
  });
  assert.equal(obsolete.isError, true);
  const split = (await list()).items;
  assert.deepEqual(split.map((c) => c.title).sort(), [
    'Input',
    'Keep',
    'Output',
    'Untouched',
  ]);
  assert.deepEqual(
    split.find((c) => c.candidateId === keep.candidateId),
    keep,
  );
  assert.deepEqual(
    split.find((c) => c.candidateId === untouched.candidateId),
    untouched,
  );
  const parts = split.filter((c) => ['Input', 'Output'].includes(c.title));
  await run(
    {
      operation: 'recompose-candidates',
      candidateIds: parts.map((c) => c.candidateId),
    },
    {
      outcome: 'proposal',
      candidates: [proposal(start.node.id, 'merged', 'Merged')],
      recomposition: {
        effects: [
          {
            kind: 'merge',
            from: parts.map((c) => ({ kind: 'candidate', id: c.candidateId })),
            to: [{ kind: 'proposal', localKey: 'merged' }],
          },
        ],
      },
    },
  );
  assert.deepEqual((await list()).items.map((c) => c.title).sort(), [
    'Keep',
    'Merged',
    'Untouched',
  ]);
});
