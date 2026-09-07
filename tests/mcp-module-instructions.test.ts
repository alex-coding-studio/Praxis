import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REGISTRY_HOME = mkdtempSync(
  path.join(os.tmpdir(), 'mcp-instructions-home-'),
);
process.env.PRAXIS_HOME = REGISTRY_HOME;

const registry = await import('../lib/project-registry.ts');
const { createStartNode } = await import('../lib/graph/task/model.ts');
const { enableMcpEndpoint, readMcpCredentials } =
  await import('../lib/mcp/credentials.ts');
const { readWhatsNextInstructions } =
  await import('../lib/modules/product-discovery/context.ts');
const { readTaskDecompositionContext } =
  await import('../lib/modules/scope-decomposition/context.ts');
const { readDomainModelInstructions } =
  await import('../lib/modules/domain-modeling/context.ts');
const { readWhatToDoInstructions } =
  await import('../lib/modules/delivery-planning/instructions.ts');
const { prepareProductExplorationOperation } =
  await import('../lib/mcp/prepare.ts');
const { submitProductExplorationResult } = await import('../lib/mcp/submit.ts');
const { connectMcpClient, readMcpJson } =
  await import('./helpers/mcp-sdk-host.ts');

test.after(() => rm(REGISTRY_HOME, { recursive: true, force: true }));

await enableMcpEndpoint();
const credentials = await readMcpCredentials();
assert.ok(credentials);
const token = credentials.token;

const connect = (t: test.TestContext) =>
  connectMcpClient(t, token, 'praxis-instructions-client');

const MODULES = [
  'product-exploration',
  'scope-decomposition',
  'domain-modeling',
  'delivery-planning',
] as const;

type ModuleState = {
  instructions: {
    revision: string;
    length: number;
    maxLength: number;
    storagePath: string;
    uri: string;
    updateTool: string;
  };
};

