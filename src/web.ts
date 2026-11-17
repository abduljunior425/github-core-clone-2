// Shared request/response plumbing for the HTTP surface.
//
// A Ctx is everything a handler needs: the method, the decoded path
// segments, the query string, the raw body bytes and the request's base
// URL (for pagination links). A Reply is a complete answer the server
// sends verbatim. JSON replies always carry the request id and the
// OAuth scopes headers the suite reads.

import { jsonBytes, requestIdText } from './consts.ts';

export interface Ctx {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  baseUrl: string;
  requestId: string;
}

export interface Reply {
  status: number;
  body: Buffer;
  contentType: string;
  headers?: Record<string, string>;
}

let requestCounter = 0;

/** The next request id, in creation order. */
export function nextRequestId(): string {
  requestCounter += 1;
  return requestIdText(requestCounter);
}

/** A JSON reply: compact body, JSON content type, no extra headers. */
export function jsonReply(status: number, value: unknown, headers?: Record<string, string>): Reply {
  return { status, body: jsonBytes(value), contentType: 'application/json', headers };
}

/** A JSON error reply: {"message": ...}. */
export function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

/** An empty reply (204 and friends): no body at all. */
export function emptyReply(status: number, headers?: Record<string, string>): Reply {
  return { status, body: Buffer.alloc(0), contentType: 'application/json', headers };
}

/**
 * Parse a request body as a JSON object. Empty means {}. A malformed body
 * or a non-object body answers 400 — the caller returns that reply at once.
 */
export function parseJsonBody(ctx: Ctx): { value: Record<string, unknown> | null; error: Reply | null } {
  if (ctx.body.length === 0) return { value: {}, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { value: null, error: errorReply(400, 'Invalid JSON body') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { value: null, error: errorReply(400, 'JSON body must be an object') };
  }
  return { value: parsed as Record<string, unknown>, error: null };
}

/**
 * Slice `items` by page/per_page and build the Link header GitHub sends:
 * rel="next" and rel="last" forward, rel="prev" and rel="first" back.
 */
export function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string, baseUrl: string): { page: T[]; link: string | null } {
  let perPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  if (Number.isNaN(perPage)) perPage = 30;
  perPage = Math.max(1, Math.min(perPage, 100));
  let page = Number.parseInt(query.get('page') ?? '1', 10);
  if (Number.isNaN(page)) page = 1;
  page = Math.max(1, page);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const base = `${baseUrl}${basePath}`;
  if (page < pages) {
    links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
    links.push(`<${base}?per_page=${perPage}&page=${pages}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
    links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  }
  return { page: [...slice], link: links.length > 0 ? links.join(', ') : null };
}

/** Decode one path segment (percent-decoding, never throwing). */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a raw request path into decoded segments, dropping empties. */
export function splitPath(rawPath: string): string[] {
  return rawPath
    .split('/')
    .filter((part) => part !== '')
    .map(decodeSegment);
}
