import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PublicApiError } from '../../api-errors.ts';
import type { IdentifiedProposalRun } from '../../graph/proposal/pending.ts';
import {
  writeRunEvidence,
  type RunActivityEntry,
} from '../../graph/run-evidence.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import { SCOPE_DECOMPOSITION_RUNS_ROOT } from './assembly.ts';
import type { TaskDecompositionHarnessResult } from './harness-result.ts';
import { taskDecompositionIntentionRegistry } from './intention.ts';
import {
  renderTaskDecompositionResponseMarkdown,
  renderTaskDecompositionSummaryMarkdown,
} from './response.ts';

const RUN_ID = /^RUN-[0-9a-f-]{36}$/i;

export type StoredScopeDecompositionRun = Omit<
  IdentifiedProposalRun,
  'result'
> & {
  result?: TaskDecompositionHarnessResult | null;
  updatedAt?: string;
  activity?: RunActivityEntry[];
  revisionOf?: string;
  sourceNodeId?: string;
  intention?: string;
  motion?: string;
};

export function validateScopeDecompositionRunId(runId: string) {
  if (!RUN_ID.test(runId))
    throw new PublicApiError('The Agent Run identifier is invalid.', 400);
}

export function scopeDecompositionRunPath(
  project: RegisteredProject,
  runId: string,
) {
  validateScopeDecompositionRunId(runId);
  return path.join(
    project.planningPath,
    SCOPE_DECOMPOSITION_RUNS_ROOT,
    'runs',
    runId,
  );
}

export function normalizeScopeDecompositionRun(
  record: StoredScopeDecompositionRun,
) {
  record.operation ??= record.revisionOf ? 'revise-candidate' : 'propose';
  record.intention ??= taskDecompositionIntentionRegistry.defaultId;
  record.motion ??= 'unspecified';
  record.activity ??= [];
  return record;
}

export async function writeScopeDecompositionRunRecord(
  project: RegisteredProject,
  record: StoredScopeDecompositionRun,
) {
  const runPath = scopeDecompositionRunPath(project, record.runId);
  await mkdir(runPath, { recursive: true });
  const filePath = path.join(runPath, 'run.json');
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}

export function renderScopeDecompositionCandidateMarkdown(
  candidate: Extract<
    TaskDecompositionHarnessResult,
    { outcome: 'proposal' }
  >['candidates'][number],
) {
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

export async function ensureScopeDecompositionRunArtifacts(
  project: RegisteredProject,
  record: StoredScopeDecompositionRun,
) {
  if (!record.result) return;
  const result = record.result;
  const runPath = scopeDecompositionRunPath(project, record.runId);
  await writeRunEvidence(runPath, {
    activity: record.activity ?? [],
    summary: renderTaskDecompositionSummaryMarkdown(result),
    response: renderTaskDecompositionResponseMarkdown(result),
  });
  if (result.outcome !== 'proposal') return;
  await Promise.all(
    result.candidates.map(async (candidate) => {
      const candidatePath = path.join(
        runPath,
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
      await writeFile(
        outputPath,
        renderScopeDecompositionCandidateMarkdown(candidate),
        { flag: 'wx' },
      );
    }),
  );
}
