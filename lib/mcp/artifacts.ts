import { readFile } from 'node:fs/promises';
import { sha256Hex } from '../materialization/hash.ts';
import {
  isPlanningPathRejection,
  resolvePlanningPath,
  TASK_GRAPH_MARKDOWN_SHAPES,
} from '../planning-paths.ts';
import type { RegisteredProject } from '../project-registry.ts';
import { resourceNotFound } from './errors.ts';

export const MCP_ARTIFACT_MEDIA_TYPE = 'text/markdown';

export function encodeArtifactId(relativePath: string) {
  return Buffer.from(relativePath, 'utf8').toString('base64url');
}

export function decodeArtifactId(artifactId: string) {
  const decoded = Buffer.from(artifactId, 'base64url').toString('utf8');
  if (decoded.length === 0 || encodeArtifactId(decoded) !== artifactId)
    return null;
  return decoded;
}

function artifactKind(relativePath: string) {
  const shape = TASK_GRAPH_MARKDOWN_SHAPES.find((entry) =>
    entry.pattern.test(relativePath),
  );
  return shape?.name ?? 'planning document';
}

export type McpArtifactDocument = {
  artifactId: string;
  relativePath: string;
  kind: string;
  byteLength: number;
  mimeType: string;
  content: string;
  revision: string;
};

export async function readProjectArtifact(
  project: RegisteredProject,
  artifactId: string,
): Promise<McpArtifactDocument> {
  const relativePath = decodeArtifactId(artifactId);
  if (relativePath === null)
    throw resourceNotFound(
      'That artifact id is not a handle this project issued. Read the project module resource for its current artifact references.',
    );
  let resolved;
  try {
    resolved = await resolvePlanningPath(project, relativePath, {
      shapes: TASK_GRAPH_MARKDOWN_SHAPES,
      require: 'file',
    });
  } catch (error) {
    if (isPlanningPathRejection(error))
      throw resourceNotFound(
        'That artifact is outside the documents this project publishes to MCP clients.',
      );
    throw resourceNotFound(
      'That artifact is no longer readable in this project.',
    );
  }
  const content = await readFile(resolved.absolutePath, 'utf8');
  return {
    artifactId,
    relativePath,
    kind: artifactKind(relativePath),
    byteLength: Buffer.byteLength(content, 'utf8'),
    mimeType: MCP_ARTIFACT_MEDIA_TYPE,
    content,
    revision: sha256Hex(content),
  };
}
