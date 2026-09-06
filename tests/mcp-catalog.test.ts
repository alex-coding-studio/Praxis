import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'mcp-catalog-home-'));
process.env.PRAXIS_HOME = REGISTRY_HOME;

const registry = await import('../lib/project-registry.ts');
const catalog = await import('../lib/mcp/catalog.ts');
const { isMcpRequestError } = await import('../lib/mcp/errors.ts');
const { encodeArtifactId } = await import('../lib/mcp/artifacts.ts');
const { MCP_MODULES, MCP_MODULE_DEFINITIONS } =
  await import('../lib/mcp/modules.ts');
const { beginRun, releaseRun, activeRunRegistryOwnership } =
  await import('../lib/execution-observability/active-runs.ts');

test.after(() => rm(REGISTRY_HOME, { recursive: true, force: true }));

const NODE_ID = 'NODE-0123456789abcdef';

async function fixture(t: test.TestContext, name = 'MCP catalog probe') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-catalog-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return registry.createProject({
    kind: 'standalone',
    name,
    description: 'A registered fixture project.',
    rootPath: root,
  });
}

function parse(content: { text: string }) {
  return JSON.parse(content.text) as Record<string, unknown>;
}

void test('capabilities name the served modules, contracts and limits', async () => {
  const value = parse(catalog.readCapabilities());
  assert.equal(value.apiVersion, catalog.MCP_API_VERSION);
  assert.equal(value.protocolBaseline, '2025-11-25');
  assert.deepEqual(value.tools, [...catalog.MCP_IMPLEMENTED_TOOLS]);
  const modules = value.modules as Array<Record<string, unknown>>;
  assert.deepEqual(
    modules.map((entry) => entry.module),
    [...MCP_MODULES],
  );
  for (const entry of modules) {
    const contract = entry.contract as Record<string, unknown>;
    const definition =
      MCP_MODULE_DEFINITIONS[
        entry.module as keyof typeof MCP_MODULE_DEFINITIONS
      ];
    assert.equal(contract.id, definition.contract.id);
    assert.equal(contract.hash, definition.contract.hash);
  }
});

void test('only the implemented module advertises an operation and a submission tool', async () => {
  const value = parse(catalog.readCapabilities());
  for (const entry of value.modules as Array<Record<string, unknown>>) {
    if (entry.module === 'product-exploration') {
      assert.deepEqual(entry.preparationOperations, ['explore']);
      assert.equal(entry.submissionTool, 'praxis_submit_product_exploration');
      continue;
    }
    assert.deepEqual(entry.preparationOperations, [], entry.module as string);
    assert.equal(entry.submissionTool, null, entry.module as string);
  }
  const tools = value.tools as string[];
  assert.equal(tools.includes('praxis_submit_product_exploration'), true);
  assert.equal(
    tools.filter((tool) => tool.startsWith('praxis_submit')).length,
    1,
    'no unimplemented submission tool may be advertised',
  );
});

void test('a registered project is listed with its module links and no source content', async (t) => {
  const project = await fixture(t);
  const value = parse(await catalog.readProjects());
  const listed = (value.projects as Array<Record<string, unknown>>).find(
    (entry) => entry.id === project.id,
  );
  assert.ok(listed);
  assert.equal(listed.name, 'MCP catalog probe');
  assert.equal(listed.kind, 'standalone');
  assert.deepEqual(
    (listed.modules as Array<Record<string, unknown>>).map(
      (entry) => entry.module,
    ),
    [...MCP_MODULES],
  );
  assert.equal(Object.hasOwn(listed, 'rootPath'), false);
  assert.equal(Object.hasOwn(listed, 'planningPath'), false);
  assert.equal(Object.hasOwn(listed, 'codePath'), false);
});

void test('an unknown project id is refused as PROJECT_NOT_FOUND', async () => {
  await assert.rejects(
    () => catalog.readModuleState('no-such-project', 'domain-modeling'),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'PROJECT_NOT_FOUND',
  );
});

void test('every module resource reports its owner, contract and Latest Response reference', async (t) => {
  const project = await fixture(t);
  for (const moduleName of MCP_MODULES) {
    const value = parse(await catalog.readModuleState(project.id, moduleName));
    const definition = MCP_MODULE_DEFINITIONS[moduleName];
    assert.equal(value.module, moduleName);
    assert.equal(value.responseOwner, definition.responseOwner);
    assert.equal(
      (value.contract as Record<string, unknown>).hash,
      definition.contract.hash,
    );
    assert.equal(typeof value.revision, 'string');
    assert.equal(value.activeOperation, null);
    assert.equal(value.latestResponse, null);
    assert.equal(
      value.latestResponseUri,
      `praxis://projects/${project.id}/modules/${moduleName}/latest-response`,
    );
  }
});

