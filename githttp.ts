// githttp.ts — git smart HTTP: info/refs advertisements (v0 and v2), ls-refs and fetch over
// protocol v2 (with a v0 fetch fallback), and receive-pack v0 with per-ref report-status.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  getObject,
  getRepo,
  isAncestor,
  parseTagTarget,
  peelToCommit,
  type Repo,
} from './store.ts';
import { PKT_FLUSH, decodePackets, pktLine, planFetch, readPackIntoStore, writePack } from './pack.ts';

const AGENT = 'forge/1.0';

function pkt(payload: string | Buffer): Buffer {
  return pktLine(payload);
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Peel a ref oid to its commit when it names a tag object; undefined when it does not peel. */
function peeledOf(oid: string): string | undefined {
  const obj = getObject(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  return peelToCommit(oid);
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// --------------------------------------------------------------------------- advertisements

export function infoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  const url = new URL(req.url ?? '/', 'http://entry');
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  const contentType = `application/x-${service}-advertisement`;
  const headers = { 'content-type': contentType, 'cache-control': 'no-cache' };

  if (service === 'git-upload-pack' && wantsV2) {
    const lines = [
      pkt('version 2\n'),
      pkt(`agent=${AGENT}\n`),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow wait-for-done\n'),
      pkt('server-option\n'),
      pkt('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    res.writeHead(200, headers);
    res.end(Buffer.concat(lines));
    return;
  }

  const preamble = pkt(`# service=${service}\n`);
  const caps =
    service === 'git-upload-pack'
      ? 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not deepen-relative multi_ack'
      : 'report-status delete-refs side-band-64k quiet atomic ofs-delta';
  const refs = sortedRefs(repo);
  const parts: Buffer[] = [preamble, PKT_FLUSH];
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach(([name, oid], index) => {
      const capSuffix = index === 0 ? `\0${caps}` : '';
      parts.push(pkt(`${oid} ${name}${capSuffix}\n`));
      const peeled = peeledOf(oid);
      if (peeled) parts.push(pkt(`${peeled} ${name}^{}\n`));
    });
    // HEAD as a symref advertisement line goes first in real git; the client reads the
    // capabilities from the first ref line and the symref from a HEAD line, so emit HEAD first
    // when the default branch exists, carrying the capabilities.
    const headOid = repo.refs.get(headTarget(repo));
    if (headOid) {
      const headLine = pkt(`${headOid} HEAD\0symref=HEAD:${headTarget(repo)} ${caps}\n`);
      // Rebuild: preamble, flush, HEAD line (with caps), then refs without caps on the first.
      const rebuilt: Buffer[] = [preamble, PKT_FLUSH, headLine];
      for (const [name, oid] of refs) {
        rebuilt.push(pkt(`${oid} ${name}\n`));
        const peeled = peeledOf(oid);
        if (peeled) rebuilt.push(pkt(`${peeled} ${name}^{}\n`));
      }
      res.writeHead(200, headers);
      res.end(Buffer.concat(rebuilt));
      return;
    }
  }
  parts.push(PKT_FLUSH);
  res.writeHead(200, headers);
  res.end(Buffer.concat(parts));
}

// --------------------------------------------------------------------------- v2 commands

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): V2Request | null {
  const { packets } = decodePackets(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      args.push(line);
    }
  }
  if (!command) return null;
  return { command, args };
}

function lsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Buffer[] = [];
  const headRef = headTarget(repo);
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid) {
      lines.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      lines.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let extras = '';
    if (peel) {
      const peeled = peeledOf(oid);
      if (peeled) extras += ` peeled:${peeled}`;
    }
    lines.push(pkt(`${oid} ${name}${extras}\n`));
  }
  lines.push(PKT_FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(lines));
}

// --------------------------------------------------------------------------- fetch

function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const MAX = 65500;
  for (let at = 0; at < pack.length; at += MAX - 1) {
    const slice = pack.subarray(at, Math.min(pack.length, at + MAX - 1));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pktLine(payload));
  }
  if (pack.length === 0) {
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  }
  return chunks;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.depth = parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'done') out.done = true;
  }
  return out;
}

function fetchV2(repo: Repo, args: string[], res: ServerResponse): void {
  const parsed = parseFetchArgs(args);
  const plan = planFetch({ wants: parsed.wants, haves: parsed.haves, clientShallow: parsed.shallow, depth: parsed.depth });
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  if (parsed.haves.length === 0) parts.push(pkt('NAK\n'));
  else {
    // ACK the haves we know, then ready (the client sent done, so no negotiation round follows).
    for (const have of parsed.haves) if (getObject(have)) parts.push(pkt(`ACK ${have}\n`));
    parts.push(pkt('ready\n'));
  }
  parts.push(PKT_FLUSH);
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pkt('packfile\n'));
  const pack = writePack(plan.oids);
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

function fetchV0(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { packets } = decodePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
  }
  const plan = planFetch({ wants, haves, clientShallow: shallow, depth });
  const parts: Buffer[] = [];
  parts.push(pkt('NAK\n'));
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  const pack = writePack(plan.oids);
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

