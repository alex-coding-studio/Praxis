import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  deliverCardCandidate,
  prepareCardEnvironment,
  publishCardCandidate,
  withGitHubPublicationIdentity,
  type HostCommandRunner,
} from '../lib/card-host-operations.ts';
import type { CardWorkspace } from '../lib/modules/implementation/worktree.ts';

const execute = promisify(execFile);

void test('GitHub publication switches to the required API identity and restores the caller account', async () => {
  let activeAccount = 'Cunqi';
  const apiLogins: Record<string, string> = {
    Cunqi: 'human-user',
    xiaocq203: 'cunqi-bot',
  };
  const switches: string[] = [];
  const runner: HostCommandRunner = async (command, arguments_) => {
    assert.equal(command, 'gh');
    if (arguments_.join(' ') === 'api user --jq .login')
      return apiLogins[activeAccount]!;
    if (arguments_[0] === 'auth' && arguments_[1] === 'status')
      return JSON.stringify({
        hosts: {
          'github.com': Object.keys(apiLogins).map((login) => ({
            login,
            active: login === activeAccount,
            state: 'success',
          })),
        },
      });
    if (arguments_[0] === 'auth' && arguments_[1] === 'switch') {
      activeAccount = arguments_[arguments_.indexOf('--user') + 1]!;
      switches.push(activeAccount);
      return '';
    }
    throw new Error(`Unexpected command: ${arguments_.join(' ')}`);
  };
  const result = await withGitHubPublicationIdentity(
    runner,
    '/tmp/workspace',
    'cunqi-bot',
    async () => {
      assert.equal(activeAccount, 'xiaocq203');
      return 'published';
    },
  );
  assert.equal(result, 'published');
  assert.equal(activeAccount, 'Cunqi');
  assert.deepEqual(switches, ['xiaocq203', 'Cunqi']);
});

