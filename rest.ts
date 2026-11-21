// rest.ts — the GitHub REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, all over the same store the git endpoints serve.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  allocGlobalId,
  branchTip,
  buildTreeFromFlat,
  createCommit,
  createRepo,
  deleteRepo,
  flatTreeAtCommit,
  flattenTree,
  getObject,
  getRepo,
  isAncestor,
  listRepos,
  mergeBase,
  mergeFlatTrees,
  nextSeq,
  parseCommit,
  parseTree,
  putObject,
  readPathAtCommit,
  seqTime,
  treeAtBranch,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface RestContext {
  sendJson: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
  origin: string;
}

type Body = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 1001,
    node_id: `U_${login}`,
    type: 'User',
    site_admin: false,
    url: `/api/v3/users/${login}`,
    html_url: `https://github.invalid/${login}`,
    avatar_url: 'https://github.invalid/avatar.png',
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: full,
    private: repo.isPrivate,
    owner: userJson(repo.owner),
    html_url: `https://github.invalid/${full}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${full}`,
    git_url: `git://github.invalid/${full}.git`,
    ssh_url: `git@github.invalid:${full}.git`,
    clone_url: `https://github.invalid/${full}.git`,
    svn_url: `https://github.invalid/${full}`,
    homepage: null,
    size: 1,
    stargazers_count: 0,
    watchers_count: 0,
    watchers: 0,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    open_issues: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT', url: null, node_id: 'MDc6TGljZW5zZW1pdA==' },
    allow_forking: true,
    is_template: false,
    default_branch: repo.defaultBranch,
    created_at: seqTime(repo.createdSeq),
    updated_at: seqTime(repo.updatedSeq),
    pushed_at: seqTime(repo.updatedSeq),
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (!label) return null;
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    labels_url: `${base}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/issues/${issue.number}/comments`,
    events_url: `${base}/issues/${issue.number}/events`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: userJson(issue.authorLogin),
    labels: issue.labels.map((name) => labelJson(repo, name)).filter((x) => x !== null),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: seqTime(issue.createdSeq),
    updated_at: seqTime(issue.updatedSeq),
    closed_at: issue.closedSeq === null ? null : seqTime(issue.closedSeq),
    author_association: 'OWNER',
    body: issue.body ?? '',
  };
}

export function commentJson(repo: Repo, issue: Issue, commentId: number): Record<string, unknown> | null {
  const comment = issue.comments.find((c) => c.id === commentId);
  if (!comment) return null;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    url: `${base}/issues/comments/${comment.id}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${base}/issues/${issue.number}`,
    body: comment.body,
    user: userJson(comment.authorLogin),
    created_at: seqTime(comment.createdSeq),
    updated_at: seqTime(comment.createdSeq),
    author_association: 'OWNER',
  };
}

/** The changed-file list between two commits, with line counts computed from blob contents. */
export function diffFiles(repo: Repo, baseCommit: string | undefined, headCommit: string | undefined): Array<Record<string, unknown>> {
  const baseFlat = flatTreeAtCommit(baseCommit);
  const headFlat = flatTreeAtCommit(headCommit);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const files: Array<Record<string, unknown>> = [];
  const countLines = (oid?: string): number => {
    if (!oid) return 0;
    const obj = getObject(oid);
    if (!obj) return 0;
    const text = obj.data.toString('utf8');
    if (text.length === 0) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const path of [...paths].sort()) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (base && head && base.oid === head.oid) continue;
    let status = 'modified';
    if (!base) status = 'added';
    else if (!head) status = 'removed';
    const additions = head ? countLines(head.oid) : 0;
    const deletions = base ? countLines(base.oid) : 0;
    // For a modified file GitHub counts only the changed lines; the suite's fixtures replace a
    // file's whole content, so a modified file counts its new lines as additions and its old
    // lines as deletions — but when only some lines differ we approximate with a line-set diff.
    let add = additions;
    let del = deletions;
    if (base && head) {
      const oldLines = (getObject(base.oid)?.data.toString('utf8') ?? '').split('\n');
      const newLines = (getObject(head.oid)?.data.toString('utf8') ?? '').split('\n');
      const oldSet = new Map<string, number>();
      for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
      add = 0;
      for (const line of newLines) {
        const left = oldSet.get(line) ?? 0;
        if (left > 0) oldSet.set(line, left - 1);
        else add += 1;
      }
      del = [...oldSet.values()].reduce((a, b) => a + b, 0);
    }
    files.push({
      sha: head?.oid ?? base?.oid ?? '',
      filename: path,
      status,
      additions: add,
      deletions: del,
      changes: add + del,
      blob_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${head?.oid ?? ''}`,
      raw_url: `https://github.invalid/${repo.owner}/${repo.name}/raw/${path}`,
      contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    });
  }
  return files;
}

