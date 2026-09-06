import { PublicApiError } from '../../api-errors.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import { claimDeliveryTarget } from './ownership.ts';
import { readDeliveryRecord, updateDeliveryRecord } from './storage.ts';
import { deliveryEvidenceReady } from './record.ts';
import { deliveryGit, latestDeliveryMain } from './workspace.ts';
import { assertCurrentDeliverySource } from './sources.ts';

export async function recognizeExistingDelivery(
  project: RegisteredProject,
  uid: string,
  reason: string,
) {
  const record = await readDeliveryRecord(project, uid);
  if (!record?.workspace)
    throw new PublicApiError(
      'Inspect the delivery workspace before recognizing existing work.',
    );
  if (!reason.trim())
    throw new PublicApiError('Explain how current main satisfies this target.');
  const head = await latestDeliveryMain(project);
  if (
    (await deliveryGit(record.workspace.path, 'rev-parse', 'HEAD')) !== head ||
    (await deliveryGit(
      record.workspace.path,
      'status',
      '--porcelain',
      '--untracked-files=all',
    ))
  )
    throw new PublicApiError(
      'The candidate differs from current main. Publish its changes through the normal PR path.',
    );
  if (!deliveryEvidenceReady(record, head))
    throw new PublicApiError(
      'Record current-main checks and a review decision before submitting existing delivery.',
    );
  await updateDeliveryRecord(project, uid, (current) => {
    current.existingDelivery = { head, reason };
  });
  return {
    head,
    reason,
    next: 'Wait for the user to confirm existing delivery.',
  };
}

export async function acceptExistingDelivery(
  project: RegisteredProject,
  uid: string,
  expectedRevision: number,
) {
  const release = claimDeliveryTarget(project, uid);
  try {
    const record = await readDeliveryRecord(project, uid);
    if (
      !record ||
      record.revision !== expectedRevision ||
      !record.existingDelivery
    )
      throw new PublicApiError('Refresh the proposed existing delivery.', 409);
    await assertCurrentDeliverySource(project, record);
    const head = await latestDeliveryMain(project);
    if (
      record.existingDelivery.head !== head ||
      !deliveryEvidenceReady(record, head)
    )
      throw new PublicApiError(
        'Main or the delivery requirements changed. Refresh the evidence.',
        409,
      );
    return updateDeliveryRecord(
      project,
      uid,
      (current) => {
        current.acceptedHead = head;
        current.status = 'completed';
        current.response = {
          status: 'completed',
          title: 'Existing delivery accepted',
          detail: current.existingDelivery!.reason,
        };
      },
      expectedRevision,
    );
  } finally {
    release();
  }
}
