import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PublicApiError } from '../api-errors.ts';
import { reviseNodeDocument } from '../graph/task/document-revision.ts';
import { runHostOperation } from '../execution-observability/host-operations.ts';
import { requireProject } from './catalog.ts';
import { encodeArtifactId } from './artifacts.ts';
import { artifactUri } from './uri.ts';
import {
  invalidArgument,
  isMcpRequestError,
  resourceChanged,
} from './errors.ts';
import { toToolInputSchema } from './schema-adapter.ts';

export function registerNodeDocumentTools(server: McpServer) {
  server.registerTool(
    'praxis_update_node_document',
    {
      description:
        'Update only the Markdown body of an accepted graph node while keeping its ID, title, summary, relationships and original acceptance provenance. Read the output artifact first and pass its revision hash. Preserves old body; does not accept Candidates or alter delivery completion. Use only for a user-requested edit.',
      inputSchema: toToolInputSchema<{
        projectId: string;
        module: 'product-exploration' | 'scope-decomposition';
        nodeId: string;
        expectedRevision: string;
        markdown: string;
      }>(
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'projectId',
            'module',
            'nodeId',
            'expectedRevision',
            'markdown',
          ],
          properties: {
            projectId: { type: 'string', minLength: 1 },
            module: { enum: ['product-exploration', 'scope-decomposition'] },
            nodeId: { type: 'string', pattern: '^NODE-[0-9a-f]{8,32}$' },
            expectedRevision: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            markdown: { type: 'string', minLength: 1, maxLength: 100000 },
          },
        },
        'praxis_update_node_document',
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      let committed: Awaited<ReturnType<typeof reviseNodeDocument>> | undefined;
      let logUrlPath: string | undefined;
      try {
        const project = await requireProject(input.projectId);
        const operation = await runHostOperation(
          project,
          {
            kind: 'node-document-update',
            label: `Update node document ${input.nodeId}`,
          },
          async (context) => {
            logUrlPath = context.logUrlPath;
            committed = await reviseNodeDocument(
              project,
              input.module === 'product-exploration'
                ? 'whats-next'
                : 'task-graph',
              input,
            );
            return committed;
          },
        );
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(operation.result) },
          ],
          structuredContent: {
            ...operation.result,
            uri: artifactUri(
              project.id,
              encodeArtifactId(operation.result.logicalPath),
            ),
            logUrlPath: operation.logUrlPath,
          },
        };
      } catch (error) {
        if (committed) {
          const result = {
            ...committed,
            uri: artifactUri(
              input.projectId,
              encodeArtifactId(committed.logicalPath),
            ),
            logUrlPath,
            warning:
              'The document update succeeded, but its operation log could not be finalized. Read the returned revision to verify; do not repeat publication blindly.',
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }
        const failure =
          error instanceof PublicApiError
            ? error.status === 409
              ? resourceChanged(error.message)
              : invalidArgument(error.message)
            : error;
        const envelope = isMcpRequestError(failure)
          ? failure.envelope
          : {
              code: 'PUBLICATION_FAILED',
              title: 'Node document was not updated',
              detail:
                'The document update could not complete. Inspect the Host operation log.',
              retryAction: 'inspect-operation',
            };
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...envelope, logUrlPath }),
            },
          ],
          structuredContent: { ...envelope, logUrlPath },
        };
      }
    },
  );
}