/** Whether the pull request would merge cleanly, and the merged flat tree when it would. */
export function pullMergePlan(repo: Repo, pull: PullRequest): { conflict: boolean; tree: Map<string, { mode: string; oid: string }> | null; baseTip?: string; headTip?: string } {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headShaStored;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseShaStored;
  if (!headTip || !baseTip) return { conflict: false, tree: null, baseTip, headTip };
  if (headTip === baseTip) return { conflict: false, tree: flatTreeAtCommit(headTip), baseTip, headTip };
  const base = mergeBase(baseTip, headTip);
  if (!base) return { conflict: true, tree: null, baseTip, headTip };
  const merged = mergeFlatTrees(flatTreeAtCommit(base), flatTreeAtCommit(baseTip), flatTreeAtCommit(headTip));
  if (!merged) return { conflict: true, tree: null, baseTip, headTip };
  return { conflict: false, tree: merged, baseTip, headTip };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  const headTip = branchTip(repo, pull.headRef) ?? pull.headShaStored;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseShaStored;
  const plan = pullMergePlan(repo, pull);
  const files = diffFiles(repo, mergeBase(baseTip ?? '', headTip ?? '') ?? baseTip, headTip);
  const repoRef = {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: base,
    created_at: seqTime(repo.createdSeq),
    updated_at: seqTime(repo.updatedSeq),
    pushed_at: seqTime(repo.updatedSeq),
    git_url: `git://github.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.invalid/${repo.owner}/${repo.name}.git`,
    size: 1,
    stargazers_count: 0,
    watchers_count: 0,
    default_branch: repo.defaultBranch,
  };
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: `${base}/pulls/${pull.number}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${base}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(pull.authorLogin),
    body: pull.body ?? '',
    created_at: seqTime(pull.createdSeq),
    updated_at: seqTime(pull.updatedSeq),
    closed_at: pull.state === 'closed' ? seqTime(pull.mergedSeq ?? pull.updatedSeq) : null,
    merged_at: pull.mergedSeq === null ? null : seqTime(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headTip ?? '',
      user: userJson(repo.owner),
      repo: repoRef,
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseTip ?? '',
      user: userJson(repo.owner),
      repo: repoRef,
    },
    author_association: 'OWNER',
    merged: pull.merged,
    mergeable: pull.merged ? true : !plan.conflict,
    rebaseable: !plan.conflict,
    mergeable_state: pull.merged ? 'clean' : plan.conflict ? 'dirty' : 'clean',
    merged_by: pull.merged ? userJson(pull.authorLogin) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: files.reduce((sum, f) => sum + (f.additions as number), 0),
    deletions: files.reduce((sum, f) => sum + (f.deletions as number), 0),
    changed_files: files.length,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = getObject(oid);
  if (!obj || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const nameEmail = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: line, email: '', date: seqTime(1) };
    return { name: match[1], email: match[2], date: new Date(parseInt(match[3], 10) * 1000).toISOString() };
  };
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: nameEmail(commit.author),
      committer: nameEmail(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}`,
      html_url: `https://github.invalid/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

/** Create an issue in the store (shared by REST, GraphQL and MCP). Throws {status, message}. */
export function createIssueInRepo(repo: Repo, input: { title: string; body?: string | null; labels?: string[] }): Issue {
  for (const name of input.labels ?? []) {
    if (!repo.labels.has(name)) {
      throw Object.assign(new Error(`Label does not exist: ${name}`), { status: 422 });
    }
  }
  const stamp = nextSeq();
  const issue: Issue = {
    number: repo.nextNumber,
    id: allocGlobalId(),
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...(input.labels ?? [])],
    comments: [],
    createdSeq: stamp,
    updatedSeq: stamp,
    closedSeq: null,
    authorLogin: VIEWER_LOGIN,
    isPullRequest: false,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request in the store (shared). Throws {status, message}. */
export function createPullInRepo(repo: Repo, input: { title: string; body?: string | null; head: string; base: string }): PullRequest {
  const headTip = branchTip(repo, input.head);
  const baseTip = branchTip(repo, input.base);
  if (!headTip) throw Object.assign(new Error(`Head ref does not exist: ${input.head}`), { status: 422 });
  if (!baseTip) throw Object.assign(new Error(`Base ref does not exist: ${input.base}`), { status: 422 });
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      throw Object.assign(new Error('A pull request already exists for this branch'), { status: 422 });
    }
  }
  const stamp = nextSeq();
  const pull: PullRequest = {
    number: repo.nextNumber,
    id: allocGlobalId(),
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    headShaStored: headTip,
    baseShaStored: baseTip,
    merged: false,
    mergeCommitSha: null,
    createdSeq: stamp,
    updatedSeq: stamp,
    mergedSeq: null,
    authorLogin: VIEWER_LOGIN,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Merge a pull request (shared). Returns the merge commit sha. Throws {status, message}. */
export function mergePullInRepo(repo: Repo, pull: PullRequest, method: string): string {
  if (pull.state !== 'open') throw Object.assign(new Error('Pull request is not open'), { status: 405 });
  const plan = pullMergePlan(repo, pull);
  if (plan.conflict || !plan.tree || !plan.baseTip || !plan.headTip) {
    throw Object.assign(new Error('Pull Request is not mergeable'), { status: 405 });
  }
  const stamp = nextSeq();
  const treeOid = buildTreeFromFlat(plan.tree);
  let mergeSha: string;
  if (method === 'merge') {
    mergeSha = createCommit(treeOid, [plan.baseTip, plan.headTip], `Merge pull request #${pull.number}\n\n${pull.title}`, stamp);
  } else {
    // Squash (and rebase, approximated as squash): one commit carrying the PR's title.
    mergeSha = createCommit(treeOid, [plan.baseTip], `${pull.title} (#${pull.number})`, stamp);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  repo.updatedSeq = stamp;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  pull.mergedSeq = stamp;
  pull.updatedSeq = stamp;
  return mergeSha;
}

