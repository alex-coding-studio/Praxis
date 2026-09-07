import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createServer,
  request as httpRequest,
  type Server as HttpServer,
} from 'node:http';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const REGISTRY_HOME = mkdtempSync(
  path.join(os.tmpdir(), 'mcp-transport-home-'),
);
process.env.PRAXIS_HOME = REGISTRY_HOME;

const registry = await import('../lib/project-registry.ts');
const { enableMcpEndpoint, readMcpCredentials } =
  await import('../lib/mcp/credentials.ts');
const route = await import('../app/api/mcp/route.ts');
const { MCP_IMPLEMENTED_TOOLS } = await import('../lib/mcp/catalog.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } =
  await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

test.after(() => rm(REGISTRY_HOME, { recursive: true, force: true }));

await enableMcpEndpoint();
const credentials = await readMcpCredentials();
assert.ok(credentials);
const token = credentials.token;

async function listen(t: test.TestContext) {
  let port = 0;
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
          `http://127.0.0.1:${port}${incoming.url ?? '/'}`,
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
        try {
          const response = await handler(request);
          outgoing.statusCode = response.status;
          response.headers.forEach((value, name) =>
            outgoing.setHeader(name, value),
          );
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          outgoing.statusCode = 500;
          outgoing.end(String(error));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${port}/api/mcp`;
}

async function connect(t: test.TestContext, url: string, bearer = token) {
  const client = new Client({ name: 'praxis-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-transport-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return registry.createProject({
    kind: 'standalone',
    name: 'MCP transport probe',
    description: '',
    rootPath: root,
  });
}

void test(
  'an SDK client completes initialization and discovers the read surface',
  { timeout: 20_000 },
  async (t) => {
    const url = await listen(t);
    const client = await connect(t, url);
    const version = client.getServerVersion();
    assert.equal(version?.name, 'praxis');
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'praxis_accept_candidate',
      'praxis_create_source',
      'praxis_get_operation',
      'praxis_list_projects',
      'praxis_prepare',
      'praxis_read_log',
      'praxis_read_resource',
      'praxis_read_source',
      'praxis_register_project',
      'praxis_submit_delivery_map',
      'praxis_submit_domain_model',
      'praxis_submit_product_exploration',
      'praxis_submit_scope_decomposition',
      'praxis_update_node_document',
      'praxis_update_source',
    ]);
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [...MCP_IMPLEMENTED_TOOLS].sort(),
      'praxis://capabilities must name exactly the tools the server registers',
    );
    const writeTools = [
      'praxis_update_source',
      'praxis_update_node_document',
      'praxis_accept_candidate',
      'praxis_prepare',
      'praxis_register_project',
      'praxis_create_source',
      'praxis_submit_product_exploration',
      'praxis_submit_scope_decomposition',
      'praxis_submit_domain_model',
      'praxis_submit_delivery_map',
    ];
    for (const tool of tools.tools) {
      assert.equal(
        tool.annotations?.readOnlyHint,
        !writeTools.includes(tool.name),
        `${tool.name} read-only annotation`,
      );
      assert.equal(
        tool.annotations?.destructiveHint,
        ['praxis_update_node_document', 'praxis_update_source'].includes(
          tool.name,
        ),
        tool.name,
      );
      assert.equal(
        (tool.inputSchema as { additionalProperties?: boolean })
          .additionalProperties,
        false,
      );
    }
    const resources = await client.listResources();
    assert.equal(
      resources.resources.some(
        (resource) => resource.uri === 'praxis://capabilities',
      ),
      true,
    );
    const templates = await client.listResourceTemplates();
    assert.equal(
      templates.resourceTemplates.some(
        (template) =>
          template.uriTemplate ===
          'praxis://projects/{projectId}/modules/{module}',
      ),
      true,
    );
  },
);

void test(
  'an SDK client reads a real fixture project and Result Contract schema',
  { timeout: 20_000 },
  async (t) => {
    const project = await fixture(t);
    const url = await listen(t);
    const client = await connect(t, url);
    const projects = await client.callTool({
      name: 'praxis_list_projects',
      arguments: {},
    });
    const listed = JSON.parse(
      (projects.structuredContent as { text: string }).text,
    ) as { projects: Array<{ id: string }> };
    assert.equal(
      listed.projects.some((entry) => entry.id === project.id),
      true,
    );
    const contract = await client.readResource({
      uri: 'praxis://contracts/praxis.domain-model.result/1',
    });
    const first = contract.contents[0] as { text?: string };
    const body = JSON.parse(first.text as string) as {
      hash: string;
      schema: object;
    };
    assert.equal(typeof body.hash, 'string');
    assert.equal(typeof body.schema, 'object');
    const state = await client.callTool({
      name: 'praxis_read_resource',
      arguments: {
        uri: `praxis://projects/${project.id}/modules/scope-decomposition`,
      },
    });
    assert.notEqual(state.isError, true);
  },
);

