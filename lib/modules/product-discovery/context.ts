import { PublicApiError } from '../../api-errors.ts';
import {
  assertInstructionsRevision,
  withInstructionsMutation,
  type SaveInstructionsOptions,
} from '../module-instructions.ts';
import {
  readFile,
  readdir,
  stat,
  lstat,
  realpath,
  mkdir,
  writeFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RegisteredProject } from '@/lib/project-registry';

export type WhatsNextAttachment = {
  fileName: string;
  path: string;
  format: 'markdown' | 'json';
  size: number;
};

export type WhatsNextContext = {
  instructions: string;
  attachments: WhatsNextAttachment[];
};

export async function readWhatsNextContext(
  project: RegisteredProject,
): Promise<WhatsNextContext> {
  const instructions = await readWhatsNextInstructions(project);
  return { instructions, attachments: await listAttachments(project) };
}

async function instructionsDirectory(
  project: RegisteredProject,
  create = false,
) {
  const directory = path.join(
    await realpath(project.planningPath),
    'whats-next',
  );
  if (create)
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Invalid What’s Next context directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return directory;
}

export async function readWhatsNextInstructions(project: RegisteredProject) {
  const file = path.join(
    await instructionsDirectory(project),
    'instructions.md',
  );
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 80_000)
      throw new Error('Invalid What’s Next instructions file.');
    const instructions = await readFile(file, 'utf8');
    if (instructions.length > 20_000)
      throw new PublicApiError('Instructions exceed 20000 characters.', 400);
    return instructions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export async function saveWhatsNextInstructions(
  project: RegisteredProject,
  instructions: string,
  options?: SaveInstructionsOptions,
) {
  return withInstructionsMutation(project, () =>
    saveWhatsNextInstructionsUnlocked(project, instructions, options),
  );
}

async function saveWhatsNextInstructionsUnlocked(
  project: RegisteredProject,
  instructions: string,
  options?: SaveInstructionsOptions,
) {
  if (typeof instructions !== 'string' || instructions.length > 20_000)
    throw new PublicApiError(
      'Instructions must be at most 20000 characters.',
      400,
    );
  const current = await readWhatsNextInstructions(project);
  assertInstructionsRevision(current, options);
  if (current === instructions) return { instructions };
  const directory = await instructionsDirectory(project, true);
  const temporary = path.join(directory, `instructions-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, instructions, { flag: 'wx' });
    await rename(temporary, path.join(directory, 'instructions.md'));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { instructions };
}

export async function readWhatsNextAttachment(
  project: RegisteredProject,
  fileName: string,
) {
  const validFileName = validateAttachmentName(fileName);
  const content = await readFile(
    path.join(featureContextPath(project), 'attachments', validFileName),
    'utf8',
  );
  return {
    fileName: validFileName,
    format: attachmentFormat(validFileName),
    content,
  };
}

async function listAttachments(project: RegisteredProject) {
  const attachmentsPath = path.join(featureContextPath(project), 'attachments');
  const entries = await readdir(attachmentsPath, { withFileTypes: true }).catch(
    () => [],
  );
  const fileNames = entries
    .filter(
      (entry) => entry.isFile() && /\.(md|markdown|json)$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(
    fileNames.map(async (fileName) => {
      const fileStat = await stat(path.join(attachmentsPath, fileName));
      return {
        fileName,
        path: `whats-next/attachments/${fileName}`,
        format: attachmentFormat(fileName),
        size: fileStat.size,
      } satisfies WhatsNextAttachment;
    }),
  );
}

function featureContextPath(project: RegisteredProject) {
  return path.join(project.planningPath, 'whats-next');
}

function validateAttachmentName(value: string) {
  const fileName = value.normalize('NFC').trim();
  if (
    !fileName ||
    fileName.length > 160 ||
    path.basename(fileName) !== fileName ||
    fileName.includes('\0') ||
    fileName.includes('\r') ||
    fileName.includes('\n') ||
    !/\.(md|markdown|json)$/i.test(fileName)
  ) {
    throw new PublicApiError(
      'Only named Markdown or JSON context attachments are supported.',
      400,
    );
  }
  return fileName;
}

function attachmentFormat(fileName: string): 'markdown' | 'json' {
  return /\.json$/i.test(fileName) ? 'json' : 'markdown';
}
