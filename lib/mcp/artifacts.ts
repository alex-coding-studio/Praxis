import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../materialization/hash.ts';
import {
  isAcceptedPlanningShape,
  isPlanningPathRejection,
  resolvePlanningPath,
  TASK_GRAPH_MARKDOWN_SHAPES,
} from '../planning-paths.ts';
import type { RegisteredProject } from '../project-registry.ts';
import { resourceNotFound } from './errors.ts';

export const MCP_ARTIFACT_ROOTS = [
  'context',
  'delivery',
  'domain-model',
  'implementation',
  'task-decomposition',
  'task-graph',
  'what-to-do',
  'whats-next',
] as const;

export const MCP_ARTIFACT_WALK_DEPTH = 8;
export const MCP_ARTIFACT_MEDIA_TYPE = 'text/markdown';

export type McpArtifactEntry = {
  artifactId: string;
  relativePath: string;
  kind: string;
  byteLength: number;
  mimeType: string;
};

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

async function walk(
  root: string,
  base: string,
  depth: number,
  found: string[],
) {
  if (depth > MCP_ARTIFACT_WALK_DEPTH) return;
  let entries;
  try {
    entries = await readdir(path.join(root, base), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relativePath = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(root, relativePath, depth + 1, found);
    else if (
      entry.isFile() &&
      isAcceptedPlanningShape(relativePath, TASK_GRAPH_MARKDOWN_SHAPES)
    )
      found.push(relativePath);
  }
}

export async function listProjectArtifacts(
  project: RegisteredProject,
): Promise<McpArtifactEntry[]> {
  const found: string[] = [];
  for (const root of MCP_ARTIFACT_ROOTS)
    await walk(project.planningPath, root, 0, found);
  found.sort();
  const entries: McpArtifactEntry[] = [];
  for (const relativePath of found) {
    let byteLength: number;
    try {
      byteLength = (await stat(path.join(project.planningPath, relativePath)))
        .size;
    } catch {
      continue;
    }
    entries.push({
      artifactId: encodeArtifactId(relativePath),
      relativePath,
      kind: artifactKind(relativePath),
      byteLength,
      mimeType: MCP_ARTIFACT_MEDIA_TYPE,
    });
  }
  return entries;
}

export type McpArtifactDocument = McpArtifactEntry & {
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
