import { syncProjectMain } from '../lib/modules/implementation/sync-main.ts';
import { githubReader } from '../lib/github-delivery.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  chmod,
  lstat,
  readFile,
  writeFile,
  rm,
  rename,
  realpath,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  ensureCardWorkspace,
  verifyCardWorkspace,
  restartCardWorkspace,
} from '../lib/modules/implementation/worktree.ts';
import { createExecutionService } from '../lib/modules/implementation/execution-service.ts';
import {
  createPlanningService,
  type PlanningCard,
} from '../lib/modules/implementation/planning-service.ts';
import { appendCardWorkRecord } from '../lib/modules/implementation/worklog.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';
import type {
  LocalAgentResult,
  startLocalAgentRun,
} from '../lib/agents/transport.ts';
import type { CardHarnessRequest } from '../lib/modules/implementation/harness.ts';

const exec = promisify(execFile);
const git = async (directory: string, ...args: string[]) =>
  (await exec('git', ['-C', directory, ...args])).stdout.trim();
async function fixture(
  t: { after: (callback: () => Promise<void>) => void },
  reader = githubReader,
) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'card-worktrees-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rootPath = path.join(base, 'project');
  const project: RegisteredProject = {
    id: randomUUID(),
    kind: 'standalone',
    rootPath,
    codePath: null,
    planningPath: path.join(rootPath, '.praxis'),
    name: 'Fixture',
    description: '',
    createdAt: '',
  };
  await mkdir(project.planningPath, { recursive: true });
  const actions = [1, 2].map((n) => ({
    id: randomUUID(),
    title: `Action ${n}`,
    input: 'Workspace',
    output: 'Working file',
    validation: 'Check file',
    acceptanceCriteria: [
      {
        id: 'AC-01',
        criterion: 'Working output',
        passCondition: 'The expected output is readable',
        evidence: 'Output reference',
      },
    ],
  }));
  const card: PlanningCard = {
    schemaVersion: 1,
    id: randomUUID(),
    revision: 1,
    source: {
      module: 'whats-next',
      id: 'NODE-fixture',
      uid: randomUUID(),
      title: 'Fixture Card',
      summary: 'Test worktree isolation',
      dependsOn: [],
      derivedFrom: [],
      outputPaths: [],
    },
    sourceRef: 'source.md',
    requirements: '',
    resources: [],
    plan: { status: 'finalized', overview: 'Two steps', steps: actions },
    actions,
    run: null,
    createdAt: '',
    updatedAt: '',
    finalizedAt: new Date().toISOString(),
  };
  await appendCardWorkRecord(
    path.join(project.planningPath, 'implementation/cards'),
    card.id,
    0,
    {
      kind: 'system-event',
      stage: 'planning',
      actionId: null,
      event: 'plan-finalized',
      text: 'Fixture confirmation',
      refs: [],
    },
    { 'planning-state.json': JSON.stringify(card) },
  );
  const calls: Array<{
    options: Parameters<typeof startLocalAgentRun>[1];
    request: CardHarnessRequest;
    resolve: (result: LocalAgentResult) => void;
    reject: (error: Error) => void;
  }> = [];
  const transport: typeof startLocalAgentRun = (_agent, options) => {
    const request = JSON.parse(
      options.prompt
        .split('\nREQUEST DATA')[1]
        .split(':\n')[1]
        .split('\n\nExecution runtime:')[0],
    );
    let resolve!: (result: LocalAgentResult) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<LocalAgentResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    calls.push({ options, request, resolve, reject });
    return { completion, cancel: () => reject(new Error('Fixture canceled')) };
  };
  const store = createPlanningService(undefined, new Map());
  let failResetPersistence = false;
  const activeRuns = new Map();
  const service = createExecutionService(
    store,
    transport,
    activeRuns,
    1800000,
    reader,
    undefined,
    async (...args) => {
      if (
        failResetPersistence &&
        args[3].kind === 'system-event' &&
        args[3].event === 'rollback-confirmed'
      )
        throw new Error('Fixture reset persistence failed');
      return appendCardWorkRecord(...args);
    },
    (input) => input.transport!(input.workerAgent, input.workerOptions),
  );
  const input = {
    cardId: card.id,
    actionId: actions[0].id,
    expectedRevision: 1,
    instruction: '',
    profile: {
      agent: 'codex' as const,
      model: 'fixture',
      effort: 'low' as const,
    },
  };
  async function settled() {
    for (let i = 0; i < 200; i++) {
      const current = await store.read(project, card.id);
      if (
        current.execution?.runs.at(-1)?.status !== 'running' &&
        activeRuns.size === 0
      )
        return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Fixture did not settle');
  }
  return {
    project,
    card,
    actions,
    calls,
    store,
    service,
    input,
    settled,
    failReset: () => {
      failResetPersistence = true;
    },
  };
}
function delivered(request: CardHarnessRequest): LocalAgentResult {
  return {
    agentSessionId: 'fixture',
    usage: null,
    finalOutput: JSON.stringify({
      harnessRevision: request.harnessRevision,
      requestId: request.requestId,
      cardId: request.context.cardId,
      contextRevision: request.context.contextRevision,
      inputFingerprint: request.inputFingerprint,
      handoffSummary: 'Fixture file written',
      stage: 'execution',
      actionId: request.actionId,
      outcome: 'delivered',
      summary: 'File written in Card worktree',
      artifactRefs: ['file:app.txt'],
      checks: [
        {
          criterionId: 'AC-01',
          summary: 'Read app',
          status: 'passed',
          evidenceRefs: ['file:app.txt'],
        },
      ],
      remaining: [],
    }),
  };
}
async function initializeRemoteFixture(
  project: RegisteredProject,
  content = 'initial\n',
) {
  const remote = path.join(path.dirname(project.rootPath), 'remote.git');
  const publisher = path.join(path.dirname(project.rootPath), 'publisher');
  await exec('git', ['init', '--bare', '--initial-branch=main', remote]);
  await git(project.rootPath, 'init', '-b', 'main');
  await git(project.rootPath, 'config', 'user.name', 'Fixture');
  await git(
    project.rootPath,
    'config',
    'user.email',
    'fixture@example.invalid',
  );
  await writeFile(path.join(project.rootPath, 'app.txt'), content);
  await git(project.rootPath, 'add', 'app.txt');
  await git(project.rootPath, 'commit', '-m', 'initial');
  await git(project.rootPath, 'remote', 'add', 'origin', remote);
  await git(project.rootPath, 'push', '-u', 'origin', 'main');
  await exec('git', ['clone', remote, publisher]);
  await git(publisher, 'config', 'user.name', 'Publisher');
  await git(publisher, 'config', 'user.email', 'publisher@example.invalid');
  return { remote, publisher };
}

