/**
 * L2 — the upload surface: two writers and one public reader.
 *
 * The invariant this file is built around is the one the code does NOT hold:
 *
 *   a renter can retrieve only files tied to their own session, and admin
 *   uploads need an admin session
 *
 * `GET /api/uploads/[filename]` is outside the proxy matcher and checks
 * nothing at all, so every uploaded file — a renter's damage photos, an
 * equipment manual, whatever an admin dropped into the settings form — is
 * world-readable to anyone who can name it. Names are `<prefix>-<Date.now()>.<ext>`,
 * which is a 40-bit guess over a known day. That is flag F-2, recorded below.
 *
 * The rest is the write path: magic-byte sniffing (the declared MIME type and
 * the filename are both attacker-controlled), the size caps, and the traversal
 * defences on the read path.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { toDateStr } from '@/lib/dates';

import { TEST_DB_DIR } from '../setup';
import { booking, ensureSchema, resetDb } from '../helpers/db';
import { adminCookieJar, call, COOKIE_NAME, renterBearer, type RouteHandler } from '../helpers/route';
import { mockClock } from '../helpers/mocks';

/**
 * The helper's `RouteHandler` widens `params` to a string record; this route
 * declares `{ filename: string }`. Neither is assignable to the other, so the
 * cast lives here, at the call boundary, and nowhere else.
 */
const asRoute = (handler: unknown) => handler as RouteHandler;

const UPLOAD_DIR = path.join(TEST_DB_DIR, 'uploads');
const created = new Set<string>();

let ipSeq = 0;
const freshIp = () => ({ 'x-forwarded-for': `10.7.${Math.floor(ipSeq / 250)}.${++ipSeq % 250}` });

// ── Fixture bytes ────────────────────────────────────────────────────────────

const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const pad = (bytes: number[], size = 16) =>
  new Uint8Array([...bytes, ...new Array(Math.max(0, size - bytes.length)).fill(0)]);

