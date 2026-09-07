import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { mkdtempSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  rename,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const home = mkdtempSync(path.join(os.tmpdir(), 'delete-node-home-'));
process.env.PRAXIS_HOME = home;
let failTrash = false;
mock.module('trash', {
  defaultExport: async (target: string) => {
    if (failTrash) throw new Error('Fixture Trash failure');
    const trash = path.join(home, 'trash');
    await mkdir(trash, { recursive: true });
    await rename(target, path.join(trash, randomUUID()));
  },
});
test.after(() => rm(home, { recursive: true, force: true }));
const { createProject } = await import('../lib/project-registry.ts');
const { createPraxisMcpServer } = await import('../lib/mcp/server.ts');
const { prepareProductExplorationOperation } =
  await import('../lib/mcp/prepare.ts');
const { readOperationSource } = await import('../lib/mcp/catalog.ts');
async function fixture(
  t: test.TestContext,
  scope: 'whats-next' | 'task-graph' = 'whats-next',
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delete-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await createProject({
    kind: 'standalone',
    name: 'Delete fixture',
    description: '',
    rootPath: root,
  });
  const id = 'NODE-1234abcd',
    otherId = 'NODE-2345abcd';
  for (const nodeId of [id, otherId]) {
    const dir = path.join(project.planningPath, scope, 'nodes', nodeId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'output.md'),
      `# ${nodeId}\nOriginal content\n`,
    );
    await writeFile(
      path.join(dir, 'node.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: nodeId,
        uid: randomUUID(),
        relations: { derivedFrom: [], dependsOn: [] },
        role: 'node',
        type: 'feature',
        title: nodeId,
        status: 'accepted',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        resources: [
          { kind: 'output', path: `${scope}/nodes/${nodeId}/output.md` },
        ],
        derivedFrom: [],
        dependsOn: [],
        typeTemplateRef: nodeId,
        metadata: {},
        layer: 'product-design',
        artifactKind: 'feature',
      }),
    );
  }
  const server = createPraxisMcpServer(),
    client = new Client({ name: 'delete-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const args = {
    projectId: project.id,
    module:
      scope === 'whats-next' ? 'product-exploration' : 'scope-decomposition',
    nodeId: id,
  };
  const inspect = await client.callTool({
    name: 'praxis_inspect_node_deletion',
    arguments: args,
  });
  assert.notEqual(inspect.isError, true, JSON.stringify(inspect));
  const expectedRevision = (inspect.structuredContent as { revision: string })
    .revision;
  return { project, id, otherId, client, args, expectedRevision, scope };
}
for (const scope of ['whats-next', 'task-graph'] as const) {
  void test(
    `SDK deletes only the inspected unreferenced node in ${scope}`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, scope);
      const beforeOther = await readFile(
        path.join(
          f.project.planningPath,
          scope,
          'nodes',
          f.otherId,
          'node.json',
        ),
        'utf8',
      );
      let frozen:
        | Awaited<ReturnType<typeof prepareProductExplorationOperation>>
        | undefined;
      if (scope === 'whats-next')
        frozen = await prepareProductExplorationOperation(f.project, {
          userInput: 'Freeze current document',
          layer: 'product-design',
          intention: 'feature-synthesis',
          sourceNodeIds: [f.id],
        });
      const removed = await f.client.callTool({
        name: 'praxis_delete_node',
        arguments: { ...f.args, expectedRevision: f.expectedRevision },
      });
      assert.notEqual(removed.isError, true, JSON.stringify(removed));
      assert.equal(
        (removed.structuredContent as { deleted: boolean }).deleted,
        true,
      );
      await assert.rejects(
        () => stat(path.join(f.project.planningPath, scope, 'nodes', f.id)),
        { code: 'ENOENT' },
      );
      assert.equal(
        await readFile(
          path.join(
            f.project.planningPath,
            scope,
            'nodes',
            f.otherId,
            'node.json',
          ),
          'utf8',
        ),
        beforeOther,
      );
      if (frozen) {
        const source = frozen.record.sources.find((s) =>
          s.logicalPath.includes(f.id),
        )!;
        assert.match(
          (
            await readOperationSource(
              f.project.id,
              frozen.record.operationId,
              source.sourceId,
            )
          ).text,
          /Original content/,
        );
      }
      const repeat = await f.client.callTool({
        name: 'praxis_delete_node',
        arguments: { ...f.args, expectedRevision: f.expectedRevision },
      });
      assert.notEqual(repeat.isError, true);
      assert.equal(
        (repeat.structuredContent as { alreadyAbsent: boolean }).alreadyAbsent,
        true,
      );
      const moduleState = await f.client.callTool({
        name: 'praxis_read_resource',
        arguments: {
          uri: `praxis://projects/${f.project.id}/modules/${f.args.module}`,
          limitBytes: 131072,
        },
      });
      const state = JSON.parse(
        (moduleState.structuredContent as { text: string }).text,
      );
      assert.equal(
        state.state.entities.some((n: { id: string }) => n.id === f.id),
        false,
      );
    },
  );
}
void test('new dependents block deletion even after an earlier inspection', async (t) => {
  const f = await fixture(t);
  const nodeFile = path.join(
    f.project.planningPath,
    'whats-next/nodes',
    f.id,
    'node.json',
  );
  const original = await readFile(nodeFile, 'utf8');
  const otherFile = path.join(
    f.project.planningPath,
    'whats-next/nodes',
    f.otherId,
    'node.json',
  );
  const other = JSON.parse(await readFile(otherFile, 'utf8'));
  const target = JSON.parse(original);
  other.dependsOn = [f.id];
  other.relations.dependsOn = [target.uid];
  await writeFile(otherFile, JSON.stringify(other));
  const refused = await f.client.callTool({
    name: 'praxis_delete_node',
    arguments: { ...f.args, expectedRevision: f.expectedRevision },
  });
  assert.equal(refused.isError, true);
  assert.deepEqual(
    (refused.structuredContent as { blockerNodeIds: string[] }).blockerNodeIds,
    [f.otherId],
  );
  assert.equal(await readFile(nodeFile, 'utf8'), original);
});
void test('changed body invalidates a deletion revision', async (t) => {
  const f = await fixture(t);
  const output = path.join(
    f.project.planningPath,
    'whats-next/nodes',
    f.id,
    'output.md',
  );
  await writeFile(output, 'Updated meaning');
  const refused = await f.client.callTool({
    name: 'praxis_delete_node',
    arguments: { ...f.args, expectedRevision: f.expectedRevision },
  });
  assert.equal(refused.isError, true);
  assert.equal(
    (refused.structuredContent as { code: string }).code,
    'RESOURCE_CHANGED',
  );
  assert.equal(await readFile(output, 'utf8'), 'Updated meaning');
});
void test('Trash failure leaves the node and unrelated content intact', async (t) => {
  const f = await fixture(t);
  failTrash = true;
  t.after(() => {
    failTrash = false;
  });
  const refused = await f.client.callTool({
    name: 'praxis_delete_node',
    arguments: { ...f.args, expectedRevision: f.expectedRevision },
  });
  assert.equal(refused.isError, true);
  assert.ok(
    (
      await stat(path.join(f.project.planningPath, 'whats-next/nodes', f.id))
    ).isDirectory(),
  );
});

