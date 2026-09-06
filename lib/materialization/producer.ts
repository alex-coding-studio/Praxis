export const PRODUCER_KINDS = ['agent-run', 'direct'] as const;

export type ProducerKind = (typeof PRODUCER_KINDS)[number];
