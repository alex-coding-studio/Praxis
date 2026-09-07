import type { AgentGraphRecomposeEffect } from '../../graph/agent/recompose.ts';
import type {
  ScopeDecompositionCandidateInput,
  ScopeDecompositionResourceReference,
} from './contract.ts';

export const TASK_DECOMPOSITION_HARNESS_ID = 'praxis.task-decomposition';
export const TASK_DECOMPOSITION_HARNESS_REVISION = 8;

export type HarnessRequestIdentity = {
  sessionId: string;
  requestId: string;
  inputFingerprint: string;
};

export type HarnessResourceReference = ScopeDecompositionResourceReference;

export type HarnessCandidate = ScopeDecompositionCandidateInput;

export type HarnessImpactReview = {
  reviewedNodeIds: string[];
  affectedNodeIds: string[];
  notes: string[];
};

type HarnessResultBase = {
  candidateAliases?: Record<string, string>;
  schemaVersion: 1;
  harness: {
    id: typeof TASK_DECOMPOSITION_HARNESS_ID;
    revision: typeof TASK_DECOMPOSITION_HARNESS_REVISION;
  };
  request: HarnessRequestIdentity;
  impactReview: HarnessImpactReview;
};

export type TaskDecompositionHarnessResult = HarnessResultBase &
  (
    | {
        outcome: 'proposal';
        candidates: HarnessCandidate[];
        recomposition?: { effects: AgentGraphRecomposeEffect[] };
      }
    | {
        outcome: 'clarification';
        clarification: {
          question: string;
          options: Array<{
            id: string;
            label: string;
            effect: string;
            recommended: boolean;
          }>;
        };
      }
    | { outcome: 'insufficient-evidence'; missingEvidence: string[] }
    | { outcome: 'no-change'; reason: string }
  );
