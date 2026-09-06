import { activeRunRegistryOwnership } from '@/lib/execution-observability/active-runs';
import { guardRequest } from '@/lib/request-boundary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;
  return Response.json(
    { activeRunRegistry: activeRunRegistryOwnership() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
