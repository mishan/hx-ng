/**
 * The number on the app's icon, where the platform draws one: an
 * installed app on Chromium's desktops, and a Home Screen app on iOS
 * once notifications are allowed. Everywhere else it is a no-op, and on
 * Android the launcher's own dot for a waiting notification does the
 * job.
 *
 * Two things set it, and neither can see the other's count. The page,
 * while it runs, knows what is unread in its session and shows the same
 * number as its title. The service worker, while nobody is looking,
 * knows only that a notification arrived: the payload carries no count
 * for the whole app, and there may be one worker per server and
 * account. So the workers keep a count of their own — notices since the
 * app was last looked at — in the origin's Cache Storage, which every
 * worker and page shares, and the page puts it back to nothing when it
 * is on screen.
 */

/** The Badging API, which the DOM library does not describe. */
export interface BadgeHost {
  setAppBadge?(contents?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

const CACHE = 'hx-badge';
/** A URL only as the key a cache needs; nothing is ever fetched from it. */
const key = (): string => new URL('/hx-badge/away', location.origin).href;

function storage(): CacheStorage | null {
  // Absent outside a secure context, as the rest of this is.
  return typeof caches === 'undefined' ? null : caches;
}

/** Draw `count` on the icon, or nothing for none. `'dot'` is a badge
 *  with no number, for a count that could not be kept. */
export async function showBadge(
  count: number | 'dot',
  host: BadgeHost = navigator as unknown as BadgeHost,
): Promise<void> {
  if (!host.setAppBadge || !host.clearAppBadge) return;
  try {
    if (count === 'dot') await host.setAppBadge();
    else if (count > 0) await host.setAppBadge(count);
    else await host.clearAppBadge();
  } catch {
    // Refused — not installed, or no notification permission on iOS.
    // A badge is a courtesy; nothing waits on it.
  }
}

/** The notices counted since the app was last on screen. */
export async function awayCount(store = storage()): Promise<number> {
  if (!store) return 0;
  try {
    const hit = await (await store.open(CACHE)).match(key());
    const n = hit ? Number(await hit.text()) : 0;
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** One more notice while nobody was looking; the new count, or `'dot'`
 *  where there is nowhere to keep one. Two workers woken together can
 *  both read the same count, and the icon is one short until the next;
 *  that is not worth a lock. */
export async function countAway(store = storage()): Promise<number | 'dot'> {
  if (!store) return 'dot';
  try {
    const n = (await awayCount(store)) + 1;
    await (await store.open(CACHE)).put(key(), new Response(String(n)));
    return n;
  } catch {
    return 'dot';
  }
}

/** The app is on screen: what the workers counted has been seen. */
export async function clearAway(store = storage()): Promise<void> {
  try {
    await store?.delete(CACHE);
  } catch {
    /* nothing kept, then nothing to clear */
  }
}
