import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PublicApiError } from '../api-errors.ts';
import {
  inspectTaskGraphNodeDeletion,
  deleteTaskGraphNode,
} from '../graph/task/model.ts';
import { NodeReferencedError } from '../graph/task/rules.ts';
import { requireProject } from './catalog.ts';
import { moduleUri } from './uri.ts';
import {
  invalidArgument,
  isMcpRequestError,
  resourceChanged,
} from './errors.ts';
import { toToolInputSchema } from './schema-adapter.ts';
import { runHostOperation } from '../execution-observability/host-operations.ts';

type Input = {
  projectId: string;
  module: 'product-exploration' | 'scope-decomposition';
  nodeId: string;
};
const properties = {
  projectId: { type: 'string', minLength: 1 },
  module: { enum: ['product-exploration', 'scope-decomposition'] },
  nodeId: { type: 'string', pattern: '^NODE-[0-9a-f]{8,32}$' },
};
function success(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
function failure(error: unknown, logUrlPath?: string) {
  const mapped =
    error instanceof PublicApiError
      ? error.status === 409
        ? resourceChanged(error.message)
        : invalidArgument(error.message)
      : error;
  const value = {
    ...(isMcpRequestError(mapped)
      ? mapped.envelope
      : {
          code: 'PUBLICATION_FAILED',
          title: 'Node deletion could not complete',
          detail:
            'Inspect the Host log and current node state before retrying.',
        }),
    ...(error instanceof NodeReferencedError
      ? { blockerNodeIds: error.blockerNodeIds }
      : {}),
    logUrlPath,
  };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
export function registerNodeDeletionTools(server: McpServer) {
  server.registerTool(
    'praxis_inspect_node_deletion',
    {
      description:
        'Read a formal accepted node deletion revision and existing dependency/lineage blockers. Does not delete anything. Use before an explicitly user-requested deletion.',
      inputSchema: toToolInputSchema<Input>(
        {
          type: 'object',
          additionalProperties: false,
          required: ['projectId', 'module', 'nodeId'],
          properties,
        },
        'praxis_inspect_node_deletion',
      ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const project = await requireProject(input.projectId);
        return success({
          ...(await inspectTaskGraphNodeDeletion(
            project,
            input.nodeId,
            input.module === 'product-exploration'
              ? 'whats-next'
              : 'task-graph',
          )),
          moduleUri: moduleUri(project.id, input.module),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    'praxis_delete_node',
    {
      description:
        'Delete one accepted formal graph node using the existing Trash path. Requires the revision from praxis_inspect_node_deletion and a user decision to delete. Refuses referenced nodes, never cascades or rewires dependencies. Does not discard the original Candidate (which may become pending again), delete sources, projects or worktrees, or rewrite delivery records. A missing target returns alreadyAbsent without claiming a deletion occurred.',
      inputSchema: toToolInputSchema<Input & { expectedRevision: string }>(
        {
          type: 'object',
          additionalProperties: false,
          required: ['projectId', 'module', 'nodeId', 'expectedRevision'],
          properties: {
            ...properties,
            expectedRevision: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          },
        },
        'praxis_delete_node',
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      let committed: Record<string, unknown> | undefined;
      let logUrlPath: string | undefined;
      try {
        const project = await requireProject(input.projectId);
        const outcome = await runHostOperation(
          project,
          { kind: 'node-delete', label: `Delete node ${input.nodeId}` },
          async (context) => {
            logUrlPath = context.logUrlPath;
            const deleted = await deleteTaskGraphNode(
              project,
              input.nodeId,
              input.module === 'product-exploration'
                ? 'whats-next'
                : 'task-graph',
              { expectedRevision: input.expectedRevision },
            );
            committed = {
              nodeId: input.nodeId,
              deleted: !deleted.alreadyAbsent,
              alreadyAbsent: deleted.alreadyAbsent,
              moduleUri: moduleUri(project.id, input.module),
            };
            return committed;
          },
        );
        return success({ ...outcome.result, logUrlPath: outcome.logUrlPath });
      } catch (error) {
        if (committed)
          return success({
            ...committed,
            logUrlPath,
            warning:
              'The node operation completed, but its Host log could not be finalized. Read current state rather than assuming rollback.',
          });
        return failure(error, logUrlPath);
      }
    },
  );
}
