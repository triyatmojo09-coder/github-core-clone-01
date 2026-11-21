// pack.ts — pkt-lines and packfiles: the git wire's framing, written from the protocol the kit's
// conformance client speaks. Packs we send carry whole objects only (no deltas); packs we receive
// may carry OFS/REF deltas and are resolved on the way in.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  getObject,
  putObject,
  parseCommit,
  parseTree,
  parseTagTarget,
  reachableFrom,
  type GitObjectType,
} from './store.ts';

// --------------------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const size = body.length + 4;
  const head = Buffer.from(size.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode every complete pkt-line in a buffer; returns the packets and the undecoded remainder. */
export function decodePackets(buffer: Buffer, start = 0): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let at = start;
  while (at + 4 <= buffer.length) {
    const sizeText = buffer.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(sizeText)) break;
    const size = parseInt(sizeText, 16);
    if (size === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (size === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (size === 2) {
      packets.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (size < 4 || at + size > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + size) });
    at += size;
  }
  return { packets, rest: at };
}

// --------------------------------------------------------------------------- pack writing

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A complete packfile (header, objects, sha1 trailer) for the given oids, in the order given. */
export function writePack(oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = getObject(oid);
    if (!obj) continue;
    parts.push(packObjectHeader(TYPE_CODES[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// --------------------------------------------------------------------------- pack reading

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at];
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size
  const resultSize = readVarint();
  const out: Buffer[] = [];
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { offset |= delta[at] << (8 * i); at += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { size |= delta[at] << (8 * i); at += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/**
 * Read a packfile into the store. Returns the oids it carried. Handles OFS-DELTA and REF-DELTA
 * (resolving REF bases from the store or from earlier entries in the same pack).
 */
export function readPackIntoStore(pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  let at = 12;
  const byOffset = new Map<number, string>();
  const oids: string[] = [];
  const pendingRefDeltas: Array<{ baseOid: string; delta: Buffer }> = [];

  const inflateAt = (start: number): { data: Buffer; next: number } => {
    // zlib streams are self-terminating; inflate with a generous slice and measure via the stream.
    const slice = pack.subarray(start, pack.length - 20);
    const data = inflateSync(slice);
    // Recompute the consumed length by re-deflating is unreliable; instead use the async-free
    // approach: binary-search the smallest prefix that inflates to the same bytes.
    let lo = 1;
    let hi = slice.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      try {
        const trial = inflateSync(slice.subarray(0, mid));
        if (trial.equals(data)) hi = mid;
        else lo = mid + 1;
      } catch {
        lo = mid + 1;
      }
    }
    return { data, next: start + lo };
  };

  for (let i = 0; i < count; i += 1) {
    const entryOffset = at;
    let byte = pack[at];
    at += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at];
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS-DELTA
      let offsetByte = pack[at];
      at += 1;
      let baseOffset = offsetByte & 0x7f;
      while (offsetByte & 0x80) {
        offsetByte = pack[at];
        at += 1;
        baseOffset = ((baseOffset + 1) << 7) | (offsetByte & 0x7f);
      }
      const baseOid = byOffset.get(entryOffset - baseOffset);
      if (!baseOid) throw new Error('ofs-delta base not in pack');
      const { data: delta, next } = inflateAt(at);
      at = next;
      const base = getObject(baseOid);
      if (!base) throw new Error('ofs-delta base missing from store');
      const resolved = applyDelta(base.data, delta);
      const oid = putObject(base.type, resolved);
      byOffset.set(entryOffset, oid);
      oids.push(oid);
    } else if (typeCode === 7) {
      // REF-DELTA
      const baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      const { data: delta, next } = inflateAt(at);
      at = next;
      const base = getObject(baseOid);
      if (base) {
        const oid = putObject(base.type, applyDelta(base.data, delta));
        byOffset.set(entryOffset, oid);
        oids.push(oid);
      } else {
        pendingRefDeltas.push({ baseOid, delta });
        byOffset.set(entryOffset, '');
      }
    } else {
      const type = CODE_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next } = inflateAt(at);
      at = next;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const oid = putObject(type, data);
      byOffset.set(entryOffset, oid);
      oids.push(oid);
    }
  }
  for (const pending of pendingRefDeltas) {
    const base = getObject(pending.baseOid);
    if (!base) throw new Error('ref-delta base missing');
    oids.push(putObject(base.type, applyDelta(base.data, pending.delta)));
  }
  return oids;
}

// --------------------------------------------------------------------------- fetch planning

export interface FetchPlan {
  /** Object ids to pack, in a stable order (commits first by depth, then trees, then blobs/tags). */
  oids: string[];
  /** Commit oids that form the shallow boundary to report. */
  shallow: string[];
  /** Client shallow oids that are no longer shallow (their parents are now included). */
  unshallow: string[];
}

/**
 * Plan a fetch: what the client wants, minus what it already has, honouring a depth limit.
 * Depth counts commit generations from the want tips (depth 1 = the tips only).
 */
export function planFetch(input: {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth?: number;
}): FetchPlan {
  // What the client actually holds: everything reachable from its haves, except that a
  // shallow boundary commit's parents are NOT held — the client never received them. Walking
  // past a boundary (as a plain reachableFrom would) makes a deepen look already-held and the
  // parent commit is then wrongly withheld.
  const haveObjects = new Set<string>();
  {
    const shallowSet = new Set(input.clientShallow);
    const stack: string[] = [...input.haves];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (haveObjects.has(oid)) continue;
      const obj = getObject(oid);
      if (!obj) continue;
      haveObjects.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        stack.push(commit.tree);
        if (!shallowSet.has(oid)) for (const parent of commit.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTagTarget(obj.data).target);
      }
    }
  }
  const wantSet = new Set<string>();

  // Commit distances from the want tips.
  const distance = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of input.wants) {
    const obj = getObject(want);
    if (!obj) continue;
    if (obj.type === 'commit') queue.push({ oid: want, dist: 0 });
    else if (obj.type === 'tag') queue.push({ oid: parseTagTarget(obj.data).target, dist: 0 });
  }
  while (queue.length) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (distance.has(oid) && (distance.get(oid) as number) <= dist) continue;
    distance.set(oid, dist);
    const obj = getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, dist: dist + 1 });
  }

  const depth = input.depth;
  const includedCommits = new Set<string>();
  for (const [oid, dist] of distance) {
    if (depth !== undefined && dist >= depth) continue;
    if (haveObjects.has(oid) && depth === undefined) continue;
    if (haveObjects.has(oid) && depth !== undefined && !input.clientShallow.includes(oid) && oid !== input.wants[0] && !input.wants.includes(oid)) {
      // A held, non-shallow commit does not need re-sending even in a deepen.
      continue;
    }
    includedCommits.add(oid);
  }
  // Want tips are always delivered when they exist and are not fully held in a plain fetch.
  for (const want of input.wants) {
    const obj = getObject(want);
    if (!obj) continue;
    if (obj.type !== 'commit' && obj.type !== 'tag') wantSet.add(want);
  }

  const shallow: string[] = [];
  const included = new Set<string>();
  for (const oid of includedCommits) {
    included.add(oid);
    const commit = getObject(oid);
    if (!commit) continue;
    const parsed = parseCommit(commit.data);
    let cut = false;
    for (const parent of parsed.parents) {
      if (!includedCommits.has(parent)) cut = true;
    }
    if (cut && depth !== undefined) shallow.push(oid);
    else if (cut && !haveObjects.has(oid)) {
      // Plain fetch: a commit whose parent is not sent but which the client does not hold
      // cannot happen (parents are either sent or held), so nothing to mark.
    }
  }

  // Trees and blobs of included commits, plus tag objects pointing at them.
  for (const oid of includedCommits) {
    const commit = getObject(oid);
    if (!commit) continue;
    const tree = parseCommit(commit.data).tree;
    const stack = [tree];
    while (stack.length) {
      const current = stack.pop() as string;
      if (included.has(current)) continue;
      const obj = getObject(current);
      if (!obj) continue;
      if (haveObjects.has(current) && depth === undefined) continue;
      if (haveObjects.has(current) && depth !== undefined && !includedCommits.has(current)) {
        // In a deepen, trees/blobs the client holds need no re-send either.
        if (!input.wants.includes(current)) continue;
      }
      included.add(current);
      if (obj.type === 'tree') for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  }
  // Tag objects whose target is included (or directly wanted).
  for (const want of input.wants) {
    const obj = getObject(want);
    if (obj && obj.type === 'tag' && !haveObjects.has(want)) included.add(want);
  }

  const unshallow: string[] = [];
  for (const boundary of input.clientShallow) {
    if (includedCommits.has(boundary)) {
      const commit = getObject(boundary);
      if (commit) {
        const parents = parseCommit(commit.data).parents;
        if (parents.length && parents.every((p) => includedCommits.has(p))) unshallow.push(boundary);
      }
    }
  }

  const ordered = [...included].sort((a, b) => {
    const rank = (oid: string): number => {
      const type = getObject(oid)?.type;
      return type === 'commit' ? 0 : type === 'tag' ? 1 : type === 'tree' ? 2 : 3;
    };
    const byType = rank(a) - rank(b);
    if (byType !== 0) return byType;
    const da = distance.get(a) ?? 0;
    const db = distance.get(b) ?? 0;
    if (da !== db) return da - db;
    return a < b ? -1 : 1;
  });

  return { oids: ordered, shallow, unshallow };
}
