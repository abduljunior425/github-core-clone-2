// Shared constants and tiny pure helpers for the forge.
//
// Nothing here touches the network or the clock: every timestamp the server
// ever reports comes from the fixed epoch below, and every id is a counter
// or a stable encoding of its key, so two runs of the same requests produce
// the same bytes.

import { createHash } from 'node:crypto';

/** Release stamp reported by GET /api/v3/meta. */
export const FORGE_VERSION = '2.0.0';

/** Name the MCP endpoint reports for this server. */
export const SERVER_LABEL = 'forge2';

/** The login the bearer token names: the scenario viewer's login. */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's numeric id, as the scenario seeds it. */
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** "Name <email>" line stamped into every server-made commit and tag. */
export const AUTHOR_LINE = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

/** 2025-01-01T00:00:00Z. Every server-made timestamp reads from this. */
export const EPOCH_SECONDS = 1735689600;
export const EPOCH_ISO = '2025-01-01T00:00:00Z';

/** The branch a fresh repository reports as its default. */
export const MAIN_BRANCH = 'main';

/** The all-zero object id: an unborn ref, a delete command, an empty repo. */
export const ZERO_OID = '0'.repeat(40);

/** Bearer token the suite presents; empty locally means "any non-empty bearer". */
export const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** SHA-1 of `data`, lowercase hex. */
export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Standard base64 of bytes (or a UTF-8 string), no line breaks. */
export function toB64(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64');
}

/** Base64 with whitespace stripped first, so wrapped payloads still decode. */
export function fromB64(text: string): Buffer {
  return Buffer.from((text ?? '').replace(/[\r\n\t ]+/g, ''), 'base64');
}

/**
 * Opaque, stable Relay-style global id: URL-safe base64 of
 * "Kind:part:part" with the padding stripped. Decoding it recovers the key,
 * so node(id:) and the mutation inputs can resolve it without a lookup table.
 */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  const raw = `${kind}:${parts.map(String).join(':')}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Inverse of globalId: [kind, parts], or null when the value is not one. */
export function parseGlobalId(value: unknown): [string, string[]] | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const raw = Buffer.from(value, 'base64url').toString('utf8');
    const bits = raw.split(':');
    const kind = bits[0];
    if (kind === undefined || kind === '') return null;
    return [kind, bits.slice(1)];
  } catch {
    return null;
  }
}

/** Compact JSON bytes: the exact encoding every JSON reply is sent in. */
export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

/** True when `text` is a 40-hex object id. */
export function isOid(text: unknown): text is string {
  return typeof text === 'string' && /^[0-9a-f]{40}$/i.test(text);
}

/** A short, stable request id for the X-GitHub-Request-Id header. */
export function requestIdText(counter: number): string {
  return `req-${counter.toString(16).padStart(8, '0')}`;
}