void test('Product Exploration and Scope Decomposition are separate module resources sharing no layer confusion', async (t) => {
  const project = await fixture(t);
  const exploration = parse(
    await catalog.readModuleState(project.id, 'product-exploration'),
  );
  const decomposition = parse(
    await catalog.readModuleState(project.id, 'scope-decomposition'),
  );
  assert.deepEqual(exploration.layers, ['discovery', 'product-design']);
  assert.deepEqual(decomposition.layers, []);
  assert.equal(exploration.responseOwner, 'whats-next');
  assert.equal(decomposition.responseOwner, 'task-decomposition');
});

void test('a module with no result reports a null Latest Response rather than a fabricated success', async (t) => {
  const project = await fixture(t);
  const value = parse(
    await catalog.readLatestResponseProjection(project.id, 'delivery-planning'),
  );
  assert.equal(value.latestResponse, null);
  assert.equal(value.module, 'delivery-planning');
});

void test('a Result Contract resource returns the actual schema, hash and example', async () => {
  for (const moduleName of MCP_MODULES) {
    const definition = MCP_MODULE_DEFINITIONS[moduleName];
    const value = parse(
      catalog.readContract(definition.contract.id, definition.contract.version),
    );
    assert.equal(value.hash, definition.contract.hash);
    assert.deepEqual(value.schema, definition.contract.schema);
    assert.deepEqual(value.example, definition.example);
    assert.doesNotThrow(() =>
      definition.contract.validateStructure(value.example),
    );
  }
});

void test('a wrong contract version is refused as CONTRACT_MISMATCH and an unknown id as RESOURCE_NOT_FOUND', async () => {
  await assert.rejects(
    async () => catalog.readContract('praxis.domain-model.result', 99),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'CONTRACT_MISMATCH',
  );
  await assert.rejects(
    async () => catalog.readContract('praxis.invented.result', 1),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'RESOURCE_NOT_FOUND',
  );
});

void test('an artifact is read through the planning shape allowlist, not a path', async (t) => {
  const project = await fixture(t);
  const relativePath = `whats-next/nodes/${NODE_ID}/output.md`;
  await mkdir(path.join(project.planningPath, path.dirname(relativePath)), {
    recursive: true,
  });
  await writeFile(
    path.join(project.planningPath, relativePath),
    '# Direction\n\nThe accepted output.\n',
  );
  const artifactId = encodeArtifactId(relativePath);
  const content = await catalog.readArtifact(project.id, artifactId);
  assert.match(content.text, /The accepted output/);
  assert.equal(content.mimeType, 'text/markdown');
  assert.equal(typeof content.revision, 'string');
});

void test('a Delivery Map contract publishes an artifact link the client can read', async (t) => {
  const project = await fixture(t);
  const runId = 'RUN-44444444-4444-4444-8444-444444444444';
  const contractId = 'NODE-abcdef0123456789';
  const outputPath = `what-to-do/runs/${runId}/contracts/${contractId}/output.md`;
  await mkdir(path.join(project.planningPath, 'what-to-do'), {
    recursive: true,
  });
  await writeFile(
    path.join(project.planningPath, 'what-to-do', 'current-map.json'),
    JSON.stringify({
      schemaVersion: 1,
      runId,
      updatedAt: new Date().toISOString(),
      sourceUids: [],
      contracts: [
        {
          id: contractId,
          uid: 'CONTRACT-1',
          title: 'Serve the endpoint',
          outcome: 'The endpoint answers a loopback client.',
          relations: { derivedFrom: [], dependsOn: [] },
          dependsOn: [],
          outputPath,
        },
      ],
      sourceClaims: [],
      sourceSnapshots: [],
    }),
  );
  await mkdir(path.join(project.planningPath, path.dirname(outputPath)), {
    recursive: true,
  });
  await writeFile(
    path.join(project.planningPath, outputPath),
    '# Serve the endpoint\n',
  );
  const value = parse(
    await catalog.readModuleState(project.id, 'delivery-planning'),
  );
  const state = value.state as {
    contracts: Array<{ artifacts: Array<{ uri: string }> }>;
  };
  const link = state.contracts[0]?.artifacts[0];
  assert.ok(link, 'the Contract must publish a readable artifact link');
  const content = await catalog.resolveMcpResource(link.uri);
  assert.match(content.text, /Serve the endpoint/);
});

