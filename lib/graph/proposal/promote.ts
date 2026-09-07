import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CANDIDATE_ALIAS_PATTERN } from '../identity.ts';
import { reserveNodeIdentity, type Scope } from '../identity-store.ts';
import {
  listCanvasNodesWithinCanvas,
  mutateCanvas,
  type TaskGraphNode,
} from '../task/nodes.ts';
import { resolveCandidateDependencies } from './dependencies.ts';
import type { GraphCandidateRecord } from './contract.ts';
import type { RegisteredProject } from '../../project-registry.ts';

const RUN_ROOTS = {
  'whats-next': 'whats-next',
  'task-graph': 'task-decomposition',
} as const satisfies Record<Scope, string>;

const RUN_ID = /^RUN-[0-9a-f-]{36}$/;
const CANDIDATE_ID = new RegExp(CANDIDATE_ALIAS_PATTERN);

export type PromotedNodeExtension = Pick<
  TaskGraphNode,
  'layer' | 'artifactKind'
>;

export type PromoteCandidateInput = {
  scope: Scope;
  runId: string;
  candidate: GraphCandidateRecord;
  extension?: PromotedNodeExtension;
  provenanceFeature?: NonNullable<TaskGraphNode['provenance']>['feature'];
};

export async function promoteCandidateToNode(
  project: RegisteredProject,
  input: PromoteCandidateInput,
) {
  const { scope, runId, candidate } = input;
  if (!RUN_ID.test(runId)) throw new Error('The Run identifier is invalid.');
  if (!CANDIDATE_ID.test(candidate.candidateId))
    throw new Error('The Candidate identifier is invalid.');
  if (!candidate.uid) throw new Error('Candidate stable identity is missing.');
  return mutateCanvas(project, scope, async () => {
    const existingNodes = await listCanvasNodesWithinCanvas(project, scope);
    const promoted = existingNodes.find((node) => node.uid === candidate.uid);
    if (promoted)
      return { node: promoted, nodes: existingNodes, created: false };
    const resolvedDependencies = resolveCandidateDependencies(
      candidate.candidateId,
      candidate.dependsOn,
      existingNodes,
    );
    const { id: nodeId } = await reserveNodeIdentity(
      project.planningPath,
      scope,
      candidate.uid,
    );
    const nodesPath = path.join(project.planningPath, scope, 'nodes');
    const nodePath = path.join(nodesPath, nodeId);
    const temporaryPath = path.join(
      nodesPath,
      `.${nodeId}-${randomUUID()}.tmp`,
    );
    const candidateOutput = path.join(
      project.planningPath,
      RUN_ROOTS[scope],
      'runs',
      runId,
      'candidates',
      candidate.candidateId,
      'output.md',
    );
    await mkdir(temporaryPath, { recursive: true });

    try {
      await copyFile(candidateOutput, path.join(temporaryPath, 'output.md'));
      const timestamp = new Date().toISOString();
      const matchingType = existingNodes.find(
        (node) => node.type === candidate.type,
      );
      const node: TaskGraphNode = {
        schemaVersion: 1,
        id: nodeId,
        uid: candidate.uid,
        relations: candidate.relations,
        role: 'node',
        type: candidate.type,
        ...(input.extension && {
          layer: input.extension.layer,
          artifactKind: input.extension.artifactKind,
        }),
        title: candidate.title,
        summary: candidate.summary,
        status: 'accepted',
        createdAt: timestamp,
        updatedAt: timestamp,
        resources: [
          ...candidate.resources,
          { kind: 'output', path: `${scope}/nodes/${nodeId}/output.md` },
        ],
        derivedFrom: candidate.derivedFrom,
        dependsOn: resolvedDependencies,
        typeTemplateRef:
          candidate.typeTemplateRef ??
          matchingType?.typeTemplateRef ??
          matchingType?.id ??
          nodeId,
        metadata: candidate.metadata,
        presentation: candidate.presentation,
        provenance: {
          ...(input.provenanceFeature && {
            feature: input.provenanceFeature,
          }),
          runId,
          candidateId: candidate.candidateId,
          revision: candidate.revision,
        },
      };
      await writeFile(
        path.join(temporaryPath, 'node.json'),
        `${JSON.stringify(node, null, 2)}\n`,
        { flag: 'wx' },
      );
      await mkdir(nodesPath, { recursive: true });
      await rename(temporaryPath, nodePath);
      return {
        node,
        nodes: await listCanvasNodesWithinCanvas(project, scope),
        created: true,
      };
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }
  });
}
