import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type test from 'node:test';

export async function listenToMcpHost(t: test.TestContext) {
  const route = await import('../../app/api/mcp/route.ts');
  let port = 0;
  const server: HttpServer = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      void (async () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (typeof value === 'string') headers.set(name, value);
          else if (Array.isArray(value)) headers.set(name, value.join(','));
        const method = incoming.method ?? 'GET';
        const request = new Request(
          `http://127.0.0.1:${port}${incoming.url ?? '/'}`,
          {
            method,
            headers,
            body:
              method === 'GET' || method === 'HEAD' || chunks.length === 0
                ? undefined
                : Buffer.concat(chunks),
          },
        );
        const handler =
          method === 'POST'
            ? route.POST
            : method === 'DELETE'
              ? route.DELETE
              : route.GET;
        try {
          const response = await handler(request);
          outgoing.statusCode = response.status;
          response.headers.forEach((value, name) =>
            outgoing.setHeader(name, value),
          );
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          outgoing.statusCode = 500;
          outgoing.end(String(error));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${port}/api/mcp`;
}

export async function connectMcpClient(
  t: test.TestContext,
  token: string,
  name = 'praxis-test-client',
) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(await listenToMcpHost(t)),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

export type McpSdkClient = Awaited<ReturnType<typeof connectMcpClient>>;

export async function readMcpJson<T>(
  client: McpSdkClient,
  uri: string,
): Promise<T> {
  const read = await client.readResource({ uri });
  return JSON.parse((read.contents[0] as { text: string }).text) as T;
}