const JPG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = pad([...str('RIFF'), 0, 0, 0, 0, ...str('WEBP')]);
const GIF = pad(str('GIF89a'));
const HEIC = pad([0, 0, 0, 0x18, ...str('ftypheic')]);
const PDF = pad(str('%PDF-1.7\n%âãÏÓ'));
const SVG = pad(str('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 80);
const HTML = pad(str('<!doctype html><script>alert(1)</script>'), 40);

function fileOf(bytes: Uint8Array, name: string, type = 'application/octet-stream'): File {
  return new File([bytes as unknown as BlobPart], name, { type });
}

function form(file: File): FormData {
  const fd = new FormData();
  fd.set('file', file);
  return fd;
}

// ── Callers ──────────────────────────────────────────────────────────────────

async function adminUpload(file: File, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/admin/upload/route');
  const res = await call(POST, {
    method: 'POST', path: '/api/admin/upload', body: form(file),
    headers: { ...freshIp(), ...headers },
  });
  if (res.json?.url) created.add(res.json.url.split('/').pop());
  return res;
}

async function renterUpload(file: File, authorization: string, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/checklist/upload/route');
  const res = await call(POST, {
    method: 'POST', path: '/api/checklist/upload', body: form(file),
    headers: { ...freshIp(), authorization, ...headers },
  });
  if (res.json?.url) created.add(res.json.url.split('/').pop());
  return res;
}

async function fetchUpload(
  filename: string,
  credentials: { headers?: Record<string, string>; cookies?: Record<string, string> } = {},
) {
  const { GET } = await import('@/app/api/uploads/[filename]/route');
  return call(asRoute(GET), {
    path: `/api/uploads/${encodeURIComponent(filename)}`,
    params: { filename },
    ...credentials,
  });
}

/**
 * A confirmed, paid booking whose rental period covers today.
 *
 * `skipLocks` because a test may need two overlapping rentals (one renter's
 * session against another renter's file) and the date locks are per machine
 * and date — the locks play no part in what these tests assert.
 */
async function activeRental(phone = '+4740000000') {
  const row = await booking('confirmed', {
    startDateStr: toDateStr(new Date()),
    rentalType: 'week',
    fullyPaidAt: new Date(),
    phone,
    skipLocks: true,
  });
  return { booking: row, authorization: await renterBearer(row.id, phone.replace('+47', '')) };
}

beforeAll(() => ensureSchema());
beforeEach(() => resetDb());
afterAll(() => {
  for (const name of created) {
    if (name) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
  }
});

// ── The invariant ────────────────────────────────────────────────────────────

describe('access control on stored uploads', () => {
  // FIXED H-6 (F-2): GET /api/uploads/[filename] performed no authentication
  // whatsoever, and the path is not in the proxy matcher, so nothing upstream
  // authenticated it either — a renter's checklist photos were served to any
  // anonymous caller who could name the file. The handler now gates every
  // `renter-` name on an admin session cookie or the renter bearer token whose
  // bookingId matches the one in the filename. `upload-` files stay public:
  // machine photos, manuals, the logo and the hero image are rendered on the
  // public site by design.
  it('FIXED H-6: refuses a renter upload to a caller with no session', async () => {
    const { authorization } = await activeRental();
    const uploaded = await renterUpload(fileOf(JPG, 'skade.jpg', 'image/jpeg'), authorization);
    expect(uploaded.status).toBe(200);
    const name = uploaded.json.url.split('/').pop();

    const anonymous = await fetchUpload(name);
    expect(anonymous.status).toBe(401);
    expect(anonymous.text).not.toContain('\uFFFD');
  });

  it('serves a renter photo back to the renter that uploaded it', async () => {
    const { authorization } = await activeRental();
    const uploaded = await renterUpload(fileOf(JPG, 'skade.jpg', 'image/jpeg'), authorization);
    const name = uploaded.json.url.split('/').pop();

    const res = await fetchUpload(name, { headers: { authorization } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await res.response.arrayBuffer())).toEqual(JPG);
    // Per-session content: never in a shared cache.
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
  });

  it('refuses a renter session that belongs to a different booking with 403', async () => {
    const mine = await activeRental();
    const theirs = await activeRental('+4741000000');
    const uploaded = await renterUpload(fileOf(JPG, 'skade.jpg', 'image/jpeg'), mine.authorization);
    const name = uploaded.json.url.split('/').pop();

    // A real, unexpired session — for someone else's rental.
    const res = await fetchUpload(name, { headers: { authorization: theirs.authorization } });
    expect(res.status).toBe(403);

    // …and the file is still readable by the renter it belongs to.
    expect((await fetchUpload(name, { headers: { authorization: mine.authorization } })).status).toBe(200);
  });

  it('serves a renter photo to an admin session cookie, as the admin views need', async () => {
    // The admin checklist page renders these with a plain same-origin <img>,
    // which carries the session cookie and nothing else.
    const { authorization } = await activeRental();
    const uploaded = await renterUpload(fileOf(JPG, 'skade.jpg', 'image/jpeg'), authorization);
    const name = uploaded.json.url.split('/').pop();

    const res = await fetchUpload(name, { cookies: await adminCookieJar() });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.response.arrayBuffer())).toEqual(JPG);
  });

  it('refuses a forged or expired renter bearer, and a forged admin cookie', async () => {
    const { authorization } = await activeRental();
    const name = (await renterUpload(fileOf(JPG, 'x.jpg'), authorization)).json.url.split('/').pop();

    for (const headers of [
      { authorization: 'Bearer garbage' },
      { authorization: 'Basic abc' },
      { authorization: '' },
    ]) {
      expect((await fetchUpload(name, { headers })).status).toBe(401);
    }
    expect((await fetchUpload(name, { cookies: { [COOKIE_NAME]: 'forged' } })).status).toBe(401);
  });

  it('leaves admin uploads public — they are the public site\'s content', async () => {
    const uploaded = await adminUpload(fileOf(PNG, 'logo.png', 'image/png'));
    const res = await fetchUpload(uploaded.json.url.split('/').pop());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  // FIXED H-7 (F-2): stored names were `<prefix>-<Date.now()>.<ext>` — the only
  // secret protecting a file was a millisecond timestamp, and knowing one name
  // gave an attacker the neighbouring millisecond for free. Names now carry 64
  // bits from the CSPRNG (`upload-<16 hex>` / `renter-<bookingId>-<16 hex>`).
  it('FIXED H-7: stored names are not derived from a guessable timestamp', async () => {
    const clock = mockClock('2026-09-06T12:34:56.789Z');
    try {
      const res = await adminUpload(fileOf(PNG, 'logo.png', 'image/png'));
      expect(res.json.url).not.toBe(`/api/uploads/upload-${Date.parse('2026-09-06T12:34:56.789Z')}.png`);
      expect(res.json.url).toMatch(/^\/api\/uploads\/upload-[0-9a-f]{16}\.png$/);
    } finally {
      clock.restore();
    }
  });

  it('names a renter photo after its booking, so the read gate can check it', async () => {
    const { booking: row, authorization } = await activeRental();
    const res = await renterUpload(fileOf(JPG, 'skade.jpg', 'image/jpeg'), authorization);
    expect(res.json.url).toMatch(new RegExp(`^/api/uploads/renter-${row.id}-[0-9a-f]{16}\\.jpg$`));
  });

  it('never repeats a name across many uploads in the same millisecond', async () => {
    const clock = mockClock('2026-09-06T12:40:00.000Z');
    try {
      const names = new Set<string>();
      for (let i = 0; i < 12; i++) {
        names.add((await adminUpload(fileOf(PNG, 'x.png', 'image/png'))).json.url);
      }
      expect(names.size).toBe(12);
    } finally {
      clock.restore();
    }
  }, 30_000);

  // FIXED H-8 (F-2): two uploads inside the same millisecond used to produce
  // the same filename, and `writeFile` with no existence check let the second
  // silently overwrite the first — the earlier uploader's URL then served
  // someone else's bytes. Files are now created with the `wx` flag under a
  // random name, so neither the name nor the bytes can collide.
  it('FIXED H-8: a same-millisecond second upload does not overwrite the first', async () => {
    const clock = mockClock('2026-09-06T13:00:00.000Z');
    try {
      const first = await adminUpload(fileOf(PNG, 'a.png', 'image/png'));
      const second = await adminUpload(fileOf(PNG, 'b.png', 'image/png'));
      expect(second.json.url).not.toBe(first.json.url);
    } finally {
      clock.restore();
    }
  });

  it('keeps both files intact when two uploads share a millisecond and an extension', async () => {
    const clock = mockClock('2026-09-06T13:00:01.000Z');
    try {
      const first = await adminUpload(fileOf(pad([0xff, 0xd8, 0xff, 0xe0, 0x01]), 'a.jpg'));
      const second = await adminUpload(fileOf(pad([0xff, 0xd8, 0xff, 0xe0, 0x02]), 'b.jpg'));
      expect(second.json.url).not.toBe(first.json.url);

      const bytesAt = async (url: string) =>
        new Uint8Array(await (await fetchUpload(url.split('/').pop()!)).response.arrayBuffer());
      expect((await bytesAt(first.json.url))[4]).toBe(0x01);
      expect((await bytesAt(second.json.url))[4]).toBe(0x02);
    } finally {
      clock.restore();
    }
  });
});

// ── Read path: filename handling ─────────────────────────────────────────────

describe('GET /api/uploads/[filename] — filename handling', () => {
  it('404s for a name that does not exist, including a near-miss of a real one', async () => {
    const name: string = (await adminUpload(fileOf(JPG, 'x.jpg'))).json.url.split('/').pop();
    expect((await fetchUpload(name)).status).toBe(200);

    // Flip one hex digit of the random suffix — the neighbourhood of a valid
    // name is empty, which is the point of the random suffix (H-7).
    const suffix = name.match(/upload-([0-9a-f]{16})\.jpg/)![1];
    const flipped = `${suffix.slice(0, 15)}${suffix[15] === '0' ? '1' : '0'}`;
    expect((await fetchUpload(`upload-${flipped}.jpg`)).status).toBe(404);
    expect((await fetchUpload('upload-0000000000000000.jpg')).status).toBe(404);
    expect((await fetchUpload('upload-1757160896789.jpg')).status).toBe(404);
    expect((await fetchUpload('does-not-exist.png')).status).toBe(404);
  });

  it('rejects anything containing `..` or a slash with 400', async () => {
    for (const name of [
      '..',
      '../',
      '../../etc/passwd',
      '..%2fetc%2fpasswd',      // still contains `..`
      'a/../b.jpg',
      '/etc/passwd',
      'uploads/x.jpg',
      '....//etc/passwd',
    ]) {
      const res = await fetchUpload(name);
      expect({ name, status: res.status }).toEqual({ name, status: 400 });
      expect(res.json.error).toBe('Invalid filename');
    }
  });

  it('rejects an empty filename', async () => {
    const { GET } = await import('@/app/api/uploads/[filename]/route');
    const res = await call(asRoute(GET), { path: '/api/uploads/', params: { filename: '' } });
    expect(res.status).toBe(400);
  });

  it('treats an encoded, double-encoded or homoglyph traversal as an ordinary name, and 404s', async () => {
    // Next decodes the path segment before it reaches `params`, so a route test
    // that passes the still-encoded text is checking the case where decoding
    // did NOT happen: the string has no literal `..` or `/`, so it becomes a
    // literal (non-existent) filename rather than a traversal.
    for (const name of [
      '%2e%2e%2fetc%2fpasswd',
      '%252e%252e%252fetc%252fpasswd',
      '..\\..\\windows\\win.ini',     // backslash is an ordinary character on POSIX
      '..／etc',        // fullwidth solidus
      '．．/etc',             // fullwidth full stops — no literal `..`, but a real slash
      'x .jpg',
      'x.jpg .png',
    ]) {
      const res = await fetchUpload(name);
      expect({ name, ok: res.status === 404 || res.status === 400 }).toEqual({ name, ok: true });
      expect(res.status).not.toBe(200);
    }
  });

  it('cannot be walked out of the upload directory by any of the above', async () => {
    // Belt and braces: prove no probe reaches a file that certainly exists
    // outside the upload directory.
    const outside = path.join(TEST_DB_DIR, 'canary.txt');
    fs.writeFileSync(outside, 'canary');
    try {
      for (const name of [
        '../canary.txt',
        '%2e%2e%2fcanary.txt',
        '..\\canary.txt',
        './../canary.txt',
      ]) {
        const res = await fetchUpload(name);
        expect(res.status).not.toBe(200);
        expect(res.text).not.toContain('canary');
      }
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('derives the Content-Type from the extension and caches immutably', async () => {
    const cases: [Uint8Array, string, string][] = [
      [JPG, 'jpg', 'image/jpeg'],
      [PNG, 'png', 'image/png'],
      [WEBP, 'webp', 'image/webp'],
      [GIF, 'gif', 'image/gif'],
      [PDF, 'pdf', 'application/pdf'],
    ];
    for (const [bytes, ext, mime] of cases) {
      const up = await adminUpload(fileOf(bytes, `x.${ext}`));
      expect({ ext, status: up.status }).toEqual({ ext, status: 200 });
      const res = await fetchUpload(up.json.url.split('/').pop());
      expect({ ext, type: res.headers.get('content-type') }).toEqual({ ext, type: mime });
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    }
  });

  it('serves HEIC as application/octet-stream — the MIME map has no heic entry', async () => {
    // Documented, not a defect: iPhone photos are stored with a .heic extension
    // and download rather than render inline. Worth knowing before someone
    // "fixes" the upload sniffer and wonders why the admin gallery is blank.
    const up = await adminUpload(fileOf(HEIC, 'photo.heic', 'image/heic'));
    expect(up.status).toBe(200);
    expect(up.json.url).toMatch(/\.heic$/);
    const res = await fetchUpload(up.json.url.split('/').pop());
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });
});

// ── Write path: admin ────────────────────────────────────────────────────────

describe('POST /api/admin/upload', () => {
  it('requires a file part', async () => {
    const { POST } = await import('@/app/api/admin/upload/route');
    const res = await call(POST, {
      method: 'POST', path: '/api/admin/upload', body: new FormData(), headers: freshIp(),
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('Ingen fil');
  });

  it('accepts the six sniffable formats and names the file by its magic bytes', async () => {
    for (const [bytes, ext] of [
      [JPG, 'jpg'], [PNG, 'png'], [WEBP, 'webp'], [GIF, 'gif'], [HEIC, 'heic'], [PDF, 'pdf'],
    ] as const) {
      // Lie about both the extension and the declared type — neither is trusted.
      const res = await adminUpload(fileOf(bytes, 'anything.txt', 'text/plain'));
      expect({ ext, status: res.status }).toEqual({ ext, status: 200 });
      expect(res.json.url).toMatch(new RegExp(`^/api/uploads/upload-[0-9a-f]{16}\\.${ext}$`));
    }
  });

  it('refuses SVG, HTML and anything else that is not sniffable', async () => {
    for (const [bytes, name, type] of [
      [SVG, 'logo.svg', 'image/svg+xml'],
      [HTML, 'page.html', 'text/html'],
      [pad([0x4d, 0x5a]), 'tool.exe', 'application/octet-stream'],
      [pad(str('PK')), 'archive.zip', 'application/zip'],
    ] as const) {
      const res = await adminUpload(fileOf(bytes, name, type));
      expect({ name, status: res.status }).toEqual({ name, status: 400 });
      expect(res.json.error).toContain('Filtype ikke støttet');
    }
  });

  it('refuses a file too short to sniff, even with a valid-looking prefix', async () => {
    const res = await adminUpload(fileOf(new Uint8Array([0xff, 0xd8, 0xff]), 'tiny.jpg', 'image/jpeg'));
    expect(res.status).toBe(400);
    expect((await adminUpload(fileOf(new Uint8Array(0), 'empty.jpg'))).status).toBe(400);
  });

  it('accepts a file at exactly 20 MB and refuses one byte more', async () => {
    const atLimit = new Uint8Array(20 * 1024 * 1024);
    atLimit.set(JPG.slice(0, 4));
    const ok = await adminUpload(fileOf(atLimit, 'big.jpg', 'image/jpeg'));
    expect(ok.status).toBe(200);

    const over = new Uint8Array(20 * 1024 * 1024 + 1);
    over.set(JPG.slice(0, 4));
    const rejected = await adminUpload(fileOf(over, 'bigger.jpg', 'image/jpeg'));
    expect(rejected.status).toBe(400);
    expect(rejected.json.error).toContain('for stor');
  }, 60_000);

  it('caps uploads at 20 per IP per 5 minutes', async () => {
    const ip = { 'x-forwarded-for': '198.51.100.200' };
    for (let i = 0; i < 20; i++) {
      expect((await adminUpload(fileOf(JPG, 'x.jpg'), ip)).status).toBe(200);
    }
    const blocked = await adminUpload(fileOf(JPG, 'x.jpg'), ip);
    expect(blocked.status).toBe(429);
  }, 30_000);
});

// ── Write path: renter ───────────────────────────────────────────────────────

describe('POST /api/checklist/upload', () => {
  it('needs a valid renter bearer token', async () => {
    for (const auth of ['', 'Bearer', 'Bearer garbage', 'Basic abc']) {
      const res = await renterUpload(fileOf(JPG, 'x.jpg'), auth);
      expect({ auth, status: res.status }).toEqual({ auth, status: 401 });
    }
  });

  it('404s when the session points at a booking that no longer exists', async () => {
    const auth = await renterBearer('ckqzdeadbeefdeadbeefdead', '40000000');
    expect((await renterUpload(fileOf(JPG, 'x.jpg'), auth)).status).toBe(404);
  });

  it('404s when the session phone does not match the booking', async () => {
    const row = await booking('confirmed', {
      startDateStr: toDateStr(new Date()), rentalType: 'week', fullyPaidAt: new Date(),
    });
    const auth = await renterBearer(row.id, '49999999');
    expect((await renterUpload(fileOf(JPG, 'x.jpg'), auth)).status).toBe(404);
  });

  it('403s while the rental is not active', async () => {
    // Confirmed but unpaid.
    const unpaid = await booking('confirmed', {
      startDateStr: toDateStr(new Date()), rentalType: 'week', phone: '+4740000000',
    });
    const res = await renterUpload(
      fileOf(JPG, 'x.jpg'),
      await renterBearer(unpaid.id, '40000000'),
    );
    expect(res.status).toBe(403);
    expect(res.json.error).toContain('ikke aktiv');
  });

  it('stores an image under a renter- prefix', async () => {
    const { authorization } = await activeRental();
    for (const [bytes, ext] of [[JPG, 'jpg'], [PNG, 'png'], [WEBP, 'webp'], [GIF, 'gif'], [HEIC, 'heic']] as const) {
      const res = await renterUpload(fileOf(bytes, 'foto.txt', 'text/plain'), authorization);
      expect({ ext, status: res.status }).toEqual({ ext, status: 200 });
      expect(res.json.url).toMatch(new RegExp(`^/api/uploads/renter-[a-z0-9]+-[0-9a-f]{16}\\.${ext}$`));
    }
  });

  it('refuses a PDF even though the admin route accepts one', async () => {
    const { authorization } = await activeRental();
    const res = await renterUpload(fileOf(PDF, 'manual.pdf', 'application/pdf'), authorization);
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('Kun bilder');
  });

  it('refuses SVG and unsniffable content', async () => {
    const { authorization } = await activeRental();
    expect((await renterUpload(fileOf(SVG, 'x.svg', 'image/svg+xml'), authorization)).status).toBe(400);
    expect((await renterUpload(fileOf(HTML, 'x.html', 'text/html'), authorization)).status).toBe(400);
    expect((await renterUpload(fileOf(new Uint8Array([0xff, 0xd8]), 'x.jpg'), authorization)).status).toBe(400);
  });

  it('accepts a file at exactly 10 MB and refuses one byte more', async () => {
    const { authorization } = await activeRental();
    const atLimit = new Uint8Array(10 * 1024 * 1024);
    atLimit.set(JPG.slice(0, 4));
    expect((await renterUpload(fileOf(atLimit, 'big.jpg'), authorization)).status).toBe(200);

    const over = new Uint8Array(10 * 1024 * 1024 + 1);
    over.set(JPG.slice(0, 4));
    const rejected = await renterUpload(fileOf(over, 'bigger.jpg'), authorization);
    expect(rejected.status).toBe(400);
    expect(rejected.json.error).toContain('for stor');
  }, 60_000);

  it('checks the session before the rate limiter, so an anonymous flood cannot burn a renter\'s budget', async () => {
    const ip = { 'x-forwarded-for': '198.51.100.201' };
    for (let i = 0; i < 15; i++) {
      expect((await renterUpload(fileOf(JPG, 'x.jpg'), 'Bearer garbage', ip)).status).toBe(401);
    }
    const { authorization } = await activeRental();
    expect((await renterUpload(fileOf(JPG, 'x.jpg'), authorization, ip)).status).toBe(200);
  }, 30_000);

  it('caps uploads at 10 per IP per 5 minutes once authenticated', async () => {
    const { authorization } = await activeRental();
    const ip = { 'x-forwarded-for': '198.51.100.202' };
    for (let i = 0; i < 10; i++) {
      expect((await renterUpload(fileOf(JPG, 'x.jpg'), authorization, ip)).status).toBe(200);
    }
    expect((await renterUpload(fileOf(JPG, 'x.jpg'), authorization, ip)).status).toBe(429);
  }, 30_000);
});