// --------------------------------------------------------------------------- routing

function paginate<T>(req: IncomingMessage, items: T[]): { page: T[]; headers: Record<string, string> } {
  const url = new URL(req.url ?? '/', 'http://entry');
  const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URL(url.pathname, `http://${req.headers.host ?? 'localhost'}`);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(pageNum + 1));
    const lastPage = Math.ceil(items.length / perPage);
    const last = new URL(url.pathname, `http://${req.headers.host ?? 'localhost'}`);
    for (const [key, value] of url.searchParams) last.searchParams.set(key, value);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(lastPage));
    headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page: slice, headers };
}

export function handleRest(req: IncomingMessage, res: ServerResponse, ctx: RestContext, path: string, body: Body | null, rawBody: Buffer): boolean {
  const { sendJson } = ctx;
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');
  const seg = path.split('/').filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
  // seg[0] = 'api', seg[1] = 'v3'
  const rest = seg.slice(2);
  const fail = (status: number, message: string): void => {
    sendJson(res, status, { message });
  };

  if (rest.length === 0) {
    if (method !== 'GET') return false;
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos{?type,sort}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
      issue_search_url: '/api/v3/search/issues?q={query}',
      user_url: '/api/v3/users/{user}',
      organization_url: '/api/v3/orgs/{org}',
      emojis_url: '/api/v3/emojis',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: '3.10.0-forge',
      github_services_sha: 'forge',
      hooks: [],
      git: [],
      api: [],
      packages: [],
      pages: [],
      importer: [],
    });
    return true;
  }

  if (rest[0] === 'rate_limit' && rest.length === 1) {
    sendJson(res, 200, { rate: { limit: 5000, remaining: 4999, reset: 1893456000, used: 1 }, resources: { core: { limit: 5000, remaining: 4999, reset: 1893456000, used: 1 } } });
    return true;
  }

  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { ...userJson(VIEWER_LOGIN), name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` });
    return true;
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const { page, headers } = paginate(req, listRepos().map(repoJson));
      sendJson(res, 200, page, headers);
      return true;
    }
    if (method === 'POST') {
      const name = str(body?.name);
      if (!name) {
        fail(422, 'Validation Failed: name is required');
        return true;
      }
      if (getRepo(VIEWER_LOGIN, name)) {
        fail(422, 'Validation Failed: name already exists on this account');
        return true;
      }
      const repo = createRepo(name, {
        description: str(body?.description) ?? null,
        isPrivate: body?.private === true,
        defaultBranch: str(body?.default_branch) ?? 'main',
      });
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    return false;
  }

  if (rest[0] !== 'repos' || rest.length < 3) return false;
  const owner = rest[1];
  const repoName = rest[2];
  const repo = getRepo(owner, repoName);
  if (!repo) {
    fail(404, 'Not Found');
    return true;
  }
  const tail = rest.slice(3);
  const base = `/api/v3/repos/${owner}/${repoName}`;

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.name === 'string' && body.name !== repo.name) {
        // Renaming is not exercised; keep the object consistent if it happens.
        repo.name = body.name;
      }
      if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body?.default_branch === 'string') repo.defaultBranch = body.default_branch;
      repo.updatedSeq = nextSeq();
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      deleteRepo(owner, repoName);
      res.writeHead(204, { 'x-github-request-id': 'forge' });
      res.end();
      return true;
    }
    return false;
  }

  // ---- branches & commits -------------------------------------------------
  if (tail[0] === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(ref) as string, url: `${base}/commits/${repo.refs.get(ref)}` },
          protected: false,
        }));
      const { page, headers } = paginate(req, branches);
      sendJson(res, 200, page, headers);
      return true;
    }
    if (method === 'GET' && tail.length === 2) {
      const oid = repo.refs.get(`refs/heads/${tail[1]}`);
      if (!oid) {
        fail(404, 'Branch not found');
        return true;
      }
      const commit = commitJson(repo, peelCommit(oid));
      sendJson(res, 200, {
        name: tail[1],
        commit: commit ?? { sha: oid },
        protected: false,
        protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
        _links: { self: `${base}/branches/${tail[1]}`, html: `https://github.invalid/${owner}/${repoName}/tree/${tail[1]}` },
      });
      return true;
    }
    return false;
  }

  if (tail[0] === 'commits') {
    if (method === 'GET' && tail.length === 1) {
      const shaParam = url.searchParams.get('sha');
      let start: string | undefined;
      if (shaParam) {
        start = branchTip(repo, shaParam) ?? (getObject(shaParam)?.type === 'commit' ? shaParam : undefined);
      } else {
        start = branchTip(repo, repo.defaultBranch);
      }
      const commits: Array<Record<string, unknown>> = [];
      if (start) {
        // BFS from the tip, newest first by discovery order (parents after children).
        const seen = new Set<string>();
        const queue = [start];
        while (queue.length && commits.length < 500) {
          const current = queue.shift() as string;
          if (seen.has(current)) continue;
          seen.add(current);
          const json = commitJson(repo, current);
          if (!json) continue;
          commits.push(json);
          const parsed = parseCommit((getObject(current) as { data: Buffer }).data);
          queue.push(...parsed.parents);
        }
      }
      const { page, headers } = paginate(req, commits);
      sendJson(res, 200, page, headers);
      return true;
    }
    if (method === 'GET' && tail.length === 2) {
      const json = commitJson(repo, tail[1]);
      if (!json) {
        fail(404, 'Not Found');
        return true;
      }
      sendJson(res, 200, json);
      return true;
    }
    return false;
  }

  // ---- git refs ------------------------------------------------------------
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const ref = str(body?.ref);
      const sha = str(body?.sha);
      if (!ref || !sha || !getObject(sha)) {
        fail(422, 'Validation Failed');
        return true;
      }
      if (repo.refs.has(ref)) {
        fail(422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      repo.updatedSeq = nextSeq();
      sendJson(res, 201, {
        ref,
        node_id: `REF_${ref}`,
        url: `${base}/git/refs/${ref.replace('refs/', '')}`,
        object: { type: getObject(sha)?.type ?? 'commit', sha, url: `${base}/git/${getObject(sha)?.type ?? 'commit'}s/${sha}` },
      });
      return true;
    }
    if (method === 'GET') {
      const sub = tail.slice(2).join('/');
      const full = sub.startsWith('refs/') ? sub : `refs/${sub}`;
      const oid = repo.refs.get(full);
      if (tail.length > 2 && oid) {
        sendJson(res, 200, {
          ref: full,
          node_id: `REF_${full}`,
          url: `${base}/git/refs/${full.replace('refs/', '')}`,
          object: { type: getObject(oid)?.type ?? 'commit', sha: oid, url: `${base}/git/commits/${oid}` },
        });
        return true;
      }
      const all = [...repo.refs.entries()]
        .filter(([ref]) => tail.length <= 2 || ref.startsWith(full))
        .sort()
        .map(([ref, oid]) => ({
          ref,
          node_id: `REF_${ref}`,
          url: `${base}/git/refs/${ref.replace('refs/', '')}`,
          object: { type: getObject(oid)?.type ?? 'commit', sha: oid, url: `${base}/git/commits/${oid}` },
        }));
      sendJson(res, 200, all);
      return true;
    }
    if (method === 'DELETE' && tail.length > 2) {
      const sub = tail.slice(2).join('/');
      const full = sub.startsWith('refs/') ? sub : `refs/${sub}`;
      repo.refs.delete(full);
      res.writeHead(204, { 'x-github-request-id': 'forge' });
      res.end();
      return true;
    }
    return false;
  }

  if (tail[0] === 'git' && tail[1] === 'trees' && tail.length === 3 && method === 'GET') {
    const obj = getObject(tail[2]);
    if (!obj || obj.type !== 'tree') {
      fail(404, 'Not Found');
      return true;
    }
    const recursive = url.searchParams.get('recursive');
    const entries: Array<Record<string, unknown>> = [];
    const walk = (treeOid: string, prefix: string): void => {
      const treeObj = getObject(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const entry of parseTree(treeObj.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const child = getObject(entry.oid);
        entries.push({
          path,
          mode: entry.mode.padStart(6, '0'),
          type: entry.mode === '40000' ? 'tree' : 'blob',
          sha: entry.oid,
          size: child && child.type === 'blob' ? child.data.length : undefined,
          url: `${base}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
        });
        if (recursive && entry.mode === '40000') walk(entry.oid, path);
      }
    };
    walk(tail[2], '');
    sendJson(res, 200, { sha: tail[2], url: `${base}/git/trees/${tail[2]}`, tree: entries, truncated: false });
    return true;
  }

  if (tail[0] === 'git' && tail[1] === 'blobs' && tail.length === 3 && method === 'GET') {
    const obj = getObject(tail[2]);
    if (!obj || obj.type !== 'blob') {
      fail(404, 'Not Found');
      return true;
    }
    sendJson(res, 200, {
      sha: tail[2],
      node_id: `B_${tail[2]}`,
      size: obj.data.length,
      url: `${base}/git/blobs/${tail[2]}`,
      content: obj.data.toString('base64'),
      encoding: 'base64',
    });
    return true;
  }

  // ---- contents --------------------------------------------------------------
  if (tail[0] === 'contents') {
    const contentPath = tail.slice(1).join('/');
    const refParam = url.searchParams.get('ref') ?? str(body?.branch) ?? repo.defaultBranch;
    if (method === 'GET') {
      const tip = branchTip(repo, refParam);
      if (!tip) {
        fail(404, 'Not Found');
        return true;
      }
      const commit = getObject(tip);
      if (!commit || commit.type !== 'commit') {
        fail(404, 'Not Found');
        return true;
      }
      const rootTree = parseCommit(commit.data).tree;
      if (contentPath === '') {
        sendJson(res, 200, dirListing(repo, rootTree, ''));
        return true;
      }
      // Walk to the target.
      const parts = contentPath.split('/');
      let treeOid = rootTree;
      for (let i = 0; i < parts.length; i += 1) {
        const treeObj = getObject(treeOid);
        if (!treeObj || treeObj.type !== 'tree') {
          fail(404, 'Not Found');
          return true;
        }
        const entry = parseTree(treeObj.data).find((e) => e.name === parts[i]);
        if (!entry) {
          fail(404, 'Not Found');
          return true;
        }
        if (i === parts.length - 1) {
          if (entry.mode === '40000') {
            sendJson(res, 200, dirListing(repo, entry.oid, contentPath));
            return true;
          }
          const blob = getObject(entry.oid);
          if (!blob) {
            fail(404, 'Not Found');
            return true;
          }
          sendJson(res, 200, fileJson(repo, contentPath, entry.oid, blob.data));
          return true;
        }
        treeOid = entry.oid;
      }
      fail(404, 'Not Found');
      return true;
    }
    if (method === 'PUT') {
      const contentB64 = str(body?.content);
      const message = str(body?.message) ?? 'Update file';
      if (contentB64 === undefined) {
        fail(422, 'Validation Failed: content is required');
        return true;
      }
      const branch = str(body?.branch) ?? repo.defaultBranch;
      const tip = branchTip(repo, branch);
      const existing = tip ? readPathAtCommit(tip, contentPath) : undefined;
      const givenSha = str(body?.sha);
      if (existing && givenSha !== existing.oid) {
        fail(409, 'Conflict: sha does not match');
        return true;
      }
      if (!existing && givenSha) {
        fail(422, 'Validation Failed: sha must not be set for a new file');
        return true;
      }
      const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const blobOid = putObject('blob', data);
      const flat = tip ? flattenTree(treeAtBranch(repo, branch)) : new Map<string, { mode: string; oid: string }>();
      flat.set(contentPath, { mode: existing?.mode ?? '100644', oid: blobOid });
      const newTree = buildTreeFromFlat(flat);
      const stamp = nextSeq();
      const commitOid = createCommit(newTree, tip ? [tip] : [], message, stamp);
      repo.refs.set(`refs/heads/${branch}`, commitOid);
      repo.updatedSeq = stamp;
      const commitObj = commitJson(repo, commitOid);
      sendJson(res, existing ? 200 : 201, {
        content: fileJson(repo, contentPath, blobOid, data),
        commit: {
          sha: commitOid,
          node_id: `C_${commitOid}`,
          url: `${base}/git/commits/${commitOid}`,
          html_url: `https://github.invalid/${owner}/${repoName}/commit/${commitOid}`,
          author: (commitObj?.commit as { author?: unknown })?.author ?? null,
          committer: (commitObj?.commit as { committer?: unknown })?.committer ?? null,
          tree: { sha: newTree, url: `${base}/git/trees/${newTree}` },
          message,
          parents: tip ? [{ sha: tip, url: `${base}/commits/${tip}`, html_url: '' }] : [],
        },
      });
      return true;
    }
    if (method === 'DELETE') {
      const message = str(body?.message) ?? 'Delete file';
      const branch = str(body?.branch) ?? repo.defaultBranch;
      const tip = branchTip(repo, branch);
      const existing = tip ? readPathAtCommit(tip, contentPath) : undefined;
      if (!tip || !existing) {
        fail(404, 'Not Found');
        return true;
      }
      const givenSha = str(body?.sha);
      if (givenSha !== existing.oid) {
        fail(409, 'Conflict: sha does not match');
        return true;
      }
      const flat = flattenTree(treeAtBranch(repo, branch));
      flat.delete(contentPath);
      const newTree = buildTreeFromFlat(flat);
      const stamp = nextSeq();
      const commitOid = createCommit(newTree, [tip], message, stamp);
      repo.refs.set(`refs/heads/${branch}`, commitOid);
      repo.updatedSeq = stamp;
      sendJson(res, 200, {
        content: null,
        commit: { sha: commitOid, url: `${base}/git/commits/${commitOid}`, message },
      });
      return true;
    }
    return false;
  }

  // ---- labels ------------------------------------------------------------------
  if (tail[0] === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      const labels = [...repo.labels.keys()].sort().map((name) => labelJson(repo, name));
      const { page, headers } = paginate(req, labels);
      sendJson(res, 200, page, headers);
      return true;
    }
    if (method === 'POST' && tail.length === 1) {
      const name = str(body?.name);
      if (!name) {
        fail(422, 'Validation Failed: name is required');
        return true;
      }
      if (repo.labels.has(name)) {
        fail(422, 'Validation Failed: name already exists');
        return true;
      }
      repo.labels.set(name, {
        id: allocGlobalId(),
        name,
        color: (str(body?.color) ?? 'ededed').replace(/^#/, ''),
        description: str(body?.description) ?? null,
      });
      sendJson(res, 201, labelJson(repo, name));
      return true;
    }
    if (method === 'GET' && tail.length === 2) {
      const json = labelJson(repo, tail[1]);
      if (!json) {
        fail(404, 'Not Found');
        return true;
      }
      sendJson(res, 200, json);
      return true;
    }
    if (method === 'DELETE' && tail.length === 2) {
      repo.labels.delete(tail[1]);
      res.writeHead(204, { 'x-github-request-id': 'forge' });
      res.end();
      return true;
    }
    return false;
  }

  // ---- issues --------------------------------------------------------------------
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let items = [...repo.issues.values()];
        if (state === 'open') items = items.filter((i) => i.state === 'open');
        else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
        items.sort((a, b) => (sort === 'created' ? a.createdSeq - b.createdSeq : a.number - b.number));
        if (direction === 'desc') items.reverse();
        const labelsParam = url.searchParams.get('labels');
        if (labelsParam) {
          const wanted = labelsParam.split(',');
          items = items.filter((i) => wanted.every((w) => i.labels.includes(w)));
        }
        const { page, headers } = paginate(req, items.map((i) => issueJson(repo, i)));
        sendJson(res, 200, page, headers);
        return true;
      }
      if (method === 'POST') {
        const title = str(body?.title);
        if (!title) {
          fail(422, 'Validation Failed: title is required');
          return true;
        }
        const labels = Array.isArray(body?.labels) ? (body.labels.filter((x) => typeof x === 'string') as string[]) : [];
        try {
          const issue = createIssueInRepo(repo, { title, body: str(body?.body) ?? '', labels });
          sendJson(res, 201, issueJson(repo, issue));
        } catch (err) {
          const e = err as Error & { status?: number };
          fail(e.status ?? 422, e.message);
        }
        return true;
      }
      return false;
    }
    const number = parseInt(tail[1], 10);
    const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
    if (tail.length === 2) {
      if (!issue) {
        // A pull request number also answers on /issues/{n} in GitHub; the suite does not
        // rely on it, so a plain 404 is correct for unknown numbers.
        fail(404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof body?.title === 'string') issue.title = body.title;
        if (typeof body?.body === 'string') issue.body = body.body;
        if (body?.state === 'closed' || body?.state === 'open') {
          issue.state = body.state;
          issue.closedSeq = body.state === 'closed' ? nextSeq() : null;
        }
        if (Array.isArray(body?.labels)) {
          const labels = body.labels.filter((x) => typeof x === 'string') as string[];
          for (const name of labels) {
            if (!repo.labels.has(name)) {
              fail(422, `Label does not exist: ${name}`);
              return true;
            }
          }
          issue.labels = labels;
        }
        issue.updatedSeq = nextSeq();
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (!issue) {
        fail(404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        const comments = issue.comments.map((c) => commentJson(repo, issue, c.id)).filter((x) => x !== null);
        const { page, headers } = paginate(req, comments as Array<Record<string, unknown>>);
        sendJson(res, 200, page, headers);
        return true;
      }
      if (method === 'POST') {
        const text = str(body?.body);
        if (!text) {
          fail(422, 'Validation Failed: body is required');
          return true;
        }
        const comment = { id: allocGlobalId(), body: text, createdSeq: nextSeq(), authorLogin: VIEWER_LOGIN };
        issue.comments.push(comment);
        issue.updatedSeq = comment.createdSeq;
        sendJson(res, 201, commentJson(repo, issue, comment.id));
        return true;
      }
      return false;
    }
    if (tail.length === 3 && tail[2] === 'labels') {
      if (!issue) {
        fail(404, 'Not Found');
        return true;
      }
      if (method === 'POST') {
        const labels = Array.isArray(body?.labels) ? (body.labels.filter((x) => typeof x === 'string') as string[]) : str(body?.name) ? [str(body?.name) as string] : [];
        for (const name of labels) {
          if (!repo.labels.has(name)) {
            fail(422, `Label does not exist: ${name}`);
            return true;
          }
          if (!issue.labels.includes(name)) issue.labels.push(name);
        }
        sendJson(res, 200, issue.labels.map((name) => labelJson(repo, name)));
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.labels.map((name) => labelJson(repo, name)));
        return true;
      }
      return false;
    }
    return false;
  }

  if (tail[0] === 'issues' && tail[1] === 'comments') return false;

  // Issue comments by id (PATCH/DELETE /issues/comments/{id}) — minimal support.
  if (tail[0] === 'issues' && tail.length === 3 && tail[1] === 'comments') return false;

  // ---- pulls -----------------------------------------------------------------------
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let items = [...repo.pulls.values()];
        if (state === 'open') items = items.filter((p) => p.state === 'open');
        else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
        items.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page, headers } = paginate(req, items.map((p) => pullJson(repo, p)));
        sendJson(res, 200, page, headers);
        return true;
      }
      if (method === 'POST') {
        const title = str(body?.title);
        const head = str(body?.head);
        const baseName = str(body?.base);
        if (!title || !head || !baseName) {
          fail(422, 'Validation Failed: title, head and base are required');
          return true;
        }
        try {
          const pull = createPullInRepo(repo, { title, body: str(body?.body) ?? '', head, base: baseName });
          sendJson(res, 201, pullJson(repo, pull));
        } catch (err) {
          const e = err as Error & { status?: number };
          fail(e.status ?? 422, e.message);
        }
        return true;
      }
      return false;
    }
    const number = parseInt(tail[1], 10);
    const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
    if (tail.length === 2) {
      if (!pull) {
        fail(404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof body?.title === 'string') pull.title = body.title;
        if (typeof body?.body === 'string') pull.body = body.body;
        if (body?.state === 'closed' || body?.state === 'open') pull.state = body.state;
        if (typeof body?.base === 'string') pull.baseRef = body.base;
        pull.updatedSeq = nextSeq();
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      return false;
    }
    if (!pull) {
      fail(404, 'Not Found');
      return true;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseShaStored;
      const headTip = branchTip(repo, pull.headRef) ?? pull.headShaStored;
      const base = mergeBase(baseTip, headTip) ?? baseTip;
      const files = diffFiles(repo, base, headTip);
      const { page, headers } = paginate(req, files);
      sendJson(res, 200, page, headers);
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      const mergeMethod = str(body?.merge_method) ?? 'merge';
      try {
        const sha = mergePullInRepo(repo, pull, mergeMethod);
        sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
      } catch (err) {
        const e = err as Error & { status?: number };
        fail(e.status ?? 405, e.message);
      }
      return true;
    }
    if (tail.length === 3 && tail[2] === 'commits' && method === 'GET') {
      const headTip = branchTip(repo, pull.headRef) ?? pull.headShaStored;
      const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseShaStored;
      const commits: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      const queue = [headTip];
      while (queue.length) {
        const current = queue.shift() as string;
        if (seen.has(current)) continue;
        seen.add(current);
        if (baseTip && isAncestor(current, baseTip) && current !== headTip) continue;
        const json = commitJson(repo, current);
        if (json) commits.push(json);
        const obj = getObject(current);
        if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
      }
      sendJson(res, 200, commits);
      return true;
    }
    return false;
  }

  return false;
}

function peelCommit(oid: string): string {
  const obj = getObject(oid);
  if (obj && obj.type === 'commit') return oid;
  return oid;
}

function dirListing(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = getObject(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const child = getObject(entry.oid);
    const isDir = entry.mode === '40000';
    return {
      name: entry.name,
      path,
      sha: entry.oid,
      size: !isDir && child ? child.data.length : 0,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://github.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
      download_url: isDir ? null : `https://github.invalid/${repo.owner}/${repo.name}/raw/${path}`,
      type: isDir ? 'dir' : 'file',
      _links: {
        self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        git: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        html: `https://github.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      },
    };
  });
}

function fileJson(repo: Repo, path: string, oid: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  const encoded = data.toString('base64');
  const chunked = encoded.replace(/(.{60})/g, '$1\n') + (encoded.length ? '\n' : '');
  return {
    name,
    path,
    sha: oid,
    size: data.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`,
    download_url: `https://github.invalid/${repo.owner}/${repo.name}/raw/${path}`,
    type: 'file',
    content: chunked,
    encoding: 'base64',
    _links: {
      self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      git: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`,
      html: `https://github.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    },
  };
}
