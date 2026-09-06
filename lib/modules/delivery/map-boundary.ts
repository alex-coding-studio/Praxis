import type { RegisteredProject } from '../../project-registry.ts';
import type { WhatToDoDeliveryMap } from '../delivery-planning/map.ts';
import { PublicApiError } from '../../api-errors.ts';
import { listDeliveryRecords } from './storage.ts';
import { fingerprint } from './sources.ts';

export async function assertDeliveryMapPreservesTargets(
  project: RegisteredProject,
  map: WhatToDoDeliveryMap,
) {
  const records = await listDeliveryRecords(project);
  for (const record of records) {
    if (
      record.source.sourceKind !== 'delivery-contract' ||
      (!record.brief?.confirmedAt &&
        !record.workspace &&
        record.status !== 'briefing')
    )
      continue;
    const contract = map.contracts.find(
      (entry) => entry.uid === record.sourceUid,
    );
    if (
      !contract ||
      (await fingerprint(project, contract, [contract.outputPath])) !==
        record.sourceFingerprint
    )
      throw new PublicApiError(
        `The delivery map changes an active or completed target: ${record.source.title}. Resolve its delivery scope first.`,
        409,
      );
  }
}
