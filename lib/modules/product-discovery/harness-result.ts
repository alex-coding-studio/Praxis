import type {
  ProductExplorationCandidateInput,
  ProductExplorationResourceReference,
} from './contract.ts';

export const WHATS_NEXT_HARNESS_ID = 'praxis.whats-next';
export const WHATS_NEXT_HARNESS_REVISION = 8;

export type WhatsNextRequestIdentity = {
  sessionId: string;
  requestId: string;
  inputFingerprint: string;
};

export type WhatsNextResourceReference = ProductExplorationResourceReference;

export type WhatsNextCandidate = ProductExplorationCandidateInput;

export type WhatsNextReflection = {
  markdown: string;
  continuationAdvice: {
    action: 'continue' | 'consider-closing' | 'consider-branching';
    recommendedFocus: 'clarify' | 'concretize' | 'expand' | 'compare' | 'close';
    reason: string;
  };
};

export type WhatsNextExploration = {
  consideredNodeIds: string[];
  notes: string[];
};

type WhatsNextResultBase = {
  candidateAliases?: Record<string, string>;
  schemaVersion: 1;
  harness: {
    id: typeof WHATS_NEXT_HARNESS_ID;
    revision: typeof WHATS_NEXT_HARNESS_REVISION;
  };
  request: WhatsNextRequestIdentity;
  reflection: WhatsNextReflection;
  exploration: WhatsNextExploration;
};

export type WhatsNextHarnessResult = WhatsNextResultBase &
  (
    | { outcome: 'proposal'; candidates: WhatsNextCandidate[] }
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
    | { outcome: 'no-change'; reason: string }
  );
