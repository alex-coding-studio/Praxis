import {
  validateAgentGraphRecomposeDependencies,
  validateAgentGraphRecomposePlan,
} from '../../graph/agent/recompose.ts';
import { MaterializationError } from '../../materialization/receipt.ts';
import type { WhatToDoDeliveryMap } from './map.ts';
import type {
  DeliveryContractReference,
  DeliveryMapResult,
  DeliveryMapSourceClaim,
  WhatToDoContractCandidate,
  WhatToDoContractDependencyUpdate,
  WhatToDoMapProposal,
  WhatToDoSourceClaim,
} from './contract.ts';

export type DeliveryMapValidationState = {
  operation: 'create-map' | 'adjust-map';
  knownSources: Readonly<Record<string, { sha256: string; content: string }>>;
  requiredSourcePaths?: Iterable<string>;
  userInput: { path: string; sha256: string; content: string };
  knownCandidates?: Array<{
    candidateId: string;
    dependsOn: string[];
    sourceClaimIds: string[];
  }>;
  knownSourceClaims?: WhatToDoSourceClaim[];
  reservedCandidateIds?: Iterable<string>;
};

export function materializeDeliveryMapProposal<T extends WhatToDoMapProposal>(
  proposal: T,
  context: DeliveryMapValidationState,
  knownEvidence: Set<string>,
): T {
  const result = structuredClone(proposal);
  if (context.operation === 'create-map' && result.candidates.length === 0)
    fail('A new Delivery Map requires at least one Contract Candidate.');
  if (context.operation === 'create-map' && result.sourceClaimUpdates?.length)
    fail('A new Delivery Map cannot update an existing Source Claim.');
  if (
    context.operation === 'create-map' &&
    result.contractDependencyUpdates?.length
  )
    fail('A new Delivery Map cannot update an existing Contract dependency.');
  if (context.operation === 'adjust-map' && result.recomposition) {
    const retainedIds = new Set(
      result.recomposition.effects
        .filter((effect) => effect.kind === 'retain')
        .flatMap((effect) =>
          effect.from.filter((candidateId) => effect.to.includes(candidateId)),
        ),
    );
    const knownIds = new Set(
      (context.knownCandidates ?? []).map((candidate) => candidate.candidateId),
    );
    result.candidates = result.candidates.filter(
      (candidate) =>
        !(
          retainedIds.has(candidate.candidateId) &&
          knownIds.has(candidate.candidateId)
        ),
    );
  }
  if (context.operation === 'adjust-map')
    mergeAdjustedSourceClaims(result, context);
  validateCandidates(result.candidates, context, knownEvidence);
  if (context.operation === 'create-map' && result.recomposition) {
    const candidateIds = new Set(
      result.candidates.map((candidate) => candidate.candidateId),
    );
    const addedIds = result.recomposition.effects.flatMap((effect) => {
      if (effect.kind !== 'add' || effect.from.length > 0)
        fail('A new Delivery Map cannot include Recompose effects.');
      return effect.to;
    });
    if (
      new Set(addedIds).size !== candidateIds.size ||
      addedIds.some((candidateId) => !candidateIds.has(candidateId))
    )
      fail('A new Delivery Map cannot include Recompose effects.');
    delete result.recomposition;
  }
  normalizeClaimAssignments(result.candidates, result.sourceClaims);
  let retainedIds: string[] = [];
  let retainedCandidates = context.knownCandidates ?? [];
  if (context.operation === 'adjust-map') {
    if (!result.recomposition)
      fail('An adjusted Delivery Map requires Recompose effects.');
    if ((context.knownSourceClaims ?? []).length === 0)
      fail('An adjusted Delivery Map requires previous Source Claims.');
    const selectedIds = (context.knownCandidates ?? []).map(
      (candidate) => candidate.candidateId,
    );
    retainedIds = result.recomposition.effects
      .filter((effect) => effect.kind === 'retain')
      .flatMap((effect) => effect.from);
    retainedCandidates = applyContractDependencyUpdates(
      result.contractDependencyUpdates ?? [],
      retainedIds,
      [...retainedIds, ...result.candidates.map((item) => item.candidateId)],
      context.knownCandidates ?? [],
    );
    validateAgentGraphRecomposePlan({
      selectedIds,
      outputIds: [
        ...retainedIds,
        ...result.candidates.map((candidate) => candidate.candidateId),
      ],
      effects: result.recomposition.effects,
    });
    validateAgentGraphRecomposeDependencies({
      selectedIds,
      retainedIds,
      outputCandidates: result.candidates,
      knownCandidates: retainedCandidates,
    });
  }
  const completeMap = [
    ...retainedCandidates.filter((candidate) =>
      retainedIds.includes(candidate.candidateId),
    ),
    ...result.candidates,
  ];
  const retainedSet = new Set(retainedIds);
  for (const candidate of completeMap)
    if (retainedSet.has(candidate.candidateId))
      candidate.sourceClaimIds = result.sourceClaims
        .filter((claim) =>
          claim.contractCandidateIds.includes(candidate.candidateId),
        )
        .map((claim) => claim.claimId);
  validateCompleteMap(completeMap);
  validateClaims(result.sourceClaims, completeMap, context);
  return result;
}

