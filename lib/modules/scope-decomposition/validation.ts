import {
  validateAgentGraphRecomposeDependencies,
  validateAgentGraphRecomposePlan,
} from '../../graph/agent/recompose.ts';
import {
  validateGraphProposal,
  type GraphProposalDependencyState,
} from '../../graph/proposal/validate.ts';
import { MaterializationError } from '../../materialization/receipt.ts';
import type { GraphReference } from '../../graph/proposal/reference.ts';
import type { ScopeDecompositionOperation } from './basis.ts';
import type {
  ScopeDecompositionRecomposeEffect,
  ScopeDecompositionResult,
} from './contract.ts';
import {
  validateTaskDecompositionIntentionResult,
  type TaskDecompositionIntention,
} from './intention.ts';
import {
  validateTaskDecompositionMotionResult,
  type TaskDecompositionMotion,
} from './motion.ts';

export type ScopeDecompositionValidationState = GraphProposalDependencyState & {
  operation: ScopeDecompositionOperation;
  intention: TaskDecompositionIntention;
  motion: TaskDecompositionMotion;
  recomposeCandidateIds: readonly string[];
};

function fail(message: string): never {
  throw new MaterializationError('validation', message);
}

function referenceKey(reference: GraphReference) {
  return reference.kind === 'proposal' ? reference.localKey : reference.id;
}

function planEffects(effects: readonly ScopeDecompositionRecomposeEffect[]) {
  return effects.map((effect) => ({
    kind: effect.kind,
    from: effect.from.map((reference) => reference.id),
    to: effect.to.map(referenceKey),
  }));
}

function assertEffectReferences(
  state: ScopeDecompositionValidationState,
  result: Extract<ScopeDecompositionResult, { outcome: 'proposal' }>,
) {
  const localKeys = new Set(result.candidates.map((c) => c.localKey));
  const selected = new Set(state.recomposeCandidateIds);
  for (const effect of result.recomposition?.effects ?? []) {
    for (const reference of effect.to) {
      if (reference.kind === 'proposal') {
        if (!localKeys.has(reference.localKey))
          fail(
            `Recompose effect names proposal key ${reference.localKey}, which this result does not propose.`,
          );
        continue;
      }
      if (!selected.has(reference.id))
        fail(
          `Recompose effect names Candidate ${reference.id}, which is not in the selected working set.`,
        );
    }
  }
}

function validateRecomposition(
  state: ScopeDecompositionValidationState,
  result: Extract<ScopeDecompositionResult, { outcome: 'proposal' }>,
) {
  if (state.operation !== 'recompose-candidates') {
    if (result.recomposition)
      fail('Only Recompose may return recomposition effects.');
    return;
  }
  if (!result.recomposition)
    fail('Recompose requires explicit working-set effects.');
  assertEffectReferences(state, result);
  const effects = planEffects(result.recomposition.effects);
  const retainedIds = effects
    .filter((effect) => effect.kind === 'retain')
    .flatMap((effect) => effect.to);
  const selectedIds = [...state.recomposeCandidateIds];
  try {
    validateAgentGraphRecomposePlan({
      selectedIds,
      outputIds: [
        ...retainedIds,
        ...result.candidates.map((candidate) => candidate.localKey),
      ],
      effects,
    });
    validateAgentGraphRecomposeDependencies({
      selectedIds,
      retainedIds,
      outputCandidates: result.candidates.map((candidate) => ({
        candidateId: candidate.localKey,
        dependsOn: candidate.dependsOn.map(referenceKey),
      })),
      knownCandidates: state.currentCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        dependsOn: [...candidate.dependsOn],
      })),
    });
  } catch (error) {
    fail(
      error instanceof Error ? error.message : 'The Recompose plan is invalid.',
    );
  }
}

export function validateScopeDecompositionResult(
  state: ScopeDecompositionValidationState,
  result: ScopeDecompositionResult,
) {
  if (result.outcome !== 'proposal') return;
  validateGraphProposal(state, result.candidates);
  validateRecomposition(state, result);
  const outputCount = result.recomposition
    ? new Set(planEffects(result.recomposition.effects).flatMap((e) => e.to))
        .size
    : result.candidates.length;
  try {
    validateTaskDecompositionIntentionResult(state.intention, result);
    validateTaskDecompositionMotionResult(state.motion, result, outputCount);
  } catch (error) {
    fail(
      error instanceof Error ? error.message : 'The Decomposition is invalid.',
    );
  }
}
