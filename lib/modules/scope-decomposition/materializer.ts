import { allocateCandidateAliases } from '../../graph/identity-store.ts';
import { resolveProposalCandidates } from '../../graph/proposal/resolve.ts';
import { MaterializationError } from '../../materialization/receipt.ts';
import type { ScopeDecompositionMaterializationBasis } from './basis.ts';
import type { ProposalReference } from '../../graph/proposal/reference.ts';
import type {
  ScopeDecompositionCandidateRecord,
  ScopeDecompositionRecomposeEffect,
  ScopeDecompositionResult,
} from './contract.ts';

export type MaterializedRecomposeEffect = {
  kind: ScopeDecompositionRecomposeEffect['kind'];
  from: string[];
  to: string[];
};

export type ScopeDecompositionMaterialization = {
  candidates: ScopeDecompositionCandidateRecord[];
  candidateAliases: Record<string, string> | null;
  effects: MaterializedRecomposeEffect[] | null;
};

function resolveProposalReference(
  reference: ProposalReference,
  aliases: ReadonlyMap<string, string>,
) {
  const alias = aliases.get(reference.localKey);
  if (!alias) {
    throw new MaterializationError(
      'identity',
      `Recompose effect ${reference.localKey} has no allocated Candidate identifier.`,
    );
  }
  return alias;
}

function resolveEffects(
  effects: readonly ScopeDecompositionRecomposeEffect[],
  aliases: ReadonlyMap<string, string>,
): MaterializedRecomposeEffect[] {
  return effects.map((effect) => ({
    kind: effect.kind,
    from: effect.from.map((reference) => reference.id),
    to: effect.to.map((reference) =>
      reference.kind === 'candidate'
        ? reference.id
        : resolveProposalReference(reference, aliases),
    ),
  }));
}

export async function materializeScopeDecompositionResult(
  basis: ScopeDecompositionMaterializationBasis,
  result: ScopeDecompositionResult,
): Promise<ScopeDecompositionMaterialization | null> {
  if (result.outcome !== 'proposal') return null;
  const { aliases, index } = await allocateCandidateAliases(
    basis.project.planningPath,
    basis.scope,
    {
      localKeys: result.candidates.map((candidate) => candidate.localKey),
      revisionTarget: basis.revisionTarget,
    },
    basis.identityFingerprint,
  );
  return {
    candidates: resolveProposalCandidates(result.candidates, {
      aliases,
      index,
      revision: basis.revisionTarget ? basis.revisionTarget.revision + 1 : 1,
    }),
    candidateAliases: basis.revisionTarget ? null : Object.fromEntries(aliases),
    effects: result.recomposition
      ? resolveEffects(result.recomposition.effects, aliases)
      : null,
  };
}
