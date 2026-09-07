import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readProductContext } from '../modules/product-context/catalog.ts';
import { listPendingProductExplorationCandidates } from '../modules/product-discovery/acceptance.ts';
import { listPendingScopeDecompositionCandidates } from '../modules/scope-decomposition/acceptance.ts';
import { canonicalJson, sha256Hex } from '../materialization/hash.ts';
import { requireProject } from './catalog.ts';
import { encodeArtifactId } from './artifacts.ts';
import { artifactUri } from './uri.ts';
import { isMcpRequestError } from './errors.ts';
import { toToolInputSchema } from './schema-adapter.ts';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  decodeContentCursor,
  encodeContentCursor,
  pageContent,
} from './pagination.ts';

const pageProperties = {
  projectId: {
    type: 'string',
    minLength: 1,
    description: 'Registered project id from praxis_list_projects.',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_LIST_LIMIT,
    description: `Maximum entries (default ${DEFAULT_LIST_LIMIT}).`,
  },
  cursor: {
    type: 'string',
    description:
      'Use nextCursor from the same project, collection and filters. Restart listing if the collection changes.',
  },
} as const;

type PageOptions = { projectId: string; cursor?: string; limit?: number };
type CandidateOptions = PageOptions & {
  module: 'product-exploration' | 'scope-decomposition';
};

function page<T>(input: PageOptions, scope: string, items: T[]) {
  const revision = sha256Hex(
    canonicalJson({ projectId: input.projectId, scope, items }),
  );
  const { offset } = decodeContentCursor(input.cursor, revision);
  const entries = items.slice(
    offset,
    offset + (input.limit ?? DEFAULT_LIST_LIMIT),
  );
  const next = offset + entries.length;
  return {
    projectId: input.projectId,
    items: entries,
    revision,
    total: items.length,
    nextCursor:
      next < items.length
        ? encodeContentCursor({ offset: next, revision })
        : null,
  };
}

export async function listContext(input: PageOptions & { section?: string }) {
  const project = await requireProject(input.projectId);
  const sections = await readProductContext(project);
  const documents = sections
    .filter(
      (section) =>
        input.section === undefined || section.slug === input.section,
    )
    .flatMap((section) =>
      section.documents.flatMap((document) => {
        if (!document.path) return [];
        const artifactId = encodeArtifactId(document.path);
        const preview = pageContent(
          document.summary,
          sha256Hex(document.summary),
          undefined,
          1024,
        );
        return [
          {
            section: section.slug,
            title: document.title,
            summary: preview.text,
            summaryTruncated: preview.nextCursor !== null,
            artifactId,
            uri: artifactUri(project.id, artifactId),
            revision: sha256Hex(document.markdown),
          },
        ];
      }),
    )
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  const listed = page(input, `context:${input.section ?? '*'}`, documents);
  const visibleSections = new Set(
    listed.items.map((document) => document.section),
  );
  return {
    ...listed,
    sections: sections
      .filter((section) => visibleSections.has(section.slug))
      .map((section) => ({
        id: section.slug,
        title: section.title,
      })),
    usage:
      'Read uri with praxis_read_resource. Pass artifactId to praxis_prepare request.contextIds for domain-modeling or delivery-planning. Product Exploration and Scope preparation use their selected node resources, not request.contextIds. Section names describe this page; follow nextCursor to discover the rest. This is current Product Context, not all historical artifacts or repository files.',
  };
}

export async function listCandidates(input: CandidateOptions) {
  const project = await requireProject(input.projectId);
  const candidates =
    input.module === 'product-exploration'
      ? await listPendingProductExplorationCandidates(project)
      : await listPendingScopeDecompositionCandidates(project);
  const root =
    input.module === 'product-exploration'
      ? 'whats-next'
      : 'task-decomposition';
  const items = candidates
    .map((candidate) => {
      const artifactId = encodeArtifactId(
        `${root}/runs/${candidate.runId}/candidates/${candidate.candidateId}/output.md`,
      );
      return {
        ...candidate,
        artifactId,
        documentUri: artifactUri(project.id, artifactId),
      };
    })
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  return {
    ...page(input, `candidates:${input.module}`, items),
    module: input.module,
    usage:
      'These are current pending Candidates, not accepted nodes. Reuse returned runId/candidateId/revision for accept or discard only with user intent; use candidateId for preparation. Read documentUri for the body.',
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
    const value = isMcpRequestError(error)
      ? error.envelope
      : {
          code: 'HOST_UNAVAILABLE',
          title: 'The catalog could not be read',
          detail:
            error instanceof Error ? error.message : 'Unknown catalog error',
        };
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent: { ...value },
    };
  }
}

export function registerDiscoveryTools(server: McpServer) {
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  server.registerTool(
    'praxis_list_context',
    {
      description:
        'List current Product Context documents with readable URIs and artifactId handles for preparation, without reading source code or constructing paths. Paginated; optional section filter. Not keyword search.',
      inputSchema: toToolInputSchema(
        {
          type: 'object',
          additionalProperties: false,
          required: ['projectId'],
          properties: {
            ...pageProperties,
            section: {
              type: 'string',
              minLength: 1,
              description:
                'Optional section id from a previous page; omit to discover all sections.',
            },
          },
        },
        'praxis_list_context',
      ),
      annotations,
    },
    (args) =>
      result(() => listContext(args as PageOptions & { section?: string })),
  );
  server.registerTool(
    'praxis_list_candidates',
    {
      description:
        'List current pending Candidates and readable document URIs for Product Exploration or Scope Decomposition. Includes revision and eligibility; does not accept or discard. Follow nextCursor for additional entries.',
      inputSchema: toToolInputSchema(
        {
          type: 'object',
          additionalProperties: false,
          required: ['projectId', 'module'],
          properties: {
            ...pageProperties,
            module: {
              type: 'string',
              enum: ['product-exploration', 'scope-decomposition'],
            },
          },
        },
        'praxis_list_candidates',
      ),
      annotations,
    },
    (args) => result(() => listCandidates(args as CandidateOptions)),
  );
}