function applyContractDependencyUpdates(
  updates: WhatToDoContractDependencyUpdate[],
  retainedIds: string[],
  outputIds: string[],
  knownCandidates: NonNullable<DeliveryMapValidationState['knownCandidates']>,
) {
  requireUnique(
    updates.map((update) => update.candidateId),
    'Contract dependency update identifiers must be unique.',
  );
  const retained = new Set(retainedIds);
  const outputs = new Set(outputIds);
  const updateById = new Map(
    updates.map((update) => [update.candidateId, update]),
  );
  for (const update of updates) {
    if (!retained.has(update.candidateId))
      fail('A Contract dependency update must target a retained Contract.');
    if (update.dependsOn.some((dependency) => !outputs.has(dependency)))
      fail(
        'A Contract dependency update references an unknown output Contract.',
      );
  }
  return knownCandidates.map((candidate) => {
    const update = updateById.get(candidate.candidateId);
    return update
      ? { ...candidate, dependsOn: [...update.dependsOn] }
      : structuredClone(candidate);
  });
}

function normalizeClaimAssignments(
  candidates: WhatToDoContractCandidate[],
  claims: WhatToDoSourceClaim[],
) {
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const claimById = new Map(claims.map((claim) => [claim.claimId, claim]));
  for (const candidate of candidates)
    for (const claimId of candidate.sourceClaimIds) {
      const claim = claimById.get(claimId);
      if (claim && !claim.contractCandidateIds.includes(candidate.candidateId))
        claim.contractCandidateIds.push(candidate.candidateId);
    }
  for (const claim of claims)
    for (const candidateId of claim.contractCandidateIds) {
      const candidate = candidateById.get(candidateId);
      if (candidate && !candidate.sourceClaimIds.includes(claim.claimId))
        candidate.sourceClaimIds.push(claim.claimId);
    }
}

function mergeAdjustedSourceClaims(
  result: WhatToDoMapProposal,
  context: DeliveryMapValidationState,
) {
  const claims = new Map(
    (context.knownSourceClaims ?? []).map((claim) => [
      claim.claimId,
      structuredClone(claim),
    ]),
  );
  for (const claim of result.sourceClaims) claims.set(claim.claimId, claim);
  const updates = result.sourceClaimUpdates ?? [];
  requireUnique(
    updates.map((update) => update.claimId),
    'Source Claim update identifiers must be unique.',
  );
  for (const update of updates) {
    if (result.sourceClaims.some((claim) => claim.claimId === update.claimId))
      fail('A Source Claim cannot be replaced and updated together.');
    const current = claims.get(update.claimId);
    if (!current) fail(`Source Claim update ${update.claimId} does not exist.`);
    claims.set(update.claimId, { ...current, ...update });
  }
  result.sourceClaims = [...claims.values()];
  delete result.sourceClaimUpdates;
}

