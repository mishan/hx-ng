/**
 * Noticing that a newer build of this client has been published.
 *
 * The page is static and the host's caching is not ours to set: GitHub
 * Pages sends every file, `index.html` too, with ten minutes of
 * `max-age`, and a Home Screen app keeps one page alive for days. So a
 * page asks now and then which build is published, from `version.json`
 * past every cache, and the app offers a reload when it is another one.
 * It never reloads by itself: that would take a half-typed line, or a
 * call, with it.
 *
 * Nothing is precached to make this work, and nothing should be: the
 * only service workers are the push ones, and a cached shell would be
 * one more copy to go stale.
 *
 * No DOM: the fetch and the clock are passed in, so a test can be both.
 */

/** A build that knows nothing of where it came from, never compared. */
export const DEV_BUILD = 'dev';

/** Closer together than this, a check is skipped: switching tabs back
 *  and forth is not news. */
export const MIN_SPACING_MS = 60_000;

/** How often an open page that is never hidden asks anyway. */
export const INTERVAL_MS = 3 * 60 * 60_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The build published now, when it is not `running`; null when it is,
 *  or when there is no telling. Any build other than this one is the
 *  newer: a deployment only ever goes forward. */
export async function publishedBuild(running: string, fetch: Fetch, now: number): Promise<string | null> {
  if (running === DEV_BUILD) return null;
  try {
    const res = await fetch(`version.json?t=${now}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const build = (body as { build?: unknown } | null)?.build;
    if (typeof build !== 'string' || build === '' || build === DEV_BUILD || build === running) return null;
    return build;
  } catch {
    return null;
  }
}

/** Checks for one page, spaced out, each newer build reported once. */
export class UpdateCheck {
  private last = -Infinity;
  private told = new Set<string>();

  constructor(
    private running: string,
    private fetch: Fetch,
    private now: () => number,
  ) {}

  /** A newer build not reported before, or null. `urgent` skips the
   *  spacing and reports again, for when something has just gone wrong
   *  that a newer build would explain. */
  async check(urgent = false): Promise<string | null> {
    const now = this.now();
    if (!urgent && now - this.last < MIN_SPACING_MS) return null;
    this.last = now;
    const build = await publishedBuild(this.running, this.fetch, now);
    if (build === null || (!urgent && this.told.has(build))) return null;
    this.told.add(build);
    return build;
  }
}
