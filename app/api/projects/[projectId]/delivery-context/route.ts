import { getProject } from '@/lib/project-registry';
import { apiErrorResponse, PublicApiError } from '@/lib/api-errors';
import { guardRequest, guardJsonRequest } from '@/lib/request-boundary';
import {
  readDeliveryInstructions,
  writeDeliveryInstructions,
} from '@/lib/modules/delivery/storage';

type Context = { params: Promise<{ projectId: string }> };
export async function GET(request: Request, context: Context) {
  const denied = guardRequest(request);
  if (denied) return denied;
  try {
    const project = await getProject((await context.params).projectId);
    if (!project) throw new PublicApiError('Project not found.', 404);
    return Response.json({
      instructions: await readDeliveryInstructions(project),
    });
  } catch (error) {
    return apiErrorResponse(
      error,
      'Could not load Instructions.',
      'GET delivery-context',
    );
  }
}

export async function PATCH(request: Request, context: Context) {
  const denied = guardJsonRequest(request);
  if (denied) return denied;
  try {
    const project = await getProject((await context.params).projectId);
    if (!project) throw new PublicApiError('Project not found.', 404);
    const body = await request.text();
    if (Buffer.byteLength(body) > 100_000)
      throw new PublicApiError('Instructions are too large.');
    const { instructions } = JSON.parse(body);
    if (typeof instructions !== 'string')
      throw new PublicApiError('Invalid Instructions.');
    await writeDeliveryInstructions(project, instructions);
    return Response.json({ instructions });
  } catch (error) {
    return apiErrorResponse(
      error,
      'Could not save Instructions.',
      'PATCH delivery-context',
    );
  }
}