void test('deletion waits for an in-flight module acceptance before checking references', async (t) => {
  const f = await fixture(t, 'task-graph');
  const { withModuleMutation } =
    await import('../lib/graph/proposal/module-runtime.ts');
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const accepting = withModuleMutation(
    'taskDecompositionMutations',
    f.project.planningPath,
    async () => {
      entered();
      await held;
      const otherFile = path.join(
        f.project.planningPath,
        'task-graph/nodes',
        f.otherId,
        'node.json',
      );
      const target = JSON.parse(
        await readFile(
          path.join(
            f.project.planningPath,
            'task-graph/nodes',
            f.id,
            'node.json',
          ),
          'utf8',
        ),
      );
      const other = JSON.parse(await readFile(otherFile, 'utf8'));
      other.dependsOn = [f.id];
      other.relations.dependsOn = [target.uid];
      await writeFile(otherFile, JSON.stringify(other));
    },
  );
  await ready;
  const deleting = f.client.callTool({
    name: 'praxis_delete_node',
    arguments: { ...f.args, expectedRevision: f.expectedRevision },
  });
  release();
  await accepting;
  const result = await deleting;
  assert.equal(result.isError, true);
  assert.deepEqual(
    (result.structuredContent as { blockerNodeIds: string[] }).blockerNodeIds,
    [f.otherId],
  );
  assert.ok(
    (
      await stat(path.join(f.project.planningPath, 'task-graph/nodes', f.id))
    ).isDirectory(),
  );
});
