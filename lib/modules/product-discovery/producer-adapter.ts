import {
  siblingCandidateIds,
  toGraphProposalCandidate,
} from '../../graph/proposal/classify.ts';
import type {
  ProductExplorationCandidate,
  ProductExplorationCandidateInput,
  ProductExplorationResult,
} from './contract.ts';
import type { WhatsNextHarnessResult } from './harness-result.ts';

export function toProductExplorationCandidate(
  candidate: ProductExplorationCandidateInput,
  siblings: ReadonlySet<string>,
): ProductExplorationCandidate {
  return {
    ...toGraphProposalCandidate(candidate, siblings),
    outputMarkdown: candidate.outputMarkdown,
    layer: candidate.layer,
    artifactKind: candidate.artifactKind,
  };
}

export function toProductExplorationSemanticResult(
  envelope: WhatsNextHarnessResult,
): ProductExplorationResult {
  if (envelope.outcome === 'clarification')
    return { outcome: 'clarification', clarification: envelope.clarification };
  if (envelope.outcome === 'no-change')
    return { outcome: 'no-change', reason: envelope.reason };
  const siblings = siblingCandidateIds(envelope.candidates);
  return {
    outcome: 'proposal',
    candidates: envelope.candidates.map((candidate) =>
      toProductExplorationCandidate(candidate, siblings),
    ),
  };
}