void test(
  'every URI the catalog serves is reachable through the SDK resource route',
  { timeout: 20_000 },
  async (t) => {
    const project = await fixture(t);
    const url = await listen(t);
    const client = await connect(t, url);
    const templates = (
      await client.listResourceTemplates()
    ).resourceTemplates.map((template) => template.uriTemplate);
    for (const expected of [
      'praxis://projects/{projectId}/modules/{module}',
      'praxis://projects/{projectId}/modules/{module}/latest-response',
      'praxis://projects/{projectId}/artifacts/{artifactId}',
      'praxis://projects/{projectId}/operations/{operationId}',
      'praxis://projects/{projectId}/operations/{operationId}/log',
      'praxis://projects/{projectId}/operations/{operationId}/sources/{sourceId}',
      'praxis://contracts/{contractId}/{version}',
    ])
      assert.equal(
        templates.includes(expected),
        true,
        `${expected} must be registered as a resource template`,
      );

    const source = await client.callTool({
      name: 'praxis_create_source',
      arguments: {
        projectId: project.id,
        title: 'Brief',
        markdown: '# Complete source',
      },
    });
    assert.notEqual(source.isError, true);
    const sourceId = (source.structuredContent as { sourceNodeId: string })
      .sourceNodeId;
    const prepare = await client.callTool({
      name: 'praxis_prepare',
      arguments: {
        projectId: project.id,
        module: 'product-exploration',
        request: {
          userInput: 'Explore one bounded MVP.',
          layer: 'discovery',
          sourceNodeIds: [sourceId],
        },
      },
    });
    assert.notEqual(prepare.isError, true);
    const prepared = prepare.structuredContent as {
      operationUri: string;
      context: { resources: Array<{ uri: string }> };
    };
    for (const uri of [
      prepared.operationUri,
      `${prepared.operationUri}/log`,
      ...prepared.context.resources.map((resource) => resource.uri),
    ]) {
      const read = await client.readResource({ uri });
      assert.equal(
        read.contents[0]?.uri,
        uri,
        `${uri} must be readable through resources/read`,
      );
    }
  },
);

void test(
  'an unknown resource and an unknown tool are refused with a readable envelope',
  { timeout: 20_000 },
  async (t) => {
    const url = await listen(t);
    const client = await connect(t, url);
    const missing = await client.callTool({
      name: 'praxis_read_resource',
      arguments: { uri: 'praxis://projects/nope/modules/domain-modeling' },
    });
    assert.equal(missing.isError, true);
    assert.equal(
      (missing.structuredContent as { code: string }).code,
      'PROJECT_NOT_FOUND',
    );
    const traversal = await client.callTool({
      name: 'praxis_read_resource',
      arguments: { uri: 'file:///etc/passwd' },
    });
    assert.equal(traversal.isError, true);
    assert.equal(
      (traversal.structuredContent as { code: string }).code,
      'INVALID_ARGUMENT',
    );
    const unknown = await client.callTool({
      name: 'praxis_run_agent',
      arguments: {},
    });
    assert.equal(unknown.isError, true);
  },
);

void test(
  'an unknown structural field is rejected before the handler runs',
  { timeout: 20_000 },
  async (t) => {
    const url = await listen(t);
    const client = await connect(t, url);
    const result = await client.callTool({
      name: 'praxis_list_projects',
      arguments: { limit: 5, projectPath: '/etc' },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    assert.match(text, /projectPath/);
  },
);

void test(
  'a value outside the advertised bounds is rejected by the advertised schema',
  { timeout: 20_000 },
  async (t) => {
    const url = await listen(t);
    const client = await connect(t, url);
    for (const args of [
      { limit: 0 },
      { limit: 101 },
      { limit: 'many' },
      { cursor: 7 },
    ]) {
      const result = await client.callTool({
        name: 'praxis_list_projects',
        arguments: args as Record<string, unknown>,
      });
      assert.equal(
        result.isError,
        true,
        `expected ${JSON.stringify(args)} to be refused`,
      );
    }
  },
);

void test(
  'a semantic argument failure keeps the structured Praxis envelope',
  { timeout: 20_000 },
  async (t) => {
    const url = await listen(t);
    const client = await connect(t, url);
    for (const [uri, code] of [
      ['file:///etc/passwd', 'INVALID_ARGUMENT'],
      ['praxis://projects/p1/artifacts/../../etc', 'INVALID_ARGUMENT'],
      [
        'praxis://projects/missing/modules/domain-modeling',
        'PROJECT_NOT_FOUND',
      ],
      ['praxis://contracts/praxis.domain-model.result/99', 'CONTRACT_MISMATCH'],
    ] as const) {
      const result = await client.callTool({
        name: 'praxis_read_resource',
        arguments: { uri },
      });
      assert.equal(result.isError, true, `expected ${uri} to be refused`);
      assert.equal(
        (result.structuredContent as { code: string }).code,
        code,
        `expected ${uri} to report ${code}`,
      );
    }
  },
);

void test(
  'an invalid credential is refused before any catalog read',
  { timeout: 20_000 },
  async (t) => {
    const url = await listen(t);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong-credential',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'unauthorized');
  },
);

void test(
  'a non-loopback Host and a foreign browser Origin are refused',
  { timeout: 20_000 },
  async (t) => {
    const url = await listen(t);
    const endpoint = new URL(url);
    const send = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const outgoing = httpRequest(
          {
            host: endpoint.hostname,
            port: Number(endpoint.port),
            path: endpoint.pathname,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              authorization: `Bearer ${token}`,
              ...headers,
            },
          },
          (incoming) => {
            incoming.resume();
            incoming.on('end', () => resolve(incoming.statusCode ?? 0));
          },
        );
        outgoing.on('error', reject);
        outgoing.end(
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        );
      });
    assert.equal(await send({ host: 'praxis.tail1234.ts.net' }), 421);
    assert.equal(await send({ host: '192.168.1.42:3000' }), 421);
    assert.equal(await send({ origin: 'https://example.com' }), 403);
    assert.equal(await send({ origin: 'http://127.0.0.1:3000' }), 403);
    assert.equal(await send({ origin: `http://${endpoint.host}` }), 200);
  },
);

