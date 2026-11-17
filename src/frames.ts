// pkt-line framing for the git wire protocol.
//
// A pkt-line is a 4-hex-digit length (itself included) followed by the
// payload. Length 0 is a flush packet, 1 a delim, 2 a response-end. The
// helpers here build streams and read them back; the receive-pack reader
// additionally stops at the flush that precedes the packfile bytes.

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');
export const RESPONSE_END_PKT = Buffer.from('0002', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export class PktError extends Error {}

/** One pkt-line around `payload` (string or bytes). */
export function frame(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > 65520) throw new PktError('pkt-line too long');
  const head = Buffer.alloc(4);
  head.write(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** Several items in order: strings/buffers become data lines, the words
 *  'flush' | 'delim' | 'response-end' become the control packets. */
export function frameMany(...items: Array<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const chunks: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') chunks.push(FLUSH_PKT);
    else if (item === 'delim') chunks.push(DELIM_PKT);
    else if (item === 'response-end') chunks.push(RESPONSE_END_PKT);
    else chunks.push(frame(item));
  }
  return Buffer.concat(chunks);
}

/** Decode a whole pkt-line stream; throws PktError on any malformed input. */
export function decodeAll(data: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < data.length) {
    if (data.length - pos < 4) throw new PktError('short pkt-line header');
    const head = data.subarray(pos, pos + 4).toString('ascii');
    const size = Number.parseInt(head, 16);
    if (Number.isNaN(size)) throw new PktError(`bad pkt-line length ${JSON.stringify(head)}`);
    if (size === 0) {
      out.push({ kind: 'flush' });
      pos += 4;
    } else if (size === 1) {
      out.push({ kind: 'delim' });
      pos += 4;
    } else if (size === 2) {
      out.push({ kind: 'response-end' });
      pos += 4;
    } else if (size < 4 || pos + size > data.length) {
      throw new PktError(`bad pkt-line size ${size}`);
    } else {
      out.push({ kind: 'data', payload: data.subarray(pos + 4, pos + size) });
      pos += size;
    }
  }
  return out;
}

/**
 * Split a receive-pack body at the flush packet that ends the command
 * section: [command packets, packfile bytes after the flush]. Anything
 * after the first flush is pack bytes, even if it looks like pkt-lines.
 */
export function splitAtFlush(data: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let pos = 0;
  while (pos < data.length) {
    if (data.length - pos < 4) throw new PktError('short pkt-line header');
    const head = data.subarray(pos, pos + 4).toString('ascii');
    const size = Number.parseInt(head, 16);
    if (Number.isNaN(size)) throw new PktError(`bad pkt-line length ${JSON.stringify(head)}`);
    if (size === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      break;
    }
    if (size === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (size === 2) {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (size < 4 || pos + size > data.length) throw new PktError(`bad pkt-line size ${size}`);
    packets.push({ kind: 'data', payload: data.subarray(pos + 4, pos + size) });
    pos += size;
  }
  return { packets, rest: data.subarray(pos) };
}

/** The text lines of a decoded stream, stopping at the first flush. */
export function textLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const pkt of packets) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind === 'data') lines.push(pkt.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Split one pkt-line data payload into its first line, for report parsing. */
export function firstLineOf(payload: Buffer): string {
  return payload.toString('utf8').split('\n')[0] ?? '';
}
