// Git smart HTTP: the /{owner}/{repo}.git surface.
//
// upload-pack speaks protocol v2 (ls-refs, fetch with shallow/deepen) and
// falls back to v0 when the client does not ask for v2; receive-pack is
// v0 only, with report-status over side-band-64k. Every handler here is
// pure over a Repository plus the request bytes and answers a
// {status, body, contentType} triple the server sends verbatim.

import { ZERO_OID } from './consts.ts';
import { DELIM_PKT, FLUSH_PKT, decodeAll, frame, frameMany, splitAtFlush, type Pkt } from './frames.ts';
import {
  collectReachable,
  parseCommit,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
  isAncestor,
  PackError,
  type ObjStore,
} from './gitobjs.ts';
import type { Repository } from './vault.ts';

export interface WireReply {
  status: number;
  body: Buffer;
  contentType: string;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function jsonError(status: number, message: string): WireReply {
  return { status, body: Buffer.from(JSON.stringify({ message }), 'utf8'), contentType: 'application/json' };
}

/** Refs in advertisement order: HEAD, then heads, then tags (peeled). */
export function sortedRefs(repo: Repository): Array<{ name: string; oid: string; peeled: string | null }> {
  const out: Array<{ name: string; oid: string; peeled: string | null }> = [];
  const headTip = repo.headTip();
  out.push({ name: 'HEAD', oid: headTip ?? ZERO_OID, peeled: null });
  for (const name of [...repo.refs.keys()].sort()) {
    if (name.startsWith('refs/heads/')) out.push({ name, oid: repo.refs.get(name) as string, peeled: null });
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!name.startsWith('refs/tags/')) continue;
    const oid = repo.refs.get(name) as string;
    const peeled = peelToCommit(repo.objects, oid);
    out.push({ name, oid, peeled: peeled !== null && peeled !== oid ? peeled : null });
  }
  return out;
}

/** GET /info/refs?service=... — the v2 or v0 capability advertisement. */
export function handleAdvertise(repo: Repository, service: 'git-upload-pack' | 'git-receive-pack', gitProtocol: string): WireReply {
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const body = frameMany('version 2\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n', 'flush');
    return { status: 200, body, contentType: UPLOAD_AD };
  }
  const refs = sortedRefs(repo);
  const caps =
    service === 'git-upload-pack'
      ? ['symref=HEAD:refs/heads/main', 'side-band-64k', 'thin-pack', 'ofs-delta', 'multi_ack', 'shallow', 'no-progress']
      : ['symref=HEAD:refs/heads/main', 'report-status', 'side-band-64k', 'delete-refs', 'ofs-delta'];
  const chunks: Buffer[] = [frame(`# service=${service}\n`), FLUSH_PKT];
  refs.forEach((ref, index) => {
    if (index === 0) chunks.push(frame(`${ref.oid} ${ref.name}\0${caps.join(' ')}\n`));
    else chunks.push(frame(`${ref.oid} ${ref.name}\n`));
    if (ref.peeled !== null) chunks.push(frame(`${ref.peeled} ${ref.name}^{}\n`));
  });
  chunks.push(FLUSH_PKT);
  return { status: 200, body: Buffer.concat(chunks), contentType: service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD };
}

// ---------------------------------------------------------------------------
// v2 ls-refs

/** Answer a v2 ls-refs command over `args` (the argument lines). */
export function handleLsRefs(repo: Repository, args: readonly string[]): WireReply {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  interface Row {
    oid: string | null;
    name: string;
    symref: string | null;
    peeled: string | null;
  }
  const rows: Row[] = [];
  const headMatches = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (headMatches) {
    const headTip = repo.headTip();
    if (headTip !== undefined) {
      rows.push({ oid: headTip, name: 'HEAD', symref: symrefs ? 'refs/heads/main' : null, peeled: null });
    } else if (unborn) {
      rows.push({ oid: null, name: 'HEAD', symref: symrefs ? 'refs/heads/main' : null, peeled: null });
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) continue;
    const oid = repo.refs.get(name) as string;
    let peeled: string | null = null;
    if (peel && name.startsWith('refs/tags/')) {
      const target = peelToCommit(repo.objects, oid);
      if (target !== null && target !== oid) peeled = target;
    }
    rows.push({ oid, name, symref: null, peeled });
  }
  const chunks: Buffer[] = [];
  for (const row of rows) {
    let line = row.oid === null ? `unborn ${row.name}` : `${row.oid} ${row.name}`;
    if (row.symref !== null) line += ` symref-target:${row.symref}`;
    if (row.peeled !== null) line += ` peeled:${row.peeled}`;
    chunks.push(frame(`${line}\n`));
  }
  chunks.push(FLUSH_PKT);
  return { status: 200, body: Buffer.concat(chunks), contentType: UPLOAD_RESULT };
}

// ---------------------------------------------------------------------------
// fetch computation

export interface FetchPlan {
  send: ObjStore;
  shallowOut: string[];
  unshallowOut: string[];
}

