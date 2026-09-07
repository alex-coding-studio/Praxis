import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PublicApiError } from '../../api-errors.ts';
import { reserveNodeIdentity } from '../../graph/identity-store.ts';
import {
  latestPendingCandidates,
  readIdentifiedProposalRun,
  readIdentifiedProposalRuns,
  candidateRevision,
  assertExpectedRevision,
  CandidateAcceptanceError,
  type AcceptCandidateOptions,
  type PendingCandidateProjection,
  type StoredCandidateDocument,
} from '../../graph/proposal/pending.ts';
import {
  revisionRunInProgress,
  withModuleMutation,
} from '../../graph/proposal/module-runtime.ts';
import { resolveCandidateDependencies } from '../../graph/proposal/dependencies.ts';
import {
  listTaskGraphNodes,
  type TaskGraphNode,
} from '../../graph/task/nodes.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import {
  collectAcceptedCandidateIds,
  scopeDecompositionRunsDirectory,
  SCOPE_DECOMPOSITION_GRAPH_ROOT,
  SCOPE_DECOMPOSITION_RUNS_ROOT,
} from './assembly.ts';

const MUTATION_KEY = 'taskDecompositionMutations' as const;
const RUN_REGISTRY_KEY = '__praxisRuns' as const;

function validateRunId(runId: string) {
  if (!/^RUN-[0-9a-f-]{36}$/i.test(runId))
    throw new PublicApiError('The Agent Run identifier is invalid.', 400);
}

async function readProposalRuns(project: RegisteredProject) {
  return readIdentifiedProposalRuns(
    project.planningPath,
    SCOPE_DECOMPOSITION_GRAPH_ROOT,
    scopeDecompositionRunsDirectory(project),
  );
}

function acceptanceEligibility(candidate: StoredCandidateDocument) {
  if (!candidate.uid)
    return {
      acceptable: false,
      reason: 'This Candidate has no stable identity yet.',
    };
  if (revisionRunInProgress(RUN_REGISTRY_KEY, candidate.candidateId!))
    return {
      acceptable: false,
      reason: 'A Candidate revision Run is still active.',
    };
  return { acceptable: true, reason: null };
}

export async function listPendingScopeDecompositionCandidates(
  project: RegisteredProject,
): Promise<PendingCandidateProjection[]> {
  const accepted = new Set(await collectAcceptedCandidateIds(project));
  return latestPendingCandidates(await readProposalRuns(project), accepted, {
    recomposition: true,
  }).map(({ runId, candidate }) => ({
    runId,
    candidateId: candidate.candidateId!,
    revision: candidateRevision(candidate),
    uid: candidate.uid ?? null,
    type: candidate.type ?? '',
    title: candidate.title ?? '',
    summary: candidate.summary ?? '',
    layer: null,
    artifactKind: null,
    derivedFrom: candidate.derivedFrom ?? [],
    dependsOn: candidate.dependsOn ?? [],
    acceptance: acceptanceEligibility(candidate),
  }));
}

export async function acceptScopeDecompositionCandidate(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
  options: AcceptCandidateOptions = {},
) {
  return withModuleMutation(MUTATION_KEY, project.planningPath, () =>
    acceptScopeDecompositionCandidateUnlocked(
      project,
      runId,
      candidateId,
      options,
    ),
  );
}

async function acceptScopeDecompositionCandidateUnlocked(
  project: RegisteredProject,
  runId: string,
  candidateId: string,
  options: AcceptCandidateOptions,
) {
  if (revisionRunInProgress(RUN_REGISTRY_KEY, candidateId))
    throw new CandidateAcceptanceError(
      'active-revision',
      'Wait for the active Candidate revision to finish.',
      400,
    );
  validateRunId(runId);
  const run = await readIdentifiedProposalRun(
    project.planningPath,
    SCOPE_DECOMPOSITION_GRAPH_ROOT,
    scopeDecompositionRunsDirectory(project),
    runId,
  );
  if (!run || run.result?.outcome !== 'proposal')
    throw new CandidateAcceptanceError(
      'proposal-unavailable',
      'The Candidate proposal is unavailable.',
      400,
    );
  const candidate = (run.result.candidates ?? []).find(
    (value) => value.candidateId === candidateId,
  );
  if (!candidate)
    throw new CandidateAcceptanceError(
      'candidate-not-found',
      'The Candidate could not be found.',
      400,
    );
  assertExpectedRevision(candidate, options.expectedRevision);

  const existingNodes = await listTaskGraphNodes(project);
  const accepted = existingNodes.find((node) => node.uid === candidate.uid);
  if (accepted) return { node: accepted, nodes: existingNodes, created: false };
  const acceptedIds = new Set(await collectAcceptedCandidateIds(project));
  if (
    !latestPendingCandidates(await readProposalRuns(project), acceptedIds, {
      recomposition: true,
    }).some((item) => item.candidate.candidateId === candidateId)
  )
    throw new CandidateAcceptanceError(
      'replaced-by-recompose',
      'This Candidate was replaced or removed by Recompose.',
      409,
    );
  const resolvedDependencies = resolveCandidateDependencies(
    candidate.candidateId!,
    candidate.dependsOn ?? [],
    existingNodes,
  );

  if (!candidate.uid) throw new Error('Candidate stable identity is missing.');
  const { id: nodeId } = await reserveNodeIdentity(
    project.planningPath,
    SCOPE_DECOMPOSITION_GRAPH_ROOT,
    candidate.uid,
  );
  const nodesPath = path.join(
    project.planningPath,
    SCOPE_DECOMPOSITION_GRAPH_ROOT,
    'nodes',
  );
  const nodePath = path.join(nodesPath, nodeId);
  const temporaryPath = path.join(nodesPath, `.${nodeId}-${randomUUID()}.tmp`);
  const candidateOutput = path.join(
    project.planningPath,
    SCOPE_DECOMPOSITION_RUNS_ROOT,
    'runs',
    runId,
    'candidates',
    candidateId,
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
      relations: candidate.relations!,
      role: 'node',
      type: candidate.type!,
      title: candidate.title!,
      summary: candidate.summary!,
      status: 'accepted',
      createdAt: timestamp,
      updatedAt: timestamp,
      resources: [
        ...(candidate.resources ?? []),
        {
          kind: 'output',
          path: `${SCOPE_DECOMPOSITION_GRAPH_ROOT}/nodes/${nodeId}/output.md`,
        },
      ],
      derivedFrom: candidate.derivedFrom!,
      dependsOn: resolvedDependencies,
      typeTemplateRef:
        candidate.typeTemplateRef ??
        matchingType?.typeTemplateRef ??
        matchingType?.id ??
        nodeId,
      metadata: candidate.metadata!,
      presentation: candidate.presentation!,
      provenance: {
        runId,
        candidateId,
        revision: candidateRevision(candidate),
      },
    };
    await writeFile(
      path.join(temporaryPath, 'node.json'),
      `${JSON.stringify(node, null, 2)}\n`,
      { flag: 'wx' },
    );
    await mkdir(nodesPath, { recursive: true });
    await rename(temporaryPath, nodePath);
    return { node, nodes: await listTaskGraphNodes(project), created: true };
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}