void test('a new Card starts from the advanced remote default without changing the primary checkout', async (t) => {
  const f = await fixture(t);
  const { publisher } = await initializeRemoteFixture(f.project);
  const localHead = await git(f.project.rootPath, 'rev-parse', 'HEAD');
  await writeFile(path.join(publisher, 'app.txt'), 'merged\n');
  await git(publisher, 'commit', '-am', 'merged output');
  await git(publisher, 'push', 'origin', 'main');
  const remoteHead = await git(publisher, 'rev-parse', 'HEAD');

  const workspace = await ensureCardWorkspace(f.project, f.card);

  assert.equal(workspace.baseCommit, remoteHead);
  assert.equal(await git(workspace.path, 'rev-parse', 'HEAD'), remoteHead);
  assert.equal(
    await readFile(path.join(workspace.path, 'app.txt'), 'utf8'),
    'merged\n',
  );
  assert.equal(await git(f.project.rootPath, 'rev-parse', 'HEAD'), localHead);
  assert.equal(
    await readFile(path.join(f.project.rootPath, 'app.txt'), 'utf8'),
    'initial\n',
  );
});

void test('a remote default rename overrides a stale local origin HEAD', async (t) => {
  const f = await fixture(t);
  const remote = path.join(path.dirname(f.project.rootPath), 'remote.git');
  const publisher = path.join(path.dirname(f.project.rootPath), 'publisher');
  await exec('git', ['init', '--bare', '--initial-branch=master', remote]);
  await git(f.project.rootPath, 'init', '-b', 'master');
  await git(f.project.rootPath, 'config', 'user.name', 'Fixture');
  await git(
    f.project.rootPath,
    'config',
    'user.email',
    'fixture@example.invalid',
  );
  await writeFile(path.join(f.project.rootPath, 'app.txt'), 'master\n');
  await git(f.project.rootPath, 'add', 'app.txt');
  await git(f.project.rootPath, 'commit', '-m', 'master base');
  await git(f.project.rootPath, 'remote', 'add', 'origin', remote);
  await git(f.project.rootPath, 'push', '-u', 'origin', 'master');
  await git(f.project.rootPath, 'remote', 'set-head', 'origin', 'master');
  assert.equal(
    await git(
      f.project.rootPath,
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ),
    'origin/master',
  );
  await exec('git', ['clone', remote, publisher]);
  await git(publisher, 'config', 'user.name', 'Publisher');
  await git(publisher, 'config', 'user.email', 'publisher@example.invalid');
  await git(publisher, 'checkout', '-b', 'main');
  await writeFile(path.join(publisher, 'app.txt'), 'main\n');
  await git(publisher, 'commit', '-am', 'main default');
  await git(publisher, 'push', '-u', 'origin', 'main');
  await exec('git', [
    '--git-dir',
    remote,
    'symbolic-ref',
    'HEAD',
    'refs/heads/main',
  ]);
  const mainHead = await git(publisher, 'rev-parse', 'HEAD');

  const workspace = await ensureCardWorkspace(f.project, f.card);

  assert.equal(workspace.baseCommit, mainHead);
  assert.equal(
    await readFile(path.join(workspace.path, 'app.txt'), 'utf8'),
    'main\n',
  );
  assert.equal(
    await git(
      f.project.rootPath,
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ),
    'origin/master',
    'the Host reads the advertised default without rewriting repository metadata',
  );
});

