import { randomUUID } from 'node:crypto';
import type {
  DeliveryContractReference,
  DeliveryMapResult,
  WhatToDoContractCandidate,
  WhatToDoSourceClaim,
} from './contract.ts';

export type WhatToDoDeliveryContract = Omit<
  WhatToDoContractCandidate,
  'candidateId' | 'revision' | 'dependsOn'
> & {
  id: string;
  uid: string;
  relations: { derivedFrom: string[]; dependsOn: string[] };
  dependsOn: string[];
  outputPath: string;
};

export type WhatToDoMapSourceClaim = {
  claimId: string;
  sourcePath: string;
  sourceSha256: string;
  anchor: string;
  summary: string;
  disposition: 'in-scope' | 'out-of-scope';
  contractIds: string[];
  exclusionReason: string | null;
  exclusionAuthority: {
    userInputPath: string;
    userInputSha256: string;
    anchor: string;
  } | null;
};

export type WhatToDoMapSourceSnapshot = {
  logicalPath: string;
  sha256: string;
  storedPath: string;
};

export type WhatToDoDeliveryMap = {
  schemaVersion: 1;
  runId: string;
  updatedAt: string;
  sourceUids: string[];
  contracts: WhatToDoDeliveryContract[];
  sourceClaims: WhatToDoMapSourceClaim[];
  sourceSnapshots: WhatToDoMapSourceSnapshot[];
};

export function whatToDoContractCandidateId(
  contract: WhatToDoDeliveryContract,
) {
  return `CANDIDATE-${contract.id.slice(5)}`;
}

export function whatToDoKnownCandidates(map: WhatToDoDeliveryMap) {
  const candidateIdByContractId = new Map(
    map.contracts.map((contract) => [
      contract.id,
      whatToDoContractCandidateId(contract),
    ]),
  );
  return map.contracts.map((contract) => ({
    candidateId: whatToDoContractCandidateId(contract),
    dependsOn: contract.dependsOn.map((dependency) =>
      candidateIdByContractId.get(dependency)!,
    ),
    sourceClaimIds: [...contract.sourceClaimIds],
  }));
}

export function whatToDoKnownSourceClaims(
  map: WhatToDoDeliveryMap,
): WhatToDoSourceClaim[] {
  const candidateIdByContractId = new Map(
    map.contracts.map((contract) => [
      contract.id,
      whatToDoContractCandidateId(contract),
    ]),
  );
  return map.sourceClaims.map((claim) => {
    const { contractIds, ...content } = claim;
    return {
      ...content,
      contractCandidateIds: contractIds.map((contractId) =>
        candidateIdByContractId.get(contractId)!,
      ),
    };
  });
}

export function whatToDoCurrentMapPromptView(map: WhatToDoDeliveryMap) {
  const candidateIdByContractId = new Map(
    map.contracts.map((contract) => [
      contract.id,
      whatToDoContractCandidateId(contract),
    ]),
  );
  return {
    contracts: map.contracts.map((contract) => {
      const {
        id: _id,
        uid: _uid,
        relations: _relations,
        ...content
      } = contract;
      return {
        ...content,
        candidateId: whatToDoContractCandidateId(contract),
        dependsOn: contract.dependsOn.map((dependency) =>
          candidateIdByContractId.get(dependency)!,
        ),
      };
    }),
    sourceClaims: whatToDoKnownSourceClaims(map).map((claim) => ({
      claimId: claim.claimId,
      sourcePath: claim.sourcePath,
      summary: claim.summary,
      disposition: claim.disposition,
      contractCandidateIds: claim.contractCandidateIds,
      exclusionReason: claim.exclusionReason,
    })),
  };
}

function contractIdentityKey(id: string) {
  return `contract:${id}`;
}

function contractReferenceKey(reference: DeliveryContractReference) {
  return reference.kind === 'proposal'
    ? `proposal:${reference.localKey}`
    : contractIdentityKey(reference.id);
}

function requireIdentity(
  identities: Map<string, { uid: string; id: string }>,
  reference: DeliveryContractReference,
) {
  const identity = identities.get(contractReferenceKey(reference));
  if (!identity)
    throw new Error(
      `Delivery Contract reference is unresolved: ${contractReferenceKey(reference)}.`,
    );
  return identity;
}

