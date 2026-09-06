import { readFile } from 'node:fs/promises';
import { sha256Hex } from '../materialization/hash.ts';
import {
  resolvePlanningPath,
  TASK_GRAPH_MARKDOWN_SHAPES,
} from '../planning-paths.ts';
import type { RegisteredProject } from '../project-registry.ts';
import { decodeArtifactId } from './artifacts.ts';
import { invalidArgument } from './errors.ts';
import {
  encodeSourceId,
  writeMcpOperationSource,
  type McpOperationSource,
} from './operations.ts';

export async function freezeLogicalSources(
  project: RegisteredProject,
  operationId: string,
  logicalPaths: readonly string[],
): Promise<McpOperationSource[]> {
  const frozen: McpOperationSource[] = [];
  for (const logicalPath of logicalPaths) {
    let resolved;
    try {
      resolved = await resolvePlanningPath(project, logicalPath, {
        shapes: TASK_GRAPH_MARKDOWN_SHAPES,
        require: 'file',
      });
    } catch {
      throw invalidArgument(
        `The source document ${JSON.stringify(logicalPath)} is not readable through this project's published documents, so it cannot be frozen as evidence.`,
      );
    }
    let content: string;
    try {
      content = await readFile(resolved.absolutePath, 'utf8');
    } catch {
      throw invalidArgument(
        `The source document ${JSON.stringify(logicalPath)} could not be read while freezing evidence.`,
      );
    }
    const sourceId = encodeSourceId(logicalPath);
    await writeMcpOperationSource(project, operationId, sourceId, content);
    frozen.push({
      sourceId,
      logicalPath,
      sha256: sha256Hex(content),
      byteLength: Buffer.byteLength(content, 'utf8'),
    });
  }
  return frozen;
}

export async function freezeContextSources(
  project: RegisteredProject,
  operationId: string,
  contextIds: readonly string[],
) {
  const logicalPaths = contextIds.map((contextId) => {
    const logicalPath = decodeArtifactId(contextId);
    if (logicalPath === null)
      throw invalidArgument(
        `request.contextIds contains ${JSON.stringify(contextId)}, which is not an artifact handle this project issued.`,
      );
    return logicalPath;
  });
  return freezeLogicalSources(project, operationId, logicalPaths);
}
