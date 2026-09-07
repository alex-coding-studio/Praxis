import { semanticResultHash, sha256Hex } from '../../materialization/hash.ts';
import { resolvePlanningPath } from '../../planning-paths.ts';
import { PublicApiError } from '../../api-errors.ts';
import { validateProductContextReferences } from '../../modules/product-context/resource.ts';
import {
  listCanvasNodesWithinCanvas,
  mutateCanvas,
  type GraphRoot,
  type TaskGraphNode,
} from './nodes.ts';

export {
  assertGraphRoot,
  listTaskGraphNodes,
  readTaskGraphMarkdownResource,
  readTaskGraphNodesSnapshot,
} from './nodes.ts';
export type { GraphRoot, TaskGraphNode } from './nodes.ts';
import { randomUUID } from 'node:crypto';

const MAX_REPORTED_CLEANUP_FAILURES = 4;
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import trash from 'trash';
import { reserveNodeIdentity } from '../identity-store.ts';
import type { RegisteredProject } from '../../project-registry.ts';
import {
  assertCanvasCanCreateStartNode,
  assertTaskGraphNodeCanBeDeleted,
} from './rules.ts';

export async function createStartNode(
  project: RegisteredProject,
  input: {
    title: string;
    contextRefs: string[];
    files: File[];
    idea?: string;
  },
  graphRoot: GraphRoot = 'task-graph',
) {
  return mutateCanvas(project, graphRoot, () =>
    createStartNodeWithinCanvas(project, input, graphRoot),
  );
}

async function createStartNodeWithinCanvas(
  project: RegisteredProject,
  input: {
    title: string;
    contextRefs: string[];
    files: File[];
    idea?: string;
  },
  graphRoot: GraphRoot,
) {
  const title = input.title.trim();
  if (!title) throw new PublicApiError('A start-node title is required.', 400);
  if (title.length > 160) {
    throw new PublicApiError(
      'Start-node title must be 160 characters or fewer.',
      400,
    );
  }
  const idea = input.idea?.trim() ?? '';
  if (input.contextRefs.length + input.files.length === 0 && !idea) {
    throw new PublicApiError(
      'Write a starting idea, or select or upload at least one source document.',
      400,
    );
  }
  if (input.contextRefs.length > 50) {
    throw new PublicApiError(
      'Select no more than 50 Context Library documents.',
      400,
    );
  }
  if (input.files.length > 20) {
    throw new PublicApiError(
      'Upload no more than 20 Markdown files at once.',
      400,
    );
  }

  const contextRefs = await validateContextRefs(
    project,
    input.contextRefs,
    graphRoot,
  );
  const uploads = await prepareUploads(input.files);

  const taskGraphPath = path.join(project.planningPath, graphRoot);
  const nodesPath = path.join(taskGraphPath, 'nodes');
  await mkdir(nodesPath, { recursive: true });
  const existingNodes = await listCanvasNodesWithinCanvas(project, graphRoot);
  assertCanvasCanCreateStartNode(existingNodes);
  const { id, uid } = await reserveNodeIdentity(
    project.planningPath,
    graphRoot,
  );
  const nodePath = path.join(nodesPath, id);
  const temporaryNodePath = path.join(nodesPath, `.${id}-${randomUUID()}.tmp`);
  await mkdir(temporaryNodePath);
  const uploadedResources: TaskGraphNode['resources'] = [];

  try {
    if (idea) {
      const resourcesPath = path.join(temporaryNodePath, 'resources');
      await mkdir(resourcesPath, { recursive: true });
      await writeFile(
        path.join(resourcesPath, 'user-input.md'),
        `# ${title}\n\n${idea}\n`,
        { flag: 'wx' },
      );
      uploadedResources.push({
        kind: 'idea',
        path: `${graphRoot}/nodes/${id}/resources/user-input.md`,
      });
    }
    if (uploads.length > 0) {
      const resourcesPath = path.join(temporaryNodePath, 'resources');
      await mkdir(resourcesPath, { recursive: true });
      const usedNames = new Set<string>();
      for (const upload of uploads) {
        const fileName = chooseUniqueName(upload.baseName, usedNames);
        await writeFile(path.join(resourcesPath, fileName), upload.content, {
          flag: 'wx',
        });
        uploadedResources.push({
          kind: 'attachment',
          path: `${graphRoot}/nodes/${id}/resources/${fileName}`,
        });
      }
    }

    const timestamp = new Date().toISOString();
    const node: TaskGraphNode = {
      schemaVersion: 1,
      id,
      uid,
      relations: { derivedFrom: [], dependsOn: [] },
      role: 'start',
      type: 'source',
      title,
      status: 'captured',
      createdAt: timestamp,
      updatedAt: timestamp,
      resources: [
        ...contextRefs.map((ref) => ({ kind: 'context', path: ref })),
        ...uploadedResources,
      ],
      dependsOn: [],
      typeTemplateRef: id,
      metadata: {},
      layer: graphRoot === 'whats-next' ? 'discovery' : undefined,
      artifactKind: graphRoot === 'whats-next' ? 'source' : undefined,
      presentation: {
        color: '#525252',
      },
    };
    await writeFile(
      path.join(temporaryNodePath, 'node.json'),
      `${JSON.stringify(node, null, 2)}\n`,
      { flag: 'wx' },
    );
    await rename(temporaryNodePath, nodePath);
    return { node, nodes: [...existingNodes, node] };
  } catch (error) {
    const cleanupFailure = await rm(temporaryNodePath, {
      recursive: true,
      force: true,
    }).then(
      () => null,
      (failure: unknown) => failure,
    );
    if (cleanupFailure && error instanceof Error && error.cause === undefined)
      error.cause = cleanupFailure;
    throw error;
  }
}

