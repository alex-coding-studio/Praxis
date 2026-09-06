import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { actionPublicationBranch } from './publication-workspace.ts';
import {
  verifyCardWorkspace,
  type CardWorkspace,
} from './publication-workspace.ts';

const exec = promisify(execFile);

export type CardExecutionRoles = {
  commit: string;
  delivery: string;
  approval: string;
  expectedGitHubLogin?: string;
};

export type CardEnvironmentManifest = {
  version: 1;
  environmentId: string;
  revision: number;
  cardId: string;
  projectId: string;
  workspace: CardWorkspace & {
    headSha: string;
    clean: boolean;
  };
  repository: {
    remote: string | null;
    remoteUrl: string | null;
    defaultBranch: string | null;
  };
  git: {
    authorName: string | null;
    authorEmail: string | null;
  };
  roles: CardExecutionRoles;
  createdAt: string;
  verifiedAt: string;
};

export type PrepareCardEnvironmentRequest = {
  cardId: string;
  projectId: string;
  workspace: CardWorkspace;
  roles: CardExecutionRoles;
  outputPath?: string;
  fetch?: boolean;
};

export type CandidatePublishRequest = {
  environment: CardEnvironmentManifest;
  actionId: string;
  roundId: string;
  baseSha: string;
  headSha: string;
  title: string;
  body: string;
  draft: boolean;
};

export type CandidatePublication = {
  version: 1;
  candidateId: string;
  environmentId: string;
  environmentRevision: number;
  actionId: string;
  roundId: string;
  baseSha: string;
  headSha: string;
  branch: string;
  commitCount: number;
  changedFiles: string[];
  repository: string;
  pullRequest: {
    number: number;
    url: string;
    state: string;
    draft: boolean;
    headSha: string;
  };
  publishedAt: string;
};

export type HostCommandRunner = (
  command: string,
  arguments_: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<string>;

const commandRunner: HostCommandRunner = async (command, arguments_, options) =>
  (
    await exec(command, arguments_, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      timeout: options?.timeoutMs ?? 30000,
      maxBuffer: 2_000_000,
    })
  ).stdout.trim();

function gitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith('GIT_')) delete environment[key];
  return environment;
}

async function git(
  runner: HostCommandRunner,
  workspace: string,
  ...arguments_: string[]
) {
  return runner('git', ['-C', workspace, ...arguments_], {
    env: gitEnvironment(),
  });
}

async function optionalGit(
  runner: HostCommandRunner,
  workspace: string,
  ...arguments_: string[]
) {
  try {
    return (await git(runner, workspace, ...arguments_)) || null;
  } catch {
    return null;
  }
}

