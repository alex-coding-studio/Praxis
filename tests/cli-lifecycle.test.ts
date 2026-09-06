import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const cli = path.join(packageRoot, 'bin', 'praxis.mjs');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(
        address && typeof address === 'object',
        'expected a bound port',
      );
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

const READY_STUB = `import net from 'node:net';
const server = net.createServer();
server.listen(Number(process.env.PRAXIS_RUNTIME_PORT), '127.0.0.1', () => console.log('READY'));
`;
const LAN_STUB = `import { writeFileSync } from 'node:fs';
import net from 'node:net';
writeFileSync(process.env.PRAXIS_CAPTURE_ENV, process.env.PRAXIS_ALLOWED_DEV_ORIGINS ?? '');
net.createServer().listen(Number(process.env.PRAXIS_RUNTIME_PORT), '127.0.0.1');
`;
const QUIET_STUB = 'setInterval(() => {}, 1000);\n';

function isolatedEnv(
  stubBody = READY_STUB,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const scope = mkdtempSync(path.join(tmpdir(), 'praxis-cli-'));
  const stub = path.join(scope, 'stub.mjs');
  writeFileSync(stub, stubBody);
  return {
    ...process.env,
    PRAXIS_HOME: path.join(scope, 'home'),
    PRAXIS_SERVER_STUB: stub,
    ...extra,
  };
}

function homeOf(env: NodeJS.ProcessEnv) {
  assert.ok(env.PRAXIS_HOME);
  return env.PRAXIS_HOME;
}

function stateFile(env: NodeJS.ProcessEnv, port: string) {
  return path.join(homeOf(env), 'run', `praxis-${port}.json`);
}

function readStatePid(env: NodeJS.ProcessEnv, port: string) {
  return JSON.parse(readFileSync(stateFile(env, port), 'utf8')).pid;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 10_000,
  stepMs = 50,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return condition();
}

function run(args: Array<string>, env = process.env) {
  return spawnSync(process.execPath, [cli, ...args], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

void test('help lists the lifecycle commands', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  for (const fragment of [
    'praxis stop',
    'praxis restart',
    'praxis status',
    'praxis logs',
    '--detach',
    '--lan',
  ]) {
    assert.ok(
      result.stdout.includes(fragment),
      `help should mention ${fragment}`,
    );
  }
});

void test('an unknown command fails with usage', () => {
  const result = run(['stopx']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: stopx/);
});

void test('stop without a managed server fails', () => {
  const result = run(['stop', '--port', '34501'], isolatedEnv());
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /No managed background Praxis server on port 34501/,
  );
});

void test('start without a build fails before launching', async () => {
  if (existsSync(path.join(packageRoot, '.next', 'BUILD_ID'))) {
    return;
  }
  const port = await freePort();
  const result = run(['start', '--port', String(port)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has not been built yet/);
});

void test('start, status, logs, restart and stop manage one detached server', async () => {
  const env = isolatedEnv();
  const port = String(await freePort());
  const stop = (extra = []) => run(['stop', '--port', port, ...extra], env);
  try {
    const started = run(['start', '-d', '--port', port], env);
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, new RegExp(`http://localhost:${port}`));

    const duplicate = run(['start', '-d', '--port', port], env);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already running/);

    const status = run(['status', '--port', port], env);
    assert.equal(status.status, 0);
    assert.match(status.stdout, /running \(start, detached\)/);

    const logs = run(['logs', '--port', port], env);
    assert.equal(logs.status, 0);
    assert.match(logs.stdout, /READY/);

    const unsupported = run(
      ['restart', '--port', port, '--hostname', '0.0.0.0'],
      env,
    );
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /Unexpected argument for 'restart'/);

    const restarted = run(['restart', '--port', port], env);
    assert.equal(restarted.status, 0, restarted.stderr);

    const stopped = stop();
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /Stopped Praxis/);

    const after = run(['status', '--port', port], env);
    assert.equal(after.status, 1);
    assert.match(after.stdout, /No managed background Praxis server/);
  } finally {
    stop();
  }
});

