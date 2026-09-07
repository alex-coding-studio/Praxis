import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'node-document-home-'));
process.env.PRAXIS_HOME = home;
test.after(() => rm(home, { recursive: true, force: true }));
const { createProject } = await import('../lib/project-registry.ts');
const { createStartNode } = await import('../lib/graph/task/model.ts');
const { prepareProductExplorationOperation } =
  await import('../lib/mcp/prepare.ts');
const { publishProductExplorationResult } =
  await import('../lib/modules/product-discovery/publish.ts');
const { PRODUCT_EXPLORATION_MINIMAL_EXAMPLE } =
  await import('../lib/modules/product-discovery/contract.ts');
const { promoteCandidateToNode } =
  await import('../lib/graph/proposal/promote.ts');
const { createPraxisMcpServer } = await import('../lib/mcp/server.ts');
const { artifactUri } = await import('../lib/mcp/uri.ts');
const { encodeArtifactId } = await import('../lib/mcp/artifacts.ts');
const { reviseNodeDocument } =
  await import('../lib/graph/task/document-revision.ts');
const { sha256Hex } = await import('../lib/materialization/hash.ts');
const { fingerprint } = await import('../lib/modules/delivery/sources.ts');
const { readOperationSource } = await import('../lib/mcp/catalog.ts');

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-document-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await createProject({
    kind: 'standalone',
    name: 'Fixture',
    description: '',
    rootPath: root,
  });
  const start = await createStartNode(
    project,
    { title: 'Source', idea: 'Build it', files: [], contextRefs: [] },
    'whats-next',
  );
  const { basis } = await prepareProductExplorationOperation(project, {
    userInput: 'Explore',
    layer: 'discovery',
    sourceNodeIds: [start.node.id],
  });
  const result = structuredClone(PRODUCT_EXPLORATION_MINIMAL_EXAMPLE);
  assert.equal(result.outcome, 'proposal');
  if (result.outcome !== 'proposal') throw new Error('Invalid fixture');
  const c = result.candidates[0]!;
  c.type = 'mvp';
  c.artifactKind = 'mvp';
  c.derivedFrom = [{ kind: 'node', id: start.node.id }];
  c.outputMarkdown += '\n\n## Assumptions\n\n- None\n';
  const published = await publishProductExplorationResult(basis, result, {
    kind: 'direct',
    sourceNodeIds: [start.node.id],
  });
  const candidate = published.candidates[0]!;
  const { node } = await promoteCandidateToNode(project, {
    scope: 'whats-next',
    runId: published.runId,
    candidate,
    extension: { layer: 'discovery', artifactKind: 'mvp' },
    provenanceFeature: 'whats-next',
  });
  const logicalPath = `whats-next/nodes/${node.id}/output.md`;
  const old = await readFile(
    path.join(project.planningPath, logicalPath),
    'utf8',
  );
  return { project, node, old, logicalPath, start, published, candidate };
}