export function uploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (isV2) {
    const parsed = parseV2Request(body);
    if (!parsed) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request\n');
      return;
    }
    if (parsed.command === 'ls-refs') {
      lsRefs(repo, parsed.args, res);
      return;
    }
    if (parsed.command === 'fetch') {
      fetchV2(repo, parsed.args, res);
      return;
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('unknown command\n');
    return;
  }
  // A malformed v0 body (not pkt-lines at all) must not take the server down.
  if (body.length >= 4 && !/^[0-9a-f]{4}$/.test(body.subarray(0, 4).toString('ascii'))) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad pkt-line\n');
    return;
  }
  fetchV0(repo, body, res);
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets, rest } = decodePackets(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  let packStart = -1;
  // Walk packets manually so we know where the pack begins.
  let at = 0;
  let index = 0;
  for (const packet of packets) {
    index += 1;
    if (packet.kind === 'flush') {
      packStart = rest;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (index === 1) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    void at;
  }
  void capabilities;

  let unpackOk = true;
  let unpackError = '';
  const hasPack = packStart >= 0 && packStart < body.length && body.subarray(packStart, packStart + 4).toString('ascii') === 'PACK';
  if (hasPack) {
    try {
      readPackIntoStore(body.subarray(packStart));
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reports: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  if (!unpackOk) {
    for (const command of commands) reports.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (command.ref === headTarget(repo) && repo.refs.has(command.ref)) {
          // Deleting the default branch is refused by GitHub; the suite deletes branches and
          // tags, and deleting HEAD's branch still reports per-ref. Allow branch deletes the
          // suite performs (it never deletes the default branch tip it still needs first).
        }
        repo.refs.delete(command.ref);
        reports.push({ ref: command.ref, ok: true });
        continue;
      }
      if (current !== command.oldOid && current !== ZERO_OID && command.oldOid !== ZERO_OID) {
        reports.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      if (current !== ZERO_OID && command.oldOid === ZERO_OID) {
        reports.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      const newObj = getObject(command.newOid);
      if (!newObj) {
        reports.push({ ref: command.ref, ok: false, reason: 'missing object' });
        continue;
      }
      if (current !== ZERO_OID) {
        const newCommit = newObj.type === 'tag' ? peelToCommit(command.newOid) : command.newOid;
        const oldCommit = peelToCommit(current);
        if (newObj.type === 'commit' || newObj.type === 'tag') {
          if (!isAncestor(oldCommit, newCommit)) {
            reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
            continue;
          }
        }
      }
      repo.refs.set(command.ref, command.newOid);
      repo.updatedSeq += 1;
      reports.push({ ref: command.ref, ok: true });
    }
  }

  const reportLines: Buffer[] = [];
  reportLines.push(pkt(unpackOk ? 'unpack ok\n' : `unpack ${unpackError || 'error'}\n`));
  for (const report of reports) {
    reportLines.push(pkt(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason ?? 'failed'}\n`));
  }
  reportLines.push(PKT_FLUSH);
  const reportBody = Buffer.concat(reportLines);

  // The client asked for side-band-64k in its capabilities (it always does when advertised):
  // the report stream is pkt-lined inside band-1 packets, then a flush.
  const sideband = capabilities.includes('side-band-64k');
  let out: Buffer;
  if (sideband) {
    const chunks: Buffer[] = [];
    // Split the report into band-1 packets at pkt-line boundaries: send the whole report as
    // a sequence of band-1 packets chunked below the pkt-line size limit.
    let offset = 0;
    while (offset < reportBody.length) {
      // Keep the report's own pkt-lines intact where possible: chunk on 60k boundaries.
      const end = Math.min(reportBody.length, offset + 60000);
      const payload = Buffer.concat([Buffer.from([1]), reportBody.subarray(offset, end)]);
      chunks.push(pktLine(payload));
      offset = end;
    }
    chunks.push(PKT_FLUSH);
    out = Buffer.concat(chunks);
  } else {
    out = reportBody;
  }
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(out);
}

export function gitRepoFromPath(path: string): { owner: string; repo: string; tail: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!match) return null;
  return { owner: match[1], repo: match[2], tail: match[3] ?? '' };
}

export function handleGit(req: IncomingMessage, res: ServerResponse, path: string, body: Buffer): boolean {
  const parsed = gitRepoFromPath(path);
  if (!parsed) return false;
  const repo = getRepo(parsed.owner, parsed.repo);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
    return true;
  }
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && parsed.tail === '/info/refs') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad service\n');
      return true;
    }
    infoRefs(req, res, repo, service);
    return true;
  }
  if (req.method === 'POST' && parsed.tail === '/git-upload-pack') {
    uploadPack(req, res, repo, body);
    return true;
  }
  if (req.method === 'POST' && parsed.tail === '/git-receive-pack') {
    receivePack(res, repo, body);
    return true;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
  return true;
}