function validateCandidates(
  candidates: WhatToDoContractCandidate[],
  context: DeliveryMapValidationState,
  knownEvidence: Set<string>,
) {
  requireUnique(
    candidates.map((candidate) => candidate.candidateId),
    'Contract Candidate identifiers must be unique.',
  );
  const unavailable = new Set([
    ...(context.reservedCandidateIds ?? []),
    ...(context.knownCandidates ?? []).map(
      (candidate) => candidate.candidateId,
    ),
  ]);
  for (const candidate of candidates) {
    if (unavailable.has(candidate.candidateId))
      fail(`Contract Candidate ${candidate.candidateId} already exists.`);
    if (candidate.revision !== 1)
      fail(`Contract Candidate ${candidate.candidateId} must use revision 1.`);
    if (candidate.openDecisions.length > 0)
      fail('A formal Delivery Map cannot contain an Open Decision.');
    if (candidate.domainImpact.kind === 'uncertain')
      fail('A formal Delivery Map cannot contain uncertain Domain Impact.');
    requireKnownPaths(candidate.domainImpact.evidencePaths, knownEvidence);
    requireUnique(
      candidate.acceptanceCriteria.map((criterion) => criterion.id),
      'Acceptance criterion identifiers must be unique within one Contract.',
    );
  }
}

function validateClaims(
  claims: WhatToDoSourceClaim[],
  candidates: Array<{ candidateId: string; sourceClaimIds: string[] }>,
  context: DeliveryMapValidationState,
) {
  requireUnique(
    claims.map((claim) => claim.claimId),
    'Source Claim identifiers must be unique.',
  );
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const claimIds = new Set(claims.map((claim) => claim.claimId));
  const claimById = new Map(claims.map((claim) => [claim.claimId, claim]));
  const previousClaims = new Map(
    (context.knownSourceClaims ?? []).map((claim) => [claim.claimId, claim]),
  );
  for (const candidate of candidates) {
    if (candidate.sourceClaimIds.some((claimId) => !claimIds.has(claimId)))
      fail('A Contract Candidate references an unknown Source Claim.');
    for (const claimId of candidate.sourceClaimIds)
      if (
        !claimById
          .get(claimId)
          ?.contractCandidateIds.includes(candidate.candidateId)
      )
        fail('Source Claim assignment must be bidirectional.');
  }
  for (const claim of claims) {
    const previous = previousClaims.get(claim.claimId);
    if (
      previous &&
      (claim.sourcePath !== previous.sourcePath ||
        claim.sourceSha256 !== previous.sourceSha256 ||
        claim.anchor !== previous.anchor ||
        claim.summary !== previous.summary)
    )
      fail(
        `Previously acknowledged Source Claim ${claim.claimId} changed identity.`,
      );
    if (!previous) {
      const source = context.knownSources[claim.sourcePath];
      if (!source || source.sha256 !== claim.sourceSha256)
        fail('A Source Claim does not match a frozen source.');
      requireUniqueExcerpt(
        source.content,
        claim.anchor,
        'A Source Claim anchor must occur exactly once in its frozen source.',
      );
    }
    if (
      claim.contractCandidateIds.some(
        (candidate) => !candidateById.has(candidate),
      )
    )
      fail('A Source Claim references an unknown Contract Candidate.');
    if (claim.disposition === 'in-scope') {
      if (
        claim.contractCandidateIds.length === 0 ||
        claim.exclusionReason ||
        claim.exclusionAuthority
      )
        fail('An in-scope Source Claim must be assigned without an exclusion.');
      for (const candidateId of claim.contractCandidateIds) {
        const candidate = candidateById.get(candidateId);
        if (!candidate?.sourceClaimIds.includes(claim.claimId))
          fail('Source Claim assignment must be bidirectional.');
      }
    } else {
      if (
        claim.contractCandidateIds.length > 0 ||
        !claim.exclusionReason ||
        !claim.exclusionAuthority
      )
        fail(
          'An out-of-scope Source Claim requires current User Input authority and no Contract.',
        );
      if (
        claim.exclusionAuthority.userInputPath !== context.userInput.path ||
        claim.exclusionAuthority.userInputSha256 !== context.userInput.sha256
      )
        fail('Source Claim exclusion does not match current User Input.');
      requireUniqueExcerpt(
        context.userInput.content,
        claim.exclusionAuthority.anchor,
        'Source Claim exclusion authority must occur exactly once in current User Input.',
      );
    }
  }
  for (const claimId of previousClaims.keys()) {
    const current = claimById.get(claimId);
    if (!current)
      fail(`Previously acknowledged Source Claim ${claimId} is missing.`);
  }
  for (const sourcePath of context.requiredSourcePaths ??
    Object.keys(context.knownSources))
    if (!claims.some((claim) => claim.sourcePath === sourcePath))
      fail('Every selected Product Design Feature needs a Source Claim.');
}