/**
 * Which objects a fetch sends, for wants/haves/shallow/deepen.
 *
 * A have on the client's shallow boundary is held itself, with its tree,
 * but its parents are not held — that is what keeps a deepen fetch from
 * coming back empty. A commit at distance d from a want is sent when
 * d < depth; the deepest sent generation is the new shallow boundary.
 */
export function computeFetch(repo: Repository, wants: readonly string[], haves: readonly string[], shallowIn: readonly string[], depth: number | null): FetchPlan {
  const objects = repo.objects;
  const held = new Set<string>();
  if (haves.length > 0) {
    const shallowSet = new Set(shallowIn);
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (held.has(oid)) continue;
      const entry = objects.get(oid);
      if (entry === undefined) continue;
      held.add(oid);
      if (entry.kind === 'commit') {
        const info = parseCommit(entry.data);
        if (info.tree !== null) {
          for (const x of collectReachable(objects, [info.tree])) held.add(x);
        }
        if (!shallowSet.has(oid)) {
          for (const parent of info.parents) stack.push(parent);
        }
      } else if (entry.kind === 'tag') {
        const target = parseTag(entry.data).object;
        if (target !== null) stack.push(target);
      } else if (entry.kind === 'tree') {
        for (const x of collectReachable(objects, [oid])) held.add(x);
      }
    }
  }

  const dist = new Map<string, number>();
  const included = new Set<string>();
  const stack: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  while (stack.length > 0) {
    const [oid, d] = stack.pop() as [string, number];
    const seen = dist.get(oid);
    if (seen !== undefined && seen <= d) continue;
    const entry = objects.get(oid);
    if (entry === undefined) continue;
    if (entry.kind === 'tag') {
      included.add(oid);
      const target = parseTag(entry.data).object;
      if (target !== null) {
        const targetEntry = objects.get(target);
        if (targetEntry !== undefined && targetEntry.kind === 'commit') stack.push([target, d]);
        else for (const x of collectReachable(objects, [target])) included.add(x);
      }
      dist.set(oid, d);
      continue;
    }
    if (entry.kind !== 'commit') {
      included.add(oid);
      dist.set(oid, d);
      continue;
    }
    if (depth !== null && d >= depth) {
      dist.set(oid, d);
      continue;
    }
    dist.set(oid, d);
    included.add(oid);
    const info = parseCommit(entry.data);
    if (info.tree !== null) {
      for (const x of collectReachable(objects, [info.tree])) included.add(x);
    }
    for (const parent of info.parents) stack.push([parent, d + 1]);
  }

  const send: ObjStore = new Map();
  for (const oid of included) {
    if (held.has(oid)) continue;
    const entry = objects.get(oid);
    if (entry !== undefined) send.set(oid, entry);
  }
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of dist) {
      const entry = objects.get(oid);
      if (entry === undefined || entry.kind !== 'commit') continue;
      if (d === depth - 1 && included.has(oid)) shallowOut.push(oid);
    }
    for (const oid of shallowIn) {
      const entry = objects.get(oid);
      if (entry === undefined || entry.kind !== 'commit') continue;
      if (!included.has(oid)) continue;
      const parents = parseCommit(entry.data).parents;
      if (parents.every((p) => included.has(p))) unshallowOut.push(oid);
    }
    shallowOut.sort();
    unshallowOut.sort();
  }
  return { send, shallowOut, unshallowOut };
}

/** Pack bytes in sideband band 1, chunked under the pkt-line limit. */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let start = 0; start < pack.length; start += 65000) {
    chunks.push(frame(Buffer.concat([Buffer.from([1]), pack.subarray(start, start + 65000)])));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// fetch: v2 and v0

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowIn: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallowIn: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).split(' ')[0] as string);
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallowIn.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      out.depth = Number.isNaN(n) ? null : n;
    } else if (arg === 'done') out.done = true;
  }
  return out;
}