void test('mcp info reports the endpoint of a running managed server', async () => {
  const env = isolatedEnv();
  const port = String(await freePort());
  const stop = () => run(['stop', '--port', port], env);
  try {
    const idle = run(['mcp', 'info'], env);
    assert.equal(idle.status, 0, idle.stderr);
    assert.match(idle.stdout, /No managed background Praxis server is running/);

    const started = run(['start', '-d', '--port', port], env);
    assert.equal(started.status, 0, started.stderr);

    const info = run(['mcp', 'info'], env);
    assert.equal(info.status, 0, info.stderr);
    assert.match(
      info.stdout,
      new RegExp(`Endpoint: http://127\\.0\\.0\\.1:${port}/api/mcp`),
      'a running server must have its endpoint reported',
    );
    assert.doesNotMatch(
      info.stdout,
      /No managed background Praxis server is running/,
    );
  } finally {
    stop();
  }
});

void test('dev mode is recorded on the managed server', async () => {
  const env = isolatedEnv();
  const port = String(await freePort());
  try {
    const started = run(['dev', '-d', '--port', port], env);
    assert.equal(started.status, 0, started.stderr);
    const status = run(['status', '--port', port], env);
    assert.equal(status.status, 0);
    assert.match(status.stdout, /running \(dev, detached\)/);
  } finally {
    run(['stop', '--port', port], env);
  }
});

void test('--lan forwards an all-interfaces hostname without ambiguity', async () => {
  const env = isolatedEnv(LAN_STUB, {
    PRAXIS_ALLOWED_DEV_ORIGINS: 'saved.example',
  });
  const capturePath = path.join(homeOf(env), 'lan-origins.txt');
  env.PRAXIS_CAPTURE_ENV = capturePath;
  const port = String(await freePort());
  try {
    const started = run(['start', '-d', '--lan', '--port', port], env);
    assert.equal(started.status, 0, started.stderr);
    const state = JSON.parse(readFileSync(stateFile(env, port), 'utf8'));
    assert.equal(state.hostname, '0.0.0.0');
    assert.deepEqual(state.nextArgs, ['--hostname', '0.0.0.0', '--port', port]);
    const origins = readFileSync(capturePath, 'utf8').split(',');
    assert.ok(origins.includes('saved.example'));
    for (const addresses of Object.values(networkInterfaces()))
      for (const address of addresses ?? [])
        if (!address.internal && address.family === 'IPv4')
          assert.ok(origins.includes(address.address));

    const conflicting = run(['start', '--lan', '--hostname', '127.0.0.1'], env);
    assert.equal(conflicting.status, 1);
    assert.match(conflicting.stderr, /either '--lan' or '--hostname'/);

    const forwardedConflict = run(
      ['start', '--lan', '--', '--hostname', '127.0.0.1'],
      env,
    );
    assert.equal(forwardedConflict.status, 1);
    assert.match(forwardedConflict.stderr, /either '--lan' or '--hostname'/);
  } finally {
    run(['stop', '--port', port], env);
  }
});