void test(
  'a client registers a project, captures a full source and submits without private APIs',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-first-project-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const client = await connect(t, await listen(t));
    const registered = await client.callTool({
      name: 'praxis_register_project',
      arguments: { rootPath: root, name: 'First project', kind: 'standalone' },
    });
    assert.notEqual(registered.isError, true);
    const projectId = (registered.structuredContent as { projectId: string })
      .projectId;
    const retry = await client.callTool({
      name: 'praxis_register_project',
      arguments: { rootPath: root, name: 'First project', kind: 'standalone' },
    });
    assert.equal(
      (retry.structuredContent as { projectId: string }).projectId,
      projectId,
    );
    const missing = await client.callTool({
      name: 'praxis_prepare',
      arguments: {
        projectId,
        module: 'product-exploration',
        request: { layer: 'discovery', userInput: 'Decompose' },
      },
    });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing), /praxis_create_source/);
    const markdown =
      '# Full product and architecture brief\n' +
      'Preserve business details. '.repeat(300);
    const created = await client.callTool({
      name: 'praxis_create_source',
      arguments: { projectId, title: 'Source', markdown },
    });
    assert.notEqual(created.isError, true);
    const source = created.structuredContent as {
      sourceNodeId: string;
      resources: Array<{ uri: string; path: string }>;
    };
    const read = await client.readResource({ uri: source.resources[0]!.uri });
    assert.equal((read.contents[0] as { text: string }).text, markdown);
    const duplicate = await client.callTool({
      name: 'praxis_create_source',
      arguments: { projectId, title: 'Overwrite', markdown: 'Different' },
    });
    assert.equal(duplicate.isError, true);
    assert.match(JSON.stringify(duplicate), new RegExp(source.sourceNodeId));
    const state = await client.callTool({
      name: 'praxis_read_resource',
      arguments: {
        uri: `praxis://projects/${projectId}/modules/product-exploration`,
        limitBytes: 131072,
      },
    });
    const stateText = (state.structuredContent as { text: string }).text;
    assert.match(stateText, /feature-synthesis/);
    assert.match(stateText, /independently meaningful business capabilities/);
    const prepare = await client.callTool({
      name: 'praxis_prepare',
      arguments: {
        projectId,
        module: 'product-exploration',
        request: {
          layer: 'discovery',
          sourceNodeIds: [source.sourceNodeId],
          userInput: 'Propose one capability',
        },
      },
    });
    assert.notEqual(prepare.isError, true);
    const operation = prepare.structuredContent as {
      operationId: string;
      contract: object;
    };
    const { PRODUCT_EXPLORATION_MINIMAL_EXAMPLE } =
      await import('../lib/modules/product-discovery/contract.ts');
    const result = structuredClone(PRODUCT_EXPLORATION_MINIMAL_EXAMPLE);
    assert.equal(result.outcome, 'proposal');
    if (result.outcome !== 'proposal')
      throw new Error('Expected proposal fixture');
    result.candidates[0]!.type = 'mvp';
    result.candidates[0]!.artifactKind = 'mvp';
    result.candidates[0]!.derivedFrom = [
      { kind: 'node', id: source.sourceNodeId },
    ];
    result.candidates[0]!.outputMarkdown +=
      '\n\n## Details\n' +
      'Full design detail. '.repeat(300) +
      '\n\n## Assumptions\n\n- None\n';
    const submitted = await client.callTool({
      name: 'praxis_submit_product_exploration',
      arguments: {
        operationId: operation.operationId,
        contract: operation.contract,
        result,
      },
    });
    assert.notEqual(submitted.isError, true, JSON.stringify(submitted));
    assert.equal(
      (submitted.structuredContent as { status: string }).status,
      'completed',
    );
  },
);
