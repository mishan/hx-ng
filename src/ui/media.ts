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

export class MediaCache {
  private urls = new Map<string, string>();
  private inflight = new Map<string, Promise<string | null>>();
  /** Handles a moderator revoked while this page was open. Held so a
   *  row that has not been drawn yet never fetches one. */
  private revoked = new Set<string>();
  private conn: Connection | null = null;

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
  }

  wasRevoked(id: string): boolean {
    return this.revoked.has(id);
  }

  /** The blob URL for a handle, fetching it at most once. `null` when
   *  the server would not give it to us — expired, revoked, or a handle
   *  this session was never shown, which are deliberately one answer. */
  url(id: string): Promise<string | null> {
    const held = this.urls.get(id);
    if (held) return Promise.resolve(held);
    if (this.revoked.has(id)) return Promise.resolve(null);
    const running = this.inflight.get(id);
    if (running) return running;
    const conn = this.conn;
    if (!conn) return Promise.resolve(null);
    const p = conn
      .fetchMedia(id)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        this.urls.set(id, url);
        return url;
      })
      .catch(() => null)
      .finally(() => this.inflight.delete(id));
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
  const gone = revoked || !media.id;
  const frame = h('div', {
    class: `media${gone ? ' gone' : ''}`,
    style: { width: `${width}px`, height: `${height}px` },
    title: caption(media),
  });
  if (gone) {
    frame.append(
      h(
        'span',
        { class: 'media-note' },
        revoked ? 'Image removed by a moderator' : 'Image no longer available',
      ),
    );
    return frame;
  }
  const id = media.id as string;
  frame.append(h('span', { class: 'media-note' }, caption(media)));
  void cache.url(id).then((url) => {
    if (!url || !frame.isConnected) return;
    const img = h('img', {
      class: 'media-img',
      src: url,
      alt: caption(media),
      width,
      height,
      loading: 'lazy',
    });
    // Click opens the image at its own size, in its own tab: the row is
    // a preview, and a 2048-pixel photograph deserves better than a
    // 420-pixel column.
    img.onclick = () => window.open(url, '_blank', 'noopener');
    frame.replaceChildren(img);
    frame.classList.add('loaded');
  });
  return frame;
}