async function sourceRevision(project: RegisteredProject, node: TaskGraphNode) {
  const contents = await Promise.all(
    node.resources.map(async (resource) => {
      const resolved = await resolvePlanningPath(project, resource.path, {
        require: 'file',
      });
      return {
        path: resource.path,
        hash: sha256Hex(await readFile(resolved.absolutePath, 'utf8')),
      };
    }),
  );
  return semanticResultHash({
    node: {
      id: node.id,
      uid: node.uid,
      title: node.title,
      updatedAt: node.updatedAt,
      resources: node.resources,
      metadata: node.metadata,
    },
    contents,
  });
}

export async function readStartNodeForUpdate(
  project: RegisteredProject,
  id: string,
  graphRoot: GraphRoot,
) {
  return mutateCanvas(project, graphRoot, async () => {
    const node = (await listCanvasNodesWithinCanvas(project, graphRoot)).find(
      (entry) => entry.id === id && entry.role === 'start',
    );
    if (!node) throw new PublicApiError('The source node was not found.', 400);
    return { node, revision: await sourceRevision(project, node) };
  });
}

export async function updateStartNode(
  project: RegisteredProject,
  input: {
    id: string;
    expectedRevision?: string;
    preservePreviousDocuments?: boolean;
    title: string;
    contextRefs: string[];
    retainedAttachmentRefs: string[];
    files: File[];
    idea?: string;
  },
  graphRoot: GraphRoot = 'task-graph',
) {
  return mutateCanvas(project, graphRoot, () =>
    updateStartNodeWithinCanvas(project, input, graphRoot),
  );
}