void test('a new Card uses remote main while preserving ahead local commits', async (t) => {
  const f = await fixture(t);
  await initializeRemoteFixture(f.project);
  await writeFile(path.join(f.project.rootPath, 'app.txt'), 'local ahead\n');
  await git(f.project.rootPath, 'commit', '-am', 'local work');
  const localHead = await git(f.project.rootPath, 'rev-parse', 'HEAD');

  const workspace = await ensureCardWorkspace(f.project, f.card);

  assert.equal(
    workspace.baseCommit,
    await git(f.project.rootPath, 'rev-parse', 'origin/main'),
  );
  assert.equal(await git(f.project.rootPath, 'rev-parse', 'HEAD'), localHead);
  assert.equal(
    await readFile(path.join(workspace.path, 'app.txt'), 'utf8'),
    'initial\n',
  );
});

void test('a divergent local branch is preserved while a new worktree uses remote main', async (t) => {
  const f = await fixture(t);
  const { publisher } = await initializeRemoteFixture(f.project);
  await writeFile(path.join(f.project.rootPath, 'local.txt'), 'local\n');
  await git(f.project.rootPath, 'add', 'local.txt');
  await git(f.project.rootPath, 'commit', '-m', 'local divergence');
  await writeFile(path.join(publisher, 'remote.txt'), 'remote\n');
  await git(publisher, 'add', 'remote.txt');
  await git(publisher, 'commit', '-m', 'remote divergence');
  await git(publisher, 'push', 'origin', 'main');

  const workspace = await ensureCardWorkspace(f.project, f.card);
  assert.equal(workspace.baseCommit, await git(publisher, 'rev-parse', 'HEAD'));
  assert.equal(
    await readFile(path.join(f.project.rootPath, 'local.txt'), 'utf8'),
    'local\n',
  );
});

void test('an unavailable remote cannot silently create a task from stale local HEAD', async (t) => {
  const f = await fixture(t);
  await git(f.project.rootPath, 'init', '-b', 'main');
  await git(f.project.rootPath, 'config', 'user.name', 'Fixture');
  await git(
    f.project.rootPath,
    'config',
    'user.email',
    'fixture@example.invalid',
  );
  await writeFile(path.join(f.project.rootPath, 'app.txt'), 'offline\n');
  await git(f.project.rootPath, 'add', 'app.txt');
  await git(f.project.rootPath, 'commit', '-m', 'offline base');
  await git(
    f.project.rootPath,
    'remote',
    'add',
    'origin',
    path.join(path.dirname(f.project.rootPath), 'missing.git'),
  );
  await assert.rejects(
    () => ensureCardWorkspace(f.project, f.card),
    /Could not fetch the latest default branch/,
  );
});

