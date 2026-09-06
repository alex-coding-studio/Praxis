import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RegisteredProject } from '../../project-registry.ts';
import { PublicApiError } from '../../api-errors.ts';
import { writeFileAtomically } from '../../atomic-json-store.ts';
import { runHostOperation } from '../../execution-observability/host-operations.ts';
import { serializeCandidatePublication } from '../../agents/candidate-publication.ts';
import {
  withGitHubPublicationIdentity,
  type HostCommandRunner,
} from '../../card-host-operations.ts';
import { cancelDeliveryRun } from './runtime.ts';
import { claimDeliveryTarget } from './ownership.ts';
import {
  deliveryDirectory,
  readDeliveryRecord,
  updateDeliveryRecord,
} from './storage.ts';
import { deliveryGit } from './workspace.ts';

const execute = promisify(execFile);
const commandRunner: HostCommandRunner = async (command, args, options) =>
  (
    await execute(command, args, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      timeout: 60000,
      maxBuffer: 2_000_000,
    })
  ).stdout.trim();

export async function withdrawDelivery(
  project: RegisteredProject,
  uid: string,
  expectedRevision: number,
  dependencies: {
    runner?: HostCommandRunner;
    cancel?: typeof cancelDeliveryRun;
  } = {},
) {
  const before = await readDeliveryRecord(project, uid);
  if (!before || before.revision !== expectedRevision)
    throw new PublicApiError('Refresh this delivery before withdrawing.', 409);
  if (before.acceptedHead || before.status === 'completed')
    throw new PublicApiError('An accepted delivery cannot be withdrawn.', 409);
  return runHostOperation(
    project,
    { kind: 'withdraw-delivery', label: 'Withdraw delivery', cardId: uid },
    async (operation) => {
      await (dependencies.cancel ?? cancelDeliveryRun)(project, uid);
      const release = claimDeliveryTarget(project, uid);
      try {
        const record = await readDeliveryRecord(project, uid);
        if (
          !record ||
          record.acceptedHead ||
          record.status === 'completed' ||
          record.runs.at(-1)?.status === 'running'
        )
          throw new PublicApiError(
            'The delivery is still running or has been accepted. Refresh before withdrawing.',
            409,
          );
        const repository = await realpath(project.codePath ?? project.rootPath);
        let removeWorkspace = false;
        if (record.workspace) {
          const suffix = record.attempt ? `${uid}-${record.attempt}` : uid;
          const expectedPath = path.join(
            path.dirname(repository),
            `.praxis-delivery-${project.id}-${suffix}`,
          );
          if (
            record.workspace.path !== expectedPath ||
            record.workspace.branch !== `delivery/${suffix}`
          )
            throw new PublicApiError(
              'The workspace is not owned by this delivery.',
              409,
            );
          const registered = (
            await deliveryGit(repository, 'worktree', 'list', '--porcelain')
          )
            .split('\n\n')
            .find((entry) =>
              entry.split('\n').includes(`worktree ${expectedPath}`),
            );
          if (registered) {
            if (
              !registered
                .split('\n')
                .includes(`branch refs/heads/${record.workspace.branch}`)
            )
              throw new PublicApiError(
                'The delivery workspace branch changed.',
                409,
              );
            removeWorkspace = true;
          } else if (
            await lstat(expectedPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            })
          ) {
            throw new PublicApiError(
              'The workspace is no longer registered to this repository.',
              409,
            );
          }
        }
        await writeFileAtomically(
          path.join(
            await deliveryDirectory(project, uid),
            'withdrawals',
            `${operation.operationId}.json`,
          ),
          `${JSON.stringify(record, null, 2)}\n`,
        );
        if (record.publication) {
          const match = record.publication.url.match(
            /^https:\/\/github.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/,
          );
          if (!match || Number(match[2]) !== record.publication.number)
            throw new PublicApiError('Invalid delivery pull request.');
          await serializeCandidatePublication(() =>
            withGitHubPublicationIdentity(
              dependencies.runner ?? commandRunner,
              repository,
              process.env.PRAXIS_BOT_GITHUB_LOGIN ?? 'cunqi-bot',
              async (gh) => {
                const observed = JSON.parse(
                  await gh('gh', [
                    'pr',
                    'view',
                    match[2],
                    '--repo',
                    match[1],
                    '--json',
                    'state',
                  ]),
                );
                if (observed.state === 'OPEN')
                  await gh('gh', ['pr', 'close', match[2], '--repo', match[1]]);
                else if (!['CLOSED', 'MERGED'].includes(observed.state))
                  throw new PublicApiError(
                    'The pull request state is unavailable.',
                  );
                operation.log.append({
                  level: 'INFO',
                  actor: 'HOST',
                  phase: 'STOP',
                  event: 'delivery.pr',
                  message: `${record.publication!.url}: ${observed.state === 'OPEN' ? 'closed' : observed.state}`,
                });
              },
            ),
          );
        }
        if (removeWorkspace)
          await deliveryGit(
            repository,
            'worktree',
            'remove',
            '--force',
            record.workspace!.path,
          );
        operation.log.append({
          level: 'INFO',
          actor: 'HOST',
          phase: 'STOP',
          event: 'delivery.workspace',
          message: removeWorkspace
            ? `Removed ${record.workspace!.path}`
            : 'No active worktree to remove.',
        });
        return updateDeliveryRecord(
          project,
          uid,
          (current) => {
            current.attempt = (current.attempt ?? 0) + 1;
            current.brief = null;
            current.workspace = null;
            current.publication = null;
            current.existingDelivery = null;
            current.orchestratorSessionId = null;
            current.agents = [];
            current.messages = [];
            current.progress = [];
            current.checks = [];
            current.review = null;
            current.actor = 'HOST';
            current.status = 'ready';
            current.lastWithdrawal = {
              at: new Date().toISOString(),
              logUrlPath: operation.logUrlPath,
              logRef: operation.logRef,
              operationId: operation.operationId,
            };
            current.response = {
              status: 'warning',
              title: 'Delivery withdrawn',
              detail:
                'This unaccepted attempt was withdrawn. Prepare a new brief; the next execution will start from latest main. Previously merged code is unchanged.',
            };
          },
          record.revision,
        );
      } finally {
        release();
      }
    },
  );
}
