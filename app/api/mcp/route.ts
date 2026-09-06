import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { evaluateMcpRequest } from '@/lib/mcp/authorization';
import { readMcpCredentials } from '@/lib/mcp/credentials';
import { createPraxisMcpServer } from '@/lib/mcp/server';
import { guardRequest } from '@/lib/request-boundary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function mcpDenial(request: Request) {
  const headers = request.headers;
  const denied = evaluateMcpRequest(
    {
      host: headers.get('host'),
      origin: headers.get('origin'),
      authorization: headers.get('authorization'),
    },
    await readMcpCredentials(),
  );
  if (!denied) return null;
  return Response.json(
    { error: denied.message, code: denied.code },
    {
      status: denied.status,
      headers:
        denied.code === 'unauthorized'
          ? { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' }
          : { 'Cache-Control': 'no-store' },
    },
  );
}

async function serve(request: Request) {
  const denied = await mcpDenial(request);
  if (denied) return denied;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createPraxisMcpServer();
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}

export async function POST(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;
  return serve(request);
}

export async function DELETE(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;
  return serve(request);
}

export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;
  return serve(request);
}
