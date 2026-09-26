/**
 * Avatars on the client side (hxd-ng's `docs/avatars.md` §4).
 *
 * The socket is the fake wire and the two routes are HTTP, so `fetch` is
 * stubbed, as in the media tests: what these check is the capability's
 * block, the credential on both routes, `avatar_clear` on the socket,
 * and that a refusal is the `WireFailure` every other call throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Connection, WireFailure, type Credentials } from '../src/connection';
import { mediaBlockedReason, type AvatarLimits, type LoginOk, type SelfUser } from '../src/protocol';

import { installFakeWire, settle, uninstallFakeWire, type FakeServer } from './fake-wire';

const CREDS: Credentials = { url: 'ws://test/ng', login: 'alice', password: 'hunter2', nick: 'Alice', icon: 128 };

const LIMITS: AvatarLimits = {
  max_bytes: 262144,
  max_dimension: 128,
  types: ['image/jpeg', 'image/png', 'image/gif'],
};

const AVATAR = { id: 'ab'.repeat(32), type: 'image/png', width: 128, height: 96 };

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
  caps: ['avatars'],
  seq: 0,
  avatars: LIMITS,
  ...over,
});

let server: FakeServer;
let calls: { url: string; init: RequestInit }[];

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

describe('the avatars capability', () => {
  it('carries what an upload may be', async () => {
    const conn = await connect();
    expect(conn.avatars).toEqual(LIMITS);
  });

  it('is null on a server without it, so no upload is offered', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: [], avatars: undefined }) }));
    const conn = await connect();
    expect(conn.avatars).toBeNull();
  });

  it('survives a reload, which resumes and hears nothing about it', async () => {
    await connect();
    server.on('resume', () => ({ ok: { replay: 0, self: me() } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: '' }, users: [me()], seq: 0 } }));
    const again = new Connection(CREDS, {});
    await again.start({ resumeOnly: true });
    await settle();
    expect(server.sent('resume')).toHaveLength(1);
    expect(again.avatars).toEqual(LIMITS);
  });

  it('is checked locally as media limits are', () => {
    expect(mediaBlockedReason({ type: 'image/png', size: 1024 }, LIMITS)).toBeNull();
    expect(mediaBlockedReason({ type: 'image/webp', size: 1024 }, LIMITS)).toMatch(/JPEG, PNG, GIF/);
    expect(mediaBlockedReason({ type: 'image/png', size: LIMITS.max_bytes + 1 }, LIMITS)).toMatch(/256 KB/);
  });
});

describe('setting and clearing', () => {
  it('puts the bytes with the session credential and returns the reference', async () => {
    stubFetch(() => jsonResponse(200, { avatar: AVATAR }));
    const conn = await connect();

    const got = await conn.uploadAvatar(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));

    expect(got).toEqual(AVATAR);
    const call = calls[0]!;
    expect(call.url).toBe('http://test/avatar');
    expect(call.init.method).toBe('PUT');
    expect(call.init.headers).toMatchObject({ Authorization: 'Bearer s_1.tok', 'Content-Type': 'image/png' });
  });

  it('turns a refusal into a WireFailure', async () => {
    stubFetch(() => jsonResponse(429, { error: { code: 'rate_limited', text: 'Slow down' } }));
    const conn = await connect();
    const failed = conn.uploadAvatar(new Blob([new Uint8Array(4)], { type: 'image/png' }));
    await expect(failed).rejects.toBeInstanceOf(WireFailure);
    await expect(failed).rejects.toMatchObject({ wire: { code: 'rate_limited' } });
  });

  it('reads a refused clear as a WireFailure', async () => {
    server.on('avatar_clear', () => ({ error: { code: 'rate_limited', text: 'Slow down' } }));
    const conn = await connect();
    await expect(conn.clearAvatar()).rejects.toMatchObject({ wire: { code: 'rate_limited' } });
  });

  it('clears on the socket', async () => {
    server.on('avatar_clear', () => ({ ok: {} }));
    const conn = await connect();
    await expect(conn.clearAvatar()).resolves.toEqual({});
    expect(server.sent('avatar_clear')).toHaveLength(1);
  });
});

describe('fetching', () => {
  it('gets an avatar by its id with the credential', async () => {
    stubFetch(() => new Response(new Blob([new Uint8Array([137, 80, 78, 71])]), { status: 200 }));
    const conn = await connect();

    const blob = await conn.fetchAvatar(AVATAR.id);

    expect(blob.size).toBe(4);
    expect(calls[0]!.url).toBe(`http://test/avatars/${AVATAR.id}`);
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer s_1.tok' });
  });

  it('keeps an id inside its path segment', async () => {
    stubFetch(() => new Response(new Blob([]), { status: 200 }));
    const conn = await connect();
    await conn.fetchAvatar('../media/x?y');
    expect(calls[0]!.url).toBe('http://test/avatars/..%2Fmedia%2Fx%3Fy');
  });

  it('reads a bodiless 404 as a handle that is not there', async () => {
    stubFetch(() => new Response('not found', { status: 404 }));
    const conn = await connect();
    const failed = conn.fetchAvatar(AVATAR.id);
    await expect(failed).rejects.toBeInstanceOf(WireFailure);
    await expect(failed).rejects.toMatchObject({ wire: { code: expect.stringMatching(/^no_such_/) } });
  });

  it('reads a 404 as no such avatar', async () => {
    stubFetch(() => jsonResponse(404, { error: { code: 'no_such_avatar', text: 'Avatar not found' } }));
    const conn = await connect();
    await expect(conn.fetchAvatar(AVATAR.id)).rejects.toMatchObject({ wire: { code: 'no_such_avatar' } });
  });
});
