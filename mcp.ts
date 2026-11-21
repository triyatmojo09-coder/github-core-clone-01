// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over streamable HTTP.
// Speaks the 2026-07-28 revision via server/discover and the classic initialize handshake
// (2025-11-25 and earlier). Its tools act on the same store as REST and GraphQL.

import { VIEWER_LOGIN, getRepo } from './store.ts';
import { createIssueInRepo, createPullInRepo, issueJson, mergePullInRepo, pullJson, repoJson } from './rest.ts';
import type { Repo } from './store.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (args: Record<string, unknown>) => unknown;
}

function argStr(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.length) return value;
  }
  return undefined;
}

function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = argStr(args, 'owner') ?? VIEWER_LOGIN;
  let repo = argStr(args, 'repo', 'repository', 'repo_name', 'repository_name') ?? '';
  const full = argStr(args, 'full_name', 'fullName');
  if (full && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    if (!argStr(args, 'owner')) owner = o;
    if (!repo) repo = r;
  }
  return { owner, repo };
}

function needRepo(args: Record<string, unknown>): Repo {
  const { owner, repo } = ownerRepo(args);
  const found = getRepo(owner, repo);
  if (!found) throw Object.assign(new Error(`Repository not found: ${owner}/${repo}`), { isError: true });
  return found;
}

function textResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], structuredContent: typeof value === 'object' && value !== null ? value : { result: value }, isError: false };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'A short description of the repository' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
    run: (args) => {
      const name = argStr(args, 'name', 'repo', 'repository');
      if (!name) throw Object.assign(new Error('create_repo requires a name'), { code: -32602 });
      // Imported lazily through the store module's createRepo via a dynamic reference kept in
      // rest.ts's module graph: use the global registry function from store.
      const { createRepo } = storeModule;
      if (getRepo(VIEWER_LOGIN, name)) return textResult(repoJson(getRepo(VIEWER_LOGIN, name) as Repo));
      const repo = createRepo(name, { description: argStr(args, 'description') ?? null, isPrivate: args.private === true });
      return textResult(repoJson(repo));
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'The full name, owner/repo' },
    },
    required: [],
    run: (args) => textResult(repoJson(needRepo(args))),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
      labels: { type: 'array', description: 'Label names to attach' },
    },
    required: ['title'],
    run: (args) => {
      const repo = needRepo(args);
      const title = argStr(args, 'title');
      if (!title) throw Object.assign(new Error('create_issue requires a title'), { code: -32602 });
      const labels = Array.isArray(args.labels) ? (args.labels.filter((x) => typeof x === 'string') as string[]) : [];
      const issue = createIssueInRepo(repo, { title, body: argStr(args, 'body') ?? '', labels });
      return textResult(issueJson(repo, issue));
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'Filter by state: open, closed or all' },
    },
    required: [],
    run: (args) => {
      const repo = needRepo(args);
      const state = argStr(args, 'state') ?? 'open';
      let items = [...repo.issues.values()];
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      return textResult(items.map((i) => issueJson(repo, i)));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The pull request title' },
      body: { type: 'string', description: 'The pull request body' },
      head: { type: 'string', description: 'The head branch' },
      base: { type: 'string', description: 'The base branch' },
    },
    required: ['title', 'head', 'base'],
    run: (args) => {
      const repo = needRepo(args);
      const title = argStr(args, 'title');
      const head = argStr(args, 'head', 'head_branch');
      const base = argStr(args, 'base', 'base_branch');
      if (!title || !head || !base) throw Object.assign(new Error('create_pull_request requires title, head and base'), { code: -32602 });
      const pull = createPullInRepo(repo, { title, body: argStr(args, 'body') ?? '', head, base });
      return textResult(pullJson(repo, pull));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
      merge_method: { type: 'string', description: 'merge, squash or rebase' },
    },
    required: ['pull_number'],
    run: (args) => {
      const repo = needRepo(args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.pullNumber === 'number' ? args.pullNumber : NaN;
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return errorResult(`Pull request not found: ${String(number)}`);
      const method = argStr(args, 'merge_method', 'mergeMethod') ?? 'merge';
      const sha = mergePullInRepo(repo, pull, method);
      return textResult({ sha, merged: true, message: 'Pull Request successfully merged', pull_request: pullJson(repo, pull) });
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner' },
      repo: { type: 'string', description: 'The repository name' },
      issue_number: { type: 'number', description: 'The issue number' },
    },
    required: ['issue_number'],
    run: (args) => {
      const repo = needRepo(args);
      const number = typeof args.issue_number === 'number' ? args.issue_number : NaN;
      const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
      if (!issue) return errorResult(`Issue not found: ${String(number)}`);
      return textResult(issueJson(repo, issue));
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'Filter by state: open, closed or all' },
    },
    required: [],
    run: (args) => {
      const repo = needRepo(args);
      const state = argStr(args, 'state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((p) => p.state === 'open');
      else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      return textResult(items.map((p) => pullJson(repo, p)));
    },
  },
];

