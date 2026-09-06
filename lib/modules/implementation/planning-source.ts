import { createHash } from 'node:crypto';
import type { WhatToDoDeliveryContract } from '../delivery-planning/map.ts';

export type PlanningSource = {
  module: 'whats-next' | 'task-graph' | 'what-to-do';
  id: string;
  uid: string;
  title: string;
  summary: string;
  dependsOn: string[];
  derivedFrom?: string[];
  outputPaths: string[];
  version?: string;
};

export function deliveryContractPlanningSource(
  contract: WhatToDoDeliveryContract,
): PlanningSource {
  const source: PlanningSource = {
    module: 'what-to-do',
    id: contract.id,
    uid: contract.uid,
    title: contract.title,
    summary: contract.summary,
    dependsOn: [...contract.relations.dependsOn],
    derivedFrom: [],
    outputPaths: [contract.outputPath],
  };
  source.version = createHash('sha256')
    .update(
      JSON.stringify({
        module: source.module,
        id: source.id,
        uid: source.uid,
        title: source.title,
        summary: source.summary,
        dependsOn: source.dependsOn,
        derivedFrom: source.derivedFrom,
        outputPaths: source.outputPaths,
      }),
    )
    .digest('hex');
  return source;
}
