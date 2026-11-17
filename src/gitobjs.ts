// Git objects: hashing, tree/commit/tag codecs, packfiles, reachability.
//
// The store is a plain Map from hex id to {kind, data}; every object the
// server keeps is addressed by the SHA-1 of its "<kind> <size>\0" header
// plus its bytes, exactly as git computes it. Packfiles are read with full
// OFS/REF delta resolution (thin packs resolve against the repo's own
// objects) and written as plain entries, sorted by id for determinism.

import { inflateSync, deflateSync } from 'node:zlib';
import { sha1Hex, EPOCH_SECONDS, AUTHOR_LINE } from './consts.ts';

export type ObjKind = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  kind: ObjKind;
  data: Buffer;
}

export type ObjStore = Map<string, GitObj>;

const KIND_CODE: Record<ObjKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_KIND: Record<number, ObjKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const DELTA_OFS = 6;
const DELTA_REF = 7;

/** The id of an object: SHA-1 of its git header plus its bytes. */
export function hashObj(kind: ObjKind, data: Buffer): string {
  const head = Buffer.from(`${kind} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([head, data]));
}

/** Store `data` as an object of `kind` in `store` (idempotent); return its id. */
export function putObj(store: ObjStore, kind: ObjKind, data: Buffer): string {
  const oid = hashObj(kind, data);
  if (!store.has(oid)) store.set(oid, { kind, data });
  return oid;
}

// ---------------------------------------------------------------------------
// trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse tree bytes into entries in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    const mode = data.subarray(pos, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Encode entries as tree bytes, in git's order (directories sort as if
 *  their name ended with '/'). */
export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// commits and tags

export interface CommitView {
  tree: string | null;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse commit bytes. The message is the body with trailing newlines cut,
 *  the form the API shows (git's own display trims them too). */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = (split === -1 ? '' : text.slice(split + 2)).replace(/\n+$/, '');
  const view: CommitView = { tree: null, parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export interface CommitSpec {
  tree: string;
  parents: readonly string[];
  message: string;
  timestamp?: number;
  who?: string;
}

/** Build commit bytes. The message is stored with one trailing newline. */
export function encodeCommit(spec: CommitSpec): Buffer {
  const stamp = `${spec.timestamp ?? EPOCH_SECONDS} +0000`;
  const who = spec.who ?? AUTHOR_LINE;
  const lines = [`tree ${spec.tree}`];
  for (const parent of spec.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who} ${stamp}`);
  lines.push(`committer ${who} ${stamp}`);
  lines.push('');
  let body = `${lines.join('\n')}\n${spec.message}`;
  if (!body.endsWith('\n')) body += '\n';
  return Buffer.from(body, 'utf8');
}

export interface TagView {
  object: string | null;
  type: string | null;
  tag: string | null;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const view: TagView = { object: null, type: null, tag: null, tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

export function encodeTag(object: string, objKind: string, tag: string, message: string, timestamp = EPOCH_SECONDS, who = AUTHOR_LINE): Buffer {
  let body = `object ${object}\ntype ${objKind}\ntag ${tag}\ntagger ${who} ${timestamp} +0000\n\n${message}`;
  if (!body.endsWith('\n')) body += '\n';
  return Buffer.from(body, 'utf8');
}

// ---------------------------------------------------------------------------
// deltas and packfiles

export class PackError extends Error {}

/** The size varint at the head of a delta: returns [value, nextPos]. */
function readDeltaVarint(data: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = data[pos] ?? 0;
    pos += 1;
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) return [result, pos];
  }
}

/** The base offset of an OFS_DELTA entry: returns [offset, nextPos]. */
function readOfsOffset(data: Buffer, pos: number): [number, number] {
  let byte = data[pos] ?? 0;
  pos += 1;
  let offset = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = data[pos] ?? 0;
    pos += 1;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
  }
  return [offset, pos];
}

