import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  disableMcpEndpoint,
  enableMcpEndpoint,
  matchesMcpToken,
  mcpCredentialPath,
  readMcpCredentials,
  rotateMcpToken,
} from '../lib/mcp/credentials.ts';
import { evaluateMcpRequest } from '../lib/mcp/authorization.ts';
import { parseMcpUri } from '../lib/mcp/uri.ts';
import {
  decodeContentCursor,
  pageContent,
  pageList,
} from '../lib/mcp/pagination.ts';
import { isMcpRequestError } from '../lib/mcp/errors.ts';

async function home(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'praxis-mcp-home-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function bearer(token: string) {
  return `Bearer ${token}`;
}

void test('the endpoint stays disabled until it is explicitly enabled', async (t) => {
  const directory = await home(t);
  assert.equal(await readMcpCredentials(directory), null);
  const denied = evaluateMcpRequest(
    {
      host: '127.0.0.1:3000',
      origin: null,
      authorization: bearer('anything'),
    },
    await readMcpCredentials(directory),
  );
  assert.equal(denied?.status, 404);
  assert.equal(denied?.code, 'endpoint-disabled');
});

void test('enabling issues a private high-entropy credential file', async (t) => {
  const directory = await home(t);
  const { file, issued } = await enableMcpEndpoint(directory);
  assert.equal(issued, true);
  assert.equal(file, mcpCredentialPath(directory));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const credentials = await readMcpCredentials(directory);
  assert.ok(credentials);
  assert.equal(credentials.enabled, true);
  assert.ok(credentials.token.length >= 43);
  const again = await enableMcpEndpoint(directory);
  assert.equal(again.issued, false);
  assert.equal((await readMcpCredentials(directory))?.token, credentials.token);
});

void test('rotation replaces the credential and disabling retains it', async (t) => {
  const directory = await home(t);
  await enableMcpEndpoint(directory);
  const first = (await readMcpCredentials(directory))?.token;
  await rotateMcpToken(directory);
  const second = await readMcpCredentials(directory);
  assert.notEqual(second?.token, first);
  assert.ok(second?.rotatedAt);
  const { changed } = await disableMcpEndpoint(directory);
  assert.equal(changed, true);
  const after = await readMcpCredentials(directory);
  assert.equal(after?.enabled, false);
  assert.equal(after?.token, second?.token);
});

void test('the credential file never carries the token in its own name or path', async (t) => {
  const directory = await home(t);
  const { file } = await enableMcpEndpoint(directory);
  const credentials = await readMcpCredentials(directory);
  assert.ok(credentials);
  assert.equal(file.includes(credentials.token), false);
  const contents = await readFile(file, 'utf8');
  assert.equal(contents.includes(credentials.token), true);
});

void test('a non-loopback Host is refused before the credential is consulted', async (t) => {
  const directory = await home(t);
  await enableMcpEndpoint(directory);
  const credentials = await readMcpCredentials(directory);
  assert.ok(credentials);
  for (const host of [
    '192.168.1.20:3000',
    'praxis.tail1234.ts.net',
    'example.com',
    '0.0.0.0:3000',
    null,
  ]) {
    const denied = evaluateMcpRequest(
      { host, origin: null, authorization: bearer(credentials.token) },
      credentials,
    );
    assert.equal(denied?.status, 421, `expected 421 for host ${host}`);
    assert.equal(denied?.code, 'host-not-allowed');
  }
});

void test('a configured LAN host for the UI does not widen the MCP endpoint', async (t) => {
  const directory = await home(t);
  await enableMcpEndpoint(directory);
  const credentials = await readMcpCredentials(directory);
  assert.ok(credentials);
  const previous = process.env.PRAXIS_ALLOWED_HOSTS;
  process.env.PRAXIS_ALLOWED_HOSTS = 'praxis.tail1234.ts.net';
  t.after(() => {
    if (previous === undefined) delete process.env.PRAXIS_ALLOWED_HOSTS;
    else process.env.PRAXIS_ALLOWED_HOSTS = previous;
  });
  const denied = evaluateMcpRequest(
    {
      host: 'praxis.tail1234.ts.net',
      origin: null,
      authorization: bearer(credentials.token),
    },
    credentials,
  );
  assert.equal(denied?.code, 'host-not-allowed');
});

void test('a browser origin outside loopback is refused', async (t) => {
  const directory = await home(t);
  await enableMcpEndpoint(directory);
  const credentials = await readMcpCredentials(directory);
  assert.ok(credentials);
  for (const origin of ['https://example.com', 'null', 'not a url']) {
    const denied = evaluateMcpRequest(
      {
        host: '127.0.0.1:3000',
        origin,
        authorization: bearer(credentials.token),
      },
      credentials,
    );
    assert.equal(denied?.status, 403, `expected 403 for origin ${origin}`);
    assert.equal(denied?.code, 'origin-not-allowed');
  }
  assert.equal(
    evaluateMcpRequest(
      {
        host: '127.0.0.1:3000',
        origin: 'http://localhost:3000',
        authorization: bearer(credentials.token),
      },
      credentials,
    ),
    null,
  );
});

