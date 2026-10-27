import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkHostKey } from '../src/identity/trust';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const discovery = (challenge: string) =>
  Response.json({ v: 1, name: 'x', server_key: 'AAAA', ng: { ws: '/ng' }, identity: { enabled: true, endpoints: { challenge } } });

describe('checkHostKey', () => {
  it.each(['//evil.example/c', '/\\evil.example/c', '.evil.example/c', '@evil.example/c', 'https://evil.example/c'])(
    'fetches no challenge from an endpoint off the host addressed: %s',
    async (challenge) => {
      const fetch = vi.fn(async (_url: string) => discovery(challenge));
      vi.stubGlobal('fetch', fetch);
      await expect(checkHostKey('ws://hx.example:5700/ng')).rejects.toThrow(/off this server/);
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['http://hx.example:5700/.well-known/hotline']);
    },
  );

  it.each([
    // Built, the socket's own host and port, not the page's on its host name.
    [false, 'wss://hx.example:5701/ng', 'https://hx.example/', 'https://hx.example:5701/.well-known/hotline'],
    // Under the dev server, the page, whose proxy keeps `Host`.
    [true, 'ws://hx.example:5700/ng', 'http://hx.example:5701/', 'http://hx.example:5701/.well-known/hotline'],
  ])('with DEV %s, checks %s where its login goes', async (dev, ws, page, asked) => {
    vi.stubEnv('DEV', dev);
    vi.stubGlobal('location', { hostname: 'hx.example', href: page });
    const fetch = vi.fn(async (_url: string) => discovery('//evil.example/c'));
    vi.stubGlobal('fetch', fetch);
    await expect(checkHostKey(ws)).rejects.toThrow(/off this server/);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([asked]);
  });
});
