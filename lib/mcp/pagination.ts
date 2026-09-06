import { invalidArgument, resourceChanged } from './errors.ts';

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_READ_BYTES = 32 * 1024;
export const MAX_READ_BYTES = 128 * 1024;
export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 1000;

export type ListCursor = { offset: number };
export type ContentCursor = { offset: number; revision: string };

function encode(payload: object) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decode(cursor: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidArgument('The continuation cursor is not readable.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw invalidArgument('The continuation cursor is not readable.');
  return parsed as Record<string, unknown>;
}

export function boundedLimit(value: unknown, fallback: number, max: number) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
    throw invalidArgument('A limit is a positive integer.');
  return Math.min(value, max);
}

export function encodeListCursor(cursor: ListCursor) {
  return encode(cursor);
}

export function decodeListCursor(cursor: string | undefined): ListCursor {
  if (cursor === undefined) return { offset: 0 };
  const payload = decode(cursor);
  const offset = payload.offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)
    throw invalidArgument('The continuation cursor is not readable.');
  return { offset };
}

export function encodeContentCursor(cursor: ContentCursor) {
  return encode(cursor);
}

export function decodeContentCursor(
  cursor: string | undefined,
  revision: string,
): ContentCursor {
  if (cursor === undefined) return { offset: 0, revision };
  const payload = decode(cursor);
  const offset = payload.offset;
  const previous = payload.revision;
  if (
    typeof offset !== 'number' ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    typeof previous !== 'string'
  )
    throw invalidArgument('The continuation cursor is not readable.');
  if (previous !== revision)
    throw resourceChanged(
      'The document changed since the previous page was read. Read it again from the start so no evidence is spliced across revisions.',
    );
  return { offset, revision };
}

export function pageList<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number,
) {
  const { offset } = decodeListCursor(cursor);
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    page,
    nextCursor: next < items.length ? encodeListCursor({ offset: next }) : null,
    total: items.length,
  };
}

function characterBoundary(buffer: Buffer, end: number, floor: number) {
  let boundary = end;
  while (boundary > floor && (buffer[boundary]! & 0xc0) === 0x80) boundary -= 1;
  if (boundary > floor) return boundary;
  let forward = end;
  while (forward < buffer.byteLength && (buffer[forward]! & 0xc0) === 0x80)
    forward += 1;
  return forward;
}

export function pageContent(
  content: string,
  revision: string,
  cursor: string | undefined,
  limitBytes: number,
) {
  const buffer = Buffer.from(content, 'utf8');
  const { offset } = decodeContentCursor(cursor, revision);
  if (offset > buffer.byteLength)
    throw invalidArgument(
      'The continuation cursor is past the end of the document.',
    );
  const proposed = Math.min(offset + limitBytes, buffer.byteLength);
  const end =
    proposed === buffer.byteLength
      ? proposed
      : characterBoundary(buffer, proposed, offset);
  return {
    text: buffer.subarray(offset, end).toString('utf8'),
    byteOffset: offset,
    byteLength: end - offset,
    totalBytes: buffer.byteLength,
    nextCursor:
      end < buffer.byteLength
        ? encodeContentCursor({ offset: end, revision })
        : null,
  };
}