void test('empty bootstrap initializes locally and Actions reuse one isolated Card worktree', async (t) => {
  const f = await fixture(t);
  await f.service.start(f.project, f.input);
  const directory = f.calls[0].options.workingDirectory;
  assert.notEqual(directory, f.project.rootPath);
  const common = await realpath(path.join(f.project.rootPath, '.git'));
  assert.ok(
    f.calls[0].options.gitWritePaths?.includes(path.join(common, 'objects')),
  );
  assert.ok(!f.calls[0].options.gitWritePaths?.includes(common));
  assert.ok(
    !f.calls[0].options.gitWritePaths?.includes(path.join(common, 'HEAD')),
  );
  assert.ok(
    !f.calls[0].options.gitWritePaths?.includes(path.join(common, 'index')),
  );
  assert.ok(
    !f.calls[0].options.gitWritePaths?.includes(
      path.join(common, 'refs/heads/main'),
    ),
  );
  assert.equal(f.calls[0].options.protectedPath, f.project.planningPath);
  const main = await git(f.project.rootPath, 'rev-parse', 'HEAD');
  await writeFile(path.join(directory, 'app.txt'), 'first Action');
  f.calls[0].resolve(delivered(f.calls[0].request));
  let current = await f.settled();
  assert.equal(current.execution?.runs[0].status, 'succeeded');
  assert.equal(await git(f.project.rootPath, 'rev-parse', 'HEAD'), main);
  await assert.rejects(
    () => readFile(path.join(f.project.rootPath, 'app.txt')),
    /ENOENT/,
  );
  current = await f.service.update(
    f.project,
    f.card.id,
    current.revision,
    'accept',
    current.execution!.runs[0].id,
  );
  await f.service.start(f.project, {
    ...f.input,
    actionId: f.actions[1].id,
    expectedRevision: current.revision,
  });
  assert.equal(f.calls[1].options.workingDirectory, directory);
  assert.equal(
    await readFile(path.join(directory, 'app.txt'), 'utf8'),
    'first Action',
  );
  await writeFile(path.join(directory, 'app.txt'), 'second Action');
  f.calls[1].resolve(delivered(f.calls[1].request));
  current = await f.settled();
  assert.equal(current.execution?.runs[1].status, 'succeeded');
  assert.equal(current.execution?.workspace?.path, directory);
});

void test('undo restores only the current Action to its clean baseline', async (t) => {
  const f = await fixture(t);
  await f.service.start(f.project, {
    ...f.input,
    initializeRepository: true,
  });
  const firstWorkspace = f.calls[0].options.workingDirectory;
  await writeFile(path.join(firstWorkspace, 'app.txt'), 'first Action');
  await writeFile(path.join(firstWorkspace, '.env'), 'LOCAL=value');
  f.calls[0].resolve(delivered(f.calls[0].request));
  let card = await f.settled();
  card = await f.service.update(
    f.project,
    f.card.id,
    card.revision,
    'accept',
    card.execution!.runs[0].id,
  );
  await writeFile(path.join(firstWorkspace, 'between.txt'), 'before Action 2');
  await writeFile(path.join(firstWorkspace, 'private.txt'), 'private');
  await chmod(path.join(firstWorkspace, 'private.txt'), 0o600);
  await f.service.start(f.project, {
    ...f.input,
    actionId: f.actions[1].id,
    expectedRevision: card.revision,
    instruction: 'Try the risky approach',
  });
  await writeFile(path.join(firstWorkspace, 'app.txt'), 'broken second Action');
  await writeFile(path.join(firstWorkspace, 'between.txt'), 'broken Action 2');
  await writeFile(path.join(firstWorkspace, 'partial.txt'), 'remove me');
  f.calls[1].reject(new Error('Needs user input'));
  card = await f.settled();

  const undone = await f.service.undoAction(
    f.project,
    f.card.id,
    f.actions[1].id,
    card.revision,
  );

  assert.deepEqual(undone.execution?.acceptedActionIds, [f.actions[0].id]);
  assert.deepEqual(
    undone.execution?.runs.map((run) => run.actionId),
    [f.actions[0].id],
  );
  assert.equal(
    undone.execution?.retryInputs?.[f.actions[1].id],
    'Try the risky approach',
  );
  assert.equal(undone.plan?.status, 'finalized');
  const cleanWorkspace = undone.execution!.workspace!.path;
  assert.notEqual(cleanWorkspace, firstWorkspace);
  assert.equal(
    await readFile(path.join(cleanWorkspace, 'app.txt'), 'utf8'),
    'first Action',
  );
  assert.equal(
    await readFile(path.join(cleanWorkspace, '.env'), 'utf8'),
    'LOCAL=value',
  );
  assert.equal(
    await readFile(path.join(cleanWorkspace, 'between.txt'), 'utf8'),
    'before Action 2',
  );
  assert.equal(
    (await lstat(path.join(cleanWorkspace, 'private.txt'))).mode & 0o777,
    0o600,
  );
  await assert.rejects(
    () => readFile(path.join(cleanWorkspace, 'partial.txt')),
    /ENOENT/,
  );
  assert.equal(
    await readFile(
      path.join(
        undone.execution!.workspaceBackups!.at(-1)!.path,
        'partial.txt',
      ),
      'utf8',
    ),
    'remove me',
  );
  assert.equal(f.calls.length, 2);
});

