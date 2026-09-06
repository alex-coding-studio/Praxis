export const MATERIALIZATION_FAILURE_BOUNDARIES = [
  'validation',
  'identity',
  'staging',
  'stale-basis',
  'publication',
] as const;

export type MaterializationFailureBoundary =
  (typeof MATERIALIZATION_FAILURE_BOUNDARIES)[number];

import type { ProducerKind } from './producer.ts';

export type MaterializationReceipt = {
  schemaVersion: 1;
  contract: { id: string; version: number; hash: string };
  producer: {
    kind: ProducerKind;
    runId: string;
    harness?: { id: string; revision: number };
  };
  basis: { fingerprint: string; preparedAt: string };
  semanticResultHash: string;
  outcome:
    | 'candidates'
    | 'canonical'
    | 'no-change'
    | 'clarification'
    | 'insufficient-evidence'
    | 'rejected';
  affected: {
    candidateIds: string[];
    nodeIds: string[];
    contractIds: string[];
    domainIds: string[];
  };
  publication: {
    target: 'run-record' | 'domain-state' | 'current-map';
    at: string;
    revision: string | number | null;
  } | null;
  failure: { boundary: MaterializationFailureBoundary; message: string } | null;
};

export class MaterializationError extends Error {
  readonly boundary: MaterializationFailureBoundary;
  readonly status: 409 | 400;

  constructor(boundary: MaterializationFailureBoundary, message: string) {
    super(message);
    this.name = 'MaterializationError';
    this.boundary = boundary;
    this.status = boundary === 'stale-basis' ? 409 : 400;
  }
}

export function isStaleBasisError(
  error: unknown,
): error is MaterializationError {
  return (
    error instanceof MaterializationError && error.boundary === 'stale-basis'
  );
}
