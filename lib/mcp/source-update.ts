import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PublicApiError } from '../api-errors.ts';
import {
  readStartNodeForUpdate,
  updateStartNode,
} from '../graph/task/model.ts';
import { requireProject } from './catalog.ts';
import { artifactUri, moduleUri } from './uri.ts';
import { encodeArtifactId } from './artifacts.ts';
import {
  invalidArgument,
  isMcpRequestError,
  resourceChanged,
} from './errors.ts';
import { toToolInputSchema } from './schema-adapter.ts';
import type { TaskGraphNode } from '../graph/task/nodes.ts';

type SourceModule = 'product-exploration' | 'scope-decomposition';
type SourceInput = { projectId: string; module: SourceModule; nodeId: string };
type UpdateInput = SourceInput & {
  expectedRevision: string;
  title?: string;
  idea?: string;
  removeAttachmentRefs?: string[];
  attachments?: Array<{
    fileName: string;
    markdown: string;
    replaces?: string;
  }>;
};
const properties = {
  projectId: { type: 'string', minLength: 1 },
  module: { enum: ['product-exploration', 'scope-decomposition'] },
  nodeId: { type: 'string', pattern: '^NODE-[0-9a-f]{8,32}$' },
};
function projection(
  projectId: string,
  module: SourceModule,
  node: TaskGraphNode,
  revision: string,
) {
  return {
    projectId,
    module,
    nodeId: node.id,
    title: node.title,
    revision,
    resources: node.resources.map((r) => ({
      ...r,
      uri: artifactUri(projectId, encodeArtifactId(r.path)),
    })),
    moduleUri: moduleUri(projectId, module),
    updateTool: 'praxis_update_source',
  };
}
async function result(work: () => Promise<object>) {
  try {
    const value = await work();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent: value as Record<string, unknown>,
    };
  } catch (error) {
    const failure =
      error instanceof PublicApiError
        ? error.status === 409
          ? resourceChanged(error.message)
          : invalidArgument(error.message)
        : error;
    const value = isMcpRequestError(failure)
      ? failure.envelope
      : {
          code: 'PUBLICATION_FAILED',
          title: 'Source operation could not complete',
          detail:
            error instanceof Error ? error.message : 'Unknown source error',
        };
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent: { ...value },
    };
  }
}
export function registerSourceUpdateTools(server: McpServer) {
  server.registerTool(
    'praxis_read_source',
    {
      description:
        'Read an existing source node and its content-bound revision before updating it. Returns attachment paths and readable URIs; does not create or revise anything.',
      inputSchema: toToolInputSchema<SourceInput>(
        {
          type: 'object',
          additionalProperties: false,
          required: ['projectId', 'module', 'nodeId'],
          properties,
        },
        'praxis_read_source',
      ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      result(async () => {
        const project = await requireProject(input.projectId);
        const current = await readStartNodeForUpdate(
          project,
          input.nodeId,
          input.module === 'product-exploration' ? 'whats-next' : 'task-graph',
        );
        return projection(
          project.id,
          input.module,
          current.node,
          current.revision,
        );
      }),
  );
  server.registerTool(
    'praxis_update_source',
    {
      description:
        'Update an existing start/source node, retaining its ID and graph relations. Read praxis_read_source first. Omitted title, idea and attachments are preserved. Attachments add documents unless replaces names an existing attachment; only explicitly listed removeAttachmentRefs are removed. Frozen operation snapshots are not rewritten. This is not accepted-node body revision or Candidate acceptance.',
      inputSchema: toToolInputSchema<UpdateInput>(
        {
          type: 'object',
          additionalProperties: false,
          required: ['projectId', 'module', 'nodeId', 'expectedRevision'],
          properties: {
            ...properties,
            expectedRevision: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            title: {
              type: 'string',
              minLength: 1,
              maxLength: 160,
              pattern: '\\S',
            },
            idea: {
              type: 'string',
              minLength: 1,
              maxLength: 100000,
              pattern: '\\S',
            },
            removeAttachmentRefs: {
              type: 'array',
              maxItems: 50,
              items: { type: 'string', minLength: 1 },
            },
            attachments: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['fileName', 'markdown'],
                properties: {
                  fileName: {
                    type: 'string',
                    pattern: '^[^/\\\\]+\\.(md|markdown)$',
                  },
                  markdown: { type: 'string', minLength: 1, maxLength: 100000 },
                  replaces: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
        'praxis_update_source',
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) =>
      result(async () => {
        const project = await requireProject(input.projectId),
          scope =
            input.module === 'product-exploration'
              ? 'whats-next'
              : 'task-graph';
        const current = await readStartNodeForUpdate(
          project,
          input.nodeId,
          scope,
        );
        if (current.revision !== input.expectedRevision)
          throw resourceChanged(
            'The source changed. Read praxis_read_source again before applying the edit.',
          );
        const existing = current.node.resources
          .filter((r) => r.kind === 'attachment')
          .map((r) => r.path);
        const removals = new Set([
          ...(input.removeAttachmentRefs ?? []),
          ...(input.attachments ?? []).flatMap((a) =>
            a.replaces ? [a.replaces] : [],
          ),
        ]);
        for (const ref of removals)
          if (!existing.includes(ref))
            throw invalidArgument(
              `Attachment is not part of this source: ${ref}`,
            );
        const replacements = (input.attachments ?? []).flatMap((a) =>
          a.replaces ? [a.replaces] : [],
        );
        if (new Set(replacements).size !== replacements.length)
          throw invalidArgument(
            'An attachment cannot be replaced twice in one update.',
          );
        await updateStartNode(
          project,
          {
            id: input.nodeId,
            expectedRevision: input.expectedRevision,
            preservePreviousDocuments: true,
            title: input.title ?? current.node.title,
            idea: input.idea,
            contextRefs: current.node.resources
              .filter((r) => r.kind === 'context')
              .map((r) => r.path),
            retainedAttachmentRefs: existing.filter(
              (ref) => !removals.has(ref),
            ),
            files: (input.attachments ?? []).map(
              (a) =>
                new File([a.markdown], a.fileName, { type: 'text/markdown' }),
            ),
          },
          scope,
        );
        const updated = await readStartNodeForUpdate(
          project,
          input.nodeId,
          scope,
        );
        return projection(
          project.id,
          input.module,
          updated.node,
          updated.revision,
        );
      }),
  );
}