void test('legacy Undo ignores unrecoverable untracked baseline state generically', async (t) => {
  const f = await fixture(t);
  await f.service.start(f.project, {
    ...f.input,
    initializeRepository: true,
  });
  const workspace = f.calls[0].options.workingDirectory;
  await writeFile(path.join(workspace, 'app.txt'), 'accepted Action');
  f.calls[0].resolve(delivered(f.calls[0].request));
  let card = await f.settled();
  card = await f.service.update(
    f.project,
    f.card.id,
    card.revision,
    'accept',
    card.execution!.runs[0].id,
  );
  const transient = path.join(workspace, 'tool-local-state.tmp');
  await writeFile(transient, 'temporary');
  await f.service.start(f.project, {
    ...f.input,
    actionId: f.actions[1].id,
    expectedRevision: card.revision,
  });
  await rm(transient);
  f.calls[1].reject(new Error('Needs user input'));
  card = await f.settled();
  const legacy = structuredClone(card);
  legacy.revision += 1;
  legacy.execution!.runs[1].baselineRef = undefined;
  legacy.execution!.runs[1].parentCommit = legacy.execution!.runs[0].commit;
  await appendCardWorkRecord(
    path.join(f.project.planningPath, 'implementation/cards'),
    f.card.id,
    card.revision,
    {
      kind: 'system-event',
      stage: 'execution',
      actionId: f.actions[1].id,
      event: 'run-ended',
      text: 'Fixture converted this Round to the legacy checkpoint shape.',
      refs: [],
    },
    { 'planning-state.json': JSON.stringify(legacy) },
  );

  const undone = await f.service.undoAction(
    f.project,
    f.card.id,
    f.actions[1].id,
    legacy.revision,
  );

  assert.deepEqual(undone.execution?.acceptedActionIds, [f.actions[0].id]);
  assert.deepEqual(
    undone.execution?.runs.map((run) => run.actionId),
    [f.actions[0].id],
  );
  assert.equal(
    await readFile(
      path.join(undone.execution!.workspace!.path, 'app.txt'),
      'utf8',
    ),
    'accepted Action',
  );
  await assert.rejects(
    () =>
      readFile(
        path.join(undone.execution!.workspace!.path, 'tool-local-state.tmp'),
      ),
    /ENOENT/,
  );
});

