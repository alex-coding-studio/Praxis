import { getProject } from '@/lib/project-registry';
import { PublicApiError, apiErrorResponse } from '@/lib/api-errors';
import { guardRequest } from '@/lib/request-boundary';
import { deliveryLogTarget } from '@/lib/modules/delivery/logs';
import { readLogChunk } from '@/lib/execution-observability/log-targets';

export async function GET(
  request: Request,
  {
    params,
  }: { params: Promise<{ projectId: string; uid: string; runId: string }> },
) {
  const denied = guardRequest(request);
  if (denied) return denied;
  try {
    const { projectId, uid, runId } = await params;
    const project = await getProject(projectId);
    if (!project) throw new PublicApiError('Project not found.', 404);
    const target = await deliveryLogTarget(project, uid, runId);
    const offset = Number(new URL(request.url).searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new PublicApiError('Invalid log offset.');
    return Response.json({
      ...(await readLogChunk(target, offset)),
      meta: target.meta,
    });
  } catch (error) {
    return apiErrorResponse(
      error,
      'Could not read delivery log.',
      '/api/projects/delivery/logs',
    );
  }
}
