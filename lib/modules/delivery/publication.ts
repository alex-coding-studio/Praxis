import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import type { RegisteredProject } from '../../project-registry.ts';
import {
  prepareCardEnvironment,
  withGitHubPublicationIdentity,
  type HostCommandRunner,
} from '../../card-host-operations.ts';
import {
  runCandidatePublicationScript,
  serializeCandidatePublication,
} from '../../agents/candidate-publication.ts';
import { PublicApiError } from '../../api-errors.ts';
import { deliveryGit } from './workspace.ts';
import { readDeliveryRecord, updateDeliveryRecord } from './storage.ts';
import { deliveryCandidateReady } from './record.ts';
import { syncProjectMain } from '../implementation/sync-main.ts';
import { claimDeliveryTarget } from './ownership.ts';

const execute = promisify(execFile);
const runner: HostCommandRunner = async (command, args, options) =>
  (
    await execute(command, args, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      timeout: 60000,
      maxBuffer: 2_000_000,
    })
  ).stdout.trim();

export async function publishDeliveryCandidate(
  project: RegisteredProject,
  uid: string,
  title: string,
  body: string,
) {
  const record = await readDeliveryRecord(project, uid);
  if (!record?.workspace)
    throw new PublicApiError('The delivery workspace is not ready.');
  const repository = await realpath(project.codePath ?? project.rootPath);
  const environment = await prepareCardEnvironment({
    cardId: uid,
    projectId: project.id,
    workspace: {
      ...record.workspace,
      repository,
      baseCommit: record.workspace.base,
      gitDirectory: await realpath(
        await deliveryGit(
          record.workspace.path,
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ),
      ),
    },
    roles: {
      commit: 'bot',
      delivery: 'bot',
      approval: 'user',
      expectedGitHubLogin: process.env.PRAXIS_BOT_GITHUB_LOGIN ?? 'cunqi-bot',
    },
  });
  const result = await runCandidatePublicationScript({
    environment,
    actionId: uid,
    roundId: record.runs.at(-1)!.id,
    baseSha: record.workspace.base,
    headSha: environment.workspace.headSha,
    title,
    body,
    draft: true,
  });
  await updateDeliveryRecord(project, uid, (current) => {
    current.publication = {
      url: result.pullRequest.url,
      number: result.pullRequest.number,
      head: result.headSha,
      state: result.pullRequest.state as 'OPEN' | 'MERGED' | 'CLOSED',
      draft: result.pullRequest.draft,
    };
  });
  return result;
}

export async function acceptDelivery(
  project: RegisteredProject,
  uid: string,
  expectedRevision: number,
  dependencies: {
    runner?: HostCommandRunner;
    git?: typeof deliveryGit;
    syncMain?: typeof syncProjectMain;
  } = {},
) {
  const runCommand = dependencies.runner ?? runner;
  const git = dependencies.git ?? deliveryGit;
  const syncMain = dependencies.syncMain ?? syncProjectMain;
  return serializeCandidatePublication(async () => {
    const release = claimDeliveryTarget(project, uid);
    try {
      const record = await readDeliveryRecord(project, uid);
      if (!record?.workspace || record.revision !== expectedRevision)
        throw new PublicApiError(
          'Refresh the current delivery before accepting.',
          409,
        );
      if (record.runs.at(-1)?.status === 'running')
        throw new PublicApiError('Wait for the current run.', 409);
      const head = await git(record.workspace.path, 'rev-parse', 'HEAD');
      if (!deliveryCandidateReady(record, head))
        throw new PublicApiError(
          'Current delivery verification or review is incomplete.',
          409,
        );
      if (
        await git(
          record.workspace.path,
          'status',
          '--porcelain',
          '--untracked-files=all',
        )
      )
        throw new PublicApiError(
          'The workspace changed after verification.',
          409,
        );
      const pr = record.publication!;
      const match = pr.url.match(
        /^https:\/\/github.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/,
      );
      if (!match) throw new PublicApiError('Invalid delivery pull request.');
      const repository = match[1];
      await withGitHubPublicationIdentity(
        runCommand,
        record.workspace.path,
        process.env.PRAXIS_BOT_GITHUB_LOGIN ?? 'cunqi-bot',
        async (gh) => {
          const observed = JSON.parse(
            await gh('gh', [
              'pr',
              'view',
              String(pr.number),
              '--repo',
              repository,
              '--json',
              'headRefOid,state,isDraft',
            ]),
          );
          if (
            observed.headRefOid !== head ||
            !['OPEN', 'MERGED'].includes(observed.state)
          )
            throw new PublicApiError(
              'The pull request changed. Refresh the current candidate.',
              409,
            );
          if (observed.state === 'MERGED') return;
          if (observed.isDraft)
            await gh('gh', [
              'pr',
              'ready',
              String(pr.number),
              '--repo',
              repository,
            ]);
          await gh('gh', [
            'pr',
            'merge',
            String(pr.number),
            '--repo',
            repository,
            '--merge',
            '--match-head-commit',
            head,
          ]);
          const merged = JSON.parse(
            await gh('gh', [
              'pr',
              'view',
              String(pr.number),
              '--repo',
              repository,
              '--json',
              'state',
            ]),
          );
          if (merged.state !== 'MERGED')
            throw new PublicApiError(
              'The pull request has not merged yet.',
              409,
            );
        },
      );
      await updateDeliveryRecord(project, uid, (current) => {
        current.acceptedHead = head;
        current.publication!.state = 'MERGED';
        current.publication!.draft = false;
        current.status = 'completed';
        current.response = {
          status: 'completed',
          title: 'Delivery accepted',
          detail: `Merged ${pr.url}`,
        };
      });
      try {
        await syncMain(project.codePath ?? project.rootPath);
      } catch (error) {
        await updateDeliveryRecord(project, uid, (current) => {
          current.response = {
            status: 'warning',
            title: 'Delivery merged; local sync needs attention',
            detail: String(error),
          };
        });
      }
      return readDeliveryRecord(project, uid);
    } finally {
      release();
    }
  });
}