void test('failed Undo persistence restores the original active worktree', async (t) => {
  const f = await fixture(t);
  await f.service.start(f.project, {
    ...f.input,
    initializeRepository: true,
  });
  const workspace = f.calls[0].options.workingDirectory;
  await writeFile(path.join(workspace, 'app.txt'), 'accepted Action');
  f.calls[0].resolve(delivered(f.calls[0].request));
  let card = await f.settled();
  card = await f.service.update(
    f.project,
    f.card.id,
    card.revision,
    'accept',
    card.execution!.runs[0].id,
  );
  await f.service.start(f.project, {
    ...f.input,
    actionId: f.actions[1].id,
    expectedRevision: card.revision,
  });
  await writeFile(path.join(workspace, 'app.txt'), 'broken Action');
  f.calls[1].reject(new Error('Needs user input'));
  card = await f.settled();
  f.failReset();

  await assert.rejects(
    () =>
      f.service.undoAction(
        f.project,
        f.card.id,
        f.actions[1].id,
        card.revision,
      ),
    /persistence failed/,
  );

  assert.equal(
    (await f.store.read(f.project, f.card.id)).revision,
    card.revision,
  );
  assert.equal((await ensureCardWorkspace(f.project, card)).path, workspace);
  assert.equal(
    await readFile(path.join(workspace, 'app.txt'), 'utf8'),
    'broken Action',
  );
});
void test('different Cards have distinct branches, and dirty primary checkout content is never copied or overwritten', async (t) => {
  const f = await fixture(t);
  const first = await ensureCardWorkspace(f.project, f.card, true);
  await writeFile(
    path.join(f.project.rootPath, 'personal.txt'),
    'primary only',
  );
  await git(f.project.rootPath, 'add', 'personal.txt');
  const before = await git(f.project.rootPath, 'diff', '--cached');
  const other = { ...f.card, id: randomUUID() };
  await mkdir(
    path.join(f.project.planningPath, 'implementation/cards', other.id),
  );
  const second = await ensureCardWorkspace(f.project, other);
  assert.notEqual(first.path, second.path);
  assert.notEqual(first.branch, second.branch);
  await assert.rejects(
    () => readFile(path.join(second.path, 'personal.txt')),
    /ENOENT/,
  );
  assert.equal(await git(f.project.rootPath, 'diff', '--cached'), before);
  assert.equal(
    await readFile(path.join(f.project.rootPath, 'personal.txt'), 'utf8'),
    'primary only',
  );
});
void test('failed Card restart preserves untracked and ignored files plus history and never auto-starts', async (t) => {
  const f = await fixture(t);
  await f.service.start(f.project, { ...f.input, initializeRepository: true });
  const directory = f.calls[0].options.workingDirectory;
  await writeFile(path.join(directory, 'app.txt'), 'partial');
  await mkdir(path.join(directory, 'node_modules'));
  await writeFile(
    path.join(directory, 'node_modules/keep.bin'),
    'ignored output',
  );
  f.calls[0].reject(new Error('Fixture failed'));
  let current = await f.settled();
  await f.service.resetWorkspace(f.project, f.card.id, current.revision);
  const preview = (
    await f.service.resetWorkspace(f.project, f.card.id, current.revision)
  ).preview!;
  await writeFile(path.join(directory, 'app.txt'), 'later edit');
  await assert.rejects(
    () =>
      f.service.resetWorkspace(
        f.project,
        f.card.id,
        current.revision,
        preview.token,
      ),
    /Workspace changed/,
  );
  const freshPreview = (
    await f.service.resetWorkspace(f.project, f.card.id, current.revision)
  ).preview!;
  current = (
    await f.service.resetWorkspace(
      f.project,
      f.card.id,
      current.revision,
      freshPreview.token,
    )
  ).card!;
  assert.equal(current.execution?.runs.length, 0);
  assert.equal(current.plan?.status, 'finalized');
  assert.equal(f.calls.length, 1);
  assert.notEqual(current.execution?.workspace?.path, directory);
  const backup = current.execution!.workspaceBackups![0];
  assert.equal(
    await readFile(path.join(backup.path, 'app.txt'), 'utf8'),
    'later edit',
  );
  assert.equal(
    await readFile(path.join(backup.path, 'node_modules/keep.bin'), 'utf8'),
    'ignored output',
  );
  await verifyCardWorkspace(backup);
  await assert.rejects(
    () => readFile(path.join(current.execution!.workspace!.path, 'app.txt')),
    /ENOENT/,
  );
  await f.service.start(f.project, {
    ...f.input,
    expectedRevision: current.revision,
  });
  assert.equal(f.calls.length, 2);
  f.calls[1].reject(new Error('Fixture ends'));
  await f.settled();
});
void test('delivered but unaccepted Card can restart from its base', async (t) => {
  const f = await fixture(t);
  await f.service.start(f.project, { ...f.input, initializeRepository: true });
  const directory = f.calls[0].options.workingDirectory;
  await writeFile(path.join(directory, 'app.txt'), 'delivered candidate');
  f.calls[0].resolve(delivered(f.calls[0].request));
  const current = await f.settled();
  assert.equal(current.execution?.runs.at(-1)?.result?.outcome, 'delivered');
  await assert.rejects(
    () => f.service.reopenPlanFromBase(f.project, f.card.id, current.revision),
    /accepted work/,
  );
  const preview = (
    await f.service.resetWorkspace(f.project, f.card.id, current.revision)
  ).preview!;
  const reset = (
    await f.service.resetWorkspace(
      f.project,
      f.card.id,
      current.revision,
      preview.token,
    )
  ).card!;
  assert.equal(reset.execution?.runs.length, 0);
  assert.equal(reset.execution?.acceptedActionIds.length, 0);
  assert.notEqual(reset.execution?.workspace?.path, directory);
  const backup = reset.execution?.workspaceBackups?.at(-1);
  assert.ok(backup);
  assert.notEqual(backup.path, directory);
  assert.equal(
    await readFile(path.join(backup.path, 'app.txt'), 'utf8'),
    'delivered candidate',
  );
});
void test('an accepted Action can return the Card to planning from its base', async (t) => {
  const f = await fixture(t);
  await f.service.start(f.project, { ...f.input, initializeRepository: true });
  const directory = f.calls[0].options.workingDirectory;
  await writeFile(path.join(directory, 'app.txt'), 'accepted output');
  f.calls[0].resolve(delivered(f.calls[0].request));
  let current = await f.settled();
  const output = current.execution!.runs.at(-1)!;
  current = await f.service.update(
    f.project,
    f.card.id,
    current.revision,
    'accept',
    output.id,
  );
  await assert.rejects(
    () => f.service.resetWorkspace(f.project, f.card.id, current.revision),
    /Only unaccepted Cards/,
  );

  const preview = (
    await f.service.reopenPlanFromBase(f.project, f.card.id, current.revision)
  ).preview!;
  const reopened = (
    await f.service.reopenPlanFromBase(
      f.project,
      f.card.id,
      current.revision,
      preview.token,
    )
  ).card!;

  assert.equal(reopened.plan?.status, 'draft');
  assert.deepEqual(reopened.actions, []);
  assert.equal(reopened.finalizedAt, null);
  assert.deepEqual(reopened.execution?.runs, []);
  assert.deepEqual(reopened.execution?.acceptedActionIds, []);
  const backup = reopened.execution?.workspaceBackups?.at(-1);
  assert.ok(backup);
  assert.equal(
    await readFile(path.join(backup.path, 'app.txt'), 'utf8'),
    'accepted output',
  );
});
void test('missing and branch-switched worktrees block continuation rather than silently changing directories', async (t) => {
  const f = await fixture(t);
  const workspace = await ensureCardWorkspace(f.project, f.card, true);
  await git(workspace.path, 'checkout', '-b', 'unexpected');
  await assert.rejects(
    () => ensureCardWorkspace(f.project, f.card),
    /identity changed/,
  );
  await git(workspace.path, 'checkout', workspace.branch);
  await rename(workspace.path, workspace.path + '-missing');
  await assert.rejects(() => ensureCardWorkspace(f.project, f.card), /ENOENT/);
});
void test('already merged Card commits cannot be reset as unmerged work', async (t) => {
  const f = await fixture(t);
  const workspace = await ensureCardWorkspace(f.project, f.card, true);
  await writeFile(path.join(workspace.path, 'app.txt'), 'delivered');
  await git(workspace.path, 'add', 'app.txt');
  await git(
    workspace.path,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'delivered',
  );
  await git(f.project.rootPath, 'merge', '--ff-only', workspace.branch);
  await assert.rejects(
    () =>
      restartCardWorkspace(f.project, {
        ...f.card,
        execution: { workspace, runs: [], acceptedActionIds: [] },
      }),
    /already in the primary/,
  );
});

