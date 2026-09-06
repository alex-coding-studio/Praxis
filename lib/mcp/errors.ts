export const MCP_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'PROJECT_NOT_FOUND',
  'RESOURCE_NOT_FOUND',
  'CONTRACT_MISMATCH',
  'RESOURCE_CHANGED',
  'HOST_UNAVAILABLE',
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export type McpErrorBoundary =
  | 'invalid-argument'
  | 'unknown-resource'
  | 'contract-mismatch'
  | 'changed-content'
  | 'host';

export type McpRetryAction =
  | 'correct-argument'
  | 'refresh-catalog'
  | 'reload-contract'
  | 'read-again'
  | 'start-host';

export type McpErrorEnvelope = {
  code: McpErrorCode;
  title: string;
  detail: string;
  boundary: McpErrorBoundary;
  retryAction: McpRetryAction;
};

export class McpRequestError extends Error {
  readonly envelope: McpErrorEnvelope;
  constructor(envelope: McpErrorEnvelope) {
    super(`${envelope.code}: ${envelope.title}`);
    this.name = 'McpRequestError';
    this.envelope = envelope;
  }
}

export function invalidArgument(detail: string) {
  return new McpRequestError({
    code: 'INVALID_ARGUMENT',
    title: 'The request arguments are not valid',
    detail,
    boundary: 'invalid-argument',
    retryAction: 'correct-argument',
  });
}

export function projectNotFound(projectId: string) {
  return new McpRequestError({
    code: 'PROJECT_NOT_FOUND',
    title: 'No registered project has that id',
    detail: `Read praxis://projects and use a listed project id instead of ${JSON.stringify(projectId)}.`,
    boundary: 'unknown-resource',
    retryAction: 'refresh-catalog',
  });
}

export function resourceNotFound(detail: string) {
  return new McpRequestError({
    code: 'RESOURCE_NOT_FOUND',
    title: 'That resource is not in the catalog',
    detail,
    boundary: 'unknown-resource',
    retryAction: 'refresh-catalog',
  });
}

export function contractMismatch(detail: string) {
  return new McpRequestError({
    code: 'CONTRACT_MISMATCH',
    title: 'The requested Result Contract identity does not match',
    detail,
    boundary: 'contract-mismatch',
    retryAction: 'reload-contract',
  });
}

export function resourceChanged(detail: string) {
  return new McpRequestError({
    code: 'RESOURCE_CHANGED',
    title: 'The document changed while it was being read',
    detail,
    boundary: 'changed-content',
    retryAction: 'read-again',
  });
}

export function isMcpRequestError(error: unknown): error is McpRequestError {
  return error instanceof McpRequestError;
}
