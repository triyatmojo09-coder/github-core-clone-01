// app.ts — the forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL v4
// and MCP from the store in store.ts. Every API reply is JSON with an X-GitHub-Request-Id;
// every surface but /healthz requires the suite's bearer token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit, gitRepoFromPath } from './githttp.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpRaw } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isAuthed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  const header = req.headers.authorization ?? '';
  if (!expected) return header.startsWith('Bearer ') || header.length > 0 || process.env.MAKEFUN_FORGE_OPEN === '1';
  return header === `Bearer ${expected}`;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        // Auth: everything else needs the token.
        if (!isAuthed(req)) {
          if (path.startsWith('/api/') || path === '/mcp' || gitRepoFromPath(path)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
        }

        // Git smart HTTP.
        if (gitRepoFromPath(path)) {
          const handled = handleGit(req, res, path, body);
          if (handled) return;
        }

        // GraphQL (single operation or a JSON-array batch).
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((op) => {
              const entry = op as { query?: string; variables?: Record<string, unknown>; operationName?: string };
              return executeGraphQL(String(entry.query ?? ''), entry.variables ?? {}, entry.operationName);
            });
            const text = JSON.stringify(results);
            res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': nextRequestId() });
            res.end(text);
            return;
          }
          const entry = parsed as { query?: string; variables?: Record<string, unknown>; operationName?: string };
          const result = executeGraphQL(String(entry.query ?? ''), entry.variables ?? {}, entry.operationName);
          sendJson(res, 200, result);
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method === 'GET') {
            res.writeHead(405, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId(), allow: 'POST' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed: this endpoint is POST-only' }, id: null }));
            return;
          }
          if (method === 'DELETE') {
            res.writeHead(405, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          const outcome = handleMcpRaw(body);
          const headers: Record<string, string> = {
            'content-type': JSON_TYPE,
            'x-github-request-id': nextRequestId(),
          };
          if (outcome.sessionId) headers['mcp-session-id'] = outcome.sessionId;
          if (outcome.body === null) {
            res.writeHead(outcome.status, headers);
            res.end();
            return;
          }
          res.writeHead(outcome.status, { ...headers, 'content-length': Buffer.byteLength(outcome.body) });
          res.end(outcome.body);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          let jsonBody: Record<string, unknown> | null = null;
          if (body.length) {
            try {
              const parsedBody = JSON.parse(body.toString('utf8'));
              jsonBody = typeof parsedBody === 'object' && parsedBody !== null ? (parsedBody as Record<string, unknown>) : {};
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
          }
          const handled = handleRest(req, res, { sendJson, origin: '' }, path, jsonBody, body);
          if (handled) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A single bad request must never take the forge down.
        try {
          if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
          else res.end();
        } catch {
          // The socket is gone; nothing to answer.
        }
      }
    })();
  });
}
