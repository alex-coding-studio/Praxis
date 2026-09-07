import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { PublicApiError } from '../../api-errors.ts';
import {
  assertInstructionsRevision,
  withInstructionsMutation,
  type SaveInstructionsOptions,
} from '../module-instructions.ts';
import type { RegisteredProject } from '../../project-registry.ts';

async function contextDirectory(project: RegisteredProject, create = false) {
  const directory = path.join(
    await realpath(project.planningPath),
    'domain-model',
  );
  if (create)
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Invalid Domain Model context directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return directory;
}

export async function readDomainModelInstructions(project: RegisteredProject) {
  const file = path.join(await contextDirectory(project), 'instructions.md');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 80_000)
      throw new Error('Invalid Domain Model instructions file.');
    const instructions = await readFile(file, 'utf8');
    if (instructions.length > 20_000)
      throw new PublicApiError('Instructions exceed 20000 characters.', 400);
    return instructions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export async function saveDomainModelInstructions(
  project: RegisteredProject,
  instructions: string,
  options?: SaveInstructionsOptions,
) {
  return withInstructionsMutation(project, () =>
    saveDomainModelInstructionsUnlocked(project, instructions, options),
  );
}

async function saveDomainModelInstructionsUnlocked(
  project: RegisteredProject,
  instructions: string,
  options?: SaveInstructionsOptions,
) {
  if (typeof instructions !== 'string' || instructions.length > 20_000)
    throw new PublicApiError(
      'Instructions must be at most 20000 characters.',
      400,
    );
  const current = await readDomainModelInstructions(project);
  assertInstructionsRevision(current, options);
  if (current === instructions) return { instructions };
  const directory = await contextDirectory(project, true);
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
