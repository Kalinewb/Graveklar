/**
 * Route harness — call a real Next.js route handler in-process.
 *
 * Handlers are ordinary functions of (NextRequest, ctx); nothing about them
 * needs a running server. `call()` builds the NextRequest the way Next would
 * (absolute URL, cookies as a header, params as a Promise) and normalises the
 * Response so assertions stay short.
 */
import { NextRequest, type NextResponse } from 'next/server';

import { COOKIE_NAME, createSessionToken } from '@/lib/admin-auth';
import { createRenterSessionToken } from '@/lib/renter-checklist-session';
import { proxy, config as proxyConfig } from '@/proxy';

/** Origin used for every synthetic request — the audit instance's port. */
export const TEST_ORIGIN = 'http://localhost:3001';

export type RouteParams = Record<string, string | string[]>;

export interface CallOptions {
  method?: string;
  path?: string;
  /** Object → JSON body, string → raw body, FormData → multipart. */
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  /** Dynamic segment values. Handed to the handler as `{ params: Promise<…> }`. */
  params?: RouteParams;
  searchParams?: Record<string, string | number | boolean | null | undefined>;
}

export type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<RouteParams> },
) => Response | Promise<Response>;

export interface CallResult<T = any> {
  status: number;
  /** Parsed JSON body, or null when the body was empty or not JSON. */
  json: T;
  text: string;
  headers: Headers;
  response: Response;
}

function buildUrl(path: string, searchParams?: CallOptions['searchParams']): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, TEST_ORIGIN);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function serializeCookies(cookies?: Record<string, string>): string | null {
  const entries = Object.entries(cookies ?? {});
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Build the NextRequest a handler (or the proxy) would receive. */
export function buildRequest(opts: CallOptions = {}): NextRequest {
  const method = (opts.method ?? 'GET').toUpperCase();
  const headers = new Headers(opts.headers ?? {});

  const cookieHeader = serializeCookies(opts.cookies);
  if (cookieHeader) {
    const existing = headers.get('cookie');
    headers.set('cookie', existing ? `${existing}; ${cookieHeader}` : cookieHeader);
  }

  let body: BodyInit | undefined;
  if (opts.body !== undefined && opts.body !== null && method !== 'GET' && method !== 'HEAD') {
    if (typeof FormData !== 'undefined' && opts.body instanceof FormData) {
      body = opts.body; // fetch sets the multipart boundary itself
    } else if (typeof opts.body === 'string') {
      body = opts.body;
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8');
    } else {
      body = JSON.stringify(opts.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
  }

  return new NextRequest(buildUrl(opts.path ?? '/', opts.searchParams), { method, headers, body });
}

async function normalize<T>(response: Response): Promise<CallResult<T>> {
  const text = await response.clone().text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, text, headers: response.headers, response };
}

/**
 * Invoke a route handler.
 *
 * ```ts
 * const { POST } = await import('@/app/api/quote/route');
 * const res = await call(POST, { method: 'POST', path: '/api/quote', body: { … } });
 * ```
 *
 * Next 16 hands dynamic segments to the handler as a Promise, so `params` is
 * always wrapped even when empty.
 */
export async function call<T = any>(
  handler: RouteHandler,
  opts: CallOptions = {},
): Promise<CallResult<T>> {
  const request = buildRequest(opts);
  const response = await handler(request, { params: Promise.resolve(opts.params ?? {}) });
  return normalize<T>(response);
}

// ── Credentials ──────────────────────────────────────────────────────────────

/** A real admin session token, signed with the secret tests/setup.ts stubbed. */
export async function adminSessionToken(): Promise<string> {
  return createSessionToken();
}

/** …as a ready-to-use `cookie` request header value. */
export async function adminCookie(): Promise<string> {
  return `${COOKIE_NAME}=${await adminSessionToken()}`;
}

/** …as the `cookies` map `call()` accepts. */
export async function adminCookieJar(): Promise<Record<string, string>> {
  return { [COOKIE_NAME]: await adminSessionToken() };
}

/** `Authorization` value for the renter QR kiosk endpoints. */
export async function renterBearer(bookingId: string, phone: string): Promise<string> {
  return `Bearer ${await createRenterSessionToken(bookingId, phone)}`;
}

/** Header pair for the 2FA-gated admin endpoints. Never enrols anything. */
export function totpHeader(code: string): Record<string, string> {
  return { 'x-admin-totp': code };
}

/** `Authorization` value for the cron endpoints. */
export function cronBearer(): string {
  return `Bearer ${process.env.CRON_SECRET ?? ''}`;
}

export { COOKIE_NAME };

// ── Proxy ────────────────────────────────────────────────────────────────────

/**
 * Run src/proxy.ts against a synthetic request and return its NextResponse, so
 * a test can assert the 401 / redirect the matcher-selected paths get before
 * any handler runs.
 */
export async function proxyCall(path: string, opts: CallOptions = {}): Promise<NextResponse> {
  return proxy(buildRequest({ ...opts, path })) as Promise<NextResponse>;
}

/**
 * Does `path` fall inside the exported `config.matcher`?
 *
 * Next compiles matcher entries with path-to-regexp. This reimplements the
 * subset the app actually uses — literal segments plus `/:name`, `/:name?`,
 * `/:name+`, `/:name*` — which is exact for every current pattern. It is NOT a
 * general path-to-regexp: add a matcher with a custom regex group, a
 * `has`/`missing` condition, or a non-segment parameter and this helper must
 * be revisited (see tests/helpers/README.md).
 */
export function matcherToRegExp(pattern: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '/' && pattern[i + 1] === ':') {
      const rest = pattern.slice(i + 2);
      const name = rest.match(/^[A-Za-z0-9_]+/)?.[0];
      if (name) {
        const modifier = rest[name.length];
        if (modifier === '*') {
          out += '(?:\\/[^\\/]+)*';
          i += 2 + name.length + 1;
        } else if (modifier === '+') {
          out += '(?:\\/[^\\/]+)+';
          i += 2 + name.length + 1;
        } else if (modifier === '?') {
          out += '(?:\\/[^\\/]+)?';
          i += 2 + name.length + 1;
        } else {
          out += '\\/[^\\/]+';
          i += 2 + name.length;
        }
        continue;
      }
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

/** The matcher patterns src/proxy.ts exports. */
export const PROXY_MATCHER: string[] = (proxyConfig.matcher ?? []) as string[];

/** True when Next would run the proxy for this pathname. */
export function matcherMatches(pathname: string): boolean {
  return PROXY_MATCHER.some((pattern) => matcherToRegExp(pattern).test(pathname));
}
