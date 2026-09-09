/**
 * Inline media on the client side (`docs/inline-media.md` §8).
 *
 * The socket is the fake wire; the two media routes are HTTP, so
 * `fetch` is stubbed here — what these check is that the right
 * credential goes out, that a refusal arrives as the same
 * `WireFailure` every other call throws, and that the local pre-flight
 * refuses what the server would.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Connection, WireFailure, type Credentials } from '../src/connection';
import { mediaBlockedReason, type LoginOk, type MediaLimits, type SelfUser } from '../src/protocol';

import { installFakeWire, uninstallFakeWire, type FakeServer } from './fake-wire';

const CREDS: Credentials = {
  url: 'ws://test/ng',
  login: 'alice',
  password: 'hunter2',
  nick: 'Alice',
  icon: 128,
};

const LIMITS: MediaLimits = {
  max_bytes: 262144,
  max_dimension: 2048,
  max_pixels: 4194304,
  max_frames: 150,
  max_duration_ms: 15000,
  types: ['image/jpeg', 'image/png', 'image/gif'],
};

const me = (): SelfUser => ({
  uid: 1,
  nick: 'Alice',
  icon: 128,
  admin: false,
  status: 'active',
  transport: 'encrypted',
});

const loginOk = (over: Partial<LoginOk> = {}): LoginOk => ({
  session: 's_1',
  token: 'tok',
  self: me(),
  server: { name: 'Test', subject: '' },
  users: [],
  detach: { grace: 300 },
  caps: ['media'],
  seq: 0,
  media: LIMITS,
  ...over,
});

let server: FakeServer;
let calls: { url: string; init: RequestInit }[];

/** A `fetch` that records what it was asked and answers what the test
 *  told it to. */
function stubFetch(answer: () => Response): void {
  calls = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve(answer());
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  server = installFakeWire();
  server.on('login', () => ({ ok: loginOk() }));
});

afterEach(() => {
  uninstallFakeWire();
  vi.unstubAllGlobals();
});

async function connect(): Promise<Connection> {
  const conn = new Connection(CREDS, {});
  await conn.start();
  return conn;
}

describe('the login reply', () => {
  it('carries the ceilings a file picker needs', async () => {
    const conn = await connect();
    expect(conn.media).toEqual(LIMITS);
    expect(conn.hasCap('media')).toBe(true);
  });

  it('says plainly when a server takes no images', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: [], media: undefined }) }));
    const conn = await connect();
    // `null` rather than an empty object: a client draws the paperclip
    // from this, and "no ceilings" would be indistinguishable from
    // "ceilings of zero".
    expect(conn.media).toBeNull();
  });
});

describe('uploading', () => {
  it('posts the bytes with the session credential and returns the handle', async () => {
    const media = { id: 'AAAAAAAAAAAAAAAAAAAAAA', type: 'image/png', width: 8, height: 4, bytes: 91 };
    stubFetch(() => jsonResponse(201, { media }));
    const conn = await connect();

    const got = await conn.uploadMedia(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));

    expect(got).toEqual(media);
    const call = calls[0]!;
    expect(call.url).toBe('http://test/media');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    // The public session id and the secret token, joined by a dot — the
    // same credential `resume` presents, which is why an upload works
    // while detached and stops the moment the session does.
    expect(headers.Authorization).toBe('Bearer s_1.tok');
    expect(headers['Content-Type']).toBe('image/png');
  });

  it('turns a refusal into the failure every other call throws', async () => {
    stubFetch(() =>
      jsonResponse(413, { error: { code: 'media_too_large', text: 'Media too large' } }),
    );
    const conn = await connect();

    const failed = conn.uploadMedia(new Blob([new Uint8Array(4)], { type: 'image/png' }));
    await expect(failed).rejects.toBeInstanceOf(WireFailure);
    await expect(failed).rejects.toMatchObject({ wire: { code: 'media_too_large' } });
  });

  it('does not invent a code when the body is not ours', async () => {
    // A reverse proxy's own error page, which is HTML and says nothing
    // about media.
    stubFetch(() => new Response('<html>502</html>', { status: 502 }));
    const conn = await connect();
    await expect(
      conn.uploadMedia(new Blob([new Uint8Array(4)], { type: 'image/png' })),
    ).rejects.toMatchObject({ wire: { code: 'server_error' } });
  });
});

describe('downloading', () => {
  it('fetches with the credential and hands back the bytes', async () => {
    stubFetch(() => new Response(new Blob([new Uint8Array([137, 80, 78, 71])]), { status: 200 }));
    const conn = await connect();

    const blob = await conn.fetchMedia('AAAAAAAAAAAAAAAAAAAAAA');

    expect(blob.size).toBe(4);
    const call = calls[0]!;
    expect(call.url).toBe('http://test/media/AAAAAAAAAAAAAAAAAAAAAA');
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer s_1.tok');
  });

  it('reads every failure as the one answer the server gives', async () => {
    // Expired, revoked, never shown it, no such handle: all 404, because
    // a status that told them apart would be a way to ask whether a
    // handle exists.
    stubFetch(() =>
      jsonResponse(404, { error: { code: 'no_such_media', text: 'Media not found' } }),
    );
    const conn = await connect();
    await expect(conn.fetchMedia('AAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({
      wire: { code: 'no_such_media' },
    });
  });
});

describe('the local pre-flight', () => {
  it('refuses what the server would, in words for the person who picked it', () => {
    expect(mediaBlockedReason({ type: 'image/png', size: 1024 }, LIMITS)).toBeNull();
    expect(mediaBlockedReason({ type: 'image/webp', size: 1024 }, LIMITS)).toMatch(
      /JPEG, PNG, GIF/,
    );
    expect(mediaBlockedReason({ type: 'image/png', size: 999_999 }, LIMITS)).toMatch(/KB/);
  });

  it('reads the list the server sent rather than a copy of the spec', () => {
    const narrowed = { ...LIMITS, types: ['image/png'] };
    expect(mediaBlockedReason({ type: 'image/jpeg', size: 10 }, narrowed)).toBe(
      'This server takes PNG images only.',
    );
  });
});

describe('sending', () => {
  it('names the handle on a chat line, and lets the text be empty', async () => {
    const sent: Record<string, unknown>[] = [];
    server.on('chat', (params) => {
      sent.push(params);
      return { ok: {} };
    });
    const conn = await connect();

    await conn.chat({ text: '', media: 'AAAAAAAAAAAAAAAAAAAAAA' });

    expect(sent[0]).toEqual({ text: '', media: 'AAAAAAAAAAAAAAAAAAAAAA' });
  });

  it('carries one on a private message too', async () => {
    const sent: Record<string, unknown>[] = [];
    server.on('msg', (params) => {
      sent.push(params);
      return { ok: { queued: false } };
    });
    const conn = await connect();

    await conn.msg({ to: 2, text: 'look', guid: 'g', media: 'AAAAAAAAAAAAAAAAAAAAAA' });

    expect(sent[0]).toMatchObject({ to: 2, media: 'AAAAAAAAAAAAAAAAAAAAAA' });
  });
});
