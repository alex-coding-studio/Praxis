import { getProject } from '@/lib/project-registry';
import { readDeliveryWorkspace } from '@/lib/modules/delivery/service';
import { apiErrorResponse } from '@/lib/api-errors';

export const dynamic = 'force-dynamic';
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const project = await getProject((await params).projectId);
  if (!project)
    return Response.json({ error: 'Project not found.' }, { status: 404 });
  try {
    const { targets } = await readDeliveryWorkspace(project);
    return Response.json(
      {
        states: Object.fromEntries(
          targets
            .filter((target) => target.delivery)
            .map((target) => [
              target.sourceUid,
              target.status === 'completed' ? 'completed' : 'in-progress',
            ]),
        ),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return apiErrorResponse(
      error,
      'Could not load contract completion.',
      'GET contract-completion',
    );
  }
}
