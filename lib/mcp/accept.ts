import { CandidateAcceptanceError } from '../graph/proposal/pending.ts';
import { PublicApiError } from '../api-errors.ts';
import type { TaskGraphNode } from '../graph/task/nodes.ts';
import { acceptProductExplorationCandidate } from '../modules/product-discovery/acceptance.ts';
import { acceptScopeDecompositionCandidate } from '../modules/scope-decomposition/acceptance.ts';
import { encodeArtifactId } from './artifacts.ts';
import {
  activeRunConflict,
  invalidArgument,
  resourceChanged,
  resourceNotFound,
  publicationFailed,
} from './errors.ts';
import { requireProject } from './catalog.ts';
import { artifactUri, moduleUri } from './uri.ts';
import type { RegisteredProject } from '../project-registry.ts';

export const ACCEPTANCE_MODULES = [
  'product-exploration',
  'scope-decomposition',
] as const;

export type AcceptanceModule = (typeof ACCEPTANCE_MODULES)[number];

const ACCEPT = {
  'product-exploration': acceptProductExplorationCandidate,
  'scope-decomposition': acceptScopeDecompositionCandidate,
} as const;

export function candidateOperationFailure(error: unknown, unchanged: string) {
  if (error instanceof CandidateAcceptanceError) {
    if (error.reason === 'active-revision')
      return activeRunConflict(error.message);
    if (
      error.reason === 'stale-revision' ||
      error.reason === 'replaced-by-recompose'
    )
      return resourceChanged(`${error.message} ${unchanged}`);
    if (
      error.reason === 'no-stable-identity' ||
      error.reason === 'already-accepted' ||
      error.reason === 'dependency-blocked' ||
      error.reason === 'recompose-output'
    )
      return publicationFailed(`${error.message} ${unchanged}`);
    return resourceNotFound(error.message);
  }
  if (error instanceof PublicApiError) return invalidArgument(error.message);
  return error;
}

function acceptanceFailure(error: unknown) {
  return candidateOperationFailure(
    error,
    'The Candidate was not accepted and the graph is unchanged.',
  );
}

function nodeProjection(project: RegisteredProject, node: TaskGraphNode) {
  return {
    id: node.id,
    uid: node.uid,
    role: node.role,
    type: node.type,
    title: node.title,
    status: node.status,
    layer: node.layer ?? null,
    artifactKind: node.artifactKind ?? null,
    derivedFrom: node.derivedFrom ?? [],
    dependsOn: node.dependsOn,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    provenance: node.provenance ?? null,
    artifacts: node.resources.map((resource) => ({
      kind: resource.kind,
      relativePath: resource.path,
      uri: artifactUri(project.id, encodeArtifactId(resource.path)),
    })),
  };
}

export async function acceptCandidate(input: {
  projectId: string;
  module: AcceptanceModule;
  runId: string;
  candidateId: string;
  expectedRevision: number;
}) {
  const project = await requireProject(input.projectId);
  let outcome;
  try {
    outcome = await ACCEPT[input.module](
      project,
      input.runId,
      input.candidateId,
      {
        expectedRevision: input.expectedRevision,
      },
    );
  } catch (error) {
    throw acceptanceFailure(error);
  }
  return {
    projectId: project.id,
    module: input.module,
    runId: input.runId,
    candidateId: input.candidateId,
    expectedRevision: input.expectedRevision,
    created: outcome.created,
    node: nodeProjection(project, outcome.node),
    moduleUri: moduleUri(project.id, input.module),
  };
}
