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
import type { MaterializationReceipt } from '../../materialization/receipt.ts';
import { domainModelDirectory } from './storage.ts';
import type { DomainModelBasis } from './basis.ts';
import {
  DOMAIN_MODEL_RESULT_CONTRACT,
  type DomainModelResult,
} from './contract.ts';
import { composeDomainModel } from './materializer.ts';
import {
  applyProposedDomainModel,
  type DomainChange,
  type ProposedDomainModel,
} from './model.ts';
import type { RegisteredProject } from '../../project-registry.ts';

export type DomainModelPublicationOutcome =
  | 'model-change'
  | 'no-change'
  | 'clarification';

type PublishedDomainModelBase = {
  summary: string;
  change: DomainChange | null;
  stateVersion: number;
};

export type PublishedDomainModel = PublishedDomainModelBase &
  (
    | { outcome: 'model-change'; model: ProposedDomainModel }
    | { outcome: 'no-change' | 'clarification'; model: null }
  ) & { receipt: MaterializationReceipt };

export const DOMAIN_MODEL_UNCHANGED_REASON =
  'The current Domain Model already represents this request.';

async function recordReceipt(
  project: RegisteredProject,
  runId: string,
  receipt: MaterializationReceipt,
  log: MaterializationLog,
) {
  await (async () => {
    const directory = await domainModelDirectory(
      project,
      ['runs', runId],
      true,
    );
    await writeFileAtomically(
      path.join(directory, 'materialization.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  })().catch((error: unknown) =>
    log(
      materializationLogEntry(
        'materialization.publication.failed',
        `publication: the Receipt was not recorded: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
      ),
    ),
  );
}

export async function publishDomainModelResult(
  project: RegisteredProject,
  basis: DomainModelBasis,
  result: DomainModelResult,
  producer: {
    kind?: 'agent-run' | 'direct';
    runId: string;
    userInputPath: string | null;
    harness?: { id: string; revision: number };
  },
  now: () => string = () => new Date().toISOString(),
  log: MaterializationLog = () => undefined,
): Promise<PublishedDomainModel> {
  const resultHash = semanticResultHash(result);
  const identity = receiptIdentity(DOMAIN_MODEL_RESULT_CONTRACT, {
    kind: producer.kind ?? 'agent-run',
    runId: producer.runId,
    ...(producer.harness && { harness: producer.harness }),
  });
  const guard = materializationGuard({
    log,
    identity,
    basis: { fingerprint: basis.fingerprint, preparedAt: basis.preparedAt },
    semanticResultHash: resultHash,
    onReject: (receipt) => recordReceipt(project, producer.runId, receipt, log),
  });
  await (async () => {
    const directory = await domainModelDirectory(
      project,
      ['runs', producer.runId],
      true,
    );
    await writeFileAtomically(
      path.join(directory, 'semantic-result.json'),
      semanticResultDocument(identity, resultHash, result),
    );
  })().catch((error: unknown) =>
    log(
      materializationLogEntry(
        'materialization.publication.failed',
        `publication: the semantic result was not recorded: ${error instanceof Error ? error.message : String(error)}`,
        'ERROR',
      ),
    ),
  );
  const receiptOf = (
    outcome: MaterializationReceipt['outcome'],
    change: DomainChange | null,
    stateVersion: number,
  ): MaterializationReceipt => ({
    schemaVersion: 1,
    ...identity,
    basis: { fingerprint: basis.fingerprint, preparedAt: basis.preparedAt },
    semanticResultHash: resultHash,
    outcome,
    affected: {
      ...NO_AFFECTED_IDENTITIES,
      domainIds: change
        ? [...change.added, ...change.updated, ...change.removed]
        : [],
    },
    publication: change
      ? { target: 'domain-state', at: now(), revision: stateVersion }
      : null,
    failure: null,
  });
  const validated = () =>
    log(
      materializationLogEntry(
        'materialization.validated',
        `The ${result.outcome} result satisfies ${DOMAIN_MODEL_RESULT_CONTRACT.id} v${DOMAIN_MODEL_RESULT_CONTRACT.version}.`,
      ),
    );
  if (result.outcome !== 'model-change') {
    validated();
    const receipt = receiptOf(result.outcome, null, basis.stateVersion);
    await recordReceipt(project, producer.runId, receipt, log);
    log(
      materializationLogEntry(
        'materialization.published',
        `Published the ${receipt.outcome} outcome without a Domain Model change.`,
      ),
    );
    return {
      outcome: result.outcome,
      summary: result.summary,
      model: null,
      change: null,
      stateVersion: basis.stateVersion,
      receipt,
    };
  }
  const model = await guard('validation', async () =>
    composeDomainModel(basis.model, result),
  );
  validated();
  const applied = await guard('publication', () =>
    applyProposedDomainModel(project, {
      baseVersion: basis.stateVersion,
      runId: producer.runId,
      userInputPath: producer.userInputPath,
      summary: result.summary,
      proposed: model,
    }),
  );
  const receipt = receiptOf(
    applied.change ? 'canonical' : 'no-change',
    applied.change,
    applied.model.stateVersion,
  );
  await recordReceipt(project, producer.runId, receipt, log);
  log(
    materializationLogEntry(
      'materialization.published',
      applied.change
        ? `Published Domain Model state version ${applied.model.stateVersion}.`
        : 'Published the no-change outcome without a Domain Model change.',
    ),
  );
  return applied.change
    ? {
        outcome: 'model-change',
        summary: result.summary,
        model,
        change: applied.change,
        stateVersion: applied.model.stateVersion,
        receipt,
      }
    : {
        outcome: 'no-change',
        summary: result.summary,
        model: null,
        change: null,
        stateVersion: applied.model.stateVersion,
        receipt,
      };
}