/**
 * Inflate the zlib stream starting at `pos`; returns [bytes, nextPos].
 * The consumed length comes from the engine's byte count, with a binary
 * search over the slice as a fallback for runtimes that do not report it.
 */
export function inflateAt(data: Buffer, pos: number): [Buffer, number] {
  const slice = data.subarray(pos);
  try {
    const result = inflateSync(slice, { info: true }) as unknown as {
      buffer: Buffer;
      engine?: { bytesWritten?: unknown };
    };
    const used = result.engine?.bytesWritten;
    if (typeof used === 'number' && used > 0) return [result.buffer, pos + used];
  } catch {
    // fall through to the binary search
  }
  let low = 1;
  let high = slice.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    try {
      inflateSync(slice.subarray(0, mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return [inflateSync(slice.subarray(0, low)), pos + low];
}

/** Apply a git delta to `base`, producing the target bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const [srcSize, afterSrc] = readDeltaVarint(delta, 0);
  if (srcSize !== base.length) throw new PackError('delta base size mismatch');
  const [dstSize, start] = readDeltaVarint(delta, afterSrc);
  const out: Buffer[] = [];
  let pos = start;
  while (pos < delta.length) {
    const op = delta[pos] ?? 0;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          offset |= (delta[pos] ?? 0) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          size |= (delta[pos] ?? 0) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new PackError('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize) throw new PackError('delta result size mismatch');
  return result;
}

export interface PackRead {
  objects: Map<string, GitObj>;
  deltaCount: number;
  version: number;
  declaredCount: number;
}

/**
 * Parse a packfile into its objects, resolving OFS_DELTA and REF_DELTA
 * entries (chains included). A REF_DELTA base may come from the pack
 * itself or from `lookup` — the receiving repo's objects, for thin packs.
 */
export function readPack(data: Buffer, lookup?: (oid: string) => GitObj | undefined): PackRead {
  if (data.length < 12 || data.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new PackError('not a packfile');
  }
  const version = data.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`);
  const count = data.readUInt32BE(8);
  const trailer = data.subarray(data.length - 20);
  if (sha1Hex(data.subarray(0, data.length - 20)) !== trailer.toString('hex')) {
    throw new PackError('pack checksum mismatch');
  }
  const body = data.subarray(12, data.length - 20);

  interface RawEntry {
    start: number;
    kind: ObjKind | 'ofs' | 'ref';
    base: number | string | null;
    payload: Buffer;
    size: number;
  }
  const raw: RawEntry[] = [];
  let pos = 0;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = body[pos] ?? 0;
    pos += 1;
    const code = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = body[pos] ?? 0;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (code === DELTA_OFS) {
      const [off, after] = readOfsOffset(body, pos);
      const [payload, next] = inflateAt(body, after);
      raw.push({ start, kind: 'ofs', base: off, payload, size });
      pos = next;
    } else if (code === DELTA_REF) {
      const baseOid = body.subarray(pos, pos + 20).toString('hex');
      const [payload, next] = inflateAt(body, pos + 20);
      raw.push({ start, kind: 'ref', base: baseOid, payload, size });
      pos = next;
    } else {
      const kind = CODE_KIND[code];
      if (kind === undefined) throw new PackError(`unknown pack object type ${code}`);
      const [payload, next] = inflateAt(body, pos);
      raw.push({ start, kind, base: null, payload, size });
      pos = next;
    }
  }

  const objects = new Map<string, GitObj>();
  const byOffset = new Map<number, GitObj & { oid: string }>();
  let deltaCount = 0;
  for (const entry of raw) {
    if (entry.kind === 'ofs' || entry.kind === 'ref') {
      deltaCount += 1;
      continue;
    }
    if (entry.payload.length !== entry.size) throw new PackError('object size mismatch');
    const oid = hashObj(entry.kind, entry.payload);
    objects.set(oid, { kind: entry.kind, data: entry.payload });
    byOffset.set(entry.start, { kind: entry.kind, data: entry.payload, oid });
  }
  let pending = raw.filter((e) => e.kind === 'ofs' || e.kind === 'ref');
  let guard = 0;
  while (pending.length > 0) {
    guard += 1;
    if (guard > raw.length + 5) throw new PackError('unresolvable delta chain');
    const remaining: RawEntry[] = [];
    let progressed = false;
    for (const entry of pending) {
      let baseObj: GitObj | undefined;
      if (entry.kind === 'ofs') {
        const baseOff = entry.start - (entry.base as number);
        baseObj = byOffset.get(baseOff);
      } else {
        const baseOid = entry.base as string;
        baseObj = objects.get(baseOid) ?? lookup?.(baseOid);
      }
      if (baseObj === undefined) {
        remaining.push(entry);
        continue;
      }
      const resolved = applyDelta(baseObj.data, entry.payload);
      const oid = hashObj(baseObj.kind, resolved);
      objects.set(oid, { kind: baseObj.kind, data: resolved });
      byOffset.set(entry.start, { kind: baseObj.kind, data: resolved, oid });
      progressed = true;
    }
    if (!progressed) throw new PackError('delta base not found');
    pending = remaining;
  }
  if (objects.size !== count) throw new PackError('pack object count mismatch');
  return { objects, deltaCount, version, declaredCount: count };
}

// ---------------------------------------------------------------------------
// pack writing and reachability

/** Encode one pack entry header: type code plus the size varint. */
function packEntryHeader(kind: ObjKind, size: number): Buffer {
  const code = KIND_CODE[kind];
  const first = (code << 4) | (size & 0x0f);
  let rest = size >> 4;
  const bytes: number[] = [];
  if (rest !== 0) {
    bytes.push(first | 0x80);
    while (rest !== 0) {
      const chunk = rest & 0x7f;
      rest >>= 7;
      bytes.push(rest !== 0 ? chunk | 0x80 : chunk);
    }
  } else {
    bytes.push(first);
  }
  return Buffer.from(bytes);
}

/** Build a packfile from plain entries, ids sorted for determinism. */
export function writePack(objs: Iterable<GitObj> | Map<string, GitObj>): Buffer {
  const list = [...objs.values()];
  list.sort((a, b) => {
    const ka = hashObj(a.kind, a.data);
    const kb = hashObj(b.kind, b.data);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const obj of list) {
    parts.push(packEntryHeader(obj.kind, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/** A packfile holding no objects. */
export function emptyPack(): Buffer {
  return writePack(new Map());
}

/**
 * Every id reachable from `tips` through commits, tags, trees and blobs.
 * Missing objects are skipped silently here; callers that need closure
 * completeness check the result against what they asked for.
 */
export function collectReachable(store: ObjStore, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    if (tip && tip !== '0'.repeat(40)) stack.push(tip);
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const entry = store.get(oid);
    if (entry === undefined) continue;
    seen.add(oid);
    if (entry.kind === 'commit') {
      const info = parseCommit(entry.data);
      if (info.tree !== null) stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (entry.kind === 'tag') {
      const info = parseTag(entry.data);
      if (info.object !== null) stack.push(info.object);
    } else if (entry.kind === 'tree') {
      for (const child of parseTree(entry.data)) stack.push(child.oid);
    }
  }
  return seen;
}

/** True when `maybeAncestor` is reachable from `tip` (or equals it). */
export function isAncestor(store: ObjStore, maybeAncestor: string, tip: string): boolean {
  if (maybeAncestor === tip) return true;
  return collectReachable(store, [tip]).has(maybeAncestor);
}

/** Follow tag objects to the commit they point at; null when unresolvable. */
export function peelToCommit(store: ObjStore, oid: string): string | null {
  const seen = new Set<string>();
  let current = oid;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const entry = store.get(current);
    if (entry === undefined) return null;
    if (entry.kind === 'tag') {
      const target = parseTag(entry.data).object;
      if (target === null) return null;
      current = target;
      continue;
    }
    return current;
  }
}
