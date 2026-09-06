import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomically } from '../../atomic-json-store.ts';
import { semanticResultHash } from '../../materialization/hash.ts';
import { materializationLogEntry } from '../../materialization/log.ts';
import {
  materializationGuard,
  receiptIdentity,
  semanticResultDocument,
  NO_AFFECTED_IDENTITIES,
  type MaterializationLog,
} from '../../materialization/publication.ts';
import {
  MaterializationError,
  type MaterializationReceipt,
} from '../../materialization/receipt.ts';
import type { ScopeDecompositionMaterializationBasis } from './basis.ts';
import {
  SCOPE_DECOMPOSITION_RESULT_CONTRACT,
  type ScopeDecompositionCandidateRecord,
  type ScopeDecompositionResult,
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
  materialization?: MaterializationReceipt;
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

function receiptOutcome(
  outcome: ScopeDecompositionResult['outcome'],
): MaterializationReceipt['outcome'] {
  return outcome === 'proposal' ? 'candidates' : outcome;
}

async function publish<T extends ScopeDecompositionPublicationRecord>(
  basis: ScopeDecompositionMaterializationBasis,
  result: ScopeDecompositionResult,
  base: T,
  resultBase: object,
  timestamp: string,
  producerKind: 'agent-run' | 'direct',
  log: MaterializationLog,
  harness?: { id: string; revision: number },
): Promise<PublishedScopeDecomposition<T>> {
  assertRunId(base.runId);
  const resultHash = semanticResultHash(result);
  const directory = runDirectory(basis, base.runId);
  const identity = receiptIdentity(SCOPE_DECOMPOSITION_RESULT_CONTRACT, {
    kind: producerKind,
    runId: base.runId,
    ...(harness && { harness }),
  });
  const guard = materializationGuard({
    log,
    identity,
    basis: { fingerprint: basis.fingerprint, preparedAt: basis.preparedAt },
    semanticResultHash: resultHash,
    ...(producerKind === 'direct' && {
      onReject: (receipt: MaterializationReceipt) =>
        writeFileAtomically(
          path.join(directory, 'run.json'),
          `${JSON.stringify(
            {
              ...base,
              status: 'failed',
              result: null,
              materialization: receipt,
              error: receipt.failure?.message ?? null,
              updatedAt: timestamp,
              endedAt: timestamp,
            },
            null,
            2,
          )}\n`,
        ),
    }),
  });
  await guard('publication', async () => {
    await mkdir(directory, { recursive: true });
    await writeFileAtomically(
      path.join(directory, 'semantic-result.json'),
      semanticResultDocument(identity, resultHash, result),
    );
  });
  const materialized = await guard('validation', () =>
    materializeScopeDecompositionResult(basis, result),
  );
  log(
    materializationLogEntry(
      'materialization.validated',
      `The ${result.outcome} result satisfies ${SCOPE_DECOMPOSITION_RESULT_CONTRACT.id} v${SCOPE_DECOMPOSITION_RESULT_CONTRACT.version}.`,
    ),
  );
  const candidates = materialized?.candidates ?? [];
  if (materialized) {
    if (materialized.candidateAliases)
      log(
        materializationLogEntry(
          'materialization.identities.allocated',
          `Allocated ${Object.keys(materialized.candidateAliases).length} Candidate identities.`,
        ),
      );
    await guard('staging', async () => {
      await mkdir(directory, { recursive: true });
      await stageCandidateMarkdown(directory, candidates);
    });
    log(
      materializationLogEntry(
        'materialization.staged',
        `Staged ${candidates.length} Candidate documents.`,
      ),
    );
  }
  const receipt: MaterializationReceipt = {
    schemaVersion: 1,
    ...identity,
    basis: { fingerprint: basis.fingerprint, preparedAt: basis.preparedAt },
    semanticResultHash: resultHash,
    outcome: receiptOutcome(result.outcome),
    affected: {
      ...NO_AFFECTED_IDENTITIES,
      candidateIds: candidates.map((candidate) => candidate.candidateId),
    },
    publication: { target: 'run-record', at: timestamp, revision: null },
    failure: null,
  };
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
    materialization: receipt,
    error: null,
    updatedAt: timestamp,
    endedAt: base.endedAt ?? timestamp,
  };
  await guard('publication', () =>
    writeFileAtomically(
      path.join(directory, 'run.json'),
      `${JSON.stringify(record, null, 2)}\n`,
    ),
  );
  log(
    materializationLogEntry(
      'materialization.published',
      `Published the ${receipt.outcome} outcome to the Run record.`,
    ),
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
  producer: {
    record: T;
    resultBase: object;
    harness?: { id: string; revision: number };
  },
  now: () => string = () => new Date().toISOString(),
  log: MaterializationLog = () => undefined,
) {
  return publish(
    basis,
    result,
    producer.record,
    producer.resultBase,
    now(),
    'agent-run',
    log,
    producer.harness,
  );
}

export async function submitScopeDecompositionResult(
  basis: ScopeDecompositionMaterializationBasis,
  result: ScopeDecompositionResult,
  submission: { runId?: string; sourceNodeId: string },
  now: () => string = () => new Date().toISOString(),
  log: MaterializationLog = () => undefined,
) {
  const timestamp = now();
  const base: ScopeDecompositionPublicationRecord = {
    schemaVersion: 1,
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
    activity: [],
    result: null,
    error: null,
  };
  return publish(basis, result, base, result, timestamp, 'direct', log);
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
