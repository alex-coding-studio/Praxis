export const MCP_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'PROJECT_NOT_FOUND',
  'RESOURCE_NOT_FOUND',
  'CONTRACT_MISMATCH',
  'RESOURCE_CHANGED',
  'INVALID_RESULT',
  'STALE_BASIS',
  'ACTIVE_RUN_CONFLICT',
  'SUBMISSION_CONFLICT',
  'PUBLICATION_FAILED',
  'HOST_UNAVAILABLE',
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export type McpErrorBoundary =
  | 'invalid-argument'
  | 'unknown-resource'
  | 'contract-mismatch'
  | 'changed-content'
  | 'validation'
  | 'stale-basis'
  | 'active-run'
  | 'admitted-operation'
  | 'publication'
  | 'host';

export type McpRetryAction =
  | 'correct-argument'
  | 'refresh-catalog'
  | 'reload-contract'
  | 'read-again'
  | 'correct-result'
  | 'prepare-again'
  | 'retry-after-active-run'
  | 'inspect-operation'
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

export function invalidResult(detail: string) {
  return new McpRequestError({
    code: 'INVALID_RESULT',
    title: 'The submitted result does not satisfy its Result Contract',
    detail,
    boundary: 'validation',
    retryAction: 'correct-result',
  });
}

export function staleBasis(detail: string) {
  return new McpRequestError({
    code: 'STALE_BASIS',
    title: 'The module state changed since this operation was prepared',
    detail,
    boundary: 'stale-basis',
    retryAction: 'prepare-again',
  });
}

export function activeRunConflict(detail: string) {
  return new McpRequestError({
    code: 'ACTIVE_RUN_CONFLICT',
    title: 'Another Run owns this module',
    detail,
    boundary: 'active-run',
    retryAction: 'retry-after-active-run',
  });
}

export function submissionConflict(detail: string) {
  return new McpRequestError({
    code: 'SUBMISSION_CONFLICT',
    title: 'This operation was already admitted with a different result',
    detail,
    boundary: 'admitted-operation',
    retryAction: 'inspect-operation',
  });
}

export function publicationFailed(detail: string) {
  return new McpRequestError({
    code: 'PUBLICATION_FAILED',
    title: 'The result could not be published',
    detail,
    boundary: 'publication',
    retryAction: 'inspect-operation',
  });
}

export function isMcpRequestError(error: unknown): error is McpRequestError {
  return error instanceof McpRequestError;
}
