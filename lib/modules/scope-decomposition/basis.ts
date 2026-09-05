import type { MaterializationBasisCore } from '../../materialization/basis.ts';
import { contractIdentity } from '../../materialization/contract.ts';
import { MaterializationError } from '../../materialization/receipt.ts';
import {
  graphProposalBasisFingerprint,
  type GraphProposalBasis,
  type GraphProposalCurrentCandidate,
} from '../../graph/proposal/basis.ts';
import type { GraphProposalRevision } from '../../graph/proposal/contract.ts';
import { identitiesFingerprint } from '../../graph/identity-store.ts';
import { SCOPE_DECOMPOSITION_RESULT_CONTRACT } from './contract.ts';
import type { TaskDecompositionIntention } from './intention.ts';
import type { TaskDecompositionMotion } from './motion.ts';
import type { RegisteredProject } from '../../project-registry.ts';

export type ScopeDecompositionOperation =
  | 'propose'
  | 'append-candidates'
  | 'revise-candidate'
  | 'recompose-candidates';

type GraphProposalState = Omit<
  GraphProposalBasis,
  keyof MaterializationBasisCore
>;

export type ScopeDecompositionMaterializationBasis = MaterializationBasisCore &
  GraphProposalState & {
    operation: ScopeDecompositionOperation;
    intention: TaskDecompositionIntention;
    motion: TaskDecompositionMotion;
    recomposeCandidateIds: readonly string[];
  };

type ScopeDecompositionBasisSubject = {
  intention: TaskDecompositionIntention;
  motion: TaskDecompositionMotion;
  knownNodeIds: readonly string[];
  acceptedCandidateIds: readonly string[];
  knownResourcePaths: readonly string[];
  reservedCandidateIds: readonly string[];
  currentCandidates: readonly GraphProposalCurrentCandidate[];
};

export type ScopeDecompositionBasisInput = ScopeDecompositionBasisSubject &
  (
    | {
        operation: 'propose' | 'append-candidates';
        revisionTarget?: never;
        recomposeCandidateIds?: never;
      }
    | {
        operation: 'recompose-candidates';
        revisionTarget?: never;
        recomposeCandidateIds: readonly string[];
      }
    | {
        operation: 'revise-candidate';
        revisionTarget: GraphProposalRevision;
        recomposeCandidateIds?: never;
      }
  );

function frozenState(
  input: ScopeDecompositionBasisInput,
  identityFingerprint: string,
): GraphProposalState {
  return {
    scope: 'task-graph',
    knownNodeIds: [...input.knownNodeIds],
    acceptedCandidateIds: [...input.acceptedCandidateIds],
    knownResourcePaths: [...input.knownResourcePaths],
    reservedCandidateIds: [...input.reservedCandidateIds],
    currentCandidates: input.currentCandidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      revision: candidate.revision,
      dependsOn: [...candidate.dependsOn],
    })),
    revisionTarget: input.revisionTarget ? { ...input.revisionTarget } : null,
    identityFingerprint,
  };
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
  }
  return value;
}

export async function prepareScopeDecompositionMaterializationBasis(
  project: RegisteredProject,
  input: ScopeDecompositionBasisInput,
  now: () => string = () => new Date().toISOString(),
): Promise<ScopeDecompositionMaterializationBasis> {
  if (
    input.operation === 'revise-candidate' &&
    !input.revisionTarget.uid.trim()
  ) {
    throw new MaterializationError(
      'identity',
      `Candidate ${input.revisionTarget.candidateId} has no stable identity to revise.`,
    );
  }
  const identityFingerprint = await identitiesFingerprint(
    project.planningPath,
    'task-graph',
  );
  const state = frozenState(input, identityFingerprint);
  return deepFreeze({
    ...state,
    project: { id: project.id, planningPath: project.planningPath },
    module: 'task-graph',
    operation: input.operation,
    contract: contractIdentity(SCOPE_DECOMPOSITION_RESULT_CONTRACT),
    fingerprint: graphProposalBasisFingerprint(state),
    preparedAt: now(),
    intention: input.intention,
    motion: input.motion,
    recomposeCandidateIds: [...(input.recomposeCandidateIds ?? [])],
  });
}
