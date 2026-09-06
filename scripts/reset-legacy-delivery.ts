import { getProject } from '../lib/project-registry.ts';
import {
  previewLegacyDeliveryReset,
  resetLegacyDelivery,
} from '../lib/modules/delivery/reset.ts';

const id = process.argv
  .find((arg) => arg.startsWith('--project='))
  ?.slice('--project='.length);
if (!id)
  throw new Error(
    'Provide --project=<registered-project-id>; add --execute to perform the authorized reset.',
  );
const project = await getProject(id);
if (!project) throw new Error('Project not found.');
const result = process.argv.includes('--execute')
  ? await resetLegacyDelivery(project)
  : await previewLegacyDeliveryReset(project);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
