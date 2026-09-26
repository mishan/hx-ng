/** The server banner: the strip of the operator's own decoration a
 *  Hotline server has always shown above its client's windows, often
 *  with somewhere to click (hxd-ng's `docs/banner.md`).
 *
 *  Two kinds, and the difference is the credential. A banner the server
 *  holds is fetched from `GET /banner` with the session's bearer, which
 *  an `<img src>` cannot send, so it becomes a blob URL this strip owns
 *  and revokes. A banner somewhere else is an ordinary image the page
 *  loads itself, with no referrer and never the bearer.
 *
 *  It is decoration, so every failure is the same quiet answer: no strip.
 */

import { bannerIsHeld, schemeAllowed, type Connection } from '@hotline-ng/client';

import { h } from './dom';
import { INERT } from './media';

export class BannerStrip {
  readonly el = h('div', { class: 'server-banner', hidden: true });
  /** The blob URL of a held banner on screen, to be let go. */
  private blob: string | null = null;
  /** Bumped by `clear`, so a fetch that lands after it stores nothing. */
  private generation = 0;

  /** Draw the banner `conn`'s server has, or nothing. */
  show(conn: Connection): void {
    this.clear();
    const banner = conn.banner;
    if (!banner) return;
    const started = this.generation;
    if (bannerIsHeld(banner)) {
      conn
        .fetchBanner()
        .then((bytes) => {
          if (started !== this.generation) return;
          // The type decides what a blob URL does when it is opened, and
          // it runs in this page's origin: a picture or nothing.
          if (!INERT.includes(bytes.type)) return;
          this.blob = URL.createObjectURL(bytes);
          this.draw(this.blob, banner.link);
        })
        .catch(() => undefined);
    } else if (/^https?:\/\//i.test(banner.url)) {
      this.draw(banner.url, banner.link);
    }
  }

  /** Take the strip down, releasing what it held. */
  clear(): void {
    this.generation++;
    if (this.blob) URL.revokeObjectURL(this.blob);
    this.blob = null;
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  private draw(src: string, link: string | undefined): void {
    // The policy before the source, so it is in place before any fetch.
    const img = h('img', { referrerPolicy: 'no-referrer', src, alt: 'Server banner', draggable: false });
    // Only for the banner still drawn: an image replaced by a later one
    // can fail after it is gone, and must not take the new one down.
    const drawn = this.generation;
    img.onerror = () => {
      if (drawn === this.generation) this.clear();
    };
    const art =
      link && schemeAllowed(link)
        ? h(
            'a',
            // A new tab only for the web: a `hotline:` or `mailto:` link
            // opens an app, and would leave an empty tab behind.
            { href: link, target: /^https?:/i.test(link) ? '_blank' : '', rel: 'noopener noreferrer', title: link },
            img,
          )
        : img;
    const hide = h(
      'button',
      { class: 'ghost banner-hide', type: 'button', title: 'Hide the banner', ariaLabel: 'Hide the banner' },
      '×',
    );
    hide.onclick = () => this.clear();
    this.el.replaceChildren(art, hide);
    this.el.hidden = false;
  }
}
