import type { LatestResponseDocument } from '../../execution-observability/types.ts';
import type { DeliveryRecord } from './record.ts';

export function deliveryResponse(
  projectId: string,
  record: DeliveryRecord | undefined,
): LatestResponseDocument | null {
  const run = record?.runs.at(-1);
  const withdrawal = record?.lastWithdrawal;
  if (!record || (!run && !withdrawal)) return null;
  const running = !withdrawal && run?.status === 'running';
  const actor = record.actor ?? 'ORCHESTRATOR';
  return {
    schemaVersion: 1,
    owner: { kind: 'card', cardId: record.sourceUid },
    projectId,
    runId: withdrawal?.operationId ?? run!.id,
    revision: record.revision,
    status: running
      ? 'running'
      : (record.response?.status ??
        (run?.status === 'failed'
          ? 'fail'
          : run?.status === 'canceled'
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
    startedAt: withdrawal?.at ?? run!.startedAt,
    updatedAt: record.updatedAt,
    endedAt: withdrawal?.at ?? run!.endedAt,
    logRef:
      withdrawal?.logRef ??
      `delivery/targets/${record.sourceUid}/logs/${run!.id}.log`,
    logUrlPath:
      withdrawal?.logUrlPath ??
      `/projects/${projectId}/delivery/${record.sourceUid}/logs/${run!.id}`,
    hostPid: run?.hostPid ?? 0,
    agentProfile: record.models.orchestrator,
    recentActivity: [],
  };
}
