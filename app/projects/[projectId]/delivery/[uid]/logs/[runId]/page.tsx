import { notFound } from 'next/navigation';
import { getProject } from '@/lib/project-registry';
import { deliveryLogTarget } from '@/lib/modules/delivery/logs';
import { readLogChunk } from '@/lib/execution-observability/log-targets';
import { LogViewer } from '@/components/log-viewer';

export const dynamic = 'force-dynamic';
export default async function DeliveryLogPage({
  params,
}: {
  params: Promise<{ projectId: string; uid: string; runId: string }>;
}) {
  const { projectId, uid, runId } = await params;
  const project = await getProject(projectId);
  if (!project) notFound();
  const target = await deliveryLogTarget(project, uid, runId);
  return (
    <main className="min-h-dvh bg-background">
      <LogViewer
        apiPath={`/api/projects/${projectId}/delivery/${uid}/logs/${runId}`}
        initialMeta={target.meta}
        initialChunk={await readLogChunk(target, 0)}
      />
    </main>
  );
}
