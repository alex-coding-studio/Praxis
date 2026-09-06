import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { RegisteredProject } from '../../project-registry.ts';
import { writeFileAtomically } from '../../atomic-json-store.ts';
import { deliveryDirectory } from './storage.ts';
import type { DeliveryRecord } from './record.ts';

import { renderDeliveryBrief, renderDeliveryOutput } from './documents.ts';

export async function ensureDeliveryArtifacts(
  project: RegisteredProject,
  record: DeliveryRecord,
) {
  const directory = await deliveryDirectory(project, record.sourceUid);
  const outputs: Array<{ kind: 'brief' | 'output'; markdown: string }> = [];
  if (record.brief?.confirmedAt)
    outputs.push({ kind: 'brief', markdown: renderDeliveryBrief(record) });
  if (record.status === 'completed')
    outputs.push({ kind: 'output', markdown: renderDeliveryOutput(record) });
  for (const output of outputs) {
    const file = path.join(directory, `${output.kind}.md`);
    const previous = await readFile(file, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (previous !== output.markdown)
      await writeFileAtomically(file, output.markdown);
  }
  return outputs.map((output) => ({
    kind: output.kind,
    path: `delivery/targets/${record.sourceUid}/${output.kind}.md`,
  }));
}
