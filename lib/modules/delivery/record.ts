import type { AgentProfile } from '../../agents/profile.ts';
import type { LocalAgentUsage } from '../../agents/transport.ts';
import type {
  DeliveryBrief,
  DeliveryModels,
  DeliveryReview,
  DeliverySource,
  DeliverySummary,
} from './types.ts';

export type DeliveryActor = 'HOST' | 'ORCHESTRATOR' | 'WORKER' | 'REVIEWER';
export type DeliveryCheck = {
  id: string;
  status: 'passed' | 'failed' | 'not-run';
  head: string;
  evidence: string;
};
export type DeliveryProgress = {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed';
};
export type DeliveryMessage = {
  id: string;
  at: string;
  actor: DeliveryActor | 'USER';
  content: string;
};
export type DeliveryAgent = {
  usage?: LocalAgentUsage | null;
  id: string;
  role: 'worker' | 'reviewer';
  profile: AgentProfile;
  sessionId: string | null;
  instruction: string;
  result: string | null;
};
export type DeliveryRun = {
  moduleInstructions: string;
  usage?: LocalAgentUsage | null;
  hostPid: number;
  id: string;
  kind: 'brief' | 'execution' | 'feedback';
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'canceled';
  input: string;
  head: string | null;
  error: string | null;
};
export type DeliveryRecord = DeliverySummary & {
  stopAt?: 'draft-pr';
  attempt?: number;
  lastWithdrawal?: {
    at: string;
    logUrlPath: string;
    logRef: string;
    operationId: string;
  };
  actor?: DeliveryActor;
  schemaVersion: 1;
  revision: number;
  source: DeliverySource;
  createdAt: string;
  updatedAt: string;
  brief: DeliveryBrief | null;
  models: DeliveryModels;
  instructions: string;
  orchestratorSessionId: string | null;
  messages: DeliveryMessage[];
  runs: DeliveryRun[];
  agents: DeliveryAgent[];
  progress: DeliveryProgress[];
  checks: DeliveryCheck[];
  review: DeliveryReview | null;
  workspace: { path: string; branch: string; base: string } | null;
  publication: {
    url: string;
    number: number;
    head: string;
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    draft: boolean;
  } | null;
  response: {
    status: 'completed' | 'warning' | 'fail';
    title: string;
    detail: string;
  } | null;
  acceptedHead: string | null;
  existingDelivery?: { head: string; reason: string } | null;
};

export function deliveryCandidateReady(record: DeliveryRecord, head: string) {
  if (
    !record.publication ||
    record.publication.state !== 'OPEN' ||
    record.publication.head !== head
  )
    return false;
  return deliveryEvidenceReady(record, head);
}

export function deliveryEvidenceReady(record: DeliveryRecord, head: string) {
  return deliveryEvidenceBlockers(record, head).length === 0;
}

export function deliveryTechnicalReady(record: DeliveryRecord, head: string) {
  return Boolean(
    record.brief?.confirmedAt &&
    !record.brief.openDecisions.length &&
    record.brief.criteria.length &&
    record.brief.criteria.every((criterion) =>
      record.checks.some(
        (check) =>
          check.id === criterion.id &&
          check.head === head &&
          check.status === 'passed' &&
          check.evidence.trim(),
      ),
    ),
  );
}

export function deliveryEvidenceBlockers(
  record: DeliveryRecord,
  head: string,
): Array<{ message: string; id?: string }> {
  const blockers: Array<{ message: string; id?: string }> = [];
  if (!record.brief?.confirmedAt || record.brief.openDecisions.length)
    blockers.push({ message: 'Confirm the delivery brief first.' });
  if (
    !record.review ||
    record.review.head !== head ||
    !record.review.reason.trim()
  )
    blockers.push({
      message: 'Record a review decision for the current commit.',
    });
  if (
    record.review?.disposition === 'required' &&
    (!record.review.approved || !record.review.reviewerSessionId)
  )
    blockers.push({ message: 'Independent code review is pending.' });
  for (const criterion of record.brief?.criteria ?? []) {
    if (
      !record.checks.some(
        (check) =>
          check.id === criterion.id &&
          check.head === head &&
          check.status === 'passed' &&
          check.evidence.trim(),
      )
    )
      blockers.push({
        message: 'Technical evidence is incomplete: {id}',
        id: criterion.id,
      });
  }
  return blockers;
}
