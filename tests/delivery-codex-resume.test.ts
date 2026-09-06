import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexAppServerDriver } from '../lib/agents/codex/app-server-driver.ts';
import { HostJobBroker } from '../lib/agents/host-job-broker.ts';

void test('Codex resume applies execution workspace and permissions to the existing briefing thread', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const captured = path.join(root, 'requests.jsonl');
  const server = path.join(root, 'server.mjs');
  await writeFile(
    server,
    `import readline from 'node:readline'; import {appendFileSync} from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => { const message=JSON.parse(line); if(!message.id)return; appendFileSync(process.argv[2], JSON.stringify(message)+'\\n'); send({id:message.id,result:message.method==='thread/start'?{thread:{id:'one-session'}}:{}}); });`,
  );
  const create = () =>
    new CodexAppServerDriver({
      command: process.execPath,
      arguments: [server, captured],
      brokerFactory: (input) =>
        new HostJobBroker(input.workingDirectory, path.join(root, 'jobs')),
    });
  const first = create();
  const thread = await first.startThread({
    profile: { agent: 'codex', model: '', effort: '' },
    workingDirectory: root,
    access: 'read-only',
    instructions: 'Orchestrate',
    hostJobs: false,
    advertiseHostJobs: true,
  });
  await first.close();
  const second = create();
  await second.resumeThread({
    ...thread,
    workingDirectory: path.join(root, 'worktree'),
    access: 'workspace-write',
    hostJobs: true,
  });
  await second.close();
  const requests = (await readFile(captured, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const start = requests.find(
    (request) => request.method === 'thread/start',
  ).params;
  const resume = requests.find(
    (request) => request.method === 'thread/resume',
  ).params;
  assert.equal(start.sandbox, 'read-only');
  assert.ok(
    start.dynamicTools.some(
      (tool: { name: string }) => tool.name === 'run_job',
    ),
  );
  assert.equal(resume.threadId, 'one-session');
  assert.equal(resume.cwd, path.join(root, 'worktree'));
  assert.equal(resume.sandbox, 'workspace-write');
  assert.equal(resume.developerInstructions, 'Orchestrate');
});
