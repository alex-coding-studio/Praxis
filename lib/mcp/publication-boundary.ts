import { PublicApiError } from '../api-errors.ts';
import { MaterializationError } from '../materialization/receipt.ts';

export type McpPublicationBoundary =
  | 'stale-basis'
  | 'validation'
  | 'identity'
  | 'publication';

export function publicationBoundary(error: unknown): McpPublicationBoundary {
  if (error instanceof PublicApiError && error.status === 409)
    return 'stale-basis';
  if (error instanceof MaterializationError) {
    if (
      error.boundary === 'stale-basis' ||
      error.boundary === 'validation' ||
      error.boundary === 'identity'
    )
      return error.boundary;
  }
  return 'publication';
}
