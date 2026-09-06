import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { RegisteredProject } from '../../project-registry.ts';
import { readPlanningFile } from '../../planning-documents.ts';
export { readPlanningFile } from '../../planning-documents.ts';
import { assertCardUuid } from './harness.ts';
import { primarySourceResourcePaths } from '../../graph/agent/context-workspace.ts';
import { readWhatToDoCurrentMap } from '../delivery-planning/storage.ts';
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

export async function listPlanningSources(
  project: RegisteredProject,
): Promise<PlanningSource[]> {
  const sources: PlanningSource[] = [];
  for (const graphRoot of ['whats-next', 'task-graph'] as const) {
    const directory = path.join(project.planningPath, graphRoot, 'nodes');
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^NODE-[0-9a-f]{8,32}$/.test(entry.name))
        continue;
      const node = JSON.parse(
        await readPlanningFile(
          project,
          `${graphRoot}/nodes/${entry.name}/node.json`,
        ),
      );
      if (node.role !== 'node' || !['accepted', 'formal'].includes(node.status))
        continue;
      if (
        graphRoot === 'whats-next' &&
        (node.layer ?? 'discovery') !== 'discovery'
      )
        continue;
      assertCardUuid(node.uid);
      if (
        node.id !== entry.name ||
        typeof node.title !== 'string' ||
        !Array.isArray(node.resources)
      )
        throw new Error('Invalid formal source Node.');
      const outputs = [...primarySourceResourcePaths('node', node.resources)];
      const ownOutput = `${graphRoot}/nodes/${entry.name}/output.md`;
      sources.push({
        module: graphRoot,
        id: node.id,
        uid: node.uid,
        title: node.title,
        summary: typeof node.summary === 'string' ? node.summary : '',
        dependsOn: Array.isArray(node.relations?.dependsOn)
          ? node.relations.dependsOn.filter(
              (id: unknown) => typeof id === 'string',
            )
          : Array.isArray(node.dependsOn)
            ? node.dependsOn.filter((id: unknown) => typeof id === 'string')
            : [],
        derivedFrom: Array.isArray(node.relations?.derivedFrom)
          ? node.relations.derivedFrom.filter(
              (id: unknown) => typeof id === 'string',
            )
          : Array.isArray(node.derivedFrom)
            ? node.derivedFrom.filter((id: unknown) => typeof id === 'string')
            : [],
        outputPaths: outputs.includes(ownOutput)
          ? [ownOutput]
          : outputs.filter((ref) => typeof ref === 'string'),
      });
    }
  }
  const deliveryMap = await readWhatToDoCurrentMap(project);
  for (const contract of deliveryMap?.contracts ?? []) {
    assertCardUuid(contract.uid);
    sources.push(deliveryContractPlanningSource(contract));
  }
  return sources;
}

export async function snapshotPlanningSource(
  project: RegisteredProject,
  module: string,
  uid: string,
) {
  assertCardUuid(uid);
  const source = (await listPlanningSources(project)).find(
    (item) => item.module === module && item.uid === uid,
  );
  if (!source) throw new Error('Formal source Node not found.');
  if (!source.outputPaths.length)
    throw new Error('Source Node has no output resource.');
  const outputs = await Promise.all(
    source.outputPaths.map((ref) => readPlanningFile(project, ref)),
  );
  const markdown = `# ${source.title}\n\n${source.summary}\n\n${outputs.join('\n\n---\n\n')}`;
  if (Buffer.byteLength(markdown) > 1_048_576)
    throw new Error('Source context is too large.');
  return { source, markdown };
}
