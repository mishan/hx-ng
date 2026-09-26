/**
 * The server banner on the client side (hxd-ng's `docs/banner.md` §3).
 *
 * What matters is where the bearer goes: to the server's own `/banner`,
 * and never to a banner somewhere else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Connection, WireFailure, type Credentials } from '../src/connection';
import { bannerIsHeld, type BannerInfo, type LoginOk, type SelfUser } from '../src/protocol';

import { installFakeWire, settle, uninstallFakeWire, type FakeServer } from './fake-wire';

const CREDS: Credentials = { url: 'ws://test/ng', login: 'alice', password: 'hunter2', nick: 'Alice', icon: 128 };

const HELD: BannerInfo = { url: '/banner', type: 'image/gif', link: 'https://hl.example/' };

const me = (): SelfUser => ({
  uid: 1,
  nick: 'Alice',
  icon: 128,
  admin: false,
  status: 'active',
  transport: 'encrypted',
});

const loginOk = (banner?: BannerInfo): LoginOk => ({
  session: 's_1',
  token: 'tok',
  self: me(),
  server: { name: 'Test', subject: '' },
  users: [],
  detach: { grace: 300 },
  caps: banner ? ['banner'] : [],
  seq: 0,
  banner,
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

beforeEach(() => {
  server = installFakeWire();
});

afterEach(() => {
  uninstallFakeWire();
  vi.unstubAllGlobals();
});

async function connect(banner?: BannerInfo): Promise<Connection> {
  server.on('login', () => ({ ok: loginOk(banner) }));
  const conn = new Connection(CREDS, {});
  await conn.start();
  return conn;
}

describe('the banner capability', () => {
  it('carries the banner from the login reply', async () => {
    const conn = await connect(HELD);
    expect(conn.banner).toEqual(HELD);
  });

  it('is null on a server without one', async () => {
    const conn = await connect();
    expect(conn.banner).toBeNull();
  });

  it('survives a reload, which resumes and hears nothing about it', async () => {
    await connect(HELD);
    server.on('resume', () => ({ ok: { replay: 0, self: me() } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: '' }, users: [me()], seq: 0 } }));
    const again = new Connection(CREDS, {});
    await again.start({ resumeOnly: true });
    await settle();
    expect(server.sent('resume')).toHaveLength(1);
    expect(again.banner).toEqual(HELD);
  });

  it('is replaced by a fresh login, taken down included', async () => {
    await connect(HELD);
    // The server restarted without one: the resume fails, and the login
    // that follows is the only word on it.
    server.on('resume', () => ({ error: { code: 'session_expired', text: 'gone' } }));
    server.on('login', () => ({ ok: loginOk() }));
    const again = new Connection(CREDS, {});
    await again.start();
    await settle();
    expect(again.banner).toBeNull();
  });

  it('counts only the server’s own path as held', () => {
    expect(bannerIsHeld(HELD)).toBe(true);
    expect(bannerIsHeld({ url: 'https://hl.example/banner.jpg' })).toBe(false);
    expect(bannerIsHeld({ url: '//evil.example/banner' })).toBe(false);
    expect(bannerIsHeld({ url: '/banner/../media/x' })).toBe(false);
  });
});

describe('fetching', () => {
  it('gets a held banner with the session credential', async () => {
    stubFetch(() => new Response(new Blob([new Uint8Array([71, 73, 70])], { type: 'image/gif' }), { status: 200 }));
    const conn = await connect(HELD);

    const blob = await conn.fetchBanner();

    expect(blob.size).toBe(3);
    expect(calls[0]!.url).toBe('http://test/banner');
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer s_1.tok' });
  });

  it('never sends the credential to a banner somewhere else', async () => {
    stubFetch(() => new Response('', { status: 200 }));
    const conn = await connect({ url: 'https://hl.example/banner.jpg' });
    await expect(conn.fetchBanner()).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('fetches nothing on a server without one', async () => {
    stubFetch(() => new Response('', { status: 200 }));
    const conn = await connect();
    await expect(conn.fetchBanner()).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('turns a refusal into a WireFailure', async () => {
    stubFetch(() => new Response('{"error":{"code":"no_such_banner","text":"none"}}', { status: 404 }));
    const conn = await connect(HELD);
    await expect(conn.fetchBanner()).rejects.toBeInstanceOf(WireFailure);
  });
});
