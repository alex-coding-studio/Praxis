import type { LatestResponseDocument } from '../../execution-observability/types.ts';
import type { DeliveryRecord } from './record.ts';

export function deliveryResponse(
  projectId: string,
  record: DeliveryRecord | undefined,
): LatestResponseDocument | null {
  const run = record?.runs.at(-1);
  if (!record || !run) return null;
  const running = run.status === 'running';
  const actor =
    record.status === 'reviewing'
      ? 'REVIEWER'
      : record.agents.at(-1)?.result === null
        ? 'WORKER'
        : 'ORCHESTRATOR';
  return {
    schemaVersion: 1,
    owner: { kind: 'card', cardId: record.sourceUid },
    projectId,
    runId: run.id,
    revision: record.revision,
    status: running
      ? 'running'
      : (record.response?.status ??
        (run.status === 'failed'
          ? 'fail'
          : run.status === 'canceled'
            ? 'warning'
            : 'completed')),
    actor,
    phase: running ? 'executing' : undefined,
    title: record.response?.title ?? record.source.title,
    detail:
      record.response?.detail ??
      record.progress.find((item) => item.status === 'running')?.title ??
      'Preparing delivery.',
    subject: { kind: 'node', id: record.sourceUid, label: record.source.title },
    supplementaryWarnings: [],
    recovery: ['log'],
    startedAt: run.startedAt,
    updatedAt: record.updatedAt,
    endedAt: run.endedAt,
    logRef: `delivery/targets/${record.sourceUid}/logs/${run.id}.log`,
    logUrlPath: `/projects/${projectId}/delivery/${record.sourceUid}/logs/${run.id}`,
    hostPid: run.hostPid,
    agentProfile: record.models.orchestrator,
    recentActivity: [],
  };
}