async function updateStartNodeWithinCanvas(
  project: RegisteredProject,
  input: {
    id: string;
    expectedRevision?: string;
    preservePreviousDocuments?: boolean;
    title: string;
    contextRefs: string[];
    retainedAttachmentRefs: string[];
    files: File[];
    idea?: string;
  },
  graphRoot: GraphRoot,
) {
  if (!/^NODE-[0-9a-f]{8,32}$/.test(input.id)) {
    throw new PublicApiError('The start node is invalid.', 400);
  }
  const title = input.title.trim();
  if (!title) throw new PublicApiError('A start-node title is required.', 400);
  if (title.length > 160) {
    throw new PublicApiError(
      'Start-node title must be 160 characters or fewer.',
      400,
    );
  }
  if (input.contextRefs.length > 50) {
    throw new PublicApiError(
      'Select no more than 50 Context Library documents.',
      400,
    );
  }
  if (input.files.length > 20) {
    throw new PublicApiError(
      'Upload no more than 20 Markdown files at once.',
      400,
    );
  }
  const idea = input.idea?.trim() ?? '';

  const nodePath = path.join(
    project.planningPath,
    graphRoot,
    'nodes',
    input.id,
  );
  const nodeJsonPath = path.join(nodePath, 'node.json');
  const record = await readFile(nodeJsonPath, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        throw new PublicApiError('The node could not be found.', 400);
      throw error;
    },
  );
  const node = JSON.parse(record) as TaskGraphNode;
  if (
    node.schemaVersion !== 1 ||
    node.id !== input.id ||
    node.role !== 'start'
  ) {
    throw new Error('The start node could not be edited.');
  }

  if (
    input.expectedRevision !== undefined &&
    (await sourceRevision(project, node)) !== input.expectedRevision
  )
    throw new PublicApiError(
      'The source changed. Read praxis_read_source again before applying the edit.',
      409,
    );

  const contextRefs = await validateContextRefs(
    project,
    input.contextRefs,
    graphRoot,
  );
  const existingAttachments = new Map(
    node.resources
      .filter((resource) => resource.kind === 'attachment')
      .map((resource) => [resource.path, resource]),
  );
  const retainedAttachmentRefs = [...new Set(input.retainedAttachmentRefs)];
  const retainedAttachments = retainedAttachmentRefs.map((ref) => {
    const resource = existingAttachments.get(ref);
    if (!resource)
      throw new PublicApiError('A retained attachment is invalid.', 400);
    return resource;
  });
  const ideaResource = node.resources.find(
    (resource) => resource.kind === 'user-input' || resource.kind === 'idea',
  );
  if (
    contextRefs.length + retainedAttachments.length + input.files.length ===
      0 &&
    !idea &&
    !ideaResource
  ) {
    throw new PublicApiError(
      'Write a starting idea, or select or upload at least one source document.',
      400,
    );
  }

  const uploads = await prepareUploads(input.files);
  const resourcesPath = path.join(nodePath, 'resources');
  await mkdir(resourcesPath, { recursive: true });
  const usedNames = new Set([
    ...[...existingAttachments.keys()].map((ref) => path.basename(ref)),
    ...(await readdir(resourcesPath).catch(() => [] as string[])),
  ]);
  if (ideaResource) usedNames.add(path.basename(ideaResource.path));
  const newAttachments: TaskGraphNode['resources'] = [];
  const newAttachmentPaths: string[] = [];
  let stagedIdea: TaskGraphNode['resources'][number] | null = null;
  let temporaryJsonPath: string | null = null;
  let committed = false;

  try {
    for (const upload of uploads) {
      const fileName = chooseUniqueName(upload.baseName, usedNames);
      const absolutePath = path.join(resourcesPath, fileName);
      await writeFile(absolutePath, upload.content, { flag: 'wx' });
      newAttachmentPaths.push(absolutePath);
      newAttachments.push({
        kind: 'attachment',
        path: `${graphRoot}/nodes/${input.id}/resources/${fileName}`,
      });
    }

    if (idea) {
      const fileName = chooseUniqueName('user-input', usedNames);
      const absolutePath = path.join(resourcesPath, fileName);
      await writeFile(absolutePath, `# ${title}\n\n${idea}\n`, { flag: 'wx' });
      newAttachmentPaths.push(absolutePath);
      stagedIdea = {
        kind: 'idea',
        path: `${graphRoot}/nodes/${input.id}/resources/${fileName}`,
      };
    }

    const updatedNode: TaskGraphNode = {
      ...node,
      title,
      updatedAt: new Date().toISOString(),
      resources: [
        ...((stagedIdea ?? ideaResource)
          ? [(stagedIdea ?? ideaResource)!]
          : []),
        ...contextRefs.map((ref) => ({ kind: 'context', path: ref })),
        ...retainedAttachments,
        ...newAttachments,
      ],
    };
    temporaryJsonPath = path.join(nodePath, `.node-${randomUUID()}.json.tmp`);
    await writeFile(
      temporaryJsonPath,
      `${JSON.stringify(updatedNode, null, 2)}\n`,
      { flag: 'wx' },
    );
    await rename(temporaryJsonPath, nodeJsonPath);
    committed = true;

    if (
      !input.preservePreviousDocuments &&
      stagedIdea &&
      ideaResource &&
      ideaResource.path !== stagedIdea.path
    )
      await unlink(path.join(project.planningPath, ideaResource.path)).catch(
        () => undefined,
      );

    const removedAttachments = [...existingAttachments.keys()].filter(
      (ref) => !retainedAttachmentRefs.includes(ref),
    );
    await Promise.all(
      (input.preservePreviousDocuments ? [] : removedAttachments).map((ref) =>
        unlink(path.join(project.planningPath, ref)).catch(() => undefined),
      ),
    );
    return {
      node: updatedNode,
      nodes: await listCanvasNodesWithinCanvas(project, graphRoot),
    };
  } catch (error) {
    if (!committed) {
      const cleanupTargets = [
        ...(temporaryJsonPath ? [temporaryJsonPath] : []),
        ...newAttachmentPaths,
      ];
      const cleanupFailures = (
        await Promise.all(
          cleanupTargets.map((filePath) =>
            unlink(filePath).then(
              () => null,
              (failure: unknown) => failure,
            ),
          ),
        )
      ).filter((failure): failure is unknown => failure !== null);
      if (
        cleanupFailures.length > 0 &&
        error instanceof Error &&
        error.cause === undefined
      )
        error.cause =
          cleanupFailures.length === 1
            ? cleanupFailures[0]
            : new AggregateError(
                cleanupFailures.slice(0, MAX_REPORTED_CLEANUP_FAILURES),
                'Cleanup after a failed update did not complete.',
              );
    }
    throw error;
  }
}