export async function prepareCardEnvironment(
  request: PrepareCardEnvironmentRequest,
  runner: HostCommandRunner = commandRunner,
): Promise<CardEnvironmentManifest> {
  await verifyCardWorkspace(request.workspace);
  if (request.fetch)
    await git(runner, request.workspace.path, 'fetch', '--prune', 'origin');
  const now = new Date().toISOString();
  const previous = request.outputPath
    ? await readManifest(request.outputPath)
    : null;
  if (
    previous &&
    (previous.cardId !== request.cardId ||
      previous.projectId !== request.projectId)
  )
    throw new Error('Existing Environment Manifest belongs to another Card.');
  const workspaceChanged = Boolean(
    previous &&
    (previous.workspace.path !== request.workspace.path ||
      previous.workspace.branch !== request.workspace.branch),
  );
  const headSha = await git(
    runner,
    request.workspace.path,
    'rev-parse',
    'HEAD',
  );
  const branch = await git(
    runner,
    request.workspace.path,
    'branch',
    '--show-current',
  );
  if (branch !== request.workspace.branch)
    throw new Error('Card branch changed before environment preparation.');
  const status = await git(
    runner,
    request.workspace.path,
    'status',
    '--porcelain',
    '--untracked-files=all',
  );
  const remoteUrl = await optionalGit(
    runner,
    request.workspace.path,
    'remote',
    'get-url',
    'origin',
  );
  const originHead = await optionalGit(
    runner,
    request.workspace.path,
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD',
  );
  const roles = {
    ...request.roles,
    expectedGitHubLogin:
      request.roles.expectedGitHubLogin ??
      previous?.roles.expectedGitHubLogin ??
      (request.roles.delivery === 'bot'
        ? process.env.PRAXIS_BOT_GITHUB_LOGIN?.trim() || 'cunqi-bot'
        : undefined),
  };
  if (
    remoteUrl &&
    githubRepositoryOrNull(remoteUrl) &&
    !roles.expectedGitHubLogin
  )
    roles.expectedGitHubLogin = await runner(
      'gh',
      ['api', 'user', '--jq', '.login'],
      {
        cwd: request.workspace.path,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      },
    );
  const manifest: CardEnvironmentManifest = {
    version: 1,
    environmentId: previous?.environmentId ?? randomUUID(),
    revision: previous ? previous.revision + (workspaceChanged ? 1 : 0) : 1,
    cardId: request.cardId,
    projectId: request.projectId,
    workspace: {
      ...request.workspace,
      headSha,
      clean: !status,
    },
    repository: {
      remote: remoteUrl ? 'origin' : null,
      remoteUrl,
      defaultBranch: originHead?.replace(/^origin\//, '') ?? null,
    },
    git: {
      authorName: await optionalGit(
        runner,
        request.workspace.path,
        'config',
        '--get',
        'user.name',
      ),
      authorEmail: await optionalGit(
        runner,
        request.workspace.path,
        'config',
        '--get',
        'user.email',
      ),
    },
    roles,
    createdAt: previous?.createdAt ?? now,
    verifiedAt: now,
  };
  if (request.outputPath) await atomicJson(request.outputPath, manifest);
  return manifest;
}

export async function publishCardCandidate(
  request: CandidatePublishRequest,
  runner: HostCommandRunner = commandRunner,
): Promise<CandidatePublication> {
  return withGitHubPublicationIdentity(
    runner,
    request.environment.workspace.path,
    request.environment.roles.expectedGitHubLogin,
    (identityRunner) => publishCardCandidateUnlocked(request, identityRunner),
  );
}

async function publishCardCandidateUnlocked(
  request: CandidatePublishRequest,
  runner: HostCommandRunner,
): Promise<CandidatePublication> {
  const { environment } = request;
  await verifyCardWorkspace(environment.workspace);
  const workspace = environment.workspace.path;
  const headSha = await git(runner, workspace, 'rev-parse', 'HEAD');
  const workspaceBranch = await git(
    runner,
    workspace,
    'branch',
    '--show-current',
  );
  const branch = actionPublicationBranch(workspaceBranch, request.actionId);
  const status = await git(
    runner,
    workspace,
    'status',
    '--porcelain',
    '--untracked-files=all',
  );
  if (headSha !== request.headSha)
    throw new Error('Candidate HEAD changed before publication.');
  if (workspaceBranch !== environment.workspace.branch)
    throw new Error(
      'Candidate branch does not match its Environment Manifest.',
    );
  if (status)
    throw new Error('Candidate workspace must be clean before publication.');
  await git(
    runner,
    workspace,
    'merge-base',
    '--is-ancestor',
    request.baseSha,
    request.headSha,
  );
  const changedFiles = (
    await git(
      runner,
      workspace,
      'diff',
      '--name-only',
      `${request.baseSha}..${request.headSha}`,
    )
  )
    .split('\n')
    .filter(Boolean);
  if (!changedFiles.length)
    throw new Error('Candidate has no changes to publish.');
  if (changedFiles.some(forbiddenCandidatePath))
    throw new Error(
      'Candidate contains host-owned, generated or secret files.',
    );
  const commitCount = Number(
    await git(
      runner,
      workspace,
      'rev-list',
      '--count',
      `${request.baseSha}..${request.headSha}`,
    ),
  );
  if (!Number.isSafeInteger(commitCount) || commitCount < 1)
    throw new Error('Candidate commit range is invalid.');
  const remoteUrl = await optionalGit(
    runner,
    workspace,
    'remote',
    'get-url',
    'origin',
  );
  const initialRepository = !environment.repository.remoteUrl;
  const projectName = path.basename(environment.workspace.repository);
  if (initialRepository && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectName))
    throw new Error('Initial repository name is invalid.');
  const repository = initialRepository
    ? `alex-coding-studio/${projectName}`
    : githubRepository(environment.repository.remoteUrl);
  if (
    (remoteUrl && githubRepository(remoteUrl) !== repository) ||
    (!remoteUrl && !initialRepository)
  )
    throw new Error('Candidate remote differs from the assigned repository.');
  const defaultBranch =
    environment.repository.defaultBranch ?? (initialRepository ? 'main' : null);
  if (!defaultBranch) throw new Error('GitHub default branch is unavailable.');
  if (!request.title.trim() || request.title.length > 200)
    throw new Error('Candidate PR title is invalid.');
  if (!request.body.trim() || Buffer.byteLength(request.body) > 100_000)
    throw new Error('Candidate PR body is invalid.');
  const githubEnvironment = { ...process.env, GH_PROMPT_DISABLED: '1' };
  const login = await runner('gh', ['api', 'user', '--jq', '.login'], {
    cwd: workspace,
    env: githubEnvironment,
  });
  if (
    environment.roles.expectedGitHubLogin &&
    login !== environment.roles.expectedGitHubLogin
  )
    throw new Error('Active GitHub identity does not match the Card role.');
  if (initialRepository) {
    if (login !== 'cunqi-bot')
      throw new Error('Initial repository delivery requires the bot identity.');
    const baseline = await git(
      runner,
      workspace,
      'rev-parse',
      `refs/heads/${defaultBranch}`,
    );
    const tree = await git(
      runner,
      workspace,
      'ls-tree',
      '-r',
      '--name-only',
      baseline,
    );
    const ancestry = await git(
      runner,
      workspace,
      'rev-list',
      '--parents',
      '-n',
      '1',
      baseline,
    );
    if (
      tree ||
      ancestry !== baseline ||
      baseline !== environment.workspace.baseCommit
    )
      throw new Error(
        'Initial repository requires the existing empty root baseline.',
      );
    const repositories = JSON.parse(
      await runner(
        'gh',
        [
          'repo',
          'list',
          'alex-coding-studio',
          '--limit',
          '1000',
          '--json',
          'name,isPrivate',
        ],
        { cwd: workspace, env: githubEnvironment },
      ),
    ) as Array<{ name: string; isPrivate: boolean }>;
    const existingRepository = repositories.find(
      (item) => item.name === projectName,
    );
    if (existingRepository && !existingRepository.isPrivate)
      throw new Error('Initial project repository must be private.');
    if (!existingRepository)
      await runner('gh', ['repo', 'create', repository, '--private'], {
        cwd: workspace,
        env: githubEnvironment,
      });
    if (!remoteUrl)
      await git(
        runner,
        workspace,
        'remote',
        'add',
        'origin',
        `https://github.com/${repository}.git`,
      );
  }
  const canPush = await runner(
    'gh',
    ['api', `repos/${repository}`, '--jq', '.permissions.push'],
    { cwd: workspace, env: githubEnvironment },
  );
  if (canPush !== 'true')
    throw new Error('GitHub push permission is unavailable.');
  if (initialRepository) {
    const remoteBaseline = await git(
      runner,
      workspace,
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${defaultBranch}`,
    );
    if (remoteBaseline) {
      const baseline = await git(
        runner,
        workspace,
        'rev-parse',
        `refs/heads/${defaultBranch}`,
      );
      const [remoteSha, remoteRef, ...extra] = remoteBaseline.split(/\s+/);
      if (
        remoteSha !== baseline ||
        remoteRef !== `refs/heads/${defaultBranch}` ||
        extra.length
      )
        throw new Error(
          'Initial remote baseline differs from the assigned empty baseline.',
        );
    } else
      await git(
        runner,
        workspace,
        'push',
        'origin',
        `refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`,
      );
    await runner(
      'gh',
      [
        'api',
        '--method',
        'PATCH',
        `repos/${repository}`,
        '-F',
        'delete_branch_on_merge=true',
      ],
      { cwd: workspace, env: githubEnvironment },
    );
  }
  const existing = JSON.parse(
    await runner(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repository,
        '--head',
        branch,
        '--state',
        'all',
        '--limit',
        '10',
        '--json',
        'number,url,state,isDraft,headRefOid',
      ],
      { cwd: workspace, env: githubEnvironment },
    ),
  ) as Array<{
    number: number;
    url: string;
    state: string;
    isDraft: boolean;
    headRefOid: string;
  }>;
  if (!Array.isArray(existing) || existing.length > 1)
    throw new Error('Candidate branch has ambiguous pull request state.');
  let pr = existing[0];
  if (pr && pr.state !== 'OPEN')
    throw new Error(
      `This Action's pull request is ${pr.state.toLowerCase()}; it cannot be updated.`,
    );
  if (
    pr &&
    !pr.isDraft &&
    (request.draft || pr.headRefOid !== request.headSha)
  ) {
    await runner(
      'gh',
      ['pr', 'ready', String(pr.number), '--undo', '--repo', repository],
      { cwd: workspace, env: githubEnvironment },
    );
    pr.isDraft = true;
  }
  const publishedRef = `refs/heads/${branch}`;
  const remoteHead = (
    await git(runner, workspace, 'ls-remote', '--heads', 'origin', publishedRef)
  ).split(/\s+/)[0];
  if (remoteHead !== request.headSha)
    await git(runner, workspace, 'push', 'origin', `HEAD:${publishedRef}`);
  if (!pr) {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'praxis-pr-'),
    );
    const bodyPath = path.join(temporaryDirectory, 'body.md');
    try {
      await writeFile(bodyPath, request.body, { flag: 'wx' });
      const arguments_ = [
        'pr',
        'create',
        '--repo',
        repository,
        '--base',
        defaultBranch,
        '--head',
        branch,
        '--title',
        request.title,
        '--body-file',
        bodyPath,
      ];
      arguments_.push('--draft');
      await runner('gh', arguments_, {
        cwd: workspace,
        env: githubEnvironment,
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
  const observationDeadline = Date.now() + 10_000;
  const delays = [0, 200, 400, 800, 1600];
  let observedHead: string | undefined;
  let confirmed = false;
  for (const delay of delays) {
    if (delay)
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(delay, Math.max(0, observationDeadline - Date.now())),
        ),
      );
    const remaining = observationDeadline - Date.now();
    if (remaining <= 0) break;
    const query = pr
      ? ['pr', 'view', String(pr.number), '--repo', repository]
      : [
          'pr',
          'list',
          '--repo',
          repository,
          '--head',
          branch,
          '--state',
          'all',
          '--limit',
          '2',
        ];
    const value = JSON.parse(
      await runner(
        'gh',
        [...query, '--json', 'number,url,state,isDraft,headRefOid'],
        {
          cwd: workspace,
          env: githubEnvironment,
          timeoutMs: Math.min(remaining, 2500),
        },
      ),
    ) as typeof pr | typeof existing;
    if (Array.isArray(value) && value.length > 1)
      throw new Error(
        'Candidate branch has ambiguous pull request state after publication.',
      );
    pr = Array.isArray(value) ? value[0] : value;
    if (!pr) continue;
    if (pr.state !== 'OPEN')
      throw new Error(
        `PR #${pr.number} is ${pr.state.toLowerCase()}; published commit ${request.headSha} is retained.`,
      );
    observedHead = pr.headRefOid;
    if (observedHead === request.headSha) {
      confirmed = true;
      break;
    }
  }
  if (!pr || !confirmed)
    throw new Error(
      `Published commit ${request.headSha} to ${repository}:${branch}, but PR ${pr?.url ?? '(not visible yet)'} did not confirm it within the observation window. Expected HEAD ${request.headSha}; observed HEAD ${observedHead ?? '(unavailable)'}. The commit and push are retained; resume publication without repeating implementation or validation.`,
    );
  if (!request.draft && pr.isDraft) {
    await runner(
      'gh',
      ['pr', 'ready', String(pr.number), '--repo', repository],
      { cwd: workspace, env: githubEnvironment },
    );
    pr.isDraft = false;
  }
  return {
    version: 1,
    candidateId: candidateId(
      `${environment.environmentId}:${request.actionId}`,
      request.headSha,
    ),
    environmentId: environment.environmentId,
    environmentRevision: environment.revision,
    actionId: request.actionId,
    roundId: request.roundId,
    baseSha: request.baseSha,
    headSha: request.headSha,
    branch,
    commitCount,
    changedFiles,
    repository,
    pullRequest: {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      draft: pr.isDraft,
      headSha: pr.headRefOid,
    },
    publishedAt: new Date().toISOString(),
  };
}

export async function withGitHubPublicationIdentity<T>(
  runner: HostCommandRunner,
  workspace: string,
  expectedLogin: string | undefined,
  work: (runner: HostCommandRunner) => Promise<T>,
) {
  if (!expectedLogin) return work(runner);
  const githubEnvironment = { ...process.env, GH_PROMPT_DISABLED: '1' };
  const invoke = (arguments_: string[]) =>
    runner('gh', arguments_, { cwd: workspace, env: githubEnvironment });
  const initialLogin = await invoke(['api', 'user', '--jq', '.login']);
  if (initialLogin === expectedLogin) return work(runner);
  const status = JSON.parse(
    await invoke([
      'auth',
      'status',
      '--hostname',
      'github.com',
      '--json',
      'hosts',
    ]),
  ) as {
    hosts?: Record<
      string,
      Array<{ login?: string; active?: boolean; state?: string }>
    >;
  };
  const accounts = status.hosts?.['github.com'] ?? [];
  const initialAccount = accounts.find(
    (account) => account.active && account.state === 'success',
  )?.login;
  if (!initialAccount)
    throw new Error('The active GitHub CLI account could not be identified.');
  let selectedAccount: string | null = null;
  let result: T | undefined;
  let failure: unknown;
  try {
    for (const account of accounts) {
      if (
        account.state !== 'success' ||
        !account.login ||
        account.login === initialAccount
      )
        continue;
      await invoke([
        'auth',
        'switch',
        '--hostname',
        'github.com',
        '--user',
        account.login,
      ]);
      if ((await invoke(['api', 'user', '--jq', '.login'])) === expectedLogin) {
        selectedAccount = account.login;
        break;
      }
    }
    if (!selectedAccount)
      throw new Error(
        `No authenticated GitHub CLI account matches the required ${expectedLogin} identity.`,
      );
    result = await work(runner);
  } catch (error) {
    failure = error;
  }
  try {
    await invoke([
      'auth',
      'switch',
      '--hostname',
      'github.com',
      '--user',
      initialAccount,
    ]);
    const restored = await invoke(['api', 'user', '--jq', '.login']);
    if (restored !== initialLogin)
      throw new Error('The original GitHub identity could not be restored.');
  } catch (restoreError) {
    if (failure)
      throw new AggregateError(
        [failure, restoreError],
        'GitHub publication failed and the original identity could not be restored.',
      );
    throw restoreError;
  }
  if (failure) throw failure;
  return result as T;
}

export async function deliverCardCandidate(
  request: CandidatePublishRequest,
  runner: HostCommandRunner = commandRunner,
) {
  const workspace = request.environment.workspace;
  await verifyCardWorkspace(workspace);
  const branch = await git(runner, workspace.path, 'branch', '--show-current');
  if (branch !== workspace.branch)
    throw new Error('Delivery branch differs from the assigned Card branch.');
  if (!request.title.trim() || request.title.length > 200)
    throw new Error('Delivery commit title is invalid.');
  const changed = await git(
    runner,
    workspace.path,
    'diff',
    'HEAD',
    '--name-only',
    '-z',
  );
  const untracked = await git(
    runner,
    workspace.path,
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  );
  const files = [
    ...new Set(
      [...changed.split('\0'), ...untracked.split('\0')].filter(Boolean),
    ),
  ];
  if (files.some(forbiddenCandidatePath))
    throw new Error('Delivery contains host-owned, generated or secret files.');
  if (files.length) {
    await git(runner, workspace.path, 'add', '--all', '--', ...files);
    await git(runner, workspace.path, 'commit', '-m', request.title);
  }
  const headSha = await git(runner, workspace.path, 'rev-parse', 'HEAD');
  return publishCardCandidate(
    { ...request, baseSha: workspace.baseCommit, headSha },
    runner,
  );
}

function forbiddenCandidatePath(file: string) {
  return (
    file === '.praxis' ||
    file.startsWith('.praxis/') ||
    file === 'build' ||
    file.startsWith('build/') ||
    file.includes('DerivedData') ||
    /(^|\/)(?:\.env|credentials|secrets?)(?:\.|\/|$)/i.test(file)
  );
}

function githubRepository(remoteUrl: string | null) {
  const repository = githubRepositoryOrNull(remoteUrl);
  if (!repository)
    throw new Error('Candidate repository is not a supported GitHub remote.');
  return repository;
}

function githubRepositoryOrNull(remoteUrl: string | null) {
  const match = remoteUrl?.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  return match?.[1] ?? null;
}

function candidateId(environmentId: string, headSha: string) {
  return createHash('sha256')
    .update(`${environmentId}:${headSha}`)
    .digest('hex')
    .slice(0, 24);
}

async function readManifest(file: string) {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CardEnvironmentManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
  });
  await rename(temporary, file);
}
