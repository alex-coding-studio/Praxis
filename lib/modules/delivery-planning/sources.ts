import { createHash } from 'node:crypto';
import { PublicApiError } from '../../api-errors.ts';
import { readPlanningFile } from '../../planning-documents.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import {
  readTaskGraphNodesSnapshot,
  type TaskGraphNode,
} from '../../graph/task/nodes.ts';

export type WhatToDoFeatureSource = {
  nodeId: string;
  uid: string;
  title: string;
  summary: string;
  outputPath: string;
  outputSha256: string;
};

export function isWhatToDoFeatureNode(node: TaskGraphNode) {
  return (
    node.role === 'node' &&
    node.status === 'accepted' &&
    node.layer === 'product-design' &&
    node.artifactKind === 'feature'
  );
}

export async function listWhatToDoFeatureSources(
  project: RegisteredProject,
): Promise<WhatToDoFeatureSource[]> {
  return readTaskGraphNodesSnapshot(project, 'whats-next', async (nodes) =>
    Promise.all(
      nodes
        .filter(isWhatToDoFeatureNode)
        .map(async (node) => (await materializeFeature(project, node)).source),
    ),
  );
}

export async function selectWhatToDoFeatureSources(
  project: RegisteredProject,
  sourceUids: string[],
) {
  const requested = [...new Set(sourceUids)];
  if (requested.length === 0)
    throw new PublicApiError(
      'Select at least one accepted Product Design Feature.',
      400,
    );
  if (requested.length > 20)
    throw new PublicApiError(
      'Select no more than 20 Product Design Features.',
      400,
    );

  const available = new Map(
    (await listWhatToDoFeatureSources(project)).map((source) => [
      source.uid,
      source,
    ]),
  );
  const selected = requested.map((uid) => available.get(uid));
  if (selected.some((source) => !source))
    throw new PublicApiError(
      'A selected Product Design Feature is no longer available.',
      409,
    );
  return selected as WhatToDoFeatureSource[];
}

export async function materializeFeature(
  project: RegisteredProject,
  node: TaskGraphNode,
) {
  if (!node.uid)
    throw new Error(
      `Product Design Feature ${node.id} has no stable identity.`,
    );
  const outputPath = `whats-next/nodes/${node.id}/output.md`;
  if (
    !node.resources.some(
      (resource) => resource.kind === 'output' && resource.path === outputPath,
    )
  )
    throw new Error(
      `Product Design Feature ${node.id} has no canonical output.`,
    );
  const content = await readPlanningFile(project, outputPath);
  return {
    source: {
      nodeId: node.id,
      uid: node.uid,
      title: node.title,
      summary: node.summary ?? '',
      outputPath,
      outputSha256: createHash('sha256').update(content).digest('hex'),
    },
    content,
  } satisfies { source: WhatToDoFeatureSource; content: string };
}