const applicationReaders = {
  'product-exploration': readWhatsNextInstructions,
  'scope-decomposition': async (project: never) =>
    (await readTaskDecompositionContext(project)).instructions,
  'domain-modeling': readDomainModelInstructions,
  'delivery-planning': readWhatToDoInstructions,
} as const;

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(
    path.join(os.tmpdir(), 'mcp-instructions-project-'),
  );
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project = await registry.createProject({
    kind: 'standalone',
    name: 'Instructions fixture',
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

const readModule = (
  client: Awaited<ReturnType<typeof connect>>,
  projectId: string,
  module: string,
) =>
  readMcpJson<ModuleState>(
    client,
    `praxis://projects/${projectId}/modules/${module}`,
  );

async function readInstructionsDocument(
  client: Awaited<ReturnType<typeof connect>>,
  uri: string,
) {
  const result = await client.callTool({
    name: 'praxis_read_resource',
    arguments: { uri },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return (result.structuredContent as { text: string }).text;
}

void test(
  'every module reads, updates and clears its own Instructions through public calls',
  { timeout: 20_000 },
  async (t) => {
    const { project } = await fixture(t);
    const client = await connect(t);

    for (const moduleName of MODULES) {
      const empty = await readModule(client, project.id, moduleName);
      assert.equal(empty.instructions.length, 0);
      assert.equal(empty.instructions.updateTool, 'praxis_update_instructions');
      assert.equal(
        await readInstructionsDocument(client, empty.instructions.uri),
        '',
      );

      const text = `# ${moduleName}\n\nPrefer the smallest honest slice.`;
      const updated = await client.callTool({
        name: 'praxis_update_instructions',
        arguments: {
          projectId: project.id,
          module: moduleName,
          instructions: text,
          expectedRevision: empty.instructions.revision,
        },
      });
      assert.notEqual(updated.isError, true, JSON.stringify(updated));
      const outcome = updated.structuredContent as {
        revision: string;
        cleared: boolean;
        length: number;
      };
      assert.equal(outcome.cleared, false);
      assert.equal(outcome.length, text.length);

      assert.equal(
        await applicationReaders[moduleName](project as never),
        text,
        `${moduleName} must store the value the existing application reader returns`,
      );
      const after = await readModule(client, project.id, moduleName);
      assert.equal(after.instructions.revision, outcome.revision);
      assert.equal(
        await readInstructionsDocument(client, after.instructions.uri),
        text,
      );

      const cleared = await client.callTool({
        name: 'praxis_update_instructions',
        arguments: {
          projectId: project.id,
          module: moduleName,
          instructions: '',
          expectedRevision: after.instructions.revision,
        },
      });
      assert.notEqual(cleared.isError, true, JSON.stringify(cleared));
      assert.equal(
        (cleared.structuredContent as { cleared: boolean }).cleared,
        true,
      );
      assert.equal(await applicationReaders[moduleName](project as never), '');
    }
  },
);

void test(
  'a stale revision is refused and the other modules are untouched',
  { timeout: 20_000 },
  async (t) => {
    const { project } = await fixture(t);
    const client = await connect(t);
    const before = await readModule(client, project.id, 'product-exploration');

    const first = await client.callTool({
      name: 'praxis_update_instructions',
      arguments: {
        projectId: project.id,
        module: 'product-exploration',
        instructions: 'The first rule.',
        expectedRevision: before.instructions.revision,
      },
    });
    assert.notEqual(first.isError, true, JSON.stringify(first));

    const stale = await client.callTool({
      name: 'praxis_update_instructions',
      arguments: {
        projectId: project.id,
        module: 'product-exploration',
        instructions: 'A conflicting rule.',
        expectedRevision: before.instructions.revision,
      },
    });
    assert.equal(stale.isError, true);
    assert.equal(
      (stale.structuredContent as { code: string }).code,
      'RESOURCE_CHANGED',
    );
    assert.equal(
      await readWhatsNextInstructions(project),
      'The first rule.',
      'a refused update must not overwrite the concurrent edit',
    );
    for (const moduleName of MODULES.filter(
      (entry) => entry !== 'product-exploration',
    ))
      assert.equal(
        await applicationReaders[moduleName](project as never),
        '',
        `${moduleName} must be untouched by another moduleName's update`,
      );
  },
);

void test(
  'an unserved module and an over-long document are refused by the advertised limits',
  { timeout: 20_000 },
  async (t) => {
    const { project } = await fixture(t);
    const client = await connect(t);
    const state = await readModule(client, project.id, 'domain-modeling');
    assert.equal(state.instructions.maxLength, 20_000);
    assert.equal(
      (await readModule(client, project.id, 'scope-decomposition')).instructions
        .maxLength,
      100_000,
      'the per-module limits are the existing ones, not a uniform value',
    );

    const unknownModule = await client.callTool({
      name: 'praxis_update_instructions',
      arguments: {
        projectId: project.id,
        module: 'implementation',
        instructions: 'x',
        expectedRevision: state.instructions.revision,
      },
    });
    assert.equal(unknownModule.isError, true);
    assert.match(JSON.stringify(unknownModule), /module/);

    const tooLong = await client.callTool({
      name: 'praxis_update_instructions',
      arguments: {
        projectId: project.id,
        module: 'domain-modeling',
        instructions: 'x'.repeat(20_001),
        expectedRevision: state.instructions.revision,
      },
    });
    assert.equal(tooLong.isError, true);
    assert.equal(
      (tooLong.structuredContent as { code: string }).code,
      'INVALID_ARGUMENT',
    );
    assert.equal(await readDomainModelInstructions(project), '');
  },
);

void test(
  'editing Instructions does not disturb a prepared operation, and the module state revision moves',
  { timeout: 20_000 },
  async (t) => {
    const { project, sourceNodeId } = await fixture(t);
    const client = await connect(t);
    const { record } = await prepareProductExplorationOperation(
      project as never,
      {
        userInput: 'Explore one bounded MVP.',
        layer: 'discovery',
        sourceNodeIds: [sourceNodeId],
      },
    );
    const before = await readModule(client, project.id, 'product-exploration');

    const updated = await client.callTool({
      name: 'praxis_update_instructions',
      arguments: {
        projectId: project.id,
        module: 'product-exploration',
        instructions: 'Prefer one bounded outcome.',
        expectedRevision: before.instructions.revision,
      },
    });
    assert.notEqual(updated.isError, true, JSON.stringify(updated));
    const after = await readModule(client, project.id, 'product-exploration');
    assert.notEqual(
      after.instructions.revision,
      before.instructions.revision,
      'the Instructions revision must move with the content',
    );

    const submitted = await submitProductExplorationResult(
      project,
      record.operationId,
      record.contract,
      {
        outcome: 'proposal',
        candidates: [
          {
            localKey: 'first',
            type: 'mvp',
            title: 'Import the reading list',
            summary: 'One bounded outcome the reader asked for.',
            derivedFrom: [{ kind: 'node' as const, id: sourceNodeId }],
            dependsOn: [],
            resources: [],
            typeTemplateRef: null,
            metadata: {},
            presentation: {},
            assumptions: ['The reader already has the source material.'],
            outputMarkdown:
              '# Import the reading list\n\n## Why this direction\n\n- It answers the stated need directly.\n- It can be judged without more evidence.\n\n## Assumptions\n\n- The reader already has the source material.',
            layer: 'discovery' as const,
            artifactKind: 'mvp' as const,
          },
        ],
      },
    );
    assert.equal(
      submitted.record.status,
      'completed',
      'Instructions are not part of the frozen Basis, so an edit does not stale a prepared operation',
    );
  },
);