function validateCompleteMap(
  candidates: Array<{ candidateId: string; dependsOn: string[] }>,
) {
  const candidateIds = candidates.map((candidate) => candidate.candidateId);
  requireUnique(candidateIds, 'Contract Candidate identifiers must be unique.');
  const ids = new Set(candidateIds);
  for (const candidate of candidates) {
    if (candidate.dependsOn.some((dependency) => !ids.has(dependency)))
      fail('A Contract Candidate depends on an unknown Contract Candidate.');
    if (candidate.dependsOn.includes(candidate.candidateId))
      fail('A Contract Candidate cannot depend on itself.');
  }
  const dependencies = new Map(
    candidates.map((candidate) => [candidate.candidateId, candidate.dependsOn]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(candidateId: string) {
    if (visiting.has(candidateId))
      fail('Delivery Map dependencies contain a cycle.');
    if (visited.has(candidateId)) return;
    visiting.add(candidateId);
    for (const dependency of dependencies.get(candidateId) ?? [])
      visit(dependency);
    visiting.delete(candidateId);
    visited.add(candidateId);
  }
  for (const candidateId of dependencies.keys()) visit(candidateId);
}

function requireKnownPaths(values: string[], known: Set<string>) {
  if (values.some((path) => !known.has(path)))
    fail('The What to Do result references unknown evidence.');
}

function requireUniqueExcerpt(
  content: string,
  excerpt: string,
  message: string,
) {
  const first = content.indexOf(excerpt);
  if (first < 0 || content.indexOf(excerpt, first + 1) >= 0) fail(message);
}

function requireUnique(values: string[], message: string) {
  if (new Set(values).size !== values.length) fail(message);
}

function fail(message: string): never {
  throw new MaterializationError('validation', message);
}

function deliveryReferenceKey(reference: DeliveryContractReference) {
  return reference.kind === 'proposal'
    ? `proposal:${reference.localKey}`
    : `contract:${reference.id}`;
}

export type DeliveryMapFrozenEvidence = {
  knownSources: Readonly<Record<string, { sha256: string; content: string }>>;
  userInput: { path: string; sha256: string; content: string };
  knownEvidencePaths: Iterable<string>;
};

export function validateDeliveryMapPlan(
  basis: {
    operation: 'create-map' | 'adjust-map';
    currentMap: WhatToDoDeliveryMap | null;
  },
  result: Extract<DeliveryMapResult, { outcome: 'map-proposal' }>,
  evidence: DeliveryMapFrozenEvidence,
) {
  const knownEvidence = new Set(evidence.knownEvidencePaths);
  const proposed = result.contracts.map(
    (contract) => `proposal:${contract.localKey}`,
  );
  requireUnique(proposed, 'Contract Candidate identifiers must be unique.');
  requireUnique(
    result.sourceClaims.map((claim) => claim.claimId),
    'Source Claim identifiers must be unique.',
  );
  if (basis.operation === 'create-map') {
    if (result.contracts.length === 0)
      fail('A new Delivery Map requires at least one Contract Candidate.');
    if (result.sourceClaimUpdates?.length)
      fail('A new Delivery Map cannot update an existing Source Claim.');
    if (result.contractDependencyUpdates?.length)
      fail('A new Delivery Map cannot update an existing Contract dependency.');
  } else {
    if (!result.recomposition)
      fail('An adjusted Delivery Map requires Recompose effects.');
    if ((basis.currentMap?.sourceClaims ?? []).length === 0)
      fail('An adjusted Delivery Map requires previous Source Claims.');
  }
  for (const contract of result.contracts) {
    if (contract.openDecisions.length > 0)
      fail('A formal Delivery Map cannot contain an Open Decision.');
    if (contract.domainImpact.kind === 'uncertain')
      fail('A formal Delivery Map cannot contain uncertain Domain Impact.');
    requireUnique(
      contract.acceptanceCriteria.map((criterion) => criterion.id),
      'Acceptance criterion identifiers must be unique within one Contract.',
    );
    requireKnownPaths(contract.domainImpact.evidencePaths, knownEvidence);
  }

  if (basis.operation === 'create-map' && result.recomposition) {
    const added = result.recomposition.effects.flatMap((effect) => {
      if (effect.kind !== 'add' || effect.from.length > 0)
        fail('A new Delivery Map cannot include Recompose effects.');
      return effect.to.map(deliveryReferenceKey);
    });
    if (
      new Set(added).size !== proposed.length ||
      added.some((candidateId) => !proposed.includes(candidateId))
    )
      fail('A new Delivery Map cannot include Recompose effects.');
  }
  const known = new Map(
    (basis.currentMap?.contracts ?? []).map((contract) => [
      `contract:${contract.id}`,
      contract,
    ]),
  );
  const resolvable = new Set([...proposed, ...known.keys()]);
  const requireResolvable = (
    references: readonly DeliveryContractReference[],
  ) => {
    for (const reference of references)
      if (!resolvable.has(deliveryReferenceKey(reference)))
        fail(
          `The Delivery Map references an unknown Contract: ${deliveryReferenceKey(reference)}.`,
        );
  };
  for (const contract of result.contracts)
    requireResolvable(contract.dependsOn);
  for (const claim of result.sourceClaims) requireResolvable(claim.contracts);
  for (const update of result.contractDependencyUpdates ?? []) {
    requireResolvable([update.contract]);
    requireResolvable(update.dependsOn);
  }
  for (const effect of result.recomposition?.effects ?? []) {
    requireResolvable(effect.from);
    requireResolvable(effect.to);
  }

  const retained = new Set(
    result.recomposition?.effects
      .filter((effect) => effect.kind === 'retain')
      .flatMap((effect) => effect.from.map(deliveryReferenceKey)) ?? [],
  );
  const outputs = new Set([...retained, ...proposed]);
  const dependencyUpdates = result.contractDependencyUpdates ?? [];
  requireUnique(
    dependencyUpdates.map((update) => deliveryReferenceKey(update.contract)),
    'Contract dependency update identifiers must be unique.',
  );
  for (const update of dependencyUpdates) {
    if (!retained.has(deliveryReferenceKey(update.contract)))
      fail('A Contract dependency update must target a retained Contract.');
    if (
      update.dependsOn.some(
        (dependency) => !outputs.has(deliveryReferenceKey(dependency)),
      )
    )
      fail(
        'A Contract dependency update references an unknown output Contract.',
      );
  }
  const updated = new Map(
    dependencyUpdates.map((update) => [
      deliveryReferenceKey(update.contract),
      update.dependsOn.map(deliveryReferenceKey),
    ]),
  );
  const completeMap = [
    ...[...known].flatMap(([candidateId, contract]) =>
      retained.has(candidateId)
        ? [
            {
              candidateId,
              dependsOn:
                updated.get(candidateId) ??
                contract.dependsOn.map(
                  (dependency) => `contract:${dependency}`,
                ),
            },
          ]
        : [],
    ),
    ...result.contracts.map((contract) => ({
      candidateId: `proposal:${contract.localKey}`,
      dependsOn: contract.dependsOn.map(deliveryReferenceKey),
    })),
  ];
  validateCompleteMap(completeMap);

  const claimIds = new Set(result.sourceClaims.map((claim) => claim.claimId));
  const assignments = new Map(
    result.sourceClaims.map((claim) => [
      claim.claimId,
      new Set(claim.contracts.map(deliveryReferenceKey)),
    ]),
  );
  for (const contract of result.contracts)
    for (const claimId of contract.sourceClaimIds) {
      if (!claimIds.has(claimId))
        fail('A Contract Candidate references an unknown Source Claim.');
      if (!assignments.get(claimId)?.has(`proposal:${contract.localKey}`))
        fail('Source Claim assignment must be bidirectional.');
    }
  const previousClaims = new Map(
    (basis.currentMap?.sourceClaims ?? []).map((claim) => [
      claim.claimId,
      claim,
    ]),
  );
  for (const claim of result.sourceClaims) {
    if (
      claim.contracts.some(
        (reference) => !outputs.has(deliveryReferenceKey(reference)),
      )
    )
      fail('A Source Claim references an unknown Contract Candidate.');
    if (claim.disposition === 'in-scope') {
      if (
        claim.contracts.length === 0 ||
        claim.exclusionReason ||
        claim.exclusionAuthority
      )
        fail('An in-scope Source Claim must be assigned without an exclusion.');
    } else if (
      claim.contracts.length > 0 ||
      !claim.exclusionReason ||
      !claim.exclusionAuthority
    )
      fail(
        'An out-of-scope Source Claim requires current User Input authority and no Contract.',
      );
    const previous = previousClaims.get(claim.claimId);
    if (
      previous &&
      (claim.source.path !== previous.sourcePath ||
        claim.anchor !== previous.anchor ||
        claim.summary !== previous.summary)
    )
      fail(
        `Previously acknowledged Source Claim ${claim.claimId} changed identity.`,
      );
    if (!previous) {
      const source = evidence.knownSources[claim.source.path];
      if (!source) fail('A Source Claim does not match a frozen source.');
      requireUniqueExcerpt(
        source.content,
        claim.anchor,
        'A Source Claim anchor must occur exactly once in its frozen source.',
      );
    }
    if (claim.exclusionAuthority)
      requireUniqueExcerpt(
        evidence.userInput.content,
        claim.exclusionAuthority.anchor,
        'Source Claim exclusion authority must occur exactly once in current User Input.',
      );
  }
  for (const sourcePath of Object.keys(evidence.knownSources))
    if (!result.sourceClaims.some((claim) => claim.source.path === sourcePath))
      fail('Every selected Product Design Feature needs a Source Claim.');
  for (const claimId of previousClaims.keys())
    if (!claimIds.has(claimId))
      fail(`Previously acknowledged Source Claim ${claimId} is missing.`);

  if (basis.operation !== 'adjust-map') return;
  const selectedIds = [...known.keys()];
  const knownCandidates = [...known].map(([candidateId, contract]) => ({
    candidateId,
    dependsOn:
      updated.get(candidateId) ??
      contract.dependsOn.map((dependency) => `contract:${dependency}`),
  }));
  try {
    validateAgentGraphRecomposePlan({
      selectedIds,
      outputIds: [...outputs],
      effects: (result.recomposition?.effects ?? []).map((effect) => ({
        kind: effect.kind,
        from: effect.from.map(deliveryReferenceKey),
        to: effect.to.map(deliveryReferenceKey),
      })),
    });
    validateAgentGraphRecomposeDependencies({
      selectedIds,
      retainedIds: [...retained],
      outputCandidates: result.contracts.map((contract) => ({
        candidateId: `proposal:${contract.localKey}`,
        dependsOn: contract.dependsOn.map(deliveryReferenceKey),
      })),
      knownCandidates,
    });
  } catch (error) {
    if (error instanceof MaterializationError) throw error;
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function mergeDeliveryMapClaims(
  basis: {
    operation: 'create-map' | 'adjust-map';
    currentMap: WhatToDoDeliveryMap | null;
  },
  result: Extract<DeliveryMapResult, { outcome: 'map-proposal' }>,
): Extract<DeliveryMapResult, { outcome: 'map-proposal' }> {
  if (basis.operation !== 'adjust-map') return result;
  const claims = new Map<string, DeliveryMapSourceClaim>(
    (basis.currentMap?.sourceClaims ?? []).map((claim) => [
      claim.claimId,
      {
        claimId: claim.claimId,
        source: { kind: 'source', path: claim.sourcePath },
        anchor: claim.anchor,
        summary: claim.summary,
        disposition: claim.disposition,
        contracts: claim.contractIds.map((id) => ({
          kind: 'contract' as const,
          id,
        })),
        exclusionReason: claim.exclusionReason,
        exclusionAuthority: claim.exclusionAuthority
          ? { anchor: claim.exclusionAuthority.anchor }
          : null,
      },
    ]),
  );
  for (const claim of result.sourceClaims) claims.set(claim.claimId, claim);
  const updates = result.sourceClaimUpdates ?? [];
  requireUnique(
    updates.map((update) => update.claimId),
    'Source Claim update identifiers must be unique.',
  );
  for (const update of updates) {
    if (result.sourceClaims.some((claim) => claim.claimId === update.claimId))
      fail('A Source Claim cannot be replaced and updated together.');
    const current = claims.get(update.claimId);
    if (!current) fail(`Source Claim update ${update.claimId} does not exist.`);
    claims.set(update.claimId, { ...current, ...update });
  }
  const { sourceClaimUpdates: _updates, ...rest } = result;
  return { ...rest, sourceClaims: [...claims.values()] };
}
