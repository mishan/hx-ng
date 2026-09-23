/**
 * What a push says on screen, and where tapping it goes.
 *
 * Shared by the service worker, which draws the notification, and the
 * page, which follows it. Pure, and it imports nothing but types: the
 * service worker is bundled on its own, and anything this pulled in
 * would be a second copy of it there.
 */

import type { PushPayload } from '@hotline-ng/client';

export interface Notice {
  title: string;
  body: string;
  /** The collapse key on the device: a second notice with the same tag
   *  replaces the first rather than stacking, as the server's `Topic`
   *  does in transit. */
  tag: string;
}

/** What tapping a notice opens. Either field, or neither when the
 *  server's content policy left nothing to open but the app. */
export interface PushOpen {
  /** A private conversation, by the sender's login. */
  msg?: string;
  /** The sender's nick, so the conversation has a name before the
   *  roster or the inbox gives it one. */
  nick?: string;
  /** A news article, by id. */
  article?: number;
}

export function noticeFor(p: PushPayload | null): Notice {
  if (!p) {
    // The browser requires something on screen for every push, and a
    // body this client cannot read is still one the server sent.
    return { title: 'Hotline', body: 'Something new on the server.', tag: 'hx' };
  }
  if (p.kind === 'message') {
    const who = p.from_nick;
    const more = p.unread > 1 ? ` (${p.unread} unread)` : '';
    return {
      title: who ? who : 'Private message',
      body: p.text ?? (who ? `Sent you a private message${more}.` : `You have a new private message${more}.`),
      // The conversation, as the server collapses it: one per sender,
      // and every sender without a name shares one.
      tag: `msg:${p.from ?? ''}`,
    };
  }
  const who = p.from_nick || 'Someone';
  const subject = p.subject ? `“${p.subject}”` : null;
  const said =
    p.reason === 'reply'
      ? subject ? `${who} replied to you in ${subject}` : 'Someone replied to you'
      : p.reason === 'reference'
        ? subject ? `${who} cited your article in ${subject}` : 'Someone cited your article'
        : subject
          ? p.scope === 'category' ? `${who} started ${subject}` : `${who} posted in ${subject}`
          : 'Something new in what you follow';
  return {
    title: 'News',
    body: p.excerpt ? `${said}: ${p.excerpt}` : `${said}.`,
    tag: `news:${p.scope}:${p.target}`,
  };
}

export function openFor(p: PushPayload | null): PushOpen {
  if (!p) return {};
  if (p.kind === 'message') {
    const open: PushOpen = {};
    if (p.from) open.msg = p.from;
    if (p.from_nick) open.nick = p.from_nick;
    return open;
  }
  return { article: p.article };
}

/** `?open=` as the page reads it after a notice opened a new window. */
export function openParam(o: PushOpen): string | null {
  if (o.msg) return `msg:${o.msg}`;
  if (o.article !== undefined) return `article:${o.article}`;
  return null;
}

export function parseOpenParam(s: string | null): PushOpen {
  if (!s) return {};
  if (s.startsWith('msg:') && s.length > 4) return { msg: s.slice(4) };
  const article = s.startsWith('article:') ? Number(s.slice(8)) : NaN;
  return Number.isSafeInteger(article) && article > 0 ? { article } : {};
}

/** What a service worker asks each open window when a notice is
 *  tapped, with a port for the answer. Asked first with `act` off, to
 *  find the right window without disturbing any; then with `act` on, of
 *  the one window chosen, which shows what the notice was about. */
export interface PushOpenMessage {
  type: 'hx-push-open';
  server: string;
  account: string;
  open: PushOpen;
  act: boolean;
}

/** A window's answer: logged in to that server as that account, not
 *  logged in anywhere yet, or busy with some other server or account. */
export type PushOpenReply = 'match' | 'idle' | 'other';

export function isPushOpenMessage(v: unknown): v is PushOpenMessage {
  const m = v as Partial<PushOpenMessage> | null;
  return (
    !!m &&
    m.type === 'hx-push-open' &&
    typeof m.server === 'string' &&
    typeof m.account === 'string' &&
    typeof m.open === 'object' &&
    m.open !== null &&
    typeof m.act === 'boolean'
  );
}