async function fixture(
  t: { after: (callback: () => Promise<void>) => void },
  empty = false,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'card-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  const workspacePath = path.join(root, 'workspace');
  await mkdir(repository);
  await execute('git', ['init', '-q', '--initial-branch=main', repository]);
  await execute('git', ['-C', repository, 'config', 'user.name', 'Agent Bot']);
  await execute('git', [
    '-C',
    repository,
    'config',
    'user.email',
    'agent@example.invalid',
  ]);
  if (!empty) {
    await writeFile(path.join(repository, 'README.md'), 'base\n');
    await execute('git', ['-C', repository, 'add', 'README.md']);
  }
  await execute('git', [
    '-C',
    repository,
    'commit',
    '--allow-empty',
    '-q',
    '-m',
    'base',
  ]);
  const baseSha = (
    await execute('git', ['-C', repository, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  const branch = 'praxis/card-fixture';
  await execute('git', [
    '-C',
    repository,
    'worktree',
    'add',
    '-q',
    '-b',
    branch,
    workspacePath,
    baseSha,
  ]);
  const common = (
    await execute('git', [
      '-C',
      repository,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
  ).stdout.trim();
  const workspace: CardWorkspace = {
    path: await realpath(workspacePath),
    repository: await realpath(repository),
    branch,
    baseCommit: baseSha,
    gitDirectory: await realpath(common),
  };
  return { root, repository, workspace, baseSha };
}

function runner(state: {
  headSha?: string;
  created?: boolean;
  remoteHead?: string;
}): HostCommandRunner {
  return async (command, arguments_, options) => {
    if (command === 'git') {
      if (arguments_.includes('push')) {
        state.remoteHead = state.headSha;
        return '';
      }
      if (arguments_.includes('ls-remote'))
        return state.remoteHead
          ? `${state.remoteHead}\t${arguments_.at(-1)}`
          : '';
      return (
        await execute(command, arguments_, {
          cwd: options?.cwd,
          env: options?.env,
        })
      ).stdout.trim();
    }
    assert.equal(command, 'gh');
    const joined = arguments_.join(' ');
    if (joined === 'api user --jq .login') return 'agent-bot';
    if (joined.includes('.permissions.push')) return 'true';
    if (arguments_[0] === 'pr' && arguments_[1] === 'create') {
      state.created = true;
      return 'https://github.com/example/repository/pull/7';
    }
    if (arguments_[0] === 'pr' && arguments_[1] === 'view')
      return JSON.stringify({
        number: 7,
        url: 'https://github.com/example/repository/pull/7',
        state: 'OPEN',
        isDraft: true,
        headRefOid: state.headSha,
      });
    if (arguments_[0] === 'pr' && arguments_[1] === 'list')
      return state.created
        ? JSON.stringify([
            {
              number: 7,
              url: 'https://github.com/example/repository/pull/7',
              state: 'OPEN',
              isDraft: true,
              headRefOid: state.headSha,
            },
          ])
        : '[]';
    throw new Error(`Unexpected command: ${command} ${joined}`);
  };
}

void test('Environment Manifest is reusable and records Host-verified facts', async (t) => {
  const f = await fixture(t);
  const outputPath = path.join(f.root, 'environment.json');
  const state = {};
  const intercepted = runner(state);
  const environment = await prepareCardEnvironment(
    {
      cardId: 'card-fixture',
      projectId: 'project-fixture',
      workspace: f.workspace,
      roles: {
        commit: 'agent-bot',
        delivery: 'bot',
        approval: 'user',
        expectedGitHubLogin: 'agent-bot',
      },
      outputPath,
    },
    async (command, arguments_, options) => {
      if (arguments_.includes('get-url'))
        return 'https://github.com/example/repository.git';
      if (arguments_.includes('symbolic-ref')) return 'origin/main';
      return intercepted(command, arguments_, options);
    },
  );
  assert.equal(environment.workspace.headSha, f.baseSha);
  assert.equal(environment.workspace.clean, true);
  assert.equal(environment.repository.defaultBranch, 'main');
  assert.equal(environment.git.authorName, 'Agent Bot');
  const repeated = await prepareCardEnvironment(
    {
      cardId: 'card-fixture',
      projectId: 'project-fixture',
      workspace: f.workspace,
      roles: environment.roles,
      outputPath,
    },
    async (command, arguments_, options) => {
      if (arguments_.includes('get-url'))
        return 'https://github.com/example/repository.git';
      if (arguments_.includes('symbolic-ref')) return 'origin/main';
      return intercepted(command, arguments_, options);
    },
  );
  assert.equal(repeated.environmentId, environment.environmentId);
  assert.equal(
    JSON.parse(await readFile(outputPath, 'utf8')).environmentId,
    environment.environmentId,
  );
});

void test('Candidate Publisher handles multiple commits as one idempotent HEAD', async (t) => {
  const f = await fixture(t);
  await execute('git', [
    '-C',
    f.workspace.path,
    'remote',
    'add',
    'origin',
    'https://github.com/example/repository.git',
  ]);
  const state: { headSha?: string; created?: boolean; remoteHead?: string } =
    {};
  const intercepted = runner(state);
  const environment = await prepareCardEnvironment(
    {
      cardId: 'card-fixture',
      projectId: 'project-fixture',
      workspace: f.workspace,
      roles: {
        commit: 'agent-bot',
        delivery: 'bot',
        approval: 'user',
        expectedGitHubLogin: 'agent-bot',
      },
    },
    async (command, arguments_, options) => {
      if (arguments_.includes('get-url'))
        return 'https://github.com/example/repository.git';
      if (arguments_.includes('symbolic-ref')) return 'origin/main';
      return intercepted(command, arguments_, options);
    },
  );
  for (const [file, content] of [
    ['one.txt', 'one'],
    ['two.txt', 'two'],
  ]) {
    await writeFile(path.join(f.workspace.path, file), content);
    await execute('git', ['-C', f.workspace.path, 'add', file]);
    await execute('git', [
      '-C',
      f.workspace.path,
      'commit',
      '-q',
      '-m',
      `add ${file}`,
    ]);
  }
  state.headSha = (
    await execute('git', ['-C', f.workspace.path, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  const request = {
    environment,
    actionId: 'action-1',
    roundId: 'round-1',
    baseSha: f.baseSha,
    headSha: state.headSha,
    title: 'Candidate',
    body: 'Candidate body',
    draft: true,
  };
  const publication = await publishCardCandidate(request, intercepted);
  assert.equal(publication.commitCount, 2);
  assert.deepEqual(publication.changedFiles, ['one.txt', 'two.txt']);
  assert.equal(publication.pullRequest.number, 7);
  const repeated = await publishCardCandidate(request, intercepted);
  assert.equal(repeated.candidateId, publication.candidateId);
  assert.equal(repeated.pullRequest.number, 7);
  const actionBranches: string[] = [];
  const secondState: { headSha?: string; created?: boolean } = {
    headSha: state.headSha,
  };
  const secondRunner = runner(secondState);
  const second = await publishCardCandidate(
    { ...request, actionId: 'action-2' },
    async (command, args, options) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        const branch = args[args.indexOf('--head') + 1];
        actionBranches.push(branch);
        assert.notEqual(branch, f.workspace.branch);
        assert.notEqual(branch, publication.branch);
      }
      return secondRunner(command, args, options);
    },
  );
  assert.ok(actionBranches.length > 0);
  assert.notEqual(second.candidateId, publication.candidateId);
  assert.equal(second.branch, `${f.workspace.branch}--action-action-2`);
  assert.equal(
    (
      await execute('git', ['-C', f.workspace.path, 'branch', '--show-current'])
    ).stdout.trim(),
    f.workspace.branch,
  );
  const transitions: string[] = [];
  state.remoteHead = f.baseSha;
  await publishCardCandidate(request, async (command, args, options) => {
    transitions.push(args.join(' '));
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'list')
      return JSON.stringify([
        {
          number: 7,
          url: publication.pullRequest.url,
          state: 'OPEN',
          isDraft: false,
          headRefOid: state.headSha,
        },
      ]);
    if (command === 'gh' && args[1] === 'ready') return '';
    return intercepted(command, args, options);
  });
  assert.ok(
    transitions.findIndex((call) => call.includes('--undo')) <
      transitions.findIndex((call) => call.includes('push origin')),
  );
  state.remoteHead = f.baseSha;
  let pushes = 0;
  let observations = 0;
  let readyCalls = 0;
  const delayed = await publishCardCandidate(
    { ...request, draft: false },
    async (command, args, options) => {
      if (command === 'git' && args.includes('push')) pushes++;
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        observations++;
        return JSON.stringify({
          number: 7,
          url: publication.pullRequest.url,
          state: 'OPEN',
          isDraft: true,
          headRefOid: observations < 3 ? f.baseSha : state.headSha,
        });
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
        assert.equal(observations, 3);
        readyCalls++;
        return '';
      }
      return intercepted(command, args, options);
    },
  );
  assert.equal(delayed.pullRequest.headSha, state.headSha);
  assert.equal(delayed.pullRequest.draft, false);
  assert.equal(pushes, 1);
  assert.equal(readyCalls, 1);
  observations = 0;
  pushes = 0;
  await assert.rejects(
    publishCardCandidate(
      { ...request, draft: false },
      async (command, args, options) => {
        if (command === 'git' && args.includes('push')) pushes++;
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          observations++;
          return JSON.stringify({
            number: 7,
            url: publication.pullRequest.url,
            state: 'OPEN',
            isDraft: true,
            headRefOid: f.baseSha,
          });
        }
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'ready')
          throw new Error('Must not promote an unconfirmed HEAD');
        return intercepted(command, args, options);
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(
        `Expected HEAD ${state.headSha}; observed HEAD ${f.baseSha}`,
      ),
  );
  assert.equal(observations, 5);
  assert.equal(pushes, 0);
  await execute('git', [
    '-C',
    f.workspace.path,
    'remote',
    'set-url',
    'origin',
    'https://github.com/example/other.git',
  ]);
  await assert.rejects(
    publishCardCandidate(request, intercepted),
    /differs from the assigned/,
  );
});

void test('Candidate Publisher rejects generated output before GitHub writes', async (t) => {
  const f = await fixture(t);
  const state: { headSha?: string; created?: boolean } = {};
  const intercepted = runner(state);
  const environment = await prepareCardEnvironment(
    {
      cardId: 'card-fixture',
      projectId: 'project-fixture',
      workspace: f.workspace,
      roles: {
        commit: 'agent-bot',
        delivery: 'bot',
        approval: 'user',
        expectedGitHubLogin: 'agent-bot',
      },
    },
    async (command, arguments_, options) => {
      if (arguments_.includes('get-url'))
        return 'https://github.com/example/repository.git';
      if (arguments_.includes('symbolic-ref')) return 'origin/main';
      return intercepted(command, arguments_, options);
    },
  );
  await mkdir(path.join(f.workspace.path, 'build'));
  await writeFile(path.join(f.workspace.path, 'build/output.txt'), 'generated');
  await execute('git', [
    '-C',
    f.workspace.path,
    'add',
    '-f',
    'build/output.txt',
  ]);
  await execute('git', [
    '-C',
    f.workspace.path,
    'commit',
    '-q',
    '-m',
    'generated',
  ]);
  state.headSha = (
    await execute('git', ['-C', f.workspace.path, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  await assert.rejects(
    publishCardCandidate(
      {
        environment,
        actionId: 'action-1',
        roundId: 'round-1',
        baseSha: f.baseSha,
        headSha: state.headSha,
        title: 'Candidate',
        body: 'Candidate body',
        draft: true,
      },
      intercepted,
    ),
    /generated or secret files/,
  );
  assert.equal(state.created, undefined);
});

void test('initial publication creates a private remote and a Draft before Ready', async (t) => {
  const f = await fixture(t, true);
  const state: { headSha?: string; created?: boolean } = {};
  const calls: string[] = [];
  let repoCreated = false;
  let failPermission = true;
  const original = runner(state);
  const initialRunner: HostCommandRunner = async (command, args, options) => {
    const call = args.join(' ');
    calls.push(call);
    if (command === 'gh') {
      if (call === 'api user --jq .login') return 'cunqi-bot';
      if (call.startsWith('repo list '))
        return JSON.stringify(
          repoCreated ? [{ name: 'repository', isPrivate: true }] : [],
        );
      if (call.startsWith('repo create ')) {
        repoCreated = true;
        return '';
      }
      if (call.includes('.permissions.push') && failPermission) {
        failPermission = false;
        throw new Error('temporary permission lookup failure');
      }
      if (
        call.startsWith('repo create ') ||
        call.startsWith('api --method PATCH ') ||
        call.startsWith('pr ready ')
      )
        return '';
    }
    if (command === 'git' && args.includes('ls-remote')) return '';
    return original(command, args, options);
  };
  const environment = await prepareCardEnvironment(
    {
      cardId: 'card-fixture',
      projectId: 'project-fixture',
      workspace: f.workspace,
      roles: {
        commit: 'agent-bot',
        delivery: 'bot',
        approval: 'user',
        expectedGitHubLogin: 'cunqi-bot',
      },
    },
    initialRunner,
  );
  await writeFile(path.join(f.workspace.path, 'App.swift'), 'import SwiftUI\n');
  await execute('git', ['-C', f.workspace.path, 'add', 'App.swift']);
  await execute('git', ['-C', f.workspace.path, 'commit', '-qm', 'shell']);
  state.headSha = (
    await execute('git', ['-C', f.workspace.path, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  const request = {
    environment,
    actionId: 'action',
    roundId: 'round',
    baseSha: f.baseSha,
    headSha: state.headSha,
    title: 'Shell',
    body: 'Verified shell',
    draft: false,
  };
  await writeFile(
    path.join(f.workspace.path, '.shared-config'),
    'pre_push_tests=deferred\n',
  );
  await assert.rejects(
    deliverCardCandidate(request, initialRunner),
    /temporary permission/,
  );
  state.headSha = (
    await execute('git', ['-C', f.workspace.path, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  const result = await deliverCardCandidate(request, initialRunner);
  assert.equal(
    (
      await execute('git', ['-C', f.workspace.path, 'status', '--porcelain'])
    ).stdout.trim(),
    '',
  );
  assert.ok(result.changedFiles.includes('.shared-config'));
  assert.equal(
    calls.filter((call) => call.startsWith('repo create ')).length,
    1,
  );
  request.headSha = result.headSha;
  assert.equal(result.pullRequest.draft, false);
  assert.ok(
    calls.includes('repo create alex-coding-studio/repository --private'),
  );
  const create = calls.findIndex((call) => call.startsWith('pr create '));
  assert.ok(calls[create].includes('--draft'));
  assert.ok(calls.findIndex((call) => call.startsWith('pr ready ')) > create);
  await assert.rejects(
    publishCardCandidate(request, async (command, args, options) => {
      if (command === 'git' && args.includes('ls-remote'))
        return `${'a'.repeat(40)}\trefs/heads/main`;
      return initialRunner(command, args, options);
    }),
    /remote baseline differs/,
  );
});
