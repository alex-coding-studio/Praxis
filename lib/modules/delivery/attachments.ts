import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RegisteredProject } from '../../project-registry.ts';
import { PublicApiError } from '../../api-errors.ts';
import { deliveryDirectory } from './storage.ts';

export type DeliveryAttachment = { name: string; base64: string };

export async function saveDeliveryAttachments(
  project: RegisteredProject,
  uid: string,
  files: DeliveryAttachment[],
) {
  if (!Array.isArray(files) || files.length > 10)
    throw new PublicApiError('Attach up to ten files.');
  const prepared = files.map((file) => {
    if (typeof file.name !== 'string' || typeof file.base64 !== 'string')
      throw new PublicApiError('Invalid attachment.');
    const name = path.basename(file.name).replace(/[^\p{L}\p{N}._ -]/gu, '_');
    if (!/\.(png|jpe?g|webp|gif|pdf|md|markdown|txt|html?)$/i.test(name))
      throw new PublicApiError(
        'Use an image, PDF, Markdown, text or HTML attachment.',
      );
    return { name, bytes: Buffer.from(file.base64, 'base64') };
  });
  if (
    prepared.reduce((size, file) => size + file.bytes.length, 0) >
    15 * 1024 * 1024
  )
    throw new PublicApiError('Attachments exceed 15 MB.');
  if (!prepared.length) return [];
  const directory = path.join(
    await deliveryDirectory(project, uid, true),
    'attachments',
    randomUUID(),
  );
  await mkdir(directory, { recursive: true });
  await Promise.all(
    prepared.map(async (file, index) =>
      writeFile(path.join(directory, `${index}-${file.name}`), file.bytes, {
        flag: 'wx',
      }),
    ),
  );
  return prepared.map((file, index) => ({
    name: file.name,
    path: path.join(directory, `${index}-${file.name}`),
  }));
}
