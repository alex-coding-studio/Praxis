import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PublicApiError } from '../../api-errors.ts';
import { writeFileAtomically } from '../../atomic-json-store.ts';
import { sha256Hex } from '../../materialization/hash.ts';
import {
  resolvePlanningPath,
  TASK_GRAPH_MARKDOWN_SHAPES,
} from '../../planning-paths.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import {
  listCanvasNodesWithinCanvas,
  mutateCanvas,
  type GraphRoot,
} from './nodes.ts';

export type ReviseNodeDocumentInput = {
  nodeId: string;
  expectedRevision: string;
  markdown: string;
};

export async function reviseNodeDocument(
  project: RegisteredProject,
  scope: GraphRoot,
  input: ReviseNodeDocumentInput,
) {
  if (!/^NODE-[0-9a-f]{8,32}$/.test(input.nodeId))
    throw new PublicApiError('Invalid formal node id.', 400);
  if (!/^[0-9a-f]{64}$/.test(input.expectedRevision))
    throw new PublicApiError(
      'expectedRevision must be the document hash returned by the resource reader.',
      400,
    );
  if (
    typeof input.markdown !== 'string' ||
    !input.markdown.trim() ||
    Array.from(input.markdown).length > 100000
  )
    throw new PublicApiError(
      'Node Markdown must contain 1 to 100000 characters.',
      400,
    );
  return mutateCanvas(project, scope, async () => {
    const nodes = await listCanvasNodesWithinCanvas(project, scope);
    const node = nodes.find((entry) => entry.id === input.nodeId);
    if (!node || node.role !== 'node' || node.status !== 'accepted')
      throw new PublicApiError(
        'Only an accepted formal graph node can be revised here. Source nodes and pending Candidates use their own tools.',
        400,
      );
    if (!input.markdown.startsWith(`# ${node.title}\n`))
      throw new PublicApiError(
        'Keep the existing node title as the first Markdown heading; this operation changes the body only.',
        400,
      );
    const logicalPath = `${scope}/nodes/${node.id}/output.md`;
    const file = await resolvePlanningPath(project, logicalPath, {
      shapes: TASK_GRAPH_MARKDOWN_SHAPES,
      within: `${scope}/nodes/${node.id}`,
      require: 'file',
    });
    const before = await readFile(file.absolutePath, 'utf8');
    const previousRevision = sha256Hex(before);
    const revision = sha256Hex(input.markdown);
    if (revision === previousRevision)
      return {
        nodeId: node.id,
        logicalPath,
        previousRevision,
        revision,
        changed: false,
      };
    if (previousRevision !== input.expectedRevision)
      throw new PublicApiError(
        'The node document changed. Read the current document and reapply the edit; nothing was overwritten.',
        409,
      );
    const history = path.join(
      path.dirname(file.absolutePath),
      'document-history',
    );
    await mkdir(history, { recursive: true });
    const info = await lstat(history);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new PublicApiError('Invalid document history directory.', 400);
    const saved = path.join(history, `${previousRevision}.md`);
    try {
      await writeFile(saved, before, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await lstat(saved);
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        (await readFile(saved, 'utf8')) !== before
      )
        throw new PublicApiError(
          'The prior document revision could not be preserved.',
          409,
        );
    }
    await writeFileAtomically(file.absolutePath, input.markdown);
    return {
      nodeId: node.id,
      logicalPath,
      previousRevision,
      revision,
      changed: true,
    };
  });
}