void test('an artifact outside the published shapes is refused even when the file exists', async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.planningPath, 'secrets.md'), 'private\n');
  await assert.rejects(
    () => catalog.readArtifact(project.id, encodeArtifactId('secrets.md')),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'RESOURCE_NOT_FOUND',
  );
  for (const attempt of ['../../etc/passwd', '/etc/passwd', 'config.json']) {
    await assert.rejects(
      () => catalog.readArtifact(project.id, encodeArtifactId(attempt)),
      (error: unknown) =>
        isMcpRequestError(error) &&
        error.envelope.code === 'RESOURCE_NOT_FOUND',
      `expected ${attempt} to be refused`,
    );
  }
});

void test('a long artifact is paged with a continuation cursor rather than truncated silently', async (t) => {
  const project = await fixture(t);
  const relativePath = `whats-next/nodes/${NODE_ID}/output.md`;
  await mkdir(path.join(project.planningPath, path.dirname(relativePath)), {
    recursive: true,
  });
  const body = 'x'.repeat(5000);
  await writeFile(path.join(project.planningPath, relativePath), body);
  const artifactId = encodeArtifactId(relativePath);
  const first = await catalog.readArtifact(project.id, artifactId, {
    limitBytes: 2000,
  });
  assert.equal(first.byteLength, 2000);
  assert.equal(first.totalBytes, 5000);
  assert.ok(first.nextCursor);
  const second = await catalog.readArtifact(project.id, artifactId, {
    limitBytes: 2000,
    cursor: first.nextCursor ?? undefined,
  });
  assert.equal(second.byteOffset, 2000);
  const third = await catalog.readArtifact(project.id, artifactId, {
    limitBytes: 2000,
    cursor: second.nextCursor ?? undefined,
  });
  assert.equal(third.nextCursor, null);
  assert.equal(first.text + second.text + third.text, body);
});

void test('resolveMcpResource reaches the same readers as the typed catalog calls', async (t) => {
  const project = await fixture(t);
  assert.deepEqual(
    parse(await catalog.resolveMcpResource('praxis://capabilities')).modules,
    parse(catalog.readCapabilities()).modules,
  );
  assert.deepEqual(
    parse(
      await catalog.resolveMcpResource(
        `praxis://projects/${project.id}/modules/domain-modeling`,
      ),
    ).contract,
    parse(await catalog.readModuleState(project.id, 'domain-modeling'))
      .contract,
  );
});

void test('a module resource reports the owner reservation held in this Host registry', async (t) => {
  const project = await fixture(t);
  const owner = {
    kind: 'module' as const,
    projectId: project.id,
    planningPath: project.planningPath,
    module: 'what-to-do' as const,
  };
  const logFile = path.join(project.planningPath, 'mcp-owner-probe.log');
  t.after(() => rm(logFile, { force: true }));
  const { reservation } = await beginRun({
    owner,
    runId: 'RUN-99999999-9999-4999-8999-999999999999',
    logFile,
    logRef: logFile,
    subject: { kind: 'module', label: 'Delivery Map' },
    startMessage: 'Owner registry probe',
    validate: async () => null,
    persist: async () => async () => undefined,
  });
  try {
    const value = parse(
      await catalog.readModuleState(project.id, 'delivery-planning'),
    );
    const active = value.activeOperation as Record<string, unknown> | null;
    assert.ok(
      active,
      'the MCP module resource must see the active reservation',
    );
    assert.equal(active.runId, reservation.runId);
    assert.equal(active.status, 'running');
    assert.equal(active.hostPid, process.pid);
    const untouched = parse(
      await catalog.readModuleState(project.id, 'domain-modeling'),
    );
    assert.equal(untouched.activeOperation, null);
  } finally {
    await reservation.log.close();
    releaseRun(reservation);
  }
  const cleared = parse(
    await catalog.readModuleState(project.id, 'delivery-planning'),
  );
  assert.equal(cleared.activeOperation, null);
});

void test('capabilities report one owner registry for this Host process', async () => {
  const value = parse(catalog.readCapabilities());
  const host = value.host as { activeRunRegistry: Record<string, unknown> };
  assert.equal(host.activeRunRegistry.hostPid, process.pid);
  assert.equal(host.activeRunRegistry.shared, true);
  assert.equal(
    host.activeRunRegistry.registryOwnerId,
    activeRunRegistryOwnership().registryOwnerId,
  );
});
