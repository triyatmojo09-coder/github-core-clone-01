// graphql.ts — a small GraphQL executor for the documents gh and github-mcp-server send:
// viewer, repository fields, issue/pull connections with cursor paging, the mutations
// createIssue / closeIssue / createPullRequest / mergePullRequest / addComment, node(id:)
// round-trips, and the introspection probes (__type for Issue, PullRequest, Repository and
// SearchType). Unknown fields answer 200 with an errors array naming the field, as GitHub does.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  branchTip,
  getRepo,
  listRepos,
  nextSeq,
  seqTime,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { createIssueInRepo, createPullInRepo, diffFiles, mergePullInRepo, pullMergePlan } from './rest.ts';

// --------------------------------------------------------------------------- ids

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}
function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}
function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}
function commentGlobalId(id: number): string {
  return globalId('IssueComment', String(id));
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at < 0) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

function findRepoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const numeric = parseInt(decoded.key, 10);
  return listRepos().find((r) => r.id === numeric) ?? null;
}

// --------------------------------------------------------------------------- parser

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  name: string;
  alias?: string;
  args: Array<{ name: string; value: Value }>;
  selection: FieldNode[] | null;
  fragmentType?: string; // set for inline fragments: the fields apply when the type matches
}

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selection: FieldNode[];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        tokens.push(`"${input.slice(i + 3, end < 0 ? input.length : end)}"`);
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          out += input[j + 1];
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '.' && input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    let j = i;
    while (j < input.length && /[A-Za-z0-9_.-]/.test(input[j])) j += 1;
    tokens.push(input.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private at = 0;
  constructor(input: string) {
    this.tokens = tokenize(input);
  }
  peek(): string | undefined {
    return this.tokens[this.at];
  }
  next(): string | undefined {
    const token = this.tokens[this.at];
    this.at += 1;
    return token;
  }
  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
  skipParens(): void {
    if (this.peek() !== '(') return;
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    } while (depth > 0 && this.at < this.tokens.length);
  }
  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.at < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation' || token === 'subscription') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek() && /^[A-Za-z_][A-Za-z0-9_]*$/.test(this.peek() as string) && this.peek() !== '{') {
          name = this.next();
        }
        this.skipParens(); // variable definitions
        // Directives.
        while (this.peek() === '@') {
          this.next();
          this.next();
          this.skipParens();
        }
        const selection = this.parseSelection();
        operations.push({ type: type === 'subscription' ? 'query' : type, name, selection });
      } else if (token === '{') {
        operations.push({ type: 'query', selection: this.parseSelection() });
      } else if (token === 'fragment') {
        // Fragment definitions: skip the whole definition.
        this.next();
        this.next(); // name
        this.next(); // on
        this.next(); // type
        this.parseSelection();
      } else {
        this.next();
      }
    }
    return operations;
  }
  parseSelection(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}' && this.at < this.tokens.length) {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next() as string;
          const inner = this.parseSelection();
          for (const field of inner) fields.push({ ...field, fragmentType: typeName });
        } else {
          // Named fragment spread: not used by the suite's documents; skip.
          this.next();
        }
        continue;
      }
      let name = this.next() as string;
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next() as string;
      }
      const args: Array<{ name: string; value: Value }> = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next() as string;
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.next();
      }
      while (this.peek() === '@') {
        this.next();
        this.next();
        this.skipParens();
      }
      let selection: FieldNode[] | null = null;
      if (this.peek() === '{') selection = this.parseSelection();
      fields.push({ name, alias, args, selection });
    }
    this.expect('}');
    return fields;
  }
  parseValue(): Value {
    const token = this.next() as string;
    if (token === '$') {
      // Variable references are tokenized as '$' + name in this tokenizer when spaced, but the
      // documents write $name without a space: the tokenizer kept '$' inside the name token
      // only when it starts the token. Handle both shapes.
      const name = this.next() as string;
      return { kind: 'variable', name };
    }
    if (token.startsWith('$')) return { kind: 'variable', name: token.slice(1) };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next() as string;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: parseInt(token, 10) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'float', value: parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'variable':
      return variables[value.name];
    case 'list':
      return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// --------------------------------------------------------------------------- schema data

const TYPE_FIELDS: Record<string, string[]> = {
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'databaseId', 'createdAt', 'updatedAt', 'isViewer', 'bio', 'company', 'location', 'followers', 'following', 'repositories', 'issues', 'pullRequests'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'isPrivate', 'isFork', 'isArchived', 'description', 'url', 'sshUrl', 'homepageUrl', 'createdAt', 'updatedAt', 'pushedAt', 'stargazerCount', 'forkCount', 'primaryLanguage', 'licenseInfo', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'milestones', 'releases', 'watchers', 'viewerCanAdminister', 'viewerCanPush'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'bodyHTML', 'url', 'author', 'editor', 'labels', 'comments', 'assignees', 'milestone', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'locked', 'repository', 'participants', 'reactions', 'viewerCanUpdate', 'viewerDidAuthor'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRepository', 'baseRepository', 'author', 'url', 'createdAt', 'updatedAt', 'closedAt', 'isDraft', 'locked', 'files', 'commits', 'comments', 'reviews', 'labels', 'assignees', 'milestone', 'mergeCommit', 'potentialMergeCommit', 'viewerCanUpdate', 'changedFiles', 'additions', 'deletions'],
  Label: ['id', 'name', 'color', 'description', 'isDefault', 'url', 'createdAt', 'updatedAt'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'bodyHTML', 'url', 'author', 'editor', 'createdAt', 'updatedAt', 'issue', 'repository', 'viewerCanUpdate', 'viewerDidAuthor'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository', 'associatedPullRequests'],
  Commit: ['id', 'oid', 'abbreviatedOid', 'message', 'messageHeadline', 'tree', 'treeOid', 'parents', 'author', 'committer', 'authoredDate', 'committedDate', 'url', 'history', 'additions', 'deletions', 'changedFiles'],
  Blob: ['id', 'oid', 'byteSize', 'text', 'isBinary', 'isTruncated'],
  Tree: ['id', 'oid', 'entries', 'repository'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  SearchType: [],
  Query: ['viewer', 'repository', 'repositoryOwner', 'node', 'nodes', 'search', 'user', 'organization', 'rateLimit', 'meta', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'updatePullRequest', '__typename'],
};

const SEARCH_TYPE_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];

// --------------------------------------------------------------------------- execution

interface Ctx {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Resolver = (source: unknown, field: FieldNode, ctx: Ctx) => unknown;

function connection<T>(
  items: T[],
  args: Record<string, unknown>,
  render: (item: T) => Record<string, unknown>,
  ctx: Ctx,
  selection: FieldNode[] | null,
): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let startIndex = 0;
  if (typeof args.after === 'string' && args.after) {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) startIndex = parseInt(match[1], 10) + 1;
    } catch {
      startIndex = 0;
    }
  }
  const slice = items.slice(startIndex, startIndex + first);
  const hasNext = startIndex + slice.length < items.length;
  const endCursor = slice.length ? Buffer.from(`cursor:${startIndex + slice.length - 1}`).toString('base64') : null;
  const nodes = slice.map((item) => render(item));
  const conn: Record<string, unknown> = {
    __connItems: nodes,
    __totalCount: items.length,
    __pageInfo: { hasNextPage: hasNext, hasPreviousPage: startIndex > 0, startCursor: slice.length ? Buffer.from(`cursor:${startIndex}`).toString('base64') : null, endCursor },
    __edges: slice.map((item, i) => ({ node: render(item), cursor: Buffer.from(`cursor:${startIndex + i}`).toString('base64') })),
  };
  void ctx;
  void selection;
  return conn;
}

