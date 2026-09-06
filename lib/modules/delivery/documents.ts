import type { DeliveryRecord } from './record.ts';

export function renderDeliveryBrief(record: DeliveryRecord) {
  const brief = record.brief;
  if (!brief) return '';
  return `# ${record.source.title}\n\n${brief.outcome}\n\n## Included\n\n${brief.included.map((item) => `- ${item}`).join('\n')}\n\n## Excluded\n\n${brief.excluded.map((item) => `- ${item}`).join('\n')}\n\n## Technical acceptance\n\n${brief.criteria.map((item) => `- ${item.id}: ${item.description}\n  Verification: ${item.verification}`).join('\n')}\n${brief.userAcceptance?.length ? `\n## User judgment at final acceptance\n\n${brief.userAcceptance.map((item) => `- ${item}`).join('\n')}\n` : ''}`;
}

export function renderDeliveryOutput(record: DeliveryRecord) {
  return `# ${record.source.title}\n\n${record.response?.detail ?? record.brief?.outcome ?? ''}\n\n## Delivery\n\n- Commit: ${record.acceptedHead ?? 'not accepted'}\n${record.publication ? `- Pull request: ${record.publication.url}\n` : ''}\n## Technical evidence\n\n${record.checks.map((check) => `- ${check.id}: ${check.status} (${check.head})\n  ${check.evidence}`).join('\n')}\n\n## Review\n\n${record.review?.reason ?? 'No review recorded.'}\n`;
}