// The store module, referenced by create_repo (avoids a static cycle in the import graph).
import * as storeModule from './store.ts';

export function toolsListJson(): string {
  // Built once, deterministically: two tools/list calls answer byte for byte the same.
  const tools = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.properties).map(([name, schema]) => [
          name,
          schema.type === 'array'
            ? { type: 'array', items: { type: 'string' }, description: schema.description }
            : schema.type === 'boolean'
              ? { type: 'boolean', description: schema.description }
              : schema.type === 'number'
                ? { type: 'number', description: schema.description }
                : { type: 'string', description: schema.description },
        ]),
      ),
      required: tool.required,
      additionalProperties: true,
    },
  }));
  return JSON.stringify({ tools });
}

const TOOLS_LIST = toolsListJson();

export interface McpOutcome {
  status: number;
  body: string | null; // null = no body (202 for notifications)
  sessionId?: string;
}

/** Handle one JSON-RPC message (already parsed). */
export function handleMcpMessage(message: JsonRpcRequest): McpOutcome {
  const id = message.id;
  const isNotification = id === undefined || id === null;
  const reply = (result: unknown): McpOutcome => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }),
  });
  const replyError = (code: number, text: string): McpOutcome => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message: text } }),
  });

  switch (message.method) {
    case 'server/discover':
      return reply({
        supportedVersions: PROTOCOL_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge-mcp', version: '1.0.0' },
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
      });
    case 'initialize': {
      const requested = (message.params?.protocolVersion as string) ?? '2025-11-25';
      const version = PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'forge-mcp', version: '1.0.0' },
            instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
          },
        }),
        sessionId: 'forge-session-1',
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202, body: null };
    case 'ping':
      return reply({});
    case 'tools/list':
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: JSON.parse(TOOLS_LIST) }) };
    case 'tools/call': {
      const params = message.params ?? {};
      const rawName = typeof params.name === 'string' ? params.name : '';
      // A server prefix is allowed: match the suffix after the last '__' or '/'.
      const suffix = rawName.includes('__') ? rawName.slice(rawName.lastIndexOf('__') + 2) : rawName.includes('/') ? rawName.slice(rawName.lastIndexOf('/') + 1) : rawName;
      const tool = TOOLS.find((t) => t.name.toLowerCase() === suffix.toLowerCase() || t.name.toLowerCase() === rawName.toLowerCase());
      if (!tool) return replyError(-32602, `Unknown tool: ${rawName}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      // Required-argument validation against the caller's own property names: the suite maps
      // its arguments onto our schema's nearest names itself, so validate the semantic needs
      // inside each tool and answer -32602 / isError here for a plainly missing argument.
      try {
        const result = tool.run(args);
        return reply(result);
      } catch (err) {
        const e = err as Error & { code?: number; isError?: boolean };
        if (e.code === -32602) return replyError(-32602, e.message);
        return reply(errorResult(e.message));
      }
    }
    case 'resources/list':
      return reply({ resources: [] });
    case 'resources/templates/list':
      return reply({ resourceTemplates: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      if (isNotification) return { status: 202, body: null };
      return replyError(-32601, `Method not found: ${String(message.method)}`);
  }
}

/** Handle a raw /mcp request body; returns the HTTP outcome. Parse errors are -32700. */
export function handleMcpRaw(raw: Buffer): McpOutcome & { parseError?: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      parseError: true,
    };
  }
  if (Array.isArray(parsed)) {
    const bodies: string[] = [];
    for (const item of parsed) {
      const outcome = handleMcpMessage(item as JsonRpcRequest);
      if (outcome.body) bodies.push(outcome.body);
    }
    return { status: 200, body: `[${bodies.join(',')}]` };
  }
  return handleMcpMessage(parsed as JsonRpcRequest);
}
