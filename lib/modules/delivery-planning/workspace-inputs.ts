import type { ContextWorkspaceInput } from '../../graph/agent/workspace-input.ts';
import { PublicApiError } from '../../api-errors.ts';
import { readTaskGraphNodesSnapshot } from '../../graph/task/nodes.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import {
  isWhatToDoFeatureNode,
  materializeFeature,
  type WhatToDoFeatureSource,
} from './sources.ts';

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
