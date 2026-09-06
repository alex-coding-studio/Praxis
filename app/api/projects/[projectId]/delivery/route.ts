import { getProject } from '@/lib/project-registry';
import { apiErrorResponse, PublicApiError } from '@/lib/api-errors';
import { guardJsonRequest, guardRequest } from '@/lib/request-boundary';
import {
  confirmDeliveryBrief,
  prepareTarget,
  readDeliveryWorkspace,
  submitDeliveryInput,
} from '@/lib/modules/delivery/service';
import { cancelDeliveryRun } from '@/lib/modules/delivery/runtime';
import {
  updateDeliveryRecord,
  readDeliveryRecord,
  writeDeliveryInstructions,
  writeDeliveryModels,
} from '@/lib/modules/delivery/storage';
import { validateDeliveryModels } from '@/lib/modules/delivery/models';
import { acceptDelivery } from '@/lib/modules/delivery/publication';
import { saveDeliveryAttachments } from '@/lib/modules/delivery/attachments';
import { resolvePlanningPath } from '@/lib/planning-paths';
import { deliveryTargetBusy } from '@/lib/modules/delivery/ownership';
import { revealDeliveryWorkspace } from '@/lib/modules/delivery/workspace';
import { acceptExistingDelivery } from '@/lib/modules/delivery/existing-delivery';
import { withdrawDelivery } from '@/lib/modules/delivery/withdraw';

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const denied = guardRequest(request);
  if (denied) return denied;
  try {
    const project = await getProject((await context.params).projectId);
    if (!project) throw new PublicApiError('Project not found.', 404);
    return Response.json(await readDeliveryWorkspace(project));
  } catch (error) {
    return apiErrorResponse(
      error,
      'Could not load delivery targets.',
      '/api/projects/delivery',
    );
  }
}

export async function POST(request: Request, context: RouteContext) {
  const denied = guardJsonRequest(request);
  if (denied) return denied;
  try {
    const project = await getProject((await context.params).projectId);
    if (!project) throw new PublicApiError('Project not found.', 404);
    const body = await request.text();
    if (Buffer.byteLength(body) > 22 * 1024 * 1024)
      throw new PublicApiError('Delivery input is too large.');
    const input = JSON.parse(body);
    if (input.action === 'prepare' || input.action === 'send') {
      if (input.contextRefs !== undefined) {
        if (
          !Array.isArray(input.contextRefs) ||
          input.contextRefs.length > 20 ||
          input.contextRefs.some((ref: unknown) => typeof ref !== 'string')
        )
          throw new PublicApiError('Invalid delivery context references.');
        const refs = await Promise.all(
          input.contextRefs.map(
            async (ref: string) =>
              (
                await resolvePlanningPath(project, ref, {
                  require: 'file',
                  maxBytes: 1_048_576,
                })
              ).absolutePath,
          ),
        );
        if (refs.length)
          input.message = `${input.message ?? ''}\n\nUser-selected context:\n${refs.join('\n')}`;
      }
    }
    if (input.action === 'prepare') {
      const prepared = await prepareTarget(project, input.uid, input.models);
      if (input.files?.length) {
        const files = await saveDeliveryAttachments(
          project,
          input.uid,
          input.files,
        );
        input.message = `${input.message ?? ''}\n\nUser attachments:\n${files.map((file) => `${file.name}: ${file.path}`).join('\n')}`;
      }
      if (typeof input.message === 'string' && input.message.trim())
        await submitDeliveryInput(
          project,
          input.uid,
          input.message,
          prepared.revision,
        );
    } else if (input.action === 'confirm-brief')
      await confirmDeliveryBrief(project, input.uid, input.expectedRevision);
    else if (input.action === 'start') {
      const record = await readDeliveryRecord(project, input.uid);
      if (!record?.brief?.confirmedAt)
        throw new PublicApiError('Confirm the delivery brief first.', 409);
      await submitDeliveryInput(
        project,
        input.uid,
        'Implement the confirmed delivery brief.',
        input.expectedRevision,
      );
    } else if (input.action === 'send') {
      if (input.files?.length) {
        const files = await saveDeliveryAttachments(
          project,
          input.uid,
          input.files,
        );
        input.message = `${input.message ?? ''}\n\nUser attachments:\n${files.map((file) => `${file.name}: ${file.path}`).join('\n')}`;
      }
      if (typeof input.message !== 'string' || !input.message.trim())
        throw new PublicApiError('Enter delivery instructions.');
      await submitDeliveryInput(
        project,
        input.uid,
        input.message,
        input.expectedRevision,
      );
    } else if (input.action === 'open-workspace') {
      const record = await readDeliveryRecord(project, input.uid);
      if (!record) throw new PublicApiError('Delivery not found.', 404);
      await revealDeliveryWorkspace(project, record);
    } else if (input.action === 'accept-existing')
      await acceptExistingDelivery(project, input.uid, input.expectedRevision);
    else if (input.action === 'accept')
      await acceptDelivery(project, input.uid, input.expectedRevision);
    else if (input.action === 'cancel')
      await cancelDeliveryRun(project, input.uid);
    else if (input.action === 'withdraw')
      await withdrawDelivery(project, input.uid, input.expectedRevision);
    else if (input.action === 'instructions') {
      if (typeof input.instructions !== 'string')
        throw new PublicApiError('Invalid module instructions.');
      await writeDeliveryInstructions(project, input.instructions);
    } else if (input.action === 'models') {
      if (input.uid && deliveryTargetBusy(project, input.uid))
        throw new PublicApiError(
          'Wait for the current delivery operation.',
          409,
        );
      validateDeliveryModels(input.models);
      await writeDeliveryModels(project, input.models);
      if (input.uid)
        await updateDeliveryRecord(
          project,
          input.uid,
          (record) => {
            if (record.runs.at(-1)?.status === 'running')
              throw new PublicApiError('Wait for the current response.', 409);
            if (
              record.models.orchestrator.agent !==
              input.models.orchestrator.agent
            )
              record.orchestratorSessionId = null;
            record.models = input.models;
          },
          input.expectedRevision,
        );
    } else throw new PublicApiError('Unknown delivery operation.');
    return Response.json(await readDeliveryWorkspace(project));
  } catch (error) {
    return apiErrorResponse(
      error,
      'Delivery operation failed.',
      '/api/projects/delivery',
    );
  }
}
