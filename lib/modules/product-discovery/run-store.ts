import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PublicApiError } from '../../api-errors.ts';
import {
  writeRunEvidence,
  type RunActivityEntry,
} from '../../graph/run-evidence.ts';
import { stageCandidateDocuments } from '../../graph/proposal/stage.ts';
import type { IdentifiedProposalRun } from '../../graph/proposal/pending.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import { renderLegacyCandidateMarkdown } from './acceptance.ts';
import { PRODUCT_EXPLORATION_GRAPH_ROOT } from './assembly.ts';
import type { WhatsNextHarnessResult } from './harness-result.ts';
import {
  renderWhatsNextResponseMarkdown,
  renderWhatsNextSummaryMarkdown,
} from './response.ts';

export const PRODUCT_EXPLORATION_RUN_ID = /^RUN-[0-9a-f-]{36}$/i;

export type StoredProductExplorationRun = Omit<
  IdentifiedProposalRun,
  'result'
> & {
  result?: WhatsNextHarnessResult | null;
  updatedAt?: string;
  activity?: RunActivityEntry[];
  revisionOf?: string;
  intention?: string;
  motion?: string;
  input?: { intention?: string; motion?: string } | null;
};

export function validateProductExplorationRunId(runId: string) {
  if (!PRODUCT_EXPLORATION_RUN_ID.test(runId))
    throw new PublicApiError("The What's next Run identifier is invalid.", 400);
}

export function productExplorationRunPath(
  project: RegisteredProject,
  runId: string,
) {
  validateProductExplorationRunId(runId);
  return path.join(
    project.planningPath,
    PRODUCT_EXPLORATION_GRAPH_ROOT,
    'runs',
    runId,
  );
}

export function normalizeProductExplorationRun(
  record: StoredProductExplorationRun,
) {
  if (record.operation === 'revise-candidate')
    record.operation = 'refine-candidate';
  record.operation ??= record.revisionOf ? 'refine-candidate' : 'explore';
  record.activity ??= [];
  record.intention ??= 'mvp-exploration';
  record.motion ??= 'diverge';
  if (record.input) {
    record.input.intention ??= record.intention;
    record.input.motion ??= record.motion;
  }
  const result = record.result as
    | (WhatsNextHarnessResult & {
        reflection?: WhatsNextHarnessResult['reflection'];
      })
    | null
    | undefined;
  if (result && !result.reflection) {
    result.reflection = {
      markdown: result.exploration?.notes?.length
        ? `# Reflection\n\n${result.exploration.notes.join('\n\n')}`
        : '# Reflection\n\nThis Run did not record a Reflection.',
      continuationAdvice: {
        action: 'continue',
        recommendedFocus: 'expand',
        reason: 'This legacy Run predates explicit continuation advice.',
      },
    };
  }
  if (result?.reflection.continuationAdvice)
    result.reflection.continuationAdvice.recommendedFocus ??= 'expand';
  return record;
}

export async function writeProductExplorationRunRecord(
  project: RegisteredProject,
  record: StoredProductExplorationRun,
) {
  const runPath = productExplorationRunPath(project, record.runId);
  await mkdir(runPath, { recursive: true });
  const filePath = path.join(runPath, 'run.json');
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}

export async function ensureProductExplorationRunArtifacts(
  project: RegisteredProject,
  record: StoredProductExplorationRun,
) {
  if (!record.result) return;
  const result = record.result;
  const runPath = productExplorationRunPath(project, record.runId);
  await writeRunEvidence(runPath, {
    activity: record.activity ?? [],
    summary: renderWhatsNextSummaryMarkdown(result),
    response: renderWhatsNextResponseMarkdown(result),
  });
  const reflectionPath = path.join(runPath, 'reflection.md');
  if (
    !(await access(reflectionPath)
      .then(() => true)
      .catch(() => false))
  ) {
    await writeFile(reflectionPath, `${result.reflection.markdown.trim()}\n`, {
      flag: 'wx',
    });
  }
  const responsePath = path.join(runPath, 'response.md');
  const responseMarkdown = renderWhatsNextResponseMarkdown(result);
  const existingResponse = await readFile(responsePath, 'utf8').catch(() => '');
  if (existingResponse !== responseMarkdown) {
    const temporaryResponsePath = `${responsePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryResponsePath, responseMarkdown, { flag: 'wx' });
    await rename(temporaryResponsePath, responsePath);
  }
  if (result.outcome !== 'proposal') return;
  await stageCandidateDocuments(
    runPath,
    result.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      markdown:
        candidate.outputMarkdown ?? renderLegacyCandidateMarkdown(candidate),
    })),
  );
}
