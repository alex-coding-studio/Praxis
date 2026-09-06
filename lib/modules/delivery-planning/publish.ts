import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { MaterializationError } from '../../materialization/receipt.ts';
import { withDeliveryState } from '../../delivery-state-lock.ts';
import { PublicApiError } from '../../api-errors.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import type { DeliveryMapBasis } from './basis.ts';
import {
  DELIVERY_MAP_RESULT_CONTRACT,
  type DeliveryMapResult,
} from './contract.ts';
import {
  materializeWhatToDoDeliveryMap,
  renderWhatToDoContract,
  type WhatToDoDeliveryContract,
  type WhatToDoDeliveryMap,
  type WhatToDoMapSourceSnapshot,
} from './map.ts';
import { validateDeliveryMapPlan } from './validation.ts';
import {
  atomicWhatToDoText,
  readWhatToDoCurrentMapWithFingerprint,
  whatToDoRunDirectory,
  writeWhatToDoCurrentMap,
} from './storage.ts';

export type DeliveryMapEvidence = {
  sourceUids: string[];
  userInput: { path: string; sha256: string };
  sourceSnapshots: WhatToDoMapSourceSnapshot[];
};

export type DeliveryPlanningCard = {
  id: string;
  revision: number;
  source: {
    module: string;
    uid: string;
    id: string;
    version?: string;
    title: string;
  };
  run?: { status: string } | null;
  plan?: { status: string } | null;
  actions: unknown[];
  execution?: { runs: unknown[] } | null;
};

export type DeliveryCardTransition = {
  finalize(): Promise<unknown>;
  rollback(): Promise<unknown>;
};

export type DeliveryPublicationHost = {
  list(project: RegisteredProject): Promise<DeliveryPlanningCard[]>;
  stageDeleteCard(
    project: RegisteredProject,
    cardId: string,
    revision: number,
  ): Promise<DeliveryCardTransition>;
  contractSource(contract: WhatToDoDeliveryContract): {
    uid: string;
    id: string;
    version?: string;
  };
  assertPreservesTargets(
    project: RegisteredProject,
    map: WhatToDoDeliveryMap,
  ): Promise<void>;
};

export type PublishedDeliveryMap = {
  runId: string;
  outcome: DeliveryMapResult['outcome'];
  map: WhatToDoDeliveryMap | null;
  contractPaths: Record<string, string>;
};

export function computeDeliveryMap(
  basis: DeliveryMapBasis,
  result: DeliveryMapResult,
  producer: { runId: string; updatedAt: string },
  evidence: DeliveryMapEvidence,
): WhatToDoDeliveryMap | null {
  if (result.outcome !== 'map-proposal') return null;
  return materializeWhatToDoDeliveryMap({
    runId: producer.runId,
    updatedAt: producer.updatedAt,
    sourceUids: [
      ...(basis.currentMap?.sourceUids ?? []),
      ...evidence.sourceUids,
    ],
    result,
    basis: { currentMap: basis.currentMap, userInput: evidence.userInput },
    sourceSnapshots: evidence.sourceSnapshots,
  });
}

export async function stageDeliveryContractArtifacts(
  project: RegisteredProject,
  runId: string,
  map: WhatToDoDeliveryMap,
): Promise<Record<string, string>> {
  const runPath = await whatToDoRunDirectory(project, runId);
  const owned = map.contracts.filter((contract) =>
    contract.outputPath.startsWith(`what-to-do/runs/${runId}/contracts/`),
  );
  try {
    await Promise.all(
      owned.map(async (contract) => {
        const directory = path.join(runPath, 'contracts', contract.id);
        await mkdir(directory, { recursive: true });
        await atomicWhatToDoText(
          path.join(directory, 'output.md'),
          renderWhatToDoContract(contract),
        );
      }),
    );
  } catch (error) {
    throw new MaterializationError(
      'staging',
      error instanceof Error ? error.message : String(error),
    );
  }
  return Object.fromEntries(
    map.contracts.map((contract) => [contract.id, contract.outputPath]),
  );
}

export async function publishDeliveryMap(
  project: RegisteredProject,
  map: WhatToDoDeliveryMap,
  host: DeliveryPublicationHost,
  basis: DeliveryMapBasis | null = null,
) {
  await withDeliveryState(project, async () => {
    await host.assertPreservesTargets(project, map);
    if (basis) {
      const { fingerprint } =
        await readWhatToDoCurrentMapWithFingerprint(project);
      if (fingerprint !== basis.currentMapFingerprint) {
        throw new MaterializationError(
          'stale-basis',
          'The current Delivery Map changed after this Run was prepared.',
        );
      }
    }
    const nextSources = new Map(
      map.contracts.map((contract) => {
        const source = host.contractSource(contract);
        return [source.uid, source] as const;
      }),
    );
    const superseded = (await host.list(project)).filter((card) => {
      if (card.source.module !== 'what-to-do') return false;
      const source = nextSources.get(card.source.uid);
      return (
        !source ||
        source.id !== card.source.id ||
        source.version !== card.source.version
      );
    });
    const protectedCards = superseded.filter(planningCardProtectsDeliveryMap);
    if (protectedCards.length)
      throw new PublicApiError(
        `The Delivery Map cannot replace Contracts already in progress: ${protectedCards.map((card) => card.source.title).join(', ')}.`,
        409,
      );
    const staged: DeliveryCardTransition[] = [];
    try {
      for (const card of superseded)
        staged.push(
          await host.stageDeleteCard(project, card.id, card.revision),
        );
      await writeWhatToDoCurrentMap(project, map);
    } catch (error) {
      await Promise.allSettled(
        staged.reverse().map((transition) => transition.rollback()),
      );
      throw error;
    }
    await Promise.allSettled(staged.map((transition) => transition.finalize()));
  });
}

function planningCardProtectsDeliveryMap(card: DeliveryPlanningCard) {
  return Boolean(
    card.run?.status === 'running' ||
    card.plan?.status === 'finalized' ||
    card.actions.length ||
    card.execution?.runs.length,
  );
}

export async function submitDeliveryMapResult(
  project: RegisteredProject,
  basis: DeliveryMapBasis,
  result: DeliveryMapResult,
  submission: { runId: string; updatedAt?: string } & DeliveryMapEvidence,
  host: DeliveryPublicationHost,
): Promise<PublishedDeliveryMap> {
  try {
    DELIVERY_MAP_RESULT_CONTRACT.validateStructure(result);
  } catch (error) {
    throw new MaterializationError(
      'validation',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (result.outcome === 'map-proposal') validateDeliveryMapPlan(basis, result);
  const map = computeDeliveryMap(
    basis,
    result,
    {
      runId: submission.runId,
      updatedAt: submission.updatedAt ?? new Date().toISOString(),
    },
    submission,
  );
  if (!map)
    return {
      runId: submission.runId,
      outcome: result.outcome,
      map: null,
      contractPaths: {},
    };
  const contractPaths = await stageDeliveryContractArtifacts(
    project,
    submission.runId,
    map,
  );
  await publishDeliveryMap(project, map, host, basis);
  return {
    runId: submission.runId,
    outcome: result.outcome,
    map,
    contractPaths,
  };
}
