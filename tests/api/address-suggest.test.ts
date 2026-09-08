/**
 * POST /api/address-suggest — the address autocomplete in the booking form.
 *
 * Contract: it never fails. Every path — a short query, a malformed body, a
 * dead upstream, a rate-limited caller — answers with a `results` array, so
 * the form never has to render an error state for a typeahead.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureSchema, resetDb } from '../helpers/db';
import { call } from '../helpers/route';

let ipCounter = 0;
const ip = () => `192.0.2.${++ipCounter % 250}.${ipCounter}`;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Suggestion {
  display_name: string;
  short_name: string;
  lat: string;
  lon: string;
  type: string;
}

/** Nominatim stand-in. Any other host throws, so nothing reaches the network. */
function stubNominatim(mode: 'ok' | 'error' | 'not-an-array', payload?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
      if (!url.includes('nominatim.openstreetmap.org')) {
        throw new Error(`[address-suggest.test] unexpected outbound fetch: ${url}`);
      }
      if (mode === 'error') return new Response('nope', { status: 500 });
      if (mode === 'not-an-array') {
        return new Response(JSON.stringify({ error: 'oops' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(payload ?? []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

async function suggest(body: unknown, from: string = ip()) {
  const { POST } = await import('@/app/api/address-suggest/route');
  return call<{ results: Suggestion[] }>(POST, {
    method: 'POST',
    path: '/api/address-suggest',
    body,
    headers: { 'x-forwarded-for': from },
  });
}

describe('POST /api/address-suggest', () => {
  it('maps a Nominatim hit into a short, human label', async () => {
    stubNominatim('ok', [
      {
        display_name: 'Storgata, 1, 8006, Bodø, Nordland, Norge',
        lat: '67.2804',
        lon: '14.4049',
        type: 'house',
        address: { road: 'Storgata', house_number: '1', postcode: '8006', city: 'Bodø' },
      },
    ]);

    const res = await suggest({ query: 'Storgata 1' });

    expect(res.status).toBe(200);
    expect(res.json.results).toHaveLength(1);
    expect(res.json.results[0]).toMatchObject({
      short_name: 'Storgata 1, 8006 Bodø',
      lat: '67.2804',
      lon: '14.4049',
      type: 'house',
    });
  });

  it('falls back to the first two display_name segments when the parts are thin', async () => {
    stubNominatim('ok', [
      {
        display_name: 'Saltstraumen, Bodø, Nordland, Norge',
        lat: '67.23',
        lon: '14.62',
        address: { city: 'Bodø' },
      },
    ]);

    const res = await suggest({ query: 'Saltstraumen' });
    expect(res.json.results[0].short_name).toBe('Saltstraumen, Bodø');
    expect(res.json.results[0].type).toBe('');
  });

  it('answers 200 with an empty array for a query it will not look up', async () => {
    stubNominatim('ok', [{ display_name: 'should not be reached', lat: '1', lon: '2' }]);

    for (const body of [{ query: '' }, { query: 'ab' }, { query: '  ' }, { query: 42 }, {}]) {
      const res = await suggest(body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(res.json.results).toEqual([]);
    }
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('answers 200 with an empty array when the upstream fails or answers junk', async () => {
    stubNominatim('error');
    expect((await suggest({ query: 'Storgata 1' })).json).toEqual({ results: [] });

    stubNominatim('not-an-array');
    const junk = await suggest({ query: 'Storgata 1' });
    expect(junk.status).toBe(200);
    expect(junk.json.results).toEqual([]);
  });

  it('answers 200 with an empty array when the body is not JSON', async () => {
    stubNominatim('ok', []);
    const { POST } = await import('@/app/api/address-suggest/route');
    const res = await call(POST, {
      method: 'POST',
      path: '/api/address-suggest',
      body: 'not json',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() },
    });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ results: [] });
  });

  it('rate-limits at 60 per minute, keeping the same body shape', async () => {
    stubNominatim('ok', []);
    const from = ip();

    for (let i = 0; i < 60; i++) {
      expect((await suggest({ query: 'ab' }, from)).status).toBe(200);
    }
    const blocked = await suggest({ query: 'ab' }, from);
    expect(blocked.status).toBe(429);
    expect(blocked.json).toEqual({ results: [] });
  }, 30_000);
});
