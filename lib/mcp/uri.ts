import { invalidArgument, resourceNotFound } from './errors.ts';
import { isMcpModule, type McpModule } from './modules.ts';

export const MCP_URI_SCHEME = 'praxis://';

export type McpResourceRef =
  | { kind: 'capabilities' }
  | { kind: 'projects' }
  | { kind: 'module'; projectId: string; module: McpModule }
  | { kind: 'latest-response'; projectId: string; module: McpModule }
  | { kind: 'artifact'; projectId: string; artifactId: string }
  | { kind: 'operation'; projectId: string; operationId: string }
  | { kind: 'operation-log'; projectId: string; operationId: string }
  | {
      kind: 'operation-source';
      projectId: string;
      operationId: string;
      sourceId: string;
    }
  | { kind: 'contract'; contractId: string; version: number };

const SEGMENT = /^[A-Za-z0-9_.~-]+$/u;
const ARTIFACT_ID = /^[A-Za-z0-9_-]+$/u;
const OPERATION_ID = /^MCPOP-[0-9a-f-]{36}$/u;

function assertOperationId(value: string) {
  if (!OPERATION_ID.test(value))
    throw invalidArgument(
      `${JSON.stringify(value)} is not an operation id issued by praxis_prepare.`,
    );
  return value;
}

function segments(uri: string) {
  if (!uri.startsWith(MCP_URI_SCHEME))
    throw invalidArgument(
      `A Praxis resource URI starts with ${MCP_URI_SCHEME}; received ${JSON.stringify(uri)}.`,
    );
  const remainder = uri.slice(MCP_URI_SCHEME.length);
  if (remainder.includes('?') || remainder.includes('#'))
    throw invalidArgument(
      'A Praxis resource URI carries no query string or fragment.',
    );
  const parts = remainder.split('/');
  for (const part of parts) {
    if (
      part.length === 0 ||
      part === '.' ||
      part === '..' ||
      !SEGMENT.test(part)
    )
      throw invalidArgument(
        `The resource URI segment ${JSON.stringify(part)} is not a legal catalog identifier.`,
      );
  }
  return parts;
}

function assertModule(value: string): McpModule {
  if (!isMcpModule(value))
    throw resourceNotFound(
      `${JSON.stringify(value)} is not a public Praxis module. Read praxis://capabilities for the supported modules.`,
    );
  return value;
}

export function parseMcpUri(uri: string): McpResourceRef {
  const parts = segments(uri);
  if (parts.length === 1 && parts[0] === 'capabilities')
    return { kind: 'capabilities' };
  if (parts.length === 1 && parts[0] === 'projects')
    return { kind: 'projects' };
  if (parts[0] === 'contracts' && parts.length === 3) {
    const version = Number(parts[2]);
    if (!Number.isInteger(version) || version <= 0)
      throw invalidArgument(
        'A Result Contract URI ends with a positive integer version.',
      );
    return { kind: 'contract', contractId: parts[1], version };
  }
  if (parts[0] === 'projects' && parts.length >= 3) {
    const projectId = parts[1];
    if (parts[2] === 'modules' && parts.length === 4)
      return { kind: 'module', projectId, module: assertModule(parts[3]) };
    if (
      parts[2] === 'modules' &&
      parts.length === 5 &&
      parts[4] === 'latest-response'
    )
      return {
        kind: 'latest-response',
        projectId,
        module: assertModule(parts[3]),
      };
    if (parts[2] === 'operations' && parts.length === 4)
      return {
        kind: 'operation',
        projectId,
        operationId: assertOperationId(parts[3]),
      };
    if (
      parts[2] === 'operations' &&
      parts.length === 6 &&
      parts[4] === 'sources'
    )
      return {
        kind: 'operation-source',
        projectId,
        operationId: assertOperationId(parts[3]),
        sourceId: parts[5],
      };
    if (parts[2] === 'operations' && parts.length === 5 && parts[4] === 'log')
      return {
        kind: 'operation-log',
        projectId,
        operationId: assertOperationId(parts[3]),
      };
    if (parts[2] === 'artifacts' && parts.length === 4) {
      if (!ARTIFACT_ID.test(parts[3]))
        throw invalidArgument(
          'An artifact id is an opaque handle issued by Praxis, not a filesystem path.',
        );
      return { kind: 'artifact', projectId, artifactId: parts[3] };
    }
  }
  throw resourceNotFound(
    `${JSON.stringify(uri)} does not name a Praxis resource. Read praxis://capabilities for the resource shapes this release serves.`,
  );
}

export function capabilitiesUri() {
  return `${MCP_URI_SCHEME}capabilities`;
}

export function projectsUri() {
  return `${MCP_URI_SCHEME}projects`;
}

export function moduleUri(projectId: string, module: McpModule) {
  return `${MCP_URI_SCHEME}projects/${projectId}/modules/${module}`;
}

export function latestResponseUri(projectId: string, module: McpModule) {
  return `${moduleUri(projectId, module)}/latest-response`;
}

export function artifactUri(projectId: string, artifactId: string) {
  return `${MCP_URI_SCHEME}projects/${projectId}/artifacts/${artifactId}`;
}

export function contractUri(contractId: string, version: number) {
  return `${MCP_URI_SCHEME}contracts/${contractId}/${version}`;
}

export function operationUri(projectId: string, operationId: string) {
  return `${MCP_URI_SCHEME}projects/${projectId}/operations/${operationId}`;
}

export function operationLogUri(projectId: string, operationId: string) {
  return `${operationUri(projectId, operationId)}/log`;
}

export function operationSourceUri(
  projectId: string,
  operationId: string,
  sourceId: string,
) {
  return `${operationUri(projectId, operationId)}/sources/${sourceId}`;
}