void test('a missing, malformed or wrong credential is refused with 401', async (t) => {
  const directory = await home(t);
  await enableMcpEndpoint(directory);
  const credentials = await readMcpCredentials(directory);
  assert.ok(credentials);
  for (const authorization of [
    null,
    '',
    'Basic abc',
    'Bearer',
    'Bearer ',
    bearer('wrong'),
    bearer(`${credentials.token}x`),
  ]) {
    const denied = evaluateMcpRequest(
      { host: 'localhost:3000', origin: null, authorization },
      credentials,
    );
    assert.equal(
      denied?.status,
      401,
      `expected 401 for authorization ${JSON.stringify(authorization)}`,
    );
  }
  assert.equal(
    evaluateMcpRequest(
      {
        host: 'localhost:3000',
        origin: null,
        authorization: bearer(credentials.token),
      },
      credentials,
    ),
    null,
  );
});

void test('token comparison rejects a prefix of the real credential', () => {
  assert.equal(matchesMcpToken('abcdef', 'abc'), false);
  assert.equal(matchesMcpToken('abcdef', 'abcdef'), true);
});

void test('a resource URI cannot name a filesystem path', () => {
  for (const uri of [
    'file:///etc/passwd',
    'praxis://projects/../../etc/passwd',
    'praxis://projects/p1/artifacts/..',
    'praxis:///etc/passwd',
    'praxis://projects/p1/artifacts/a/../../b',
    'praxis://capabilities?token=x',
    'https://example.com/api/mcp',
  ]) {
    assert.throws(
      () => parseMcpUri(uri),
      (error: unknown) => isMcpRequestError(error),
      `expected ${uri} to be refused`,
    );
  }
});

void test('the catalog URI shapes this release serves are parsed exactly', () => {
  assert.deepEqual(parseMcpUri('praxis://capabilities'), {
    kind: 'capabilities',
  });
  assert.deepEqual(parseMcpUri('praxis://projects'), { kind: 'projects' });
  assert.deepEqual(
    parseMcpUri('praxis://projects/p1/modules/delivery-planning'),
    { kind: 'module', projectId: 'p1', module: 'delivery-planning' },
  );
  assert.deepEqual(
    parseMcpUri('praxis://projects/p1/modules/domain-modeling/latest-response'),
    { kind: 'latest-response', projectId: 'p1', module: 'domain-modeling' },
  );
  assert.deepEqual(
    parseMcpUri('praxis://contracts/praxis.domain-model.result/1'),
    { kind: 'contract', contractId: 'praxis.domain-model.result', version: 1 },
  );
  assert.throws(() => parseMcpUri('praxis://projects/p1/modules/task-graph'));
  assert.throws(() => parseMcpUri('praxis://projects/p1/operations/op-1'));
  assert.throws(() => parseMcpUri('praxis://projects/p1/operations'));
  assert.deepEqual(
    parseMcpUri(
      'praxis://projects/p1/operations/MCPOP-11111111-1111-4111-8111-111111111111',
    ),
    {
      kind: 'operation',
      projectId: 'p1',
      operationId: 'MCPOP-11111111-1111-4111-8111-111111111111',
    },
  );
  assert.deepEqual(
    parseMcpUri(
      'praxis://projects/p1/operations/MCPOP-11111111-1111-4111-8111-111111111111/log',
    ),
    {
      kind: 'operation-log',
      projectId: 'p1',
      operationId: 'MCPOP-11111111-1111-4111-8111-111111111111',
    },
  );
});

void test('a list page returns a continuation cursor rather than dropping entries', () => {
  const items = Array.from({ length: 7 }, (_, index) => index);
  const first = pageList(items, undefined, 3);
  assert.deepEqual(first.page, [0, 1, 2]);
  assert.equal(first.total, 7);
  assert.ok(first.nextCursor);
  const second = pageList(items, first.nextCursor ?? undefined, 3);
  assert.deepEqual(second.page, [3, 4, 5]);
  const third = pageList(items, second.nextCursor ?? undefined, 3);
  assert.deepEqual(third.page, [6]);
  assert.equal(third.nextCursor, null);
});

void test('a content cursor is bound to the revision it was issued for', () => {
  const first = pageContent('abcdefghij', 'revision-a', undefined, 4);
  assert.equal(first.text, 'abcd');
  assert.ok(first.nextCursor);
  assert.throws(
    () => decodeContentCursor(first.nextCursor ?? undefined, 'revision-b'),
    (error: unknown) =>
      isMcpRequestError(error) && error.envelope.code === 'RESOURCE_CHANGED',
  );
  const second = pageContent(
    'abcdefghij',
    'revision-a',
    first.nextCursor ?? undefined,
    4,
  );
  assert.equal(second.text, 'efgh');
});

void test('a bounded read never splits a multi-byte character across pages', () => {
  const content = '甲乙丙丁';
  const pages: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = pageContent(content, 'revision-a', cursor, 4);
    pages.push(page.text);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(pages.join(''), content);
  assert.equal(pages.join('').includes('�'), false);
});

void test('a single character larger than the byte limit still advances', () => {
  const page = pageContent('甲乙', 'revision-a', undefined, 1);
  assert.equal(page.text, '甲');
  assert.ok(page.nextCursor);
});
