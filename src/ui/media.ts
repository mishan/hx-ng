/** Images in the transcript: fetching them once, drawing them, and
 *  letting them go.
 *
 *  A chat line carries a *handle*, not bytes. The bytes come from
 *  `GET /media/{id}` with the session's own credential — which an
 *  `<img src>` cannot send, so every image is fetched, turned into a
 *  blob URL, and swapped into the row when it arrives. That is also why
 *  this file exists rather than a `src` attribute: something has to own
 *  the URLs and revoke them, or a long session leaks every picture it
 *  has ever seen.
 *
 *  The placeholder is drawn first and at the right size, from the
 *  metadata the server measured off the canonical image. A room whose
 *  pictures arrive over a slow link therefore does not reflow as each
 *  one lands.
 */

import type { Connection, HistoryMedia } from '@hotline-ng/client';
import { h } from './dom';

/** Widest an inline image is drawn. Beyond this it is scaled down by
 *  width, keeping its aspect ratio; it is never scaled up, because a
 *  32×32 avatar blown across the pane is not what its sender sent. */
const MAX_WIDTH = 420;
/** And tallest, so a long screenshot cannot push the conversation off
 *  the screen. Click it to see the whole thing. */
const MAX_HEIGHT = 320;

/** Types a browser paints and does not execute. A blob URL inherits the
 *  origin of the page that made it, so this is the list that decides
 *  what clicking an image can do — `image/svg+xml` is a document with
 *  script in it, and the capability forbids it upstream anyway. */
const INERT = ['image/jpeg', 'image/png', 'image/gif'];

export class MediaCache {
  private urls = new Map<string, string>();
  private inflight = new Map<string, Promise<string | null>>();
  /** Handles a moderator revoked while this page was open. Held so a
   *  row that has not been drawn yet never fetches one. */
  private revoked = new Set<string>();
  /** Handles the server would not give us. The 404 is deliberately one
   *  answer for expired, revoked and never-yours, and none of them will
   *  become a different answer on this session — so remembering the
   *  refusal is what keeps a transcript full of expired images from
   *  issuing an authenticated GET apiece on every redraw. */
  private missing = new Set<string>();
  private conn: Connection | null = null;
  /** Bumped by anything that invalidates the maps. A fetch that started
   *  before the bump lands after it, and must not write into them: a
   *  blob URL stored after `clear()` is one nothing will ever revoke,
   *  and one stored after `revoke()` is the image a moderator just took
   *  down, held for the rest of the session. */
  private generation = 0;

  attach(conn: Connection | null): void {
    if (conn !== this.conn) this.clear();
    this.conn = conn;
  }

  /** Forget everything, releasing the blob URLs. A session that has
   *  ended cannot fetch any of it again anyway. */
  clear(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.inflight.clear();
    this.revoked.clear();
    this.missing.clear();
    this.generation++;
  }

  /** A moderator revoked this image: drop what we hold and stop
   *  answering for it. Rows already on screen are re-drawn by the
   *  caller. */
  revoke(id: string): void {
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.inflight.delete(id);
    this.revoked.add(id);
    this.generation++;
  }

  wasRevoked(id: string): boolean {
    return this.revoked.has(id);
  }

  /** The blob URL for a handle, fetching it at most once. `null` when
   *  the server would not give it to us — expired, revoked, or a handle
   *  this session was never shown, which are deliberately one answer —
   *  or when it answered with something this client will not render.
   *
   *  `type` is the canonical type off the line's own metadata, and the
   *  blob is built with it rather than with whatever the response said.
   *  A blob URL navigated to runs in *this page's* origin, and clicking
   *  an image opens one, so the type decides whether the browser paints
   *  a picture or executes a document. `image/svg+xml` is the case that
   *  matters and the capability forbids it by name; refusing anything
   *  outside `INERT` costs nothing and does not depend on the server
   *  having been careful. */
  url(id: string, type: string): Promise<string | null> {
    const held = this.urls.get(id);
    if (held) return Promise.resolve(held);
    if (this.revoked.has(id) || this.missing.has(id)) return Promise.resolve(null);
    const running = this.inflight.get(id);
    if (running) return running;
    const conn = this.conn;
    if (!conn) return Promise.resolve(null);
    const started = this.generation;
    const p = conn
      .fetchMedia(id)
      .then((blob) => {
        if (started !== this.generation) {
          // Cleared or revoked while this was in flight. Nothing may be
          // stored, so nothing has to be revoked either.
          return null;
        }
        if (!INERT.includes(type)) {
          this.missing.add(id);
          return null;
        }
        const url = URL.createObjectURL(new Blob([blob], { type }));
        this.urls.set(id, url);
        return url;
      })
      .catch(() => {
        if (started === this.generation) this.missing.add(id);
        return null;
      })
      .finally(() => {
        if (this.inflight.get(id) === p) this.inflight.delete(id);
      });
    this.inflight.set(id, p);
    return p;
  }
}