void test('empty remote permits local reset without requiring a remote default branch', async (t) => {
  const f = await fixture(t, {
    repository: async () => {
      throw new Error('No default branch');
    },
    pullRequest: async () => {
      throw new Error('No PR');
    },
    branchPullRequests: async () => [],
  });
  await f.service.start(f.project, { ...f.input, initializeRepository: true });
  await git(
    f.calls[0].options.workingDirectory,
    'remote',
    'add',
    'origin',
    'https://github.com/example/empty',
  );
  f.calls[0].reject(new Error('Failed before first push'));
  const current = await f.settled();
  const preview = (
    await f.service.resetWorkspace(f.project, f.card.id, current.revision)
  ).preview!;
  assert.equal(preview.repositoryUrl, 'https://github.com/example/empty');
  const reset = (
    await f.service.resetWorkspace(
      f.project,
      f.card.id,
      current.revision,
      preview.token,
    )
  ).card!;
  assert.equal(reset.execution?.runs.length, 0);
});

void test('reset persistence failure restores the previous active worktree and state', async (t) => {
  const f = await fixture(t);
  await f.service.start(f.project, { ...f.input, initializeRepository: true });
  const directory = f.calls[0].options.workingDirectory;
  await writeFile(path.join(directory, 'app.txt'), 'must survive');
  f.calls[0].reject(new Error('Fixture failure'));
  const current = await f.settled();
  const preview = (
    await f.service.resetWorkspace(f.project, f.card.id, current.revision)
  ).preview!;
  f.failReset();
  await assert.rejects(
    () =>
      f.service.resetWorkspace(
        f.project,
        f.card.id,
        current.revision,
        preview.token,
      ),
    /persistence failed/,
  );
  assert.equal(
    await readFile(path.join(directory, 'app.txt'), 'utf8'),
    'must survive',
  );
  assert.equal(
    (await f.store.read(f.project, f.card.id)).revision,
    current.revision,
  );
  const existing = await ensureCardWorkspace(f.project, current);
  assert.equal(existing.path, directory);
});

