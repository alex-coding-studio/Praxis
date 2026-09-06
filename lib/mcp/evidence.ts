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

export type EvidenceContent = { logicalPath: string; content: string };

export async function readLogicalSources(
  project: RegisteredProject,
  logicalPaths: readonly string[],
): Promise<EvidenceContent[]> {
  const read: EvidenceContent[] = [];
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
    read.push({ logicalPath, content });
  }
  return read;
}

export function contextArtifactPaths(contextIds: readonly string[]) {
  return contextIds.map((contextId) => {
    const logicalPath = decodeArtifactId(contextId);
    if (logicalPath === null)
      throw invalidArgument(
        `request.contextIds contains ${JSON.stringify(contextId)}, which is not an artifact handle this project issued.`,
      );
    return logicalPath;
  });
}

export async function readContextArtifacts(
  project: RegisteredProject,
  contextIds: readonly string[],
): Promise<EvidenceContent[]> {
  return readLogicalSources(project, contextArtifactPaths(contextIds));
}

export async function freezeEvidenceContents(
  project: RegisteredProject,
  operationId: string,
  entries: readonly EvidenceContent[],
): Promise<McpOperationSource[]> {
  const frozen: McpOperationSource[] = [];
  for (const entry of entries) {
    const sourceId = encodeSourceId(entry.logicalPath);
    await writeMcpOperationSource(
      project,
      operationId,
      sourceId,
      entry.content,
    );
    frozen.push({
      sourceId,
      logicalPath: entry.logicalPath,
      sha256: sha256Hex(entry.content),
      byteLength: Buffer.byteLength(entry.content, 'utf8'),
    });
  }
  return frozen;
}

export async function freezeLogicalSources(
  project: RegisteredProject,
  operationId: string,
  logicalPaths: readonly string[],
) {
  return freezeEvidenceContents(
    project,
    operationId,
    await readLogicalSources(project, logicalPaths),
  );
}

export async function freezeContextSources(
  project: RegisteredProject,
  operationId: string,
  contextIds: readonly string[],
) {
  return freezeLogicalSources(
    project,
    operationId,
    contextArtifactPaths(contextIds),
  );
}