export async function deleteTaskGraphNode(
  project: RegisteredProject,
  nodeId: string,
  graphRoot: GraphRoot = 'task-graph',
) {
  return mutateCanvas(project, graphRoot, () =>
    deleteTaskGraphNodeWithinCanvas(project, nodeId, graphRoot),
  );
}

async function deleteTaskGraphNodeWithinCanvas(
  project: RegisteredProject,
  nodeId: string,
  graphRoot: GraphRoot,
) {
  if (!/^NODE-[0-9a-f]{8,32}$/.test(nodeId)) {
    throw new PublicApiError('The node is invalid.', 400);
  }

  const nodes = await listCanvasNodesWithinCanvas(project, graphRoot);
  if (!nodes.some((node) => node.id === nodeId)) {
    throw new PublicApiError('The node could not be found.', 400);
  }
  assertTaskGraphNodeCanBeDeleted(nodes, nodeId);

  const nodePath = path.join(project.planningPath, graphRoot, 'nodes', nodeId);
  await trash(nodePath);
  return { nodes: await listCanvasNodesWithinCanvas(project, graphRoot) };
}

async function validateContextRefs(
  project: RegisteredProject,
  refs: string[],
  graphRoot: GraphRoot,
) {
  return validateProductContextReferences(
    project,
    refs,
    graphRoot === 'whats-next'
      ? ['mvp-prototype', 'product-design']
      : ['task-breakdown'],
  );
}

function chooseUniqueName(baseName: string, usedNames: Set<string>) {
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const fileName =
      suffix === 1 ? `${baseName}.md` : `${baseName}-${suffix}.md`;
    if (!usedNames.has(fileName)) {
      usedNames.add(fileName);
      return fileName;
    }
  }
  throw new Error('Could not choose a unique source file name.');
}

async function prepareUploads(files: File[]) {
  return Promise.all(
    files.map(async (file) => {
      if (!/\.(md|markdown)$/i.test(file.name)) {
        throw new PublicApiError(
          'Only Markdown source files can be uploaded right now.',
          400,
        );
      }
      if (file.size > 2 * 1024 * 1024) {
        throw new PublicApiError(
          'Each Markdown source file must be 2 MB or smaller.',
          400,
        );
      }
      return {
        baseName: slugify(path.parse(path.basename(file.name)).name),
        content: await file.text(),
      };
    }),
  );
}

function slugify(value: string) {
  return (
    value
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9\s_-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'source'
  );
}