export function materializeWhatToDoDeliveryMap(
  input: {
    runId: string;
    updatedAt: string;
    sourceUids: string[];
    result: Extract<DeliveryMapResult, { outcome: 'map-proposal' }>;
    basis: {
      currentMap: WhatToDoDeliveryMap | null;
      userInput: { path: string; sha256: string };
    };
    sourceSnapshots: WhatToDoMapSourceSnapshot[];
  },
  createUid: () => string = randomUUID,
): WhatToDoDeliveryMap {
  const aliases = new Set(
    (input.basis.currentMap?.contracts ?? []).map((contract) => contract.id),
  );
  const retainedCandidateIds = new Set(
    input.result.recomposition?.effects
      .filter((effect) => effect.kind === 'retain')
      .flatMap((effect) => effect.from.map(contractReferenceKey)) ?? [],
  );
  const identities = new Map([
    ...(input.basis.currentMap?.contracts ?? [])
      .filter((contract) =>
        retainedCandidateIds.has(contractIdentityKey(contract.id)),
      )
      .map(
        (contract) =>
          [
            contractIdentityKey(contract.id),
            { uid: contract.uid, id: contract.id },
          ] as const,
      ),
    ...input.result.contracts.map((contract) => {
      const uid = createUid();
      const compact = uid.replaceAll('-', '');
      let id = '';
      for (let length = 8; length <= compact.length; length += 4) {
        const candidateId = `NODE-${compact.slice(-length)}`;
        if (!aliases.has(candidateId)) {
          id = candidateId;
          aliases.add(candidateId);
          break;
        }
      }
      if (!id) throw new Error('Cannot allocate a Delivery Contract identity.');
      return [
        contractReferenceKey({ kind: 'proposal', localKey: contract.localKey }),
        { uid, id },
      ] as const;
    }),
  ]);
  const retainedContracts = (input.basis.currentMap?.contracts ?? [])
    .filter((contract) =>
      retainedCandidateIds.has(contractIdentityKey(contract.id)),
    )
    .map((contract) => {
      const candidateId = contractIdentityKey(contract.id);
      const update = input.result.contractDependencyUpdates?.find(
        (item) => contractReferenceKey(item.contract) === candidateId,
      );
      if (!update) return contract;
      const dependencyIdentities = update.dependsOn.map((dependency) =>
        requireIdentity(identities, dependency),
      );
      return {
        ...contract,
        relations: {
          ...contract.relations,
          dependsOn: dependencyIdentities.map((dependency) => dependency.uid),
        },
        dependsOn: dependencyIdentities.map((dependency) => dependency.id),
        outputPath: `what-to-do/runs/${input.runId}/contracts/${contract.id}/output.md`,
      };
    });
  const newContracts = input.result.contracts.map((proposed) => {
    const identity = requireIdentity(identities, {
      kind: 'proposal',
      localKey: proposed.localKey,
    });
    const dependencyIdentities = proposed.dependsOn.map((dependency) =>
      requireIdentity(identities, dependency),
    );
    const { localKey: _localKey, dependsOn: _dependsOn, ...content } = proposed;
    return {
      ...content,
      id: identity.id,
      uid: identity.uid,
      relations: {
        derivedFrom: [],
        dependsOn: dependencyIdentities.map((dependency) => dependency.uid),
      },
      dependsOn: dependencyIdentities.map((dependency) => dependency.id),
      outputPath: `what-to-do/runs/${input.runId}/contracts/${identity.id}/output.md`,
    };
  });
  const contracts = [...retainedContracts, ...newContracts].map((contract) => {
    const candidateId = contractIdentityKey(contract.id);
    return {
      ...contract,
      sourceClaimIds: input.result.sourceClaims
        .filter((claim) =>
          claim.contracts.some(
            (reference) => contractReferenceKey(reference) === candidateId,
          ),
        )
        .map((claim) => claim.claimId),
    };
  });
  const snapshotByPath = new Map(
    [
      ...(input.basis.currentMap?.sourceSnapshots ?? []),
      ...input.sourceSnapshots,
    ].map((snapshot) => [snapshot.logicalPath, snapshot]),
  );
  const sourcePaths = new Set(
    input.result.sourceClaims.map((claim) => claim.source.path),
  );
  const sourceSnapshots = [...sourcePaths].map((sourcePath) => {
    const snapshot = snapshotByPath.get(sourcePath);
    if (!snapshot)
      throw new Error(`Source Snapshot is unavailable: ${sourcePath}`);
    return structuredClone(snapshot);
  });
  return {
    schemaVersion: 1,
    runId: input.runId,
    updatedAt: input.updatedAt,
    sourceUids: [...new Set(input.sourceUids)],
    contracts,
    sourceClaims: input.result.sourceClaims.map((claim) => {
      const { contracts: claimContracts, source, ...content } = claim;
      const snapshot = snapshotByPath.get(source.path);
      if (!snapshot)
        throw new Error(`Source Snapshot is unavailable: ${source.path}`);
      return {
        ...content,
        sourcePath: source.path,
        sourceSha256: snapshot.sha256,
        exclusionAuthority: claim.exclusionAuthority
          ? {
              userInputPath: input.basis.userInput.path,
              userInputSha256: input.basis.userInput.sha256,
              anchor: claim.exclusionAuthority.anchor,
            }
          : null,
        contractIds: claimContracts.map(
          (reference) => requireIdentity(identities, reference).id,
        ),
      };
    }),
    sourceSnapshots,
  };
}

export function renderWhatToDoContract(contract: WhatToDoDeliveryContract) {
  const list = (items: string[]) =>
    items.map((item) => `- ${item}`).join('\n') || '- None';
  return `# ${contract.title}\n\n${contract.summary}\n\n## Outcome\n\n${contract.outcome}\n\n## Included scope\n\n${list(contract.includedScope)}\n\n## Excluded scope\n\n${list(contract.excludedScope)}\n\n## Product rules\n\n${list(contract.productRules)}\n\n## Domain impact\n\n- Kind: ${contract.domainImpact.kind}\n- Reason: ${contract.domainImpact.reason}\n- Evidence: ${contract.domainImpact.evidencePaths.join(', ') || 'None'}\n\n## Required experience states\n\n${list(contract.requiredExperienceStates)}\n\n## Repository constraints\n\n${list(contract.repositoryConstraints)}\n\n## Acceptance\n\n${contract.acceptanceCriteria.map((item) => `- **${item.id}** ${item.condition}\n  - Pass: ${item.passCondition}\n  - Evidence: ${item.evidence}`).join('\n')}\n\n## Validation expectations\n\n${list(contract.validationExpectations)}\n\n## Dependencies\n\n${list(contract.dependsOn)}\n\n## Source claims\n\n${list(contract.sourceClaimIds)}\n\n## Delivery strategy\n\n- Kind: ${contract.deliveryStrategy.kind}\n- Reason: ${contract.deliveryStrategy.reason}\n`;
}