/** Answer a v2 fetch command. */
export function handleFetchV2(repo: Repository, args: readonly string[]): WireReply {
  const parsed = parseFetchArgs(args);
  const plan = computeFetch(repo, parsed.wants, parsed.haves, parsed.shallowIn, parsed.depth);
  const pack = writePack(plan.send);
  if (!parsed.done) {
    // Negotiation round: acknowledgments first, the pack only once every
    // have the client named is a known ancestor of a want (the cut point).
    const chunks: Buffer[] = [frame('acknowledgments\n')];
    const wantReach = collectReachable(repo.objects, parsed.wants);
    const known = parsed.haves.filter((h) => wantReach.has(h));
    if (known.length > 0) {
      for (const oid of [...known].sort()) chunks.push(frame(`ACK ${oid}\n`));
    } else {
      chunks.push(frame('NAK\n'));
    }
    if (parsed.haves.length > 0 && known.length === parsed.haves.length) {
      chunks.push(frame('ready\n'), DELIM_PKT);
      if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
        chunks.push(frame('shallow-info\n'));
        for (const oid of plan.shallowOut) chunks.push(frame(`shallow ${oid}\n`));
        for (const oid of plan.unshallowOut) chunks.push(frame(`unshallow ${oid}\n`));
        chunks.push(DELIM_PKT);
      }
      chunks.push(frame('packfile\n'), ...sidebandPack(pack), FLUSH_PKT);
      return { status: 200, body: Buffer.concat(chunks), contentType: UPLOAD_RESULT };
    }
    chunks.push(FLUSH_PKT);
    return { status: 200, body: Buffer.concat(chunks), contentType: UPLOAD_RESULT };
  }
  // The client sent "done": acknowledgments are omitted entirely.
  const chunks: Buffer[] = [];
  if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
    chunks.push(frame('shallow-info\n'));
    for (const oid of plan.shallowOut) chunks.push(frame(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) chunks.push(frame(`unshallow ${oid}\n`));
    chunks.push(DELIM_PKT);
  }
  chunks.push(frame('packfile\n'), ...sidebandPack(pack), FLUSH_PKT);
  return { status: 200, body: Buffer.concat(chunks), contentType: UPLOAD_RESULT };
}

/** Answer a v0 fetch (want/have lines, no command= prefix). */
export function handleFetchV0(repo: Repository, args: readonly string[]): WireReply {
  const parsed = parseFetchArgs(args);
  const plan = computeFetch(repo, parsed.wants, parsed.haves, parsed.shallowIn, parsed.depth);
  const pack = writePack(plan.send);
  const chunks: Buffer[] = [frame('NAK\n')];
  for (const oid of plan.shallowOut) chunks.push(frame(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) chunks.push(frame(`unshallow ${oid}\n`));
  chunks.push(...sidebandPack(pack), FLUSH_PKT);
  return { status: 200, body: Buffer.concat(chunks), contentType: UPLOAD_RESULT };
}

/** POST /{owner}/{repo}.git/git-upload-pack. */
export function handleUploadPack(repo: Repository, body: Buffer): WireReply {
  let packets: Pkt[];
  try {
    packets = decodeAll(body);
  } catch {
    return jsonError(400, 'invalid pkt-line');
  }
  const texts: string[] = [];
  for (const pkt of packets) {
    if (pkt.kind === 'data') texts.push(pkt.payload.toString('utf8').replace(/\n$/, ''));
  }
  const first = texts[0] ?? '';
  if (!first.startsWith('command=')) {
    // v0 fetch shape: want/have lines directly.
    return handleFetchV0(repo, texts);
  }
  const command = first.slice('command='.length).trim();
  const args = texts.slice(1);
  if (command === 'ls-refs') return handleLsRefs(repo, args);
  if (command === 'fetch') return handleFetchV2(repo, args);
  return jsonError(400, `unknown command ${command}`);
}

// ---------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function sendReport(unpackLine: string, report: Array<{ ref: string; ok: boolean; reason: string }>): WireReply {
  const inner: Buffer[] = [frame(`${unpackLine}\n`)];
  for (const entry of report) {
    inner.push(frame(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`));
  }
  inner.push(FLUSH_PKT);
  const outer = Buffer.concat([frame(Buffer.concat([Buffer.from([1]), Buffer.concat(inner)])), FLUSH_PKT]);
  return { status: 200, body: outer, contentType: RECEIVE_RESULT };
}

/** POST /{owner}/{repo}.git/git-receive-pack. */
export function handleReceivePack(repo: Repository, body: Buffer): WireReply {
  let packets: Pkt[];
  let packBytes: Buffer;
  try {
    const split = splitAtFlush(body);
    packets = split.packets;
    packBytes = split.rest;
  } catch {
    return sendReport('unpack error: malformed request', []);
  }
  const commands: PushCommand[] = [];
  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    let text = pkt.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const bits = text.split(' ');
    if (bits.length !== 3) continue;
    commands.push({ oldOid: bits[0] as string, newOid: bits[1] as string, ref: bits[2] as string });
  }
  let unpackError: string | null = null;
  let incoming: ObjStore = new Map();
  if (packBytes.length > 0) {
    try {
      incoming = readPack(packBytes, (oid) => repo.objects.get(oid)).objects;
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  if (unpackError !== null) {
    return sendReport(`unpack error: ${unpackError}`, []);
  }
  for (const [oid, obj] of incoming) repo.objects.set(oid, obj);
  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) report.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      else if (current !== command.oldOid && command.oldOid !== ZERO_OID) {
        report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        report.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) report.push({ ref: command.ref, ok: false, reason: 'already exists' });
      else {
        repo.refs.set(command.ref, command.newOid);
        report.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      report.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      continue;
    }
    if (current !== command.oldOid) {
      report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    if (!isAncestor(repo.objects, command.oldOid, command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push({ ref: command.ref, ok: true, reason: '' });
  }
  return sendReport('unpack ok', report);
}
