import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomically } from '../../atomic-json-store.ts';
import { MaterializationError } from '../../materialization/receipt.ts';
import type { ScopeDecompositionMaterializationBasis } from './basis.ts';
import type {
  ScopeDecompositionCandidateRecord,
  ScopeDecompositionResult,
} from './contract.ts';
import {
  materializeScopeDecompositionResult,
  type MaterializedRecomposeEffect,
} from './materializer.ts';

const RUN_ID = /^RUN-[0-9a-f-]{36}$/i;

export type ScopeDecompositionPublicationRecord = {
  schemaVersion: 1;
  runId: string;
  sourceNodeId: string;
  operation: string;
  recomposeCandidateIds?: string[];
  status: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  activity: unknown[];
  result: unknown;
  error: string | null;
};

export type PublishedScopeDecomposition<
  T extends ScopeDecompositionPublicationRecord,
> = {
  runId: string;
  outcome: ScopeDecompositionResult['outcome'];
  candidates: ScopeDecompositionCandidateRecord[];
  candidateAliases: Record<string, string> | null;
  effects: MaterializedRecomposeEffect[] | null;
  candidatePaths: Record<string, string>;
  record: T;
};

function assertRunId(runId: string) {
  if (!RUN_ID.test(runId))
    throw new MaterializationError(
      'publication',
      'The Run identifier is invalid.',
    );
  return runId;
}

function runDirectory(
  basis: ScopeDecompositionMaterializationBasis,
  runId: string,
) {
  return path.join(
    basis.project.planningPath,
    'task-decomposition',
    'runs',
    runId,
  );
}

async function stageCandidateMarkdown(
  directory: string,
  candidates: ScopeDecompositionCandidateRecord[],
) {
  await Promise.all(
    candidates.map(async (candidate) => {
      const candidatePath = path.join(
        directory,
        'candidates',
        candidate.candidateId,
      );
      const outputPath = path.join(candidatePath, 'output.md');
      if (
        await access(outputPath)
          .then(() => true)
          .catch(() => false)
      )
        return;
      await mkdir(candidatePath, { recursive: true });
      await writeFile(outputPath, renderCandidateMarkdown(candidate), {
        flag: 'wx',
      });
    }),
  );
}

async function publish<T extends ScopeDecompositionPublicationRecord>(
  basis: ScopeDecompositionMaterializationBasis,
  result: ScopeDecompositionResult,
  base: T,
  resultBase: object,
  timestamp: string,
): Promise<PublishedScopeDecomposition<T>> {
  assertRunId(base.runId);
  const materialized = await materializeScopeDecompositionResult(basis, result);
  const directory = runDirectory(basis, base.runId);
  const candidates = materialized?.candidates ?? [];
  if (materialized) {
    await mkdir(directory, { recursive: true });
    await stageCandidateMarkdown(directory, candidates);
  }
  const record: T = {
    ...base,
    status: result.outcome,
    result: materialized
      ? {
          ...resultBase,
          candidates,
          ...(materialized.candidateAliases && {
            candidateAliases: materialized.candidateAliases,
          }),
          ...(materialized.effects && {
            recomposition: { effects: materialized.effects },
          }),
        }
      : resultBase,
    error: null,
    updatedAt: timestamp,
    endedAt: base.endedAt ?? timestamp,
  };
  await mkdir(directory, { recursive: true });
  await writeFileAtomically(
    path.join(directory, 'run.json'),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return {
    runId: record.runId,
    outcome: result.outcome,
    candidates,
    candidateAliases: materialized?.candidateAliases ?? null,
    effects: materialized?.effects ?? null,
    candidatePaths: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.candidateId,
        path.posix.join(
          'task-decomposition',
          'runs',
          record.runId,
          'candidates',
          candidate.candidateId,
          'output.md',
        ),
      ]),
    ),
    record,
  };
}

export async function publishScopeDecompositionResult<
  T extends ScopeDecompositionPublicationRecord,
>(
  basis: ScopeDecompositionMaterializationBasis,
  result: ScopeDecompositionResult,
  producer: { record: T; resultBase: object },
  now: () => string = () => new Date().toISOString(),
) {
  return publish(basis, result, producer.record, producer.resultBase, now());
}

export async function submitScopeDecompositionResult(
  basis: ScopeDecompositionMaterializationBasis,
  result: ScopeDecompositionResult,
  submission: { runId?: string; sourceNodeId: string },
  now: () => string = () => new Date().toISOString(),
) {
  const timestamp = now();
  return publish(
    basis,
    result,
    {
      schemaVersion: 1 as const,
      runId: assertRunId(submission.runId ?? `RUN-${randomUUID()}`),
      sourceNodeId: submission.sourceNodeId,
      operation: basis.operation,
      ...(basis.recomposeCandidateIds.length && {
        recomposeCandidateIds: [...basis.recomposeCandidateIds],
      }),
      status: 'proposal',
      startedAt: timestamp,
      updatedAt: timestamp,
      endedAt: timestamp,
      activity: [] as unknown[],
      result: null as unknown,
      error: null as string | null,
    },
    result,
    timestamp,
  );
}

function renderCandidateMarkdown(candidate: ScopeDecompositionCandidateRecord) {
  const relationships = [
    `- Derived from: ${candidate.derivedFrom.join(', ')}`,
    `- Depends on: ${candidate.dependsOn.join(', ') || 'None'}`,
  ];
  const resources = candidate.resources.length
    ? candidate.resources.map(
        (resource) => `- \`${resource.path}\` (${resource.kind})`,
      )
    : ['- None'];
  const assumptions = candidate.assumptions.length
    ? candidate.assumptions.map((assumption) => `- ${assumption}`)
    : ['- None'];
  const metadata = Object.keys(candidate.metadata).length
    ? `\n\`\`\`json\n${JSON.stringify(candidate.metadata, null, 2)}\n\`\`\``
    : '\nNone.';
  return `# ${candidate.title}

${candidate.summary}

## Candidate

- ID: \`${candidate.candidateId}\`
- Revision: ${candidate.revision}
- Type: ${candidate.type}

## Relationships

${relationships.join('\n')}

## Resources

${resources.join('\n')}

## Assumptions

${assumptions.join('\n')}

## Metadata
${metadata}
`;
}
