// The HTTP server: one Node http server, keep-alive, no framework.
//
// Request flow: read the body (for methods that carry one), check the
// bearer token, route by decoded path segment, and send the reply with
// the JSON content type, the request id and the OAuth scopes headers.
// A handler that throws answers 500 JSON and never drops the connection.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SHOP_TOKEN } from './consts.ts';
import { handleAdvertise, handleReceivePack, handleUploadPack, type WireReply } from './gitwire.ts';
import { routeGraphQL } from './graph.ts';
import { routeMcp } from './mcplink.ts';
import { routeRest } from './restapi.ts';
import { FORGE } from './vault.ts';
import { emptyReply, errorReply, jsonReply, nextRequestId, splitPath, type Ctx, type Reply } from './web.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a request body fully (chunked or Content-Length), capped. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** The bearer check: a non-empty Bearer token, equal to the trial token when one is set. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

function sendReply(res: ServerResponse, reply: Reply, requestId: string): void {
  const headers: Record<string, string> = {
    'Content-Type': reply.contentType,
    'Content-Length': String(reply.body.length),
    'X-GitHub-Request-Id': requestId,
  };
  if (reply.contentType.startsWith('application/json')) {
    headers['X-OAuth-Scopes'] = 'repo, read:org';
  }
  if (reply.headers !== undefined) {
    for (const [key, value] of Object.entries(reply.headers)) headers[key] = value;
  }
  try {
    res.writeHead(reply.status, headers);
    if (reply.body.length > 0) res.end(reply.body);
    else res.end();
  } catch {
    // The peer went away; nothing more to do.
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  try {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, 'http://entry');
    const path = url.pathname;
    const segments = splitPath(path);
    const body = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE' ? await readBody(req) : Buffer.alloc(0);
    const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
    const ctx: Ctx = { method, segments, query: url.searchParams, body, baseUrl, requestId };

    if (method === 'GET' && path === '/healthz') {
      sendReply(res, jsonReply(200, { ok: true }), requestId);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
      if (!authorized(req)) {
        sendReply(res, errorReply(401, 'Requires authentication'), requestId);
        return;
      }
      const owner = segments[0] as string;
      const repoName = (segments[1] as string).slice(0, -4);
      const rest = segments.slice(2);
      const repo = FORGE.lookup(owner, repoName);
      if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendReply(res, errorReply(400, 'unknown service'), requestId);
          return;
        }
        if (repo === null) {
          sendReply(res, errorReply(404, 'Not Found'), requestId);
          return;
        }
        const gitProtocol = req.headers['git-protocol'] ?? '';
        const reply: WireReply = handleAdvertise(repo, service, gitProtocol);
        sendReply(res, reply, requestId);
        return;
      }
      if (repo === null) {
        sendReply(res, errorReply(404, 'Not Found'), requestId);
        return;
      }
      if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
        sendReply(res, handleUploadPack(repo, body), requestId);
        return;
      }
      if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
        sendReply(res, handleReceivePack(repo, body), requestId);
        return;
      }
      sendReply(res, errorReply(404, 'Not Found'), requestId);
      return;
    }

    if (segments.length >= 2 && segments[0] === 'api') {
      if (segments[1] === 'v3') {
        if (!authorized(req)) {
          sendReply(res, errorReply(401, 'Requires authentication'), requestId);
          return;
        }
        sendReply(res, routeRest(ctx), requestId);
        return;
      }
      if (segments[1] === 'graphql' && segments.length === 2) {
        if (method !== 'POST') {
          sendReply(res, errorReply(404, 'Not Found'), requestId);
          return;
        }
        if (!authorized(req)) {
          sendReply(res, errorReply(401, 'Requires authentication'), requestId);
          return;
        }
        sendReply(res, routeGraphQL(body), requestId);
        return;
      }
    }

    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method === 'POST') {
        if (!authorized(req)) {
          sendReply(res, errorReply(401, 'Requires authentication'), requestId);
          return;
        }
        sendReply(res, routeMcp(body), requestId);
        return;
      }
      if (method === 'DELETE') {
        sendReply(res, emptyReply(405), requestId);
        return;
      }
      sendReply(res, errorReply(405, 'Method not allowed'), requestId);
      return;
    }

    sendReply(res, errorReply(404, 'Not Found'), requestId);
  } catch (err) {
    try {
      const message = err instanceof Error ? err.message : String(err);
      sendReply(res, errorReply(500, `Internal error: ${message}`), requestId);
    } catch {
      // The reply itself failed; the connection is already gone.
    }
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function buildServer(): Server {
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.keepAliveTimeout = 5000;
  return server;
}
