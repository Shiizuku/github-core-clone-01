// The forge's HTTP server: one process answering git smart HTTP, REST v3, GraphQL v4 and MCP
// from a single in-memory store. main.ts owns the trial lifecycle (register, poll, exit); this
// file owns the surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleRest, type RestResult } from './src/rest.ts';
import { handleGitInfoRefs, handleReceivePack, handleUploadPack } from './src/git.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 256 * 1024 * 1024;

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendResult(res: ServerResponse, result: RestResult): void {
  if (result.status === 204) {
    res.writeHead(204, {});
    res.end();
    return;
  }
  if (result.rawBody) {
    res.writeHead(result.status, {
      'content-type': result.contentType ?? 'application/octet-stream',
      'content-length': result.rawBody.length,
      ...(result.headers ?? {}),
    });
    res.end(result.rawBody);
    return;
  }
  sendJson(res, result.status, result.body ?? { message: 'Not Found' }, result.headers);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegments(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = nextRequestId();
    res.setHeader('x-github-request-id', requestId);
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const path = url.pathname;

    // The env's boot probe takes no token.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Everything else needs the trial's bearer token when one is configured.
    const authorization = req.headers.authorization ?? '';
    const authed = token === '' || authorization === `Bearer ${token}`;
    if (!authed) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1] as string);
      const repoName = decodeURIComponent(gitMatch[2] as string);
      const service = gitMatch[3] as string;
      if (service === 'info/refs' && method === 'GET') {
        sendResult(res, handleGitInfoRefs(store, owner, repoName, url.searchParams.get('service') ?? '', req.headers['git-protocol'] as string | undefined));
        return;
      }
      if (service === 'git-upload-pack' && method === 'POST') {
        const body = await readBody(req);
        sendResult(res, handleUploadPack(store, owner, repoName, body, req.headers['git-protocol'] as string | undefined));
        return;
      }
      if (service === 'git-receive-pack' && method === 'POST') {
        const body = await readBody(req);
        sendResult(res, handleReceivePack(store, owner, repoName, body));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // GraphQL v4.
    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      sendResult(res, handleGraphQL(store, parsed));
      return;
    }

    // MCP over streamable HTTP.
    if (path === '/mcp') {
      const raw = await readBody(req);
      sendResult(res, await handleMcp(store, method, raw, req.headers));
      return;
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const segments = decodeSegments(path.slice('/api/v3'.length));
      let body: Record<string, unknown> = {};
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            const parsed: unknown = JSON.parse(raw.toString('utf8'));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
            body = parsed as Record<string, unknown>;
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
        }
      }
      const host = req.headers.host ?? 'localhost';
      const result = handleRest(store, { method, segments, query: url.searchParams, body, baseUrl: `http://${host}` });
      // The API root carries the token's scopes, as api.github.com answers.
      if (segments.length === 0 && method === 'GET' && result.status === 200) {
        result.headers = { ...(result.headers ?? {}), 'x-oauth-scopes': 'repo, read:org' };
      }
      sendResult(res, result);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  return server;
}
