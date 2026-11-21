// store.ts — the forge's own store: git objects, repositories, issues, labels and pull requests,
// all in memory, all deterministic. No clock is ever read for state: a logical sequence number
// stamps every creation, so two runs over the same suite leave byte-identical answers.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** The login the suite's token names (kit sdk/conformance/wire.ts buildScenario().viewer.login). */
export const VIEWER_LOGIN = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';
export const VIEWER_ID = 1000;

let seq = 0;
/** The next deterministic sequence number (1, 2, 3, ...). */
export function nextSeq(): number {
  seq += 1;
  return seq;
}

/** A deterministic ISO timestamp derived from a sequence number, never from the wall clock. */
export function seqTime(s: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + s * 1000).toISOString();
}

/** A deterministic git timestamp (seconds + tz) derived from a sequence number. */
export function seqGitTime(s: number): string {
  return `${Math.floor(Date.UTC(2026, 0, 1) / 1000) + s} +0000`;
}

// --------------------------------------------------------------------------- git objects

const objects = new Map<string, GitObject>();

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object (idempotent) and return its oid. */
export function putObject(type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

export function hasObject(oid: string): boolean {
  return objects.has(oid);
}

// --------------------------------------------------------------------------- trees & commits

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const mode = data.subarray(at, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // Git sorts tree entries by name, with directories compared as if they ended in '/'.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTagTarget(data: Buffer): { target: string; type: string } {
  const text = data.toString('utf8');
  let target = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) target = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { target, type };
}

/** Peel an oid through annotated tags until a non-tag object (or a missing object) is reached. */
export function peelToCommit(oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTagTarget(obj.data).target;
  }
  return current;
}

/** Every object reachable from the given tips (commits walk parents, trees walk entries). */
export function reachableFrom(tips: Iterable<string>, opts: { commitDepth?: Map<string, number> } = {}): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTagTarget(obj.data).target);
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors in the commit graph. */
export function isAncestor(ancestor: string, descendant: string): boolean {
  const stack = [descendant];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = objects.get(current);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits (first shared commit in BFS order from `a`), or null. */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsOfB = new Set<string>();
  const stackB = [b];
  while (stackB.length) {
    const current = stackB.pop() as string;
    if (ancestorsOfB.has(current)) continue;
    ancestorsOfB.add(current);
    const obj = objects.get(current);
    if (obj && obj.type === 'commit') stackB.push(...parseCommit(obj.data).parents);
  }
  const queue = [a];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (ancestorsOfB.has(current)) return current;
    const obj = objects.get(current);
    if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** Flatten a tree (recursively) into a map of path -> {mode, oid}. */
export function flattenTree(treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build nested trees from a flat path -> {mode, oid} map; returns the root tree oid. */
export function buildTreeFromFlat(flat: Map<string, { mode: string; oid: string }>): string {
  interface Dir { files: TreeEntry[]; dirs: Map<string, Dir> }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, value] of flat) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!dir.dirs.has(parts[i])) dir.dirs.set(parts[i], { files: [], dirs: new Map() });
      dir = dir.dirs.get(parts[i]) as Dir;
    }
    dir.files.push({ mode: value.mode, name: parts[parts.length - 1], oid: value.oid });
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [...dir.files];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return putObject('tree', buildTree(entries));
  };
  return emit(root);
}

/** Read a blob's bytes by path inside a commit's tree; undefined when absent. */
export function readPathAtCommit(commitOid: string, path: string): { mode: string; oid: string; data: Buffer } | undefined {
  const commitObj = objects.get(commitOid);
  if (!commitObj || commitObj.type !== 'commit') return undefined;
  let treeOid = parseCommit(commitObj.data).tree;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const treeObj = objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return undefined;
    const entry = parseTree(treeObj.data).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) {
      const blob = objects.get(entry.oid);
      if (!blob) return undefined;
      return { mode: entry.mode, oid: entry.oid, data: blob.data };
    }
    treeOid = entry.oid;
  }
  return undefined;
}

/** Create a commit object with the viewer's deterministic identity. */
export function createCommit(treeOid: string, parents: string[], message: string, stamp: number): string {
  const identity = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${seqGitTime(stamp)}`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identity}`);
  lines.push(`committer ${identity}`);
  const data = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
  return putObject('commit', data);
}

// --------------------------------------------------------------------------- repositories

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
  authorLogin: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
  authorLogin: string;
  isPullRequest: boolean;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headShaStored: string;
  baseShaStored: string;
  merged: boolean;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
  mergedSeq: number | null;
  authorLogin: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 5000;
let nextGlobalId = 900000;

export function allocGlobalId(): number {
  nextGlobalId += 1;
  return nextGlobalId;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createRepo(name: string, opts: { description?: string | null; isPrivate?: boolean; defaultBranch?: string } = {}): Repo {
  const stamp = nextSeq();
  nextRepoId += 1;
  const repo: Repo = {
    id: nextRepoId,
    name,
    owner: VIEWER_LOGIN,
    description: opts.description ?? null,
    isPrivate: opts.isPrivate ?? false,
    defaultBranch: opts.defaultBranch ?? 'main',
    createdSeq: stamp,
    updatedSeq: stamp,
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  repos.set(repoKey(repo.owner, repo.name), repo);
  return repo;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

export function deleteRepo(owner: string, name: string): boolean {
  if (owner !== VIEWER_LOGIN) return false;
  return repos.delete(repoKey(owner, name));
}

/** The commit oid a branch ref names, resolving a short branch name or a full ref. */
export function branchTip(repo: Repo, branchOrRef: string): string | undefined {
  const full = branchOrRef.startsWith('refs/') ? branchOrRef : `refs/heads/${branchOrRef}`;
  const oid = repo.refs.get(full);
  return oid === undefined ? undefined : peelToCommit(oid);
}

/** The tree oid at a branch, or the empty tree when the branch is unborn. */
export function treeAtBranch(repo: Repo, branch: string): string {
  const tip = branchTip(repo, branch);
  if (!tip) return putObject('tree', Buffer.alloc(0));
  const commit = getObject(tip);
  if (!commit || commit.type !== 'commit') return putObject('tree', Buffer.alloc(0));
  return parseCommit(commit.data).tree;
}

/**
 * Three-way tree merge over flat path maps. Returns the merged flat map, or null on a conflict
 * (both sides changed the same path to different contents, or one deleted what the other changed).
 */
export function mergeFlatTrees(
  baseFlat: Map<string, { mode: string; oid: string }>,
  oursFlat: Map<string, { mode: string; oid: string }>,
  theirsFlat: Map<string, { mode: string; oid: string }>,
): Map<string, { mode: string; oid: string }> | null {
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const base = baseFlat.get(path);
    const ours = oursFlat.get(path);
    const theirs = theirsFlat.get(path);
    const sameOid = (x?: { mode: string; oid: string }, y?: { mode: string; oid: string }) =>
      (x?.oid ?? '') === (y?.oid ?? '') && (x?.mode ?? '') === (y?.mode ?? '');
    if (sameOid(ours, theirs)) {
      if (ours) merged.set(path, ours);
    } else if (sameOid(ours, base)) {
      if (theirs) merged.set(path, theirs);
    } else if (sameOid(theirs, base)) {
      if (ours) merged.set(path, ours);
    } else {
      return null;
    }
  }
  return merged;
}

/** The flat tree at a commit oid (empty map for a missing commit). */
export function flatTreeAtCommit(commitOid: string | undefined): Map<string, { mode: string; oid: string }> {
  if (!commitOid) return new Map();
  const obj = getObject(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(parseCommit(obj.data).tree);
}
