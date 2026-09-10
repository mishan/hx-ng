//! The transcript's image cache: one fetch per handle, and blob URLs
//! that are released rather than leaked.
import { describe, expect, it, vi } from 'vitest';

import type { Connection } from '@hotline-ng/client';

import { MediaCache } from '../src/ui/media';

const PNG = 'image/png';

/** Just enough `Connection` for the cache: a `fetchMedia` a test drives.
 *  Nothing else on it is reachable from here. */
function fakeConn(fetchMedia: (id: string) => Promise<Blob>): Connection {
  return { fetchMedia } as unknown as Connection;
}

/** A fetch whose promise a test resolves by hand, so "while it is in
 *  flight" is a state the test can stand in the middle of. */
function pending() {
  let settle!: (blob: Blob) => void;
  let fail!: (e: Error) => void;
  const promise = new Promise<Blob>((res, rej) => {
    settle = res;
    fail = rej;
  });
  return { promise, settle, fail };
}

function png(): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: PNG });
}

describe('the media cache', () => {
  it('fetches a handle once, however many times it is drawn', async () => {
    const fetchMedia = vi.fn().mockResolvedValue(png());
    const cache = new MediaCache();
    cache.attach(fakeConn(fetchMedia));

    const first = await cache.url('abc', PNG);
    const second = await cache.url('abc', PNG);
    expect(first).toBe(second);
    expect(fetchMedia).toHaveBeenCalledTimes(1);
  });

  it('remembers a refusal, so a redraw does not ask again', async () => {
    // Expired, revoked and never-yours are deliberately one answer, and
    // none of them becomes a different one on this session. A room full
    // of expired images would otherwise cost an authenticated GET
    // apiece on every redraw.
    const fetchMedia = vi.fn().mockRejectedValue(new Error('404'));
    const cache = new MediaCache();
    cache.attach(fakeConn(fetchMedia));

    expect(await cache.url('gone', PNG)).toBeNull();
    expect(await cache.url('gone', PNG)).toBeNull();
    expect(fetchMedia).toHaveBeenCalledTimes(1);
  });

  it('drops a fetch that lands after the session it belonged to', async () => {
    // The blob URL would be stored into a map nothing will ever revoke
    // again — every picture the page has seen, leaked on the way out.
    const inflight = pending();
    const cache = new MediaCache();
    cache.attach(fakeConn(() => inflight.promise));
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    const asked = cache.url('abc', PNG);
    cache.clear();
    inflight.settle(png());
    expect(await asked).toBeNull();
    // Nothing was stored, so nothing needed releasing.
    expect(revoke).not.toHaveBeenCalled();
    revoke.mockRestore();
  });

  it('drops a fetch that lands after the image was revoked', async () => {
    const inflight = pending();
    const cache = new MediaCache();
    cache.attach(fakeConn(() => inflight.promise));

    const asked = cache.url('abc', PNG);
    cache.revoke('abc');
    inflight.settle(png());
    expect(await asked).toBeNull();
    expect(cache.wasRevoked('abc')).toBe(true);
    // And it stays gone: the late result is not sitting in the map
    // waiting to be handed to the next row that asks.
    expect(await cache.url('abc', PNG)).toBeNull();
  });

  it('releases the blob URLs it holds when the session ends', async () => {
    const cache = new MediaCache();
    cache.attach(fakeConn(() => Promise.resolve(png())));
    const url = await cache.url('abc', PNG);
    expect(url).toMatch(/^blob:/);

    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    cache.clear();
    expect(revoke).toHaveBeenCalledWith(url);
    revoke.mockRestore();
  });

  it('will not make a blob URL for a type a browser would execute', async () => {
    // A blob URL runs in this page's origin when it is navigated to, and
    // clicking an image is a navigation. `image/svg+xml` is a document
    // with script in it; the capability forbids it upstream, and this is
    // what makes that not depend on the server having been careful.
    const cache = new MediaCache();
    cache.attach(fakeConn(() => Promise.resolve(new Blob(['<svg/>'], { type: 'image/svg+xml' }))));
    expect(await cache.url('abc', 'image/svg+xml')).toBeNull();
  });

  it('answers null with no connection rather than throwing', async () => {
    const cache = new MediaCache();
    expect(await cache.url('abc', PNG)).toBeNull();
  });
});
