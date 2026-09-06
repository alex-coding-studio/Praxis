export type ExecutionStage = 'planning' | 'execution' | 'review' | 'todo';

const CARD_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertCardUuid(value: string) {
  if (typeof value !== 'string' || !CARD_UUID.test(value))
    throw new Error('Expected a UUID, not a display alias.');
}
