import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const cli = path.join(projectRoot, 'bin', 'praxis.mjs');

function readPort() {
  const flag = process.argv.indexOf('--port');
  if (flag < 0) return null;
  const value = Number(process.argv[flag + 1]);
  if (!Number.isInteger(value) || value <= 0 || value > 65535)
    throw new Error('Supply a valid --port value.');
  return value;
}

function pickPort() {
  return 3900 + Math.floor(Math.random() * 80);
}

function run(command: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

async function waitForReady(origin: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/system/host`);
      if (response.ok) return;
    } catch {}
    if (Date.now() > deadline)
      throw new Error(`The Praxis Host did not become ready at ${origin}.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function callMcp(
  origin: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function mcpResult(
  origin: string,
  token: string,
  id: number,
  method: string,
  params: unknown,
) {
  const response = await callMcp(origin, token, {
    jsonrpc: '2.0',
    id,
    method,
    params,
  });
  assert.equal(response.status, 200, `${method} answered ${response.status}`);
  const payload = (await response.json()) as {
    result?: Record<string, unknown>;
    error?: unknown;
  };
  assert.ok(
    payload.result,
    `${method} returned ${JSON.stringify(payload.error)}`,
  );
  return payload.result;
}

const home = await mkdtemp(path.join(os.tmpdir(), 'praxis-mcp-smoke-home-'));
const givenPort = readPort();
const port = givenPort ?? pickPort();
const origin = `http://127.0.0.1:${port}`;
const env: Record<string, string> = { PRAXIS_HOME: home };
let started = false;

try {
  const credentials = await import('../lib/mcp/credentials.ts');
  await credentials.enableMcpEndpoint(home);
  const stored = await credentials.readMcpCredentials(home);
  assert.ok(stored, 'the credential file must exist after enable');
  const token = stored.token;

  if (givenPort === null) {
    if (!process.argv.includes('--skip-build'))
      run('npm', ['run', 'build'], env);
    else if (!existsSync(path.join(projectRoot, '.next', 'BUILD_ID')))
      throw new Error(
        'There is no production build to serve. Run without --skip-build.',
      );
    run('node', [cli, 'start', '-d', '--port', String(port)], env);
    started = true;
  }
  await waitForReady(origin);

  const uiHost = (await (await fetch(`${origin}/api/system/host`)).json()) as {
    activeRunRegistry: {
      hostPid: number;
      registryOwnerId: string;
      shared: boolean;
    };
  };

  const initialize = await mcpResult(origin, token, 1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'praxis-host-smoke', version: '1.0.0' },
  });
  assert.equal(
    (initialize.serverInfo as { name: string }).name,
    'praxis',
    'the endpoint must identify itself as praxis',
  );

  const capabilities = await mcpResult(origin, token, 2, 'resources/read', {
    uri: 'praxis://capabilities',
  });
  const contents = (capabilities.contents as Array<{ text: string }>)[0] as {
    text: string;
  };
  const served = JSON.parse(contents.text) as {
    host: {
      activeRunRegistry: {
        hostPid: number;
        registryOwnerId: string;
        shared: boolean;
      };
    };
    tools: string[];
  };

  assert.equal(
    served.host.activeRunRegistry.hostPid,
    uiHost.activeRunRegistry.hostPid,
    'the MCP endpoint and the UI API must answer from one Host process',
  );
  assert.equal(
    served.host.activeRunRegistry.registryOwnerId,
    uiHost.activeRunRegistry.registryOwnerId,
    'both entry points must reach one owner registry',
  );
  assert.equal(
    served.host.activeRunRegistry.shared,
    true,
    'the MCP route must not load a second copy of the owner registry',
  );
  assert.equal(
    uiHost.activeRunRegistry.shared,
    true,
    'the UI API must not load a second copy of the owner registry',
  );

  const projects = await fetch(`${origin}/api/projects`);
  assert.equal(projects.status, 200, 'ordinary UI access must keep working');

  const unauthorized = await callMcp(origin, 'wrong-credential', {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
  });
  assert.equal(
    unauthorized.status,
    401,
    'an invalid credential must be refused',
  );

  const foreignOrigin = await callMcp(
    origin,
    token,
    { jsonrpc: '2.0', id: 4, method: 'tools/list' },
    { origin: 'https://example.com' },
  );
  assert.equal(
    foreignOrigin.status,
    403,
    'a browser origin outside loopback must be refused',
  );

  await credentials.disableMcpEndpoint(home);
  process.stdout.write(
    `MCP_HOST_SMOKE_OK pid=${served.host.activeRunRegistry.hostPid} port=${port} tools=${served.tools.join(',')}\n`,
  );
} finally {
  if (started)
    spawnSync('node', [cli, 'stop', '--port', String(port)], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: 'ignore',
    });
  await rm(home, { recursive: true, force: true });
}
