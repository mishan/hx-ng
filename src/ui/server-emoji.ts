/** The server's own emoji (hxd-ng's `docs/server-emoji.md`): the catalog
 *  this page holds of them, their pictures, and a line's text drawn with
 *  them.
 *
 *  A name in a line is drawn as a picture only where the line's own
 *  references bind it to an id the catalog has live. The text is never
 *  read for names on its own: `:party:` with no reference is what
 *  somebody typed, and stays that.
 *
 *  Pictures come from `GET /emoji/{hash}` with the session's bearer, as
 *  avatars do, so they go through a `MediaCache` too, by hash: one
 *  picture two entries share is fetched once. One for the page, as the
 *  avatars' cache is, since every view that draws a line reaches for
 *  it. */

import { Connection, EmojiCatalog, emojiRefsFor, emojiSegments, RATE_LIMITED, WireFailure, type EmojiRef, type LiveEmoji } from '@hotline-ng/client';

import type { Session } from '../session';
import { h } from './dom';
import { MediaCache } from './media';

/** An animation's first frame, by the cache's key for it. */
const STILL = ' still';

const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const emojiImages = new MediaCache(async (conn, id) => {
  if (!(conn instanceof Connection)) throw new Error('No server emoji on this wire.');
  const still = id.endsWith(STILL);
  const blob = await conn.fetchEmoji(still ? id.slice(0, -STILL.length) : id);
  return still ? firstFrame(blob) : blob;
});

/** A GIF's first frame as a PNG, for a reader who asked for less
 *  motion: a GIF has no way to be paused. */
async function firstFrame(gif: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(gif);
  const canvas = h('canvas', { width: bitmap.width, height: bitmap.height });
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No still frame.'))), 'image/png'));
}

/** This page's catalog, one for each ng connection; `held` is it where
 *  the session was granted `emoji`. */
class ServerEmoji {
  catalog: EmojiCatalog | null = null;
  private conn: Connection | null = null;
  /** Told when what the catalog holds has changed, to draw anew. */
  changed: () => void = () => {};

  attach(conn: Session | null): void {
    emojiImages.attach(conn);
    const ng = conn instanceof Connection ? conn : null;
    this.conn = ng;
    this.catalog = ng ? new EmojiCatalog((p) => ng.emojiList(p)) : null;
  }

  /** The catalog, where this session was granted `emoji`. */
  get held(): EmojiCatalog | null {
    return this.conn?.emoji ? this.catalog : null;
  }

  /** Bring the catalog up to date. A rate limit is waited out once, as
   *  long as it says; any other refusal leaves it as it was, for the next
   *  change or catch-up to try again. */
  refresh(waited = false): void {
    const catalog = this.held;
    if (!catalog) return;
    void catalog.refresh().then(
      (changed) => {
        if (!changed || catalog !== this.catalog) return;
        // A picture refused while its entry was removed may be live
        // again, under a new entry.
        for (const e of catalog.entries()) {
          emojiImages.retry(e.hash);
          emojiImages.retry(e.hash + STILL);
        }
        this.changed();
      },
      (e: unknown) => {
        if (waited || !(e instanceof WireFailure && e.wire.code === RATE_LIMITED)) return;
        setTimeout(() => catalog === this.catalog && this.refresh(true), (e.wire.retry_after ?? 1) * 1000);
      },
    );
  }

  /** The references a send of `text` carries, none where this session
   *  sends none. */
  refsFor(text: string): { emoji?: EmojiRef[] } {
    const catalog = this.held;
    const refs = catalog ? emojiRefsFor(text, catalog) : [];
    return refs.length ? { emoji: refs } : {};
  }
}

export const serverEmoji = new ServerEmoji();

/** One emoji's picture, named `:name:` for a screen reader and on hover,
 *  sized to the text by the stylesheet. Until its bytes are here, and if
 *  they never come, the name stands in its place. */
export function emojiImage(e: LiveEmoji, name: string): HTMLElement {
  const label = `:${name}:`;
  const still = e.animated === true && reducedMotion();
  const id = still ? e.hash + STILL : e.hash;
  const picture = (src: string) =>
    h('img', { class: 'emoji', src, alt: label, title: label, draggable: false, width: e.width, height: e.height });
  const held = emojiImages.held(id);
  if (held) return picture(held);
  const stand = h('span', { class: 'emoji-pending' }, label);
  void emojiImages.url(id, e.animated && !still ? 'image/gif' : 'image/png').then((url) => {
    if (url && stand.isConnected) stand.replaceWith(picture(url));
  });
  return stand;
}

/** `text`, each name its references bind drawn as the emoji. */
export function emojiText(text: string, refs: readonly EmojiRef[] | undefined): (Node | string)[] {
  const catalog = serverEmoji.held;
  if (!catalog || !refs?.length) return text ? [text] : [];
  return emojiSegments(text, refs, catalog).map((s) => (typeof s === 'string' ? s : emojiImage(catalog.live(s.id)!, s.name)));
}

/** What another renderer made of a line's text, each name its
 *  references bind drawn as the emoji, in its prose and never in code,
 *  where a name is being shown rather than said. Markdown goes first: a
 *  name it styled, `:_ok_:` read as emphasis, is left as it drew it. */
export function withEmoji(nodes: (Node | string)[], refs: readonly EmojiRef[] | undefined): (Node | string)[] {
  if (!serverEmoji.held || !refs?.length) return nodes;
  return nodes.flatMap((n) => {
    if (typeof n === 'string') return emojiText(n, refs);
    if (n instanceof Element && !n.matches('code, pre')) {
      const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT, {
        acceptNode: (t) => (t.parentElement?.closest('code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const texts: Text[] = [];
      for (let t = walker.nextNode(); t; t = walker.nextNode()) texts.push(t as Text);
      for (const t of texts) {
        const parts = emojiText(t.data, refs);
        if (parts.some((p) => typeof p !== 'string')) t.replaceWith(...parts);
      }
    }
    return [n];
  });
}

/** Whether `e` is found by `query`: a word of its name, split at its
 *  underscores, or the name itself, starting with what was typed, its
 *  colons aside. */
export function emojiMatches(e: LiveEmoji, query: string): boolean {
  const q = query.toLowerCase().replaceAll(':', '').trim();
  return !q || e.name.startsWith(q) || e.name.split('_').some((w) => w.startsWith(q));
}