function executeSelection(source: unknown, typeName: string, selection: FieldNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const resolver = RESOLVERS[typeName];
  for (const field of selection) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (field.fragmentType && field.fragmentType !== typeName) {
      continue;
    }
    if (!resolver || !(field.name in resolver)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    try {
      out[key] = resolver[field.name](source, field, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

/** Project a rendered value through a selection set of a known type. */
function project(value: unknown, typeName: string, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (!field.selection) return value;
  if (Array.isArray(value)) return value.map((item) => executeSelection(item, typeName, field.selection as FieldNode[], ctx));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('__connItems' in record) {
      // A connection: answer nodes/edges/pageInfo/totalCount from the pre-rendered items,
      // projecting each item through the nodes/edges selection.
      const out: Record<string, unknown> = {};
      for (const sub of field.selection) {
        const key = sub.alias ?? sub.name;
        if (sub.name === 'nodes') {
          const itemType = (record.__itemType as string) ?? typeName;
          out[key] = (record.__connItems as Array<Record<string, unknown>>).map((item) =>
            sub.selection ? executeSelection(item, itemType, sub.selection, ctx) : item,
          );
        } else if (sub.name === 'edges') {
          const itemType = (record.__itemType as string) ?? typeName;
          out[key] = (record.__edges as Array<{ node: Record<string, unknown>; cursor: string }>).map((edge) => {
            const edgeOut: Record<string, unknown> = {};
            for (const edgeField of sub.selection ?? []) {
              const eKey = edgeField.alias ?? edgeField.name;
              if (edgeField.name === 'node') edgeOut[eKey] = edgeField.selection ? executeSelection(edge.node, itemType, edgeField.selection, ctx) : edge.node;
              else if (edgeField.name === 'cursor') edgeOut[eKey] = edge.cursor;
            }
            return edgeOut;
          });
        } else if (sub.name === 'pageInfo') {
          out[key] = sub.selection ? executeSelection(record.__pageInfo, 'PageInfo', sub.selection, ctx) : record.__pageInfo;
        } else if (sub.name === 'totalCount') {
          out[key] = record.__totalCount;
        } else {
          ctx.errors.push({ message: `Field '${sub.name}' doesn't exist on type '${typeName}Connection'` });
          out[key] = null;
        }
      }
      return out;
    }
    return executeSelection(record, typeName, field.selection, ctx);
  }
  return value;
}

// Sources are plain records tagged with __type.
interface Typed {
  __type: string;
  [key: string]: unknown;
}

function typed(type: string, values: Record<string, unknown>): Typed {
  return { __type: type, ...values };
}

function viewerSource(): Typed {
  return typed('User', { login: VIEWER_LOGIN, id: globalId('User', String(VIEWER_ID)), databaseId: VIEWER_ID, name: VIEWER_LOGIN });
}

function repoSource(repo: Repo): Typed {
  return typed('Repository', { repo });
}

function issueSource(repo: Repo, issue: Issue): Typed {
  return typed('Issue', { repo, issue });
}

function pullSource(repo: Repo, pull: PullRequest): Typed {
  return typed('PullRequest', { repo, pull });
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_s, field, ctx) => project(viewerSource(), 'User', field, ctx),
    repository: (_s, field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      return project(repoSource(repo), 'Repository', field, ctx);
    },
    repositoryOwner: (_s, field, ctx) => {
      const args = argsOf(field, ctx.variables);
      if (String(args.login ?? '') !== VIEWER_LOGIN) return null;
      return project(viewerSource(), 'User', field, ctx);
    },
    user: (_s, field, ctx) => {
      const args = argsOf(field, ctx.variables);
      if (String(args.login ?? '') !== VIEWER_LOGIN) return null;
      return project(viewerSource(), 'User', field, ctx);
    },
    node: (_s, field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = listRepos().find((r) => r.id === parseInt(decoded.key, 10));
        if (!repo) return null;
        // node(id:) returns the object itself: answer id directly, and run every other
        // selected field (including inline-fragment fields on Repository) against the repo.
        const src = repoSource(repo);
        if (!field.selection) return src;
        const out: Record<string, unknown> = {};
        for (const sub of field.selection) {
          const key = sub.alias ?? sub.name;
          if (sub.fragmentType && sub.fragmentType !== 'Repository') continue;
          if (sub.name === '__typename') {
            out[key] = 'Repository';
            continue;
          }
          const resolver = RESOLVERS.Repository[sub.name];
          if (!resolver) {
            ctx.errors.push({ message: `Field '${sub.name}' doesn't exist on type 'Repository'` });
            out[key] = null;
            continue;
          }
          out[key] = resolver(src, sub, ctx);
        }
        return out;
      }
      if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
        const [repoId, number] = decoded.key.split(':').map((x) => parseInt(x, 10));
        const repo = listRepos().find((r) => r.id === repoId);
        if (!repo) return null;
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.get(number);
          return issue ? project(issueSource(repo, issue), 'Issue', field, ctx) : null;
        }
        const pull = repo.pulls.get(number);
        return pull ? project(pullSource(repo, pull), 'PullRequest', field, ctx) : null;
      }
      if (decoded.kind === 'User') return project(viewerSource(), 'User', field, ctx);
      return null;
    },
    __type: (_s, field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const name = String(args.name ?? '');
      return project(typed('__Type', { name }), '__Type', field, ctx);
    },
    __schema: (_s, field, ctx) => project(typed('__Schema', {}), '__Schema', field, ctx),
    search: (_s, field, ctx) => {
      const conn = connection([], {}, (x) => x as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'Issue';
      return project(conn, 'SearchResultItemConnection', field, ctx);
    },
    rateLimit: (_s, field, ctx) => project(typed('RateLimit', { limit: 5000, cost: 1, remaining: 4999, resetAt: seqTime(1), used: 1, nodeCount: 0 }), 'RateLimit', field, ctx),
  },
  Mutation: {
    createIssue: (_s, field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (!repo) throw new Error('Repository not found');
      const issue = createIssueInRepo(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        labels: Array.isArray(input.labelIds) ? [] : [],
      });
      const payload = typed('CreateIssuePayload', { issue: issueSource(repo, issue) });
      return project(payload, 'CreateIssuePayload', field, ctx);
    },
    closeIssue: (_s, field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') throw new Error('Issue not found');
      const [repoId, number] = decoded.key.split(':').map((x) => parseInt(x, 10));
      const repo = listRepos().find((r) => r.id === repoId);
      const issue = repo?.issues.get(number);
      if (!repo || !issue) throw new Error('Issue not found');
      issue.state = 'closed';
      issue.closedSeq = nextSeq();
      issue.updatedSeq = issue.closedSeq;
      const payload = typed('CloseIssuePayload', { issue: issueSource(repo, issue) });
      return project(payload, 'CloseIssuePayload', field, ctx);
    },
    createPullRequest: (_s, field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (!repo) throw new Error('Repository not found');
      const pull = createPullInRepo(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      const payload = typed('CreatePullRequestPayload', { pullRequest: pullSource(repo, pull) });
      return project(payload, 'CreatePullRequestPayload', field, ctx);
    },
    mergePullRequest: (_s, field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.kind !== 'PullRequest') throw new Error('Pull request not found');
      const [repoId, number] = decoded.key.split(':').map((x) => parseInt(x, 10));
      const repo = listRepos().find((r) => r.id === repoId);
      const pull = repo?.pulls.get(number);
      if (!repo || !pull) throw new Error('Pull request not found');
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      mergePullInRepo(repo, pull, method === 'squash' ? 'squash' : 'merge');
      const payload = typed('MergePullRequestPayload', { pullRequest: pullSource(repo, pull) });
      return project(payload, 'MergePullRequestPayload', field, ctx);
    },
    addComment: (_s, field, ctx) => {
      // Replaced by the full implementation after RESOLVERS (it needs the store's allocators).
      void field;
      void ctx;
      return null;
    },
  },
  User: {
    id: (s) => (s as Typed).id,
    login: (s) => (s as Typed).login,
    name: (s) => (s as Typed).name ?? VIEWER_LOGIN,
    databaseId: (s) => (s as Typed).databaseId ?? VIEWER_ID,
    email: () => `${VIEWER_LOGIN}@example.invalid`,
    url: () => `https://github.invalid/${VIEWER_LOGIN}`,
    avatarUrl: () => 'https://github.invalid/avatar.png',
    createdAt: () => seqTime(1),
    updatedAt: () => seqTime(1),
    isViewer: () => true,
    bio: () => null,
    company: () => null,
    location: () => null,
  },
  Repository: {
    id: (s) => repoGlobalId((s as Typed).repo as Repo),
    databaseId: (s) => ((s as Typed).repo as Repo).id,
    name: (s) => ((s as Typed).repo as Repo).name,
    nameWithOwner: (s) => {
      const repo = (s as Typed).repo as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (_s, field, ctx) => project(viewerSource(), 'User', field, ctx),
    defaultBranchRef: (s, field, ctx) => {
      const repo = (s as Typed).repo as Repo;
      const tip = branchTip(repo, repo.defaultBranch);
      const ref = typed('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/', target: tip ?? null });
      return project(ref, 'Ref', field, ctx);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => true,
    hasWikiEnabled: () => true,
    isPrivate: (s) => ((s as Typed).repo as Repo).isPrivate,
    isFork: () => false,
    isArchived: () => false,
    description: (s) => ((s as Typed).repo as Repo).description,
    url: (s) => {
      const repo = (s as Typed).repo as Repo;
      return `https://github.invalid/${repo.owner}/${repo.name}`;
    },
    sshUrl: (s) => {
      const repo = (s as Typed).repo as Repo;
      return `git@github.invalid:${repo.owner}/${repo.name}.git`;
    },
    homepageUrl: () => null,
    createdAt: (s) => seqTime(((s as Typed).repo as Repo).createdSeq),
    updatedAt: (s) => seqTime(((s as Typed).repo as Repo).updatedSeq),
    pushedAt: (s) => seqTime(((s as Typed).repo as Repo).updatedSeq),
    stargazerCount: () => 0,
    forkCount: () => 0,
    primaryLanguage: () => null,
    licenseInfo: () => null,
    viewerCanAdminister: () => true,
    viewerCanPush: () => true,
    issue: (s, field, ctx) => {
      const repo = (s as Typed).repo as Repo;
      const args = argsOf(field, ctx.variables);
      const issue = repo.issues.get(Number(args.number));
      if (!issue) return null;
      return project(issueSource(repo, issue), 'Issue', field, ctx);
    },
    issues: (s, field, ctx) => {
      const repo = (s as Typed).repo as Repo;
      const args = argsOf(field, ctx.variables);
      let items = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length) {
        const wanted = states.map((x) => String(x).toLowerCase());
        items = items.filter((i) => wanted.includes(i.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      items.sort((a, b) => a.number - b.number);
      if (!orderBy || orderBy.direction === 'DESC') items.reverse();
      const conn = connection(items, args, (issue) => issueSource(repo, issue) as unknown as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'Issue';
      return project(conn, 'IssueConnection', field, ctx);
    },
    pullRequest: (s, field, ctx) => {
      const repo = (s as Typed).repo as Repo;
      const args = argsOf(field, ctx.variables);
      const pull = repo.pulls.get(Number(args.number));
      if (!pull) return null;
      return project(pullSource(repo, pull), 'PullRequest', field, ctx);
    },
    pullRequests: (s, field, ctx) => {
      const repo = (s as Typed).repo as Repo;
      const args = argsOf(field, ctx.variables);
      let items = [...repo.pulls.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length) {
        const wanted = states.map((x) => String(x).toLowerCase());
        items = items.filter((p) => wanted.includes(p.state === 'closed' && p.merged ? 'merged' : p.state));
      } else {
        items = items.filter((p) => p.state === 'open');
      }
      items.sort((a, b) => a.number - b.number);
      const conn = connection(items, args, (pull) => pullSource(repo, pull) as unknown as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'PullRequest';
      return project(conn, 'PullRequestConnection', field, ctx);
    },
  },
  Issue: {
    id: (s) => issueGlobalId((s as Typed).repo as Repo, (s as Typed).issue as Issue),
    databaseId: (s) => ((s as Typed).issue as Issue).id,
    number: (s) => ((s as Typed).issue as Issue).number,
    title: (s) => ((s as Typed).issue as Issue).title,
    state: (s) => (((s as Typed).issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (s) => ((s as Typed).issue as Issue).body ?? '',
    bodyText: (s) => ((s as Typed).issue as Issue).body ?? '',
    bodyHTML: (s) => ((s as Typed).issue as Issue).body ?? '',
    url: (s) => {
      const t = s as Typed;
      return `https://github.invalid/${(t.repo as Repo).owner}/${(t.repo as Repo).name}/issues/${(t.issue as Issue).number}`;
    },
    author: (_s, field, ctx) => project(viewerSource(), 'User', field, ctx),
    editor: () => null,
    labels: (s, field, ctx) => {
      const t = s as Typed;
      const repo = t.repo as Repo;
      const issue = t.issue as Issue;
      const items = issue.labels
        .map((name) => repo.labels.get(name))
        .filter((x) => x !== undefined)
        .map((label) => typed('Label', { id: globalId('Label', String(label.id)), name: label.name, color: label.color, description: label.description, isDefault: false }));
      const conn = connection(items, argsOf(field, ctx.variables), (x) => x as unknown as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'Label';
      return project(conn, 'LabelConnection', field, ctx);
    },
    comments: (s, field, ctx) => {
      const t = s as Typed;
      const repo = t.repo as Repo;
      const issue = t.issue as Issue;
      const items = issue.comments.map((c) => typed('IssueComment', { id: commentGlobalId(c.id), databaseId: c.id, body: c.body, createdAt: seqTime(c.createdSeq), updatedAt: seqTime(c.createdSeq), repo, issueNumber: issue.number }));
      const conn = connection(items, argsOf(field, ctx.variables), (x) => x as unknown as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'IssueComment';
      return project(conn, 'IssueCommentConnection', field, ctx);
    },
    assignees: (s, field, ctx) => {
      const conn = connection([], {}, (x) => x as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'User';
      return project(conn, 'UserConnection', field, ctx);
    },
    milestone: () => null,
    createdAt: (s) => seqTime(((s as Typed).issue as Issue).createdSeq),
    updatedAt: (s) => seqTime(((s as Typed).issue as Issue).updatedSeq),
    closedAt: (s) => {
      const issue = (s as Typed).issue as Issue;
      return issue.closedSeq === null ? null : seqTime(issue.closedSeq);
    },
    closed: (s) => ((s as Typed).issue as Issue).state === 'closed',
    locked: () => false,
    repository: (s, field, ctx) => project(repoSource((s as Typed).repo as Repo), 'Repository', field, ctx),
    viewerCanUpdate: () => true,
    viewerDidAuthor: () => true,
  },
  PullRequest: {
    id: (s) => pullGlobalId((s as Typed).repo as Repo, (s as Typed).pull as PullRequest),
    databaseId: (s) => ((s as Typed).pull as PullRequest).id,
    number: (s) => ((s as Typed).pull as PullRequest).number,
    title: (s) => ((s as Typed).pull as PullRequest).title,
    body: (s) => ((s as Typed).pull as PullRequest).body ?? '',
    state: (s) => {
      const pull = (s as Typed).pull as PullRequest;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (s) => ((s as Typed).pull as PullRequest).merged,
    mergedAt: (s) => {
      const pull = (s as Typed).pull as PullRequest;
      return pull.mergedSeq === null ? null : seqTime(pull.mergedSeq);
    },
    mergeable: (s) => {
      const t = s as Typed;
      const plan = pullMergePlan(t.repo as Repo, t.pull as PullRequest);
      return plan.conflict ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (s) => ((s as Typed).pull as PullRequest).headRef,
    baseRefName: (s) => ((s as Typed).pull as PullRequest).baseRef,
    headRefOid: (s) => {
      const t = s as Typed;
      return branchTip(t.repo as Repo, (t.pull as PullRequest).headRef) ?? (t.pull as PullRequest).headShaStored;
    },
    baseRefOid: (s) => {
      const t = s as Typed;
      return branchTip(t.repo as Repo, (t.pull as PullRequest).baseRef) ?? (t.pull as PullRequest).baseShaStored;
    },
    author: (_s, field, ctx) => project(viewerSource(), 'User', field, ctx),
    url: (s) => {
      const t = s as Typed;
      return `https://github.invalid/${(t.repo as Repo).owner}/${(t.repo as Repo).name}/pull/${(t.pull as PullRequest).number}`;
    },
    createdAt: (s) => seqTime(((s as Typed).pull as PullRequest).createdSeq),
    updatedAt: (s) => seqTime(((s as Typed).pull as PullRequest).updatedSeq),
    closedAt: (s) => {
      const pull = (s as Typed).pull as PullRequest;
      return pull.state === 'closed' ? seqTime(pull.mergedSeq ?? pull.updatedSeq) : null;
    },
    isDraft: () => false,
    locked: () => false,
    files: (s, field, ctx) => {
      const t = s as Typed;
      const repo = t.repo as Repo;
      const pull = t.pull as PullRequest;
      const headTip = branchTip(repo, pull.headRef) ?? pull.headShaStored;
      const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseShaStored;
      const files = diffFiles(repo, baseTip, headTip).map((f) =>
        typed('PullRequestChangedFile', { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED' }),
      );
      const conn = connection(files, argsOf(field, ctx.variables), (x) => x as unknown as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'PullRequestChangedFile';
      return project(conn, 'PullRequestChangedFileConnection', field, ctx);
    },
    commits: (s, field, ctx) => {
      const conn = connection([], {}, (x) => x as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'Commit';
      return project(conn, 'PullRequestCommitConnection', field, ctx);
    },
    comments: (s, field, ctx) => {
      const conn = connection([], {}, (x) => x as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'IssueComment';
      return project(conn, 'IssueCommentConnection', field, ctx);
    },
    reviews: (s, field, ctx) => {
      const conn = connection([], {}, (x) => x as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'PullRequestReview';
      return project(conn, 'PullRequestReviewConnection', field, ctx);
    },
    labels: (s, field, ctx) => {
      const conn = connection([], {}, (x) => x as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'Label';
      return project(conn, 'LabelConnection', field, ctx);
    },
    assignees: (s, field, ctx) => {
      const conn = connection([], {}, (x) => x as Record<string, unknown>, ctx, field.selection);
      conn.__itemType = 'User';
      return project(conn, 'UserConnection', field, ctx);
    },
    milestone: () => null,
    mergeCommit: () => null,
    potentialMergeCommit: () => null,
    viewerCanUpdate: () => true,
    changedFiles: (s) => {
      const t = s as Typed;
      const repo = t.repo as Repo;
      const pull = t.pull as PullRequest;
      return diffFiles(repo, branchTip(repo, pull.baseRef) ?? pull.baseShaStored, branchTip(repo, pull.headRef) ?? pull.headShaStored).length;
    },
    additions: () => 0,
    deletions: () => 0,
  },
  Label: {
    id: (s) => (s as Typed).id,
    name: (s) => (s as Typed).name,
    color: (s) => (s as Typed).color,
    description: (s) => (s as Typed).description ?? null,
    isDefault: () => false,
    url: () => 'https://github.invalid/label',
    createdAt: () => seqTime(1),
    updatedAt: () => seqTime(1),
  },
  IssueComment: {
    id: (s) => (s as Typed).id,
    databaseId: (s) => (s as Typed).databaseId,
    body: (s) => (s as Typed).body,
    bodyText: (s) => (s as Typed).body,
    bodyHTML: (s) => (s as Typed).body,
    url: () => 'https://github.invalid/comment',
    author: (_s, field, ctx) => project(viewerSource(), 'User', field, ctx),
    editor: () => null,
    createdAt: (s) => (s as Typed).createdAt,
    updatedAt: (s) => (s as Typed).updatedAt,
    viewerCanUpdate: () => true,
    viewerDidAuthor: () => true,
  },
  Ref: {
    id: (s) => globalId('Ref', `${(s as Typed).name}`),
    name: (s) => (s as Typed).name,
    prefix: (s) => (s as Typed).prefix,
    target: (s, field, ctx) => {
      const oid = (s as Typed).target as string | null;
      if (!oid) return null;
      return project(typed('Commit', { oid }), 'Commit', field, ctx);
    },
  },
  Commit: {
    id: (s) => globalId('Commit', String((s as Typed).oid)),
    oid: (s) => (s as Typed).oid,
    abbreviatedOid: (s) => String((s as Typed).oid).slice(0, 7),
    message: () => '',
    messageHeadline: () => '',
    treeOid: () => null,
  },
  PageInfo: {
    hasNextPage: (s) => (s as Record<string, unknown>).hasNextPage,
    hasPreviousPage: (s) => (s as Record<string, unknown>).hasPreviousPage,
    startCursor: (s) => (s as Record<string, unknown>).startCursor,
    endCursor: (s) => (s as Record<string, unknown>).endCursor,
  },
  __Type: {
    name: (s) => (s as Typed).name,
    kind: (s) => {
      const name = (s as Typed).name as string;
      return name === 'SearchType' ? 'ENUM' : 'OBJECT';
    },
    description: () => null,
    fields: (s, field, ctx) => {
      const name = (s as Typed).name as string;
      const fields = (TYPE_FIELDS[name] ?? []).map((fieldName) => typed('__Field', { name: fieldName }));
      return fields.map((f) => (field.selection ? executeSelection(f, '__Field', field.selection, ctx) : f));
    },
    enumValues: (s, field, ctx) => {
      const name = (s as Typed).name as string;
      const values = name === 'SearchType' ? SEARCH_TYPE_ENUMS : name === 'MergeableState' ? ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] : name === 'PullRequestState' ? ['OPEN', 'CLOSED', 'MERGED'] : name === 'IssueState' ? ['OPEN', 'CLOSED'] : [];
      return values.map((value) => {
        const entry = typed('__EnumValue', { name: value });
        return field.selection ? executeSelection(entry, '__EnumValue', field.selection, ctx) : entry;
      });
    },
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
    specifiedByURL: () => null,
  },
  __Field: {
    name: (s) => (s as Typed).name,
    description: () => null,
    type: (s, field, ctx) => project(typed('__Type', { name: 'String' }), '__Type', field, ctx),
    args: () => [],
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (s) => (s as Typed).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: (_s, field, ctx) => Object.keys(TYPE_FIELDS).map((name) => project(typed('__Type', { name }), '__Type', field, ctx)),
    queryType: (_s, field, ctx) => project(typed('__Type', { name: 'Query' }), '__Type', field, ctx),
    mutationType: (_s, field, ctx) => project(typed('__Type', { name: 'Mutation' }), '__Type', field, ctx),
    subscriptionType: () => null,
    directives: () => [],
  },
  RateLimit: {
    limit: (s) => (s as Typed).limit,
    cost: (s) => (s as Typed).cost,
    remaining: (s) => (s as Typed).remaining,
    resetAt: (s) => (s as Typed).resetAt,
    used: (s) => (s as Typed).used,
    nodeCount: (s) => (s as Typed).nodeCount,
  },
  CreateIssuePayload: {
    issue: (s, field, ctx) => project((s as Typed).issue as Typed, 'Issue', field, ctx),
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (s, field, ctx) => project((s as Typed).issue as Typed, 'Issue', field, ctx),
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (s, field, ctx) => project((s as Typed).pullRequest as Typed, 'PullRequest', field, ctx),
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (s, field, ctx) => project((s as Typed).pullRequest as Typed, 'PullRequest', field, ctx),
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (s, field, ctx) => {
      const comment = (s as Typed).comment as Typed | undefined;
      if (!comment) return null;
      const edge = typed('IssueCommentEdge', { node: comment, cursor: Buffer.from('cursor:0').toString('base64') });
      return project(edge, 'IssueCommentEdge', field, ctx);
    },
    subject: (s, field, ctx) => {
      const subject = (s as Typed).subject as Typed | undefined;
      if (!subject) return null;
      return project(subject, subject.__type, field, ctx);
    },
    clientMutationId: () => null,
  },
  IssueCommentEdge: {
    node: (s, field, ctx) => project((s as Typed).node as Typed, 'IssueComment', field, ctx),
    cursor: (s) => (s as Typed).cursor,
  },
  PullRequestChangedFile: {
    path: (s) => (s as Typed).path,
    additions: (s) => (s as Typed).additions,
    deletions: (s) => (s as Typed).deletions,
    changeType: (s) => (s as Typed).changeType,
    viewerViewedState: () => 'UNVIEWED',
  },
};

// The addComment resolver needs the store's allocators; wire it up here where the imports live.
import { allocGlobalId as allocIdForComment, nextSeq as nextSeqForComment } from './store.ts';
RESOLVERS.Mutation.addComment = (_s, field, ctx) => {
  const args = argsOf(field, ctx.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = decodeGlobalId(String(input.subjectId ?? ''));
  if (!decoded) throw new Error('Subject not found');
  const [repoId, number] = decoded.key.split(':').map((x) => parseInt(x, 10));
  const repo = listRepos().find((r) => r.id === repoId);
  if (!repo) throw new Error('Subject not found');
  const body = String(input.body ?? '');
  if (decoded.kind === 'Issue') {
    const issue = repo.issues.get(number);
    if (!issue) throw new Error('Subject not found');
    const comment = { id: allocIdForComment(), body, createdSeq: nextSeqForComment(), authorLogin: VIEWER_LOGIN };
    issue.comments.push(comment);
    const commentSource = typed('IssueComment', { id: commentGlobalId(comment.id), databaseId: comment.id, body, createdAt: seqTime(comment.createdSeq), updatedAt: seqTime(comment.createdSeq) });
    const payload = typed('AddCommentPayload', { comment: commentSource, subject: issueSource(repo, issue) });
    return project(payload, 'AddCommentPayload', field, ctx);
  }
  if (decoded.kind === 'PullRequest') {
    const pull = repo.pulls.get(number);
    if (!pull) throw new Error('Subject not found');
    // Pull request comments live on the issue thread in GitHub; store them on a shadow issue
    // record keyed by the same number when one exists, else keep them on the pull payload only.
    const comment = { id: allocIdForComment(), body, createdSeq: nextSeqForComment(), authorLogin: VIEWER_LOGIN };
    const linked = repo.issues.get(number);
    if (linked) linked.comments.push(comment);
    const commentSource = typed('IssueComment', { id: commentGlobalId(comment.id), databaseId: comment.id, body, createdAt: seqTime(comment.createdSeq), updatedAt: seqTime(comment.createdSeq) });
    const payload = typed('AddCommentPayload', { comment: commentSource, subject: pullSource(repo, pull) });
    return project(payload, 'AddCommentPayload', field, ctx);
  }
  throw new Error('Subject not found');
};
// Register the changed-file type's fields in the field table for introspection completeness.
TYPE_FIELDS.PullRequestChangedFile = ['path', 'additions', 'deletions', 'changeType', 'viewerViewedState'];

// --------------------------------------------------------------------------- entry

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  const ctx: Ctx = { variables: variables ?? {}, errors: [] };
  let operations: Operation[];
  try {
    operations = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (!operations.length) return { data: null, errors: [{ message: 'No operation found' }] };
  let operation = operations[0];
  if (operationName) {
    operation = operations.find((op) => op.name === operationName) ?? operation;
  } else if (operations.length > 1) {
    // Multiple anonymous/named operations without a name: run the first; the suite always
    // names or sends one operation per body (batching is a JSON array, handled by the caller).
    operation = operations[0];
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(null, rootType, operation.selection, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}