/** How big to draw it: the image's own size, scaled down to fit the
 *  column and never up. */
function fit(media: HistoryMedia): { width: number; height: number } {
  const scale = Math.min(1, MAX_WIDTH / media.width, MAX_HEIGHT / media.height);
  return {
    width: Math.max(1, Math.round(media.width * scale)),
    height: Math.max(1, Math.round(media.height * scale)),
  };
}

function caption(media: HistoryMedia): string {
  const kind = media.type.replace('image/', '').toUpperCase();
  const kb = Math.max(1, Math.round(media.bytes / 1024));
  return `${kind} · ${media.width}×${media.height} · ${kb} KB`;
}

/**
 * The media row: a sized placeholder that becomes the picture.
 *
 * Three states a reader can tell apart, which is what the history
 * tombstone and the revocation event are each for: the line was
 * moderated and the image went with it, the handle it would be fetched
 * by has expired, or it is still there and on its way. A placeholder
 * says which, because "an image was here" is worth reading and a blank
 * space is not.
 */
export function mediaEl(media: HistoryMedia, cache: MediaCache): HTMLElement {
  const { width, height } = fit(media);
  const revoked = media.removed || (!!media.id && cache.wasRevoked(media.id));
  if (revoked || !media.id) return goneEl(media, revoked);
  const frame = h('div', {
    class: 'media',
    style: { width: `${width}px`, height: `${height}px` },
    title: caption(media),
  });
  const id = media.id;
  frame.append(h('span', { class: 'media-note' }, caption(media)));
  // Deferred until the row is near the viewport. The fetch is what
  // costs — an `<img loading="lazy">` defers nothing here, because by
  // the time there is an `<img>` the bytes are already in hand — so
  // paging a month of history must not start a download for every
  // picture in it.
  whenNearViewport(frame, () => {
    void cache.url(id, media.type).then((url) => {
      if (!frame.isConnected) return;
      if (!url) {
        // The third of the three states, and the one that used to look
        // like the first: an image that has gone must not sit there
        // wearing the caption of one that is still on its way. The
        // *space* goes with it — a placeholder is a promise that a
        // picture is coming, and there is no longer one to keep.
        frame.replaceWith(goneEl(media, false));
        return;
      }
      const img = h('img', {
        class: 'media-img',
        src: url,
        alt: caption(media),
        width,
        height,
      });
      // Click opens the image at its own size, in its own tab: the row
      // is a preview, and a 2048-pixel photograph deserves better than
      // a 420-pixel column.
      img.onclick = () => window.open(url, '_blank', 'noopener');
      frame.replaceChildren(img);
      frame.classList.add('loaded');
    });
  });
  return frame;
}

/**
 * What a line says when the picture is not there: one line of text.
 *
 * Not a sized frame. The placeholder a *pending* image gets is drawn at
 * the server's own measurements so a slow link does not reflow the
 * conversation around it — but that is a promise the bytes are coming,
 * and holding a screenshot's worth of blank space open for one that will
 * never arrive is the promise broken rather than kept. What survives is
 * the metadata, and the metadata reads as a sentence.
 *
 * The dimensions go in the text and not only the `title`, because half
 * the clients this is written for are phones and a phone cannot hover.
 */
function goneEl(media: HistoryMedia, revoked: boolean): HTMLElement {
  const what = revoked ? 'Image removed by a moderator' : 'Image no longer available';
  const kind = media.type.replace('image/', '').toUpperCase();
  return h(
    'div',
    { class: 'media gone', title: caption(media) },
    h('span', { class: 'media-note' }, `${what} — ${kind}, ${media.width}×${media.height}`),
  );
}

/** Call `load` once the element is within a screen or so of the
 *  viewport — or straight away where there is nothing to ask, which is
 *  every environment without an `IntersectionObserver` and is the safe
 *  answer rather than the cheap one. */
function whenNearViewport(el: HTMLElement, load: () => void): void {
  if (typeof IntersectionObserver === 'undefined') return load();
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      load();
    },
    // A screen's worth of margin, so an image is fetched and decoded
    // before the row it belongs to is scrolled to rather than after.
    { rootMargin: '600px' },
  );
  io.observe(el);
}
