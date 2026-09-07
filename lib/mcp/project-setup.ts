import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  createProject,
  getProject,
  listProjects,
} from '../project-registry.ts';
import { createStartNode } from '../graph/task/model.ts';
import { listTaskGraphNodes } from '../graph/task/nodes.ts';
import { invalidArgument, resourceNotFound } from './errors.ts';
import { artifactUri, moduleUri } from './uri.ts';
import { encodeArtifactId } from './artifacts.ts';

export async function registerProject(input: {
  rootPath: string;
  name: string;
  description?: string;
  kind: 'standalone' | 'repository';
}) {
  if (!path.isAbsolute(input.rootPath))
    throw invalidArgument(
      'rootPath must name an existing absolute local directory.',
    );
  const rootPath = await realpath(input.rootPath);
  const findExisting = async () => {
    for (const p of await listProjects()) {
      const actual = await realpath(p.rootPath).catch(() => p.rootPath);
      if (actual === rootPath) return p;
    }
    return null;
  };
  const existing = await findExisting();
  if (existing)
    return {
      projectId: existing.id,
      name: existing.name,
      existing: true,
      nextTool: 'praxis_create_source',
    };
  try {
    const project = await createProject({
      ...input,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      rootPath,
    });
    return {
      projectId: project.id,
      name: project.name,
      existing: false,
      nextTool: 'praxis_create_source',
    };
  } catch (error) {
    const raced = await findExisting();
    if (raced)
      return {
        projectId: raced.id,
        name: raced.name,
        existing: true,
        nextTool: 'praxis_create_source',
      };
    throw error;
  }
}

export async function createProjectSource(input: {
  projectId: string;
  title: string;
  markdown: string;
  module?: 'product-exploration' | 'scope-decomposition';
}) {
  const project = await getProject(input.projectId);
  if (!project)
    throw resourceNotFound(
      'Project not found. Use praxis_list_projects or praxis_register_project.',
    );
  const graph =
    input.module === 'scope-decomposition' ? 'task-graph' : 'whats-next';
  const prior = (await listTaskGraphNodes(project, graph)).find(
    (node) => node.role === 'start',
  );
  if (prior)
    throw invalidArgument(
      `This module already has source ${prior.id} (${prior.title}). Read its module resource and prepare against that source; do not create a duplicate or overwrite its document.`,
    );
  const { node } = await createStartNode(
    project,
    {
      title: input.title,
      files: [
        new File([input.markdown], 'project-source.md', {
          type: 'text/markdown',
        }),
      ],
      contextRefs: [],
    },
    graph,
  );
  return {
    sourceNodeId: node.id,
    moduleUri: moduleUri(project.id, input.module ?? 'product-exploration'),
    resources: node.resources.map((resource) => ({
      ...resource,
      uri: artifactUri(project.id, encodeArtifactId(resource.path)),
    })),
    nextStep:
      'Read the intention guidance in the module resource, then call praxis_prepare with this sourceNodeId. Importing this document does not decompose it into Features or accept generated results.',
  };
}
