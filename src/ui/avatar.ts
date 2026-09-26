/** Avatars: a user's own picture, drawn where their icon would be.
 *
 *  The icon is always drawn first, and stays the answer whenever there
 *  is no picture to show — a server without the `avatars` capability, a
 *  user who has none, a fetch that failed. A picture replaces it in place
 *  when its bytes arrive, in the icon's box, so nothing reflows.
 *
 *  The bytes come from `GET /avatars/{id}` with the session's bearer,
 *  which an `<img src>` cannot send, so they go through a `MediaCache`
 *  like chat images do. An id names its bytes for good, so each one is
 *  fetched once per session however many rows draw it. The cache is one
 *  for the page, as the icon sheet is: every row that draws a person
 *  reaches for it, and threading it through each would say nothing.
 */

import type { Avatar } from '@hotline-ng/client';

import { h } from './dom';
import { icon } from './icons';
import { INERT, MediaCache } from './media';

export const avatars = new MediaCache((conn, id) => conn.fetchAvatar(id));

/** Someone's face at `scale`: their avatar when they have one this page
 *  can show, their icon until then and otherwise. */
export function face(who: { icon: number; avatar?: Avatar }, scale = 1): HTMLElement {
  const sprite = icon(who.icon, scale);
  const a = who.avatar;
  if (!a || !INERT.includes(a.type)) return sprite;
  const held = avatars.held(a.id);
  if (held) return picture(held, sprite);
  void avatars.url(a.id, a.type).then((url) => {
    // A redraw in between replaced this sprite with its own face, which
    // asked the cache too; this one has nothing left to do.
    if (url && sprite.isConnected) sprite.replaceWith(picture(url, sprite));
  });
  return sprite;
}

/** The picture in exactly the box the icon's sprite took — `paintIcon`
 *  sizes every sprite, drawn or not — so whatever sits beside it, a
 *  nick or a gutter, does not move when it lands. `contain` fits it to
 *  the box without cropping or squashing. */
function picture(url: string, sprite: HTMLElement): HTMLElement {
  return h('img', {
    class: 'avatar',
    src: url,
    alt: '',
    draggable: false,
    style: { width: sprite.style.width, height: sprite.style.height },
  });
}
