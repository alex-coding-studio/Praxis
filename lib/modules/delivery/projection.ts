import type {
  DeliverySource,
  DeliverySummary,
  ExecutableTarget,
} from './types.ts';

export function projectDeliveryTargets(
  sources: DeliverySource[],
  records: DeliverySummary[],
  contextUids: ReadonlySet<string>,
): ExecutableTarget[] {
  const byUid = new Map(sources.map((source) => [source.sourceUid, source]));
  const deliveries = new Map(
    records.map((record) => [record.sourceUid, record]),
  );
  function completed(uid: string) {
    const source = byUid.get(uid);
    if (!source) return contextUids.has(uid);
    const record = deliveries.get(uid);
    return (
      record?.status === 'completed' &&
      record.sourceFingerprint === source.sourceFingerprint
    );
  }
  return sources.map((source) => {
    const delivery = deliveries.get(source.sourceUid) ?? null;
    const sourceChanged =
      delivery !== null &&
      delivery.sourceFingerprint !== source.sourceFingerprint;
    const unmetDependencies = source.dependsOn.filter((uid) => !completed(uid));
    return {
      ...source,
      delivery,
      sourceChanged,
      unmetDependencies,
      status: delivery
        ? sourceChanged &&
          !['running', 'reviewing', 'briefing'].includes(delivery.status)
          ? 'warning'
          : delivery.status
        : unmetDependencies.length
          ? 'waiting'
          : 'ready',
    };
  });
}