void test('the bare command shows help instead of starting', () => {
  const result = run([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /praxis start \[options\]/);

  const implicit = run(['--port', '3100']);
  assert.equal(implicit.status, 1);
  assert.match(implicit.stderr, /Unknown command: --port/);
});

void test('stop never signals an unrelated live process', async () => {
  const env = isolatedEnv();
  const port = String(await freePort());
  const victim = spawn(process.execPath, ['-e', QUIET_STUB], {
    stdio: 'ignore',
  });
  assert.ok(victim.pid);
  try {
    mkdirSync(path.join(homeOf(env), 'run'), { recursive: true });
    writeFileSync(
      stateFile(env, port),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: victim.pid,
        startMarker: 'a marker that matches no live process',
        port: Number(port),
        hostname: null,
        mode: 'start',
        detached: true,
        nextArgs: [],
        startedAt: new Date().toISOString(),
      })}\n`,
    );
    const stopped = run(['stop', '--port', port], env);
    assert.equal(stopped.status, 1);
    assert.match(stopped.stderr, /unrelated live process/);
    assert.ok(alive(victim.pid), 'the unrelated process must survive');
    assert.ok(
      !existsSync(stateFile(env, port)),
      'the stale state must be removed',
    );
  } finally {
    victim.kill('SIGKILL');
  }
});

void test('foreground servers stay attached to their terminal and unmanaged', async () => {
  const env = isolatedEnv();
  const port = String(await freePort());
  const wrapper = spawn(process.execPath, [cli, 'start', '--port', port], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.ok(wrapper.pid);
  wrapper.stdout?.resume();
  wrapper.stderr?.resume();
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!existsSync(stateFile(env, port)));
    const status = run(['status', '--port', port], env);
    assert.equal(status.status, 1);
    assert.match(status.stdout, /No managed background Praxis server/);
  } finally {
    if (wrapper.exitCode === null) wrapper.kill('SIGTERM');
    await waitFor(
      () => wrapper.exitCode !== null || wrapper.signalCode !== null,
    );
  }
});

void test('stale log output cannot fake readiness', async () => {
  const env = isolatedEnv(QUIET_STUB, { PRAXIS_READY_TIMEOUT_MS: '1200' });
  const port = String(await freePort());
  mkdirSync(path.join(homeOf(env), 'run'), { recursive: true });
  writeFileSync(
    path.join(homeOf(env), 'run', `praxis-${port}.log`),
    'READY\nstale output from a previous run\n',
  );
  const started = run(['start', '-d', '--port', port], env);
  assert.equal(started.status, 1);
  assert.match(started.stderr, /did not become ready within/);
  const pid = Number(/\(pid (\d+)\)/.exec(started.stderr)?.[1]);
  assert.ok(Number.isInteger(pid), 'the failure must name the server pid');
  assert.ok(
    await waitFor(() => !alive(pid)),
    'the never-ready server must be stopped',
  );
  assert.ok(
    !existsSync(stateFile(env, port)),
    'failed launches must not keep state',
  );
});

void test('an existing listener cannot satisfy readiness for a new server', async () => {
  const env = isolatedEnv();
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = String(address.port);
  try {
    const started = run(
      ['start', '-d', '--port', port, '--hostname', '127.0.0.1'],
      env,
    );
    assert.equal(started.status, 1);
    assert.match(started.stderr, /port .* is already in use/);
    assert.ok(!existsSync(stateFile(env, port)));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

void test('process identity is stable across timezone changes', async () => {
  const env = isolatedEnv(READY_STUB, { TZ: 'UTC' });
  const port = String(await freePort());
  try {
    const started = run(['start', '-d', '--port', port], env);
    assert.equal(started.status, 0, started.stderr);
    const changedTimezone = { ...env, TZ: 'America/Los_Angeles' };
    const status = run(['status', '--port', port], changedTimezone);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /running \(start, detached\)/);
    assert.ok(existsSync(stateFile(env, port)));
  } finally {
    run(['stop', '--port', port], env);
  }
});

void test('stop reports a timeout without escalating to SIGKILL', async () => {
  const stubbornStub = `import net from 'node:net';
process.on('SIGTERM', () => {});
net.createServer().listen(Number(process.env.PRAXIS_RUNTIME_PORT), '127.0.0.1');
`;
  const env = isolatedEnv(stubbornStub, { PRAXIS_STOP_GRACE_MS: '300' });
  const port = String(await freePort());
  const started = run(['start', '-d', '--port', port], env);
  assert.equal(started.status, 0, started.stderr);
  const pid = readStatePid(env, port);
  try {
    const stopped = run(['stop', '--port', port], env);
    assert.equal(stopped.status, 1);
    assert.match(stopped.stderr, /did not stop within 300ms/);
    assert.ok(alive(pid));
    assert.ok(existsSync(stateFile(env, port)));
  } finally {
    process.kill(pid, 'SIGKILL');
  }
});
