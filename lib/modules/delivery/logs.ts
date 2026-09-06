import path from 'node:path';
import type { RegisteredProject } from '../../project-registry.ts';
import { PublicApiError } from '../../api-errors.ts';
import type { LogTarget } from '../../execution-observability/log-targets.ts';
import {
  assertTargetUid,
  deliveryDirectory,
  readDeliveryRecord,
} from './storage.ts';

export async function deliveryLogTarget(
  project: RegisteredProject,
  uid: string,
  runId: string,
): Promise<LogTarget> {
  assertTargetUid(runId);
  const record = await readDeliveryRecord(project, uid);
  const run = record?.runs.find((entry) => entry.id === runId);
  if (!record || !run) throw new PublicApiError('Delivery log not found.', 404);
  return {
    file: path.join(
      await deliveryDirectory(project, uid),
      'logs',
      `${runId}.log`,
    ),
    live: run.status === 'running',
    legacyText: null,
    meta: {
      kind: 'card',
      projectId: project.id,
      projectName: project.name,
      ownerLabel: 'Development Delivery',
      subject: record.source.title,
      id: run.id,
      status:
        run.status === 'running'
          ? 'running'
          : run.status === 'failed'
            ? 'fail'
            : run.status === 'canceled'
              ? 'warning'
              : 'completed',
      agentProfile: record.models.orchestrator,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      title: record.response?.title ?? null,
      detail: run.error ?? record.response?.detail ?? null,
      jobLogs: [],
      retained: null,
      pullRequests: record.publication ? [record.publication.url] : [],
      legacy: false,
      logUrlPath: `/projects/${project.id}/delivery/${uid}/logs/${runId}`,
    },
  };
}
