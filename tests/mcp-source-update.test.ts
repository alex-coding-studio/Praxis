import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const home = mkdtempSync(path.join(os.tmpdir(), 'source-update-home-'));
process.env.PRAXIS_HOME = home;
test.after(() => rm(home, { recursive: true, force: true }));
const { createProject } = await import('../lib/project-registry.ts');
const { createStartNode } = await import('../lib/graph/task/model.ts');
const { createPraxisMcpServer } = await import('../lib/mcp/server.ts');
const { prepareProductExplorationOperation } =
  await import('../lib/mcp/prepare.ts');
const { readOperationSource } = await import('../lib/mcp/catalog.ts');
const { submitProductExplorationResult } = await import('../lib/mcp/submit.ts');
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await createProject({
    rootPath: root,
    kind: 'standalone',
    name: 'Source test',
    description: '',
  });
  const { node } = await createStartNode(
    project,
    {
      title: 'Brief',
      contextRefs: [],
      files: [new File(['Original A'], 'a.md'), new File(['Keep B'], 'b.md')],
    },
    'whats-next',
  );
  const server = createPraxisMcpServer(),
    client = new Client({ name: 'source-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const key = {
    projectId: project.id,
    module: 'product-exploration',
    nodeId: node.id,
  };
  const read = await client.callTool({
    name: 'praxis_read_source',
    arguments: key,
  });
  assert.notEqual(read.isError, true, JSON.stringify(read));
  const source = read.structuredContent as {
    revision: string;
    resources: Array<{ path: string; uri: string }>;
  };
  return { project, node, client, key, source };
}
void test(
  'source replacement preserves identity, unselected attachments and frozen evidence',
  { timeout: 20000 },
  async (t) => {
    const { project, node, client, key, source } = await fixture(t);
    const first = source.resources[0]!,
      other = source.resources[1]!;
    const prepared = await prepareProductExplorationOperation(project, {
      layer: 'discovery',
      userInput: 'Use source',
      sourceNodeIds: [node.id],
    });
    const frozen = prepared.record.sources.find(
      (s) => s.logicalPath === first.path,
    )!;
    const updated = await client.callTool({
      name: 'praxis_update_source',
      arguments: {
        ...key,
        expectedRevision: source.revision,
        attachments: [
          { fileName: 'a.md', markdown: 'Updated A', replaces: first.path },
        ],
      },
    });
    assert.notEqual(updated.isError, true, JSON.stringify(updated));
    const next = updated.structuredContent as {
      nodeId: string;
      revision: string;
      resources: Array<{ path: string; uri: string }>;
    };
    assert.equal(next.nodeId, node.id);
    assert.equal(
      await readFile(path.join(project.planningPath, first.path), 'utf8'),
      'Original A',
      'old source references remain readable',
    );
    assert.notEqual(next.revision, source.revision);
    assert.ok(next.resources.some((r) => r.path === other.path));
    const replacement = next.resources.find((r) => r.path !== other.path)!;
    assert.equal(
      (
        (await client.readResource({ uri: replacement.uri })).contents[0] as {
          text: string;
        }
      ).text,
      'Updated A',
    );
    assert.equal(
      (
        (await client.readResource({ uri: other.uri })).contents[0] as {
          text: string;
        }
      ).text,
      'Keep B',
    );
    assert.equal(
      (
        await readOperationSource(
          project.id,
          prepared.record.operationId,
          frozen.sourceId,
        )
      ).text,
      'Original A',
    );
    const stored = JSON.parse(
      await readFile(
        path.join(
          project.planningPath,
          'whats-next/nodes',
          node.id,
          'node.json',
        ),
        'utf8',
      ),
    );
    assert.equal(stored.uid, node.uid);
    assert.deepEqual(stored.relations, node.relations);
    await assert.rejects(
      () =>
        submitProductExplorationResult(
          project,
          prepared.record.operationId,
          prepared.record.contract,
          { outcome: 'no-change', reason: 'Done' },
        ),
      /STALE_BASIS/,
    );
    const stale = await client.callTool({
      name: 'praxis_update_source',
      arguments: { ...key, expectedRevision: source.revision, title: 'Stale' },
    });
    assert.equal(stale.isError, true);
    assert.equal(
      (stale.structuredContent as { code: string }).code,
      'RESOURCE_CHANGED',
    );
  },
);
void test('adding an idea to a document-only source retains both attachments', async (t) => {
  const { client, key, source } = await fixture(t);
  const updated = await client.callTool({
    name: 'praxis_update_source',
    arguments: {
      ...key,
      expectedRevision: source.revision,
      idea: 'New context',
    },
  });
  assert.notEqual(updated.isError, true, JSON.stringify(updated));
  const next = updated.structuredContent as {
    resources: Array<{ kind: string; path: string; uri: string }>;
  };
  for (const r of source.resources)
    assert.ok(next.resources.some((n) => n.path === r.path));
  const idea = next.resources.find((r) => r.kind === 'idea')!;
  assert.ok(idea);
  assert.match(
    String(
      (
        (await client.readResource({ uri: idea.uri })).contents[0] as {
          text: string;
        }
      ).text,
    ),
    /New context/,
  );
});
void test('only explicitly removed attachments disappear', async (t) => {
  const { client, key, source } = await fixture(t);
  const invalid = await client.callTool({
    name: 'praxis_update_source',
    arguments: {
      ...key,
      expectedRevision: source.revision,
      removeAttachmentRefs: ['../other.md'],
    },
  });
  assert.equal(invalid.isError, true);
  const updated = await client.callTool({
    name: 'praxis_update_source',
    arguments: {
      ...key,
      expectedRevision: source.revision,
      removeAttachmentRefs: [source.resources[0]!.path],
    },
  });
  assert.notEqual(updated.isError, true);
  assert.deepEqual(
    (
      updated.structuredContent as { resources: Array<{ path: string }> }
    ).resources.map((r) => r.path),
    [source.resources[1]!.path],
  );
});
void test('concurrent edits cannot both apply the same source revision', async (t) => {
  const { client, key, source } = await fixture(t);
  const updates = await Promise.all(
    ['First', 'Second'].map((title) =>
      client.callTool({
        name: 'praxis_update_source',
        arguments: { ...key, expectedRevision: source.revision, title },
      }),
    ),
  );
  assert.equal(updates.filter((r) => !r.isError).length, 1);
  assert.equal(updates.filter((r) => r.isError).length, 1);
});
