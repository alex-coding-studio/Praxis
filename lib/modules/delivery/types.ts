import type { AgentProfile } from '../../agents/profile.ts';

export type DeliverySourceKind = 'mvp' | 'task' | 'delivery-contract';
export type DeliveryStatus =
  | 'waiting'
  | 'ready'
  | 'briefing'
  | 'ready-to-run'
  | 'running'
  | 'reviewing'
  | 'waiting-for-user'
  | 'warning'
  | 'failed'
  | 'completed';

export type DeliverySource = {
  sourceKind: DeliverySourceKind;
  sourceModule: 'whats-next' | 'task-graph' | 'what-to-do';
  sourceId: string;
  sourceUid: string;
  title: string;
  summary: string;
  dependsOn: string[];
  outputPaths: string[];
  sourceFingerprint: string;
};

export type DeliverySummary = {
  sourceUid: string;
  sourceFingerprint: string;
  status: DeliveryStatus;
};

export type ExecutableTarget = DeliverySource & {
  status: DeliveryStatus;
  sourceChanged: boolean;
  unmetDependencies: string[];
  delivery: DeliverySummary | null;
};

export type DeliveryBrief = {
  revision: number;
  outcome: string;
  included: string[];
  excluded: string[];
  criteria: Array<{ id: string; description: string; verification: string }>;
  userAcceptance?: string[];
  openDecisions: string[];
  confirmedAt: string | null;
};

export type DeliveryModels = {
  orchestrator: AgentProfile;
  workers: AgentProfile[];
  reviewers: AgentProfile[];
};

export type DeliveryReview = {
  head: string;
  disposition: 'required' | 'not-required';
  reason: string;
  approved: boolean;
  reviewerSessionId: string | null;
};
