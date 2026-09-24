import { beforeEach, describe, expect, it, vi } from 'vitest';

import { awayCount, clearAway, countAway, showBadge, type BadgeHost } from '../src/push/badge';

// Cache Storage, as much of it as `src/push/badge.ts` uses: named caches
// of responses by URL.
class FakeCaches {
  caches = new Map<string, Map<string, Response>>();
  async open(name: string) {
    const c = this.caches.get(name) ?? new Map<string, Response>();
    this.caches.set(name, c);
    return {
      match: async (url: string) => c.get(url)?.clone(),
      put: async (url: string, r: Response) => void c.set(url, r),
    } as unknown as Cache;
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
}

function host(): BadgeHost & { shown: (number | 'dot' | null)[] } {
  const shown: (number | 'dot' | null)[] = [];
  return {
    shown,
    setAppBadge: async (n?: number) => void shown.push(n ?? 'dot'),
    clearAppBadge: async () => void shown.push(null),
  };
}

describe('the app badge', () => {
  let store: FakeCaches;
  beforeEach(() => {
    vi.stubGlobal('location', new URL('https://hx.example/app/'));
    store = new FakeCaches();
  });

  it('counts notices while nobody looks, and forgets them when somebody does', async () => {
    const s = store as unknown as CacheStorage;
    expect(await awayCount(s)).toBe(0);
    expect(await countAway(s)).toBe(1);
    expect(await countAway(s)).toBe(2);
    expect(await awayCount(s)).toBe(2);
    await clearAway(s);
    expect(await awayCount(s)).toBe(0);
    expect(await countAway(s)).toBe(1);
  });

  it('is a dot where there is nowhere to keep a count', async () => {
    expect(await countAway(null)).toBe('dot');
    expect(await awayCount(null)).toBe(0);
    await clearAway(null);
  });

  it('reads a count it cannot make sense of as none', async () => {
    const c = await store.open('hx-badge');
    await c.put('https://hx.example/hx-badge/away', new Response('lots'));
    expect(await awayCount(store as unknown as CacheStorage)).toBe(0);
  });

  it('draws a number, a dot, or clears', async () => {
    const h = host();
    await showBadge(3, h);
    await showBadge('dot', h);
    await showBadge(0, h);
    expect(h.shown).toEqual([3, 'dot', null]);
  });

  it('does nothing where the platform draws no badge, or refuses one', async () => {
    await showBadge(3, {});
    await showBadge(3, { setAppBadge: () => Promise.reject(new Error('not installed')), clearAppBadge: async () => {} });
  });
});
