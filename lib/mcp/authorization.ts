import { normalizeHostname } from '../request-boundary.ts';
import { matchesMcpToken, type McpCredentials } from './credentials.ts';

export const MCP_LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export type McpAuthorizationDenial = {
  status: number;
  code:
    | 'host-not-allowed'
    | 'origin-not-allowed'
    | 'endpoint-disabled'
    | 'unauthorized';
  message: string;
};

export type McpAuthorizationInput = {
  host: string | null | undefined;
  origin: string | null | undefined;
  authorization: string | null | undefined;
};

export function isMcpLoopbackHostname(value: string | null | undefined) {
  const hostname = normalizeHostname(value);
  if (!hostname) return false;
  if (hostname === '::1') return true;
  return MCP_LOOPBACK_HOSTNAMES.includes(hostname);
}

function presentedToken(authorization: string | null | undefined) {
  const value = authorization?.trim();
  if (!value) return null;
  const separator = value.indexOf(' ');
  if (separator < 0) return null;
  if (value.slice(0, separator).toLowerCase() !== 'bearer') return null;
  const token = value.slice(separator + 1).trim();
  return token.length > 0 ? token : null;
}

export function evaluateMcpRequest(
  input: McpAuthorizationInput,
  credentials: McpCredentials | null,
): McpAuthorizationDenial | null {
  if (!isMcpLoopbackHostname(input.host))
    return {
      status: 421,
      code: 'host-not-allowed',
      message:
        'The Praxis MCP endpoint answers only loopback requests. Connect through 127.0.0.1 or localhost.',
    };
  const origin = input.origin?.trim();
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (!originHost || !isMcpLoopbackHostname(originHost))
      return {
        status: 403,
        code: 'origin-not-allowed',
        message: 'This browser origin may not reach the Praxis MCP endpoint.',
      };
  }
  if (!credentials || !credentials.enabled)
    return {
      status: 404,
      code: 'endpoint-disabled',
      message:
        'The Praxis MCP endpoint is not enabled for this Host. Run `praxis mcp enable`, then restart the server.',
    };
  const token = presentedToken(input.authorization);
  if (!token || !matchesMcpToken(credentials.token, token))
    return {
      status: 401,
      code: 'unauthorized',
      message:
        'A valid bearer credential is required. Read it from the credential file that `praxis mcp info` names.',
    };
  return null;
}
