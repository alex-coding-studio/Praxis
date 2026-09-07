import { PublicApiError } from '../api-errors.ts';
import { withModuleMutation } from '../graph/proposal/module-runtime.ts';
import { sha256Hex } from '../materialization/hash.ts';
import type { RegisteredProject } from '../project-registry.ts';

const MUTATION_KEY = 'moduleInstructionsMutations' as const;

export class InstructionsRevisionError extends PublicApiError {
  readonly currentRevision: string;
  constructor(currentRevision: string, expectedRevision: string) {
    super(
      `The Instructions are at revision ${currentRevision}, not ${expectedRevision}. Read them again and reapply the change.`,
      409,
    );
    this.name = 'InstructionsRevisionError';
    this.currentRevision = currentRevision;
  }
}

export type SaveInstructionsOptions = { expectedRevision?: string };

export function instructionsRevision(instructions: string) {
  return sha256Hex(instructions);
}

export function withInstructionsMutation<T>(
  project: RegisteredProject,
  work: () => Promise<T>,
) {
  return withModuleMutation(MUTATION_KEY, project.planningPath, work);
}

export function assertInstructionsRevision(
  current: string,
  options: SaveInstructionsOptions | undefined,
) {
  if (options?.expectedRevision === undefined) return;
  const revision = instructionsRevision(current);
  if (revision !== options.expectedRevision)
    throw new InstructionsRevisionError(revision, options.expectedRevision);
}