void test('sidecar write failure during reset does not strand the old worktree path', async (t) => {
  const f = await fixture(t);
  const workspace = await ensureCardWorkspace(f.project, f.card, true);
  const sidecar = path.join(
    f.project.planningPath,
    'implementation/cards',
    f.card.id,
    'workspace.json',
  );
  await rename(sidecar, sidecar + '.saved');
  await mkdir(sidecar);
  await assert.rejects(() =>
    restartCardWorkspace(f.project, {
      ...f.card,
      execution: { workspace, runs: [], acceptedActionIds: [] },
    }),
  );
  await verifyCardWorkspace(workspace);
  await rm(sidecar, { recursive: true });
  await rename(sidecar + '.saved', sidecar);
  assert.equal(
    (await ensureCardWorkspace(f.project, f.card)).path,
    workspace.path,
  );
});

void test('Sync Up fetches main without disturbing another branch or dirty files', async (t) => {
  const f = await fixture(t);
  const { publisher } = await initializeRemoteFixture(f.project);
  await git(f.project.rootPath, 'switch', '-c', 'busy-work');
  await writeFile(path.join(f.project.rootPath, 'local.txt'), 'unfinished\n');
  await writeFile(path.join(publisher, 'app.txt'), 'merged\n');
  await git(publisher, 'commit', '-am', 'merged change');
  await git(publisher, 'push', 'origin', 'main');
  const result = await syncProjectMain(f.project.rootPath);
  assert.equal(result.head, await git(publisher, 'rev-parse', 'HEAD'));
  assert.equal(
    await git(f.project.rootPath, 'branch', '--show-current'),
    'busy-work',
  );
  assert.equal(
    await readFile(path.join(f.project.rootPath, 'local.txt'), 'utf8'),
    'unfinished\n',
  );
  const workspace = await ensureCardWorkspace(f.project, f.card);
  assert.equal(workspace.baseCommit, result.head);
  assert.equal(await git(workspace.path, 'status', '--porcelain'), '');
});

void test('Sync Up materializes merged files while preserving unrelated untracked references even when origin was already fetched', async (t) => {
  const f = await fixture(t);
  const { publisher } = await initializeRemoteFixture(f.project);
  await writeFile(
    path.join(f.project.rootPath, '.git/info/exclude'),
    '.praxis/\n',
  );
  await writeFile(path.join(publisher, 'merged.txt'), 'delivered\n');
  await git(publisher, 'add', 'merged.txt');
  await git(publisher, 'commit', '-m', 'delivered');
  await git(publisher, 'push', 'origin', 'main');
  await git(f.project.rootPath, 'fetch', 'origin');
  await writeFile(
    path.join(f.project.rootPath, 'design-notes.md'),
    'local reference\n',
  );
  const result = await syncProjectMain(f.project.rootPath);
  assert.equal(result.checkoutUpdated, true);
  assert.equal(
    await readFile(path.join(f.project.rootPath, 'merged.txt'), 'utf8'),
    'delivered\n',
  );
  assert.equal(await git(f.project.rootPath, 'rev-parse', 'HEAD'), result.head);
  assert.equal(
    await readFile(path.join(f.project.rootPath, 'design-notes.md'), 'utf8'),
    'local reference\n',
  );
});

void test('Sync Up reports an untracked-file collision without overwriting user content', async (t) => {
  const f = await fixture(t);
  const { publisher } = await initializeRemoteFixture(f.project);
  const previous = await git(f.project.rootPath, 'rev-parse', 'HEAD');
  await writeFile(path.join(publisher, 'shared-name.txt'), 'remote\n');
  await git(publisher, 'add', 'shared-name.txt');
  await git(publisher, 'commit', '-m', 'delivered');
  await git(publisher, 'push', 'origin', 'main');
  await writeFile(
    path.join(f.project.rootPath, 'shared-name.txt'),
    'local reference\n',
  );
  await assert.rejects(syncProjectMain(f.project.rootPath), /overwritten/);
  assert.equal(await git(f.project.rootPath, 'rev-parse', 'HEAD'), previous);
  assert.equal(
    await readFile(path.join(f.project.rootPath, 'shared-name.txt'), 'utf8'),
    'local reference\n',
  );
});
