import { createHash } from 'node:crypto';
import type { ContextWorkspaceInput } from '../../graph/agent/context-workspace.ts';
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

export async function whatToDoFeatureWorkspaceInputs(
  project: RegisteredProject,
  sources: WhatToDoFeatureSource[],
): Promise<ContextWorkspaceInput[]> {
  return readTaskGraphNodesSnapshot(project, 'whats-next', async (nodes) => {
    const eligible = new Map(
      nodes
        .filter(isWhatToDoFeatureNode)
        .map((node) => [node.uid, node] as const),
    );
    return Promise.all(
      sources.map(async (source) => {
        const node = eligible.get(source.uid);
        if (!node)
          throw new PublicApiError(
            'A selected Product Design Feature is no longer available.',
            409,
          );
        const current = await materializeFeature(project, node);
        if (
          current.source.nodeId !== source.nodeId ||
          current.source.title !== source.title ||
          current.source.summary !== source.summary ||
          current.source.outputPath !== source.outputPath ||
          current.source.outputSha256 !== source.outputSha256
        )
          throw new PublicApiError(
            'A selected Product Design Feature changed. Reload before continuing.',
            409,
          );
        return {
          role: 'primary' as const,
          kind: 'product-design-feature',
          logicalPath: source.outputPath,
          content: current.content,
          nodeId: source.nodeId,
        };
      }),
    );
  });
}

async function materializeFeature(
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
