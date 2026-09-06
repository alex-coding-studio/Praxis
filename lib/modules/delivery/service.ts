import { PublicApiError } from '../../api-errors.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import { projectDeliveryTargets } from './projection.ts';
import { readDeliverySources } from './sources.ts';
import {
  createDeliveryRecord,
  listDeliveryRecords,
  readDeliveryInstructions,
  readDeliveryRecord,
  updateDeliveryRecord,
  readDeliveryModels,
} from './storage.ts';
import { validateDeliveryModels } from './models.ts';
import { startDeliveryRun } from './runtime.ts';
import type { DeliveryModels } from './types.ts';

export async function readDeliveryWorkspace(project: RegisteredProject) {
  const [{ sources, contextUids }, records, instructions] = await Promise.all([
    readDeliverySources(project),
    listDeliveryRecords(project),
    readDeliveryInstructions(project),
  ]);
  return {
    models: await readDeliveryModels(project),
    targets: projectDeliveryTargets(sources, records, contextUids),
    records,
    instructions,
  };
}

export async function prepareTarget(
  project: RegisteredProject,
  uid: string,
  models: DeliveryModels,
) {
  validateDeliveryModels(models);
  const { targets } = await readDeliveryWorkspace(project);
  const target = targets.find((entry) => entry.sourceUid === uid);
  if (!target)
    throw new PublicApiError('Executable source no longer exists.', 404);
  return createDeliveryRecord(project, target, models);
}

export async function confirmDeliveryBrief(
  project: RegisteredProject,
  uid: string,
  expectedRevision: number,
) {
  const { targets } = await readDeliveryWorkspace(project);
  const source = targets.find((target) => target.sourceUid === uid);
  if (!source)
    throw new PublicApiError('Executable source no longer exists.', 404);
  return updateDeliveryRecord(
    project,
    uid,
    (record) => {
      if (record.runs.at(-1)?.status === 'running')
        throw new PublicApiError('Wait for the current response.', 409);
      if (!record.brief || record.brief.openDecisions.length)
        throw new PublicApiError(
          'Resolve the delivery brief decisions before confirming.',
        );
      if (record.sourceFingerprint !== source.sourceFingerprint)
        throw new PublicApiError(
          'The source changed. Refresh the delivery brief.',
          409,
        );
      record.brief.confirmedAt = new Date().toISOString();
      record.status = 'ready-to-run';
    },
    expectedRevision,
  );
}

export async function submitDeliveryInput(
  project: RegisteredProject,
  uid: string,
  input: string,
  expectedRevision: number,
) {
  const current = await readDeliveryRecord(project, uid);
  if (!current || current.revision !== expectedRevision)
    throw new PublicApiError(
      'Delivery changed. Refresh before continuing.',
      409,
    );
  const { targets } = await readDeliveryWorkspace(project);
  const target = targets.find((entry) => entry.sourceUid === uid);
  if (!target)
    throw new PublicApiError('Executable source no longer exists.', 404);
  if (current.brief?.confirmedAt && target.unmetDependencies.length)
    throw new PublicApiError(
      'This delivery is waiting for prerequisites.',
      409,
    );
  if (target.sourceChanged) {
    await updateDeliveryRecord(
      project,
      uid,
      (record) => {
        record.source = target;
        record.sourceFingerprint = target.sourceFingerprint;
        if (record.brief) record.brief.confirmedAt = null;
      },
      expectedRevision,
    );
  }
  const kind =
    !current.brief?.confirmedAt || target.sourceChanged
      ? 'brief'
      : current.workspace
        ? 'feedback'
        : 'execution';
  return startDeliveryRun(project, uid, kind, input);
}