void test(
  'SDK edits a formal document in place, preserving metadata, snapshots and acceptance evidence',
  { timeout: 20000 },
  async (t) => {
    const { project, node, old, logicalPath, published, candidate } =
      await fixture(t);
    const nodeFile = path.join(
      project.planningPath,
      'whats-next/nodes',
      node.id,
      'node.json',
    );
    const metadata = await readFile(nodeFile, 'utf8');
    const beforeFingerprint = await fingerprint(project, node, [logicalPath]);
    const prepared = await prepareProductExplorationOperation(project, {
      userInput: 'Use current design',
      layer: 'discovery',
      sourceNodeIds: [node.id],
    });
    const frozen = prepared.record.sources.find(
      (s) => s.logicalPath === logicalPath,
    )!;
    assert.ok(frozen);
    const server = createPraxisMcpServer(),
      client = new Client({ name: 'node-edit-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    t.after(async () => {
      await client.close();
      await server.close();
    });
    const uri = artifactUri(project.id, encodeArtifactId(logicalPath));
    const read = await client.callTool({
      name: 'praxis_read_resource',
      arguments: { uri },
    });
    const revision = (read.structuredContent as { revision: string }).revision;
    const markdown =
      old +
      '\n## Updated business rule\nKeep duplicate source rows independently.\n';
    const args = {
      projectId: project.id,
      module: 'product-exploration',
      nodeId: node.id,
      expectedRevision: revision,
      markdown,
    };
    const updated = await client.callTool({
      name: 'praxis_update_node_document',
      arguments: args,
    });
    assert.notEqual(updated.isError, true, JSON.stringify(updated));
    assert.equal(
      (updated.structuredContent as { revision: string }).revision,
      sha256Hex(markdown),
    );
    const reread = await client.readResource({ uri });
    assert.equal((reread.contents[0] as { text: string }).text, markdown);
    assert.equal(await readFile(nodeFile, 'utf8'), metadata);
    assert.equal(
      await readFile(
        path.join(
          project.planningPath,
          `whats-next/nodes/${node.id}/document-history/${revision}.md`,
        ),
        'utf8',
      ),
      old,
    );
    assert.equal(
      await readFile(
        path.join(
          project.planningPath,
          published.candidatePaths[candidate.candidateId]!,
        ),
        'utf8',
      ),
      old,
    );
    assert.equal(
      (
        await readOperationSource(
          project.id,
          prepared.record.operationId,
          frozen.sourceId,
        )
      ).text,
      old,
    );
    assert.notEqual(
      await fingerprint(project, node, [logicalPath]),
      beforeFingerprint,
    );
    const replay = await client.callTool({
      name: 'praxis_update_node_document',
      arguments: args,
    });
    assert.notEqual(replay.isError, true);
    assert.equal(
      (replay.structuredContent as { changed: boolean }).changed,
      false,
    );
    const stale = await client.callTool({
      name: 'praxis_update_node_document',
      arguments: { ...args, markdown: old + '\nDifferent' },
    });
    assert.equal(stale.isError, true);
    assert.equal(
      (stale.structuredContent as { code: string }).code,
      'RESOURCE_CHANGED',
    );
  },
);

void test('concurrent edits using one revision have only one winner', async (t) => {
  const { project, node, old, logicalPath } = await fixture(t);
  const outcomes = await Promise.allSettled(
    ['A', 'B'].map((text) =>
      reviseNodeDocument(project, 'whats-next', {
        nodeId: node.id,
        expectedRevision: sha256Hex(old),
        markdown: old + '\n' + text,
      }),
    ),
  );
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(
    await readFile(path.join(project.planningPath, logicalPath), 'utf8'),
    old + '\nA',
  );
});

void test('source nodes and attempts to rename via the heading are refused', async (t) => {
  const { project, node, old, start, logicalPath } = await fixture(t);
  await assert.rejects(
    () =>
      reviseNodeDocument(project, 'whats-next', {
        nodeId: start.node.id,
        expectedRevision: sha256Hex(old),
        markdown: '# Source\nNew',
      }),
    /accepted formal/,
  );
  await assert.rejects(
    () =>
      reviseNodeDocument(project, 'whats-next', {
        nodeId: node.id,
        expectedRevision: sha256Hex(old),
        markdown: '# New title\nBody',
      }),
    /existing node title/,
  );
  assert.equal(
    await readFile(path.join(project.planningPath, logicalPath), 'utf8'),
    old,
  );
});

void test('failure to preserve the old body prevents publishing a new body', async (t) => {
  const { project, node, old, logicalPath } = await fixture(t);
  await writeFile(
    path.join(
      project.planningPath,
      'whats-next/nodes',
      node.id,
      'document-history',
    ),
    'occupied',
  );
  await assert.rejects(() =>
    reviseNodeDocument(project, 'whats-next', {
      nodeId: node.id,
      expectedRevision: sha256Hex(old),
      markdown: old + '\nNew rule',
    }),
  );
  assert.equal(
    await readFile(path.join(project.planningPath, logicalPath), 'utf8'),
    old,
  );
});
