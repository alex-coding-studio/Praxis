import { readFile } from 'node:fs/promises';
import type { RegisteredProject } from './project-registry.ts';
import {
  PlanningPathEscapeError,
  PlanningPathKindError,
  PlanningPathShapeError,
  PlanningPathSizeError,
  resolvePlanningPath,
} from './planning-paths.ts';

export async function readPlanningFile(
  project: RegisteredProject,
  relative: string,
  maxBytes = 262_144,
) {
  let resolved;
  try {
    resolved = await resolvePlanningPath(project, relative, {
      require: 'file',
      maxBytes,
    });
  } catch (error) {
    if (error instanceof PlanningPathShapeError)
      throw new Error('Invalid planning file path.');
    if (error instanceof PlanningPathEscapeError)
      throw new Error('Planning resource escapes the project.');
    if (
      error instanceof PlanningPathKindError ||
      error instanceof PlanningPathSizeError
    )
      throw new Error('Planning resource is missing or too large.');
    throw error;
  }
  return readFile(resolved.absolutePath, 'utf8');
}
