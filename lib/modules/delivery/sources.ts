import { readFile } from 'node:fs/promises';
import type { RegisteredProject } from '../../project-registry.ts';
import { resolvePlanningPath } from '../../planning-paths.ts';
import { semanticResultHash, sha256Hex } from '../../materialization/hash.ts';
import {
  listTaskGraphNodes,
  type TaskGraphNode,
} from '../../graph/task/nodes.ts';
import { readWhatToDoCurrentMap } from '../delivery-planning/storage.ts';
import type { DeliverySource } from './types.ts';

export function nodeDeliveryKind(
  node: TaskGraphNode,
  module: 'whats-next' | 'task-graph',
) {
  if (node.role !== 'node' || !['accepted', 'formal'].includes(node.status))
    return null;
  if (module === 'task-graph') return 'task' as const;
  return node.layer === 'discovery' && node.artifactKind === 'mvp'
    ? ('mvp' as const)
    : null;
}

export async function readDeliverySources(project: RegisteredProject) {
  const [discovery, tasks, map] = await Promise.all([
    listTaskGraphNodes(project, 'whats-next'),
    listTaskGraphNodes(project, 'task-graph'),
    readWhatToDoCurrentMap(project),
  ]);
  const sources: DeliverySource[] = [];
  const contextUids = new Set<string>();
  const aliases = new Map<string, string>();
  for (const node of [...discovery, ...tasks]) {
    if (node.uid) aliases.set(node.id, node.uid);
  }
  for (const contract of map?.contracts ?? [])
    aliases.set(contract.id, contract.uid);
  for (const [module, nodes] of [
    ['whats-next', discovery],
    ['task-graph', tasks],
  ] as const) {
    for (const node of nodes) {
      if (!node.uid) throw new Error(`Node ${node.id} has no stable identity.`);
      const kind = nodeDeliveryKind(node, module);
      if (!kind) {
        if (
          node.role === 'node' &&
          ['accepted', 'formal'].includes(node.status)
        )
          contextUids.add(node.uid);
        continue;
      }
      const ownOutput = `${module}/nodes/${node.id}/output.md`;
      const outputPaths = node.resources
        .filter((resource) => resource.kind === 'output')
        .map((resource) => resource.path);
      if (!outputPaths.includes(ownOutput)) outputPaths.push(ownOutput);
      sources.push({
        sourceKind: kind,
        sourceModule: module,
        sourceId: node.id,
        sourceUid: node.uid,
        title: node.title,
        summary: node.summary ?? '',
        dependsOn:
          node.relations?.dependsOn ??
          node.dependsOn.map((id) => aliases.get(id) ?? id),
        outputPaths,
        sourceFingerprint: await fingerprint(project, node, outputPaths),
      });
    }
  }
  for (const contract of map?.contracts ?? []) {
    sources.push({
      sourceKind: 'delivery-contract',
      sourceModule: 'what-to-do',
      sourceId: contract.id,
      sourceUid: contract.uid,
      title: contract.title,
      summary: contract.summary,
      dependsOn: [...contract.relations.dependsOn],
      outputPaths: [contract.outputPath],
      sourceFingerprint: await fingerprint(project, contract, [
        contract.outputPath,
      ]),
    });
  }
  return { sources, contextUids };
}

async function fingerprint(
  project: RegisteredProject,
  value: unknown,
  outputPaths: string[],
) {
  const contents = await Promise.all(
    outputPaths.map(async (logicalPath) => {
      const file = await resolvePlanningPath(project, logicalPath, {
        require: 'file',
        maxBytes: 1_048_576,
      });
      return {
        path: logicalPath,
        hash: sha256Hex(await readFile(file.absolutePath, 'utf8')),
      };
    }),
  );
  return semanticResultHash({ source: value, contents });
}
