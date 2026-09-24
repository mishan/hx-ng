/// <reference lib="webworker" />
/**
 * The service worker that receives this client's push notifications.
 *
 * One registration per server and account (push-notifications.md §8.1:
 * a subscription is bound to one server's key), each with its own scope
 * under `push/`, and the server and account ride in this script's own
 * URL so each copy knows whose it is. No page is ever inside those
 * scopes: this worker intercepts no fetch, and the one thing it keeps
 * is a count for the app's badge (`push/badge.ts`). All it does is draw
 * what arrives, count it on the icon, and open the app when it is
 * tapped.
 *
 * Bundled on its own, so it imports the protocol module directly rather
 * than the package index — that would drag `Connection` and
 * `VoiceSession` into a worker that has no use for either.
 */

import { parsePushPayload } from '../packages/hotline-ng/src/protocol.js';
import { countAway, showBadge } from './push/badge';
import {
  noticeFor,
  openFor,
  openParam,
  type PushOpen,
  type PushOpenMessage,
  type PushOpenReply,
} from './push/notice';

declare const self: ServiceWorkerGlobalScope;

const params = new URL(self.location.href).searchParams;
const server = params.get('server') ?? '';
const account = params.get('account') ?? '';

// A new version takes over at once. There is no page state to keep
// consistent with it: nothing is cached and nothing is controlled.
self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let raw: unknown = null;
  try {
    raw = e.data?.json() ?? null;
  } catch {
    raw = null;
  }
  const payload = parsePushPayload(raw);
  const notice = noticeFor(payload);
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(notice.title, {
        body: notice.body,
        tag: notice.tag,
        data: openFor(payload),
      }),
      countAway().then((n) => showBadge(n)),
    ]),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(follow((e.notification.data ?? {}) as PushOpen));
});

/** Bring the app forward, on the thing the notice was about. Every open
 *  window is asked whose it is: one logged in to this server as this
 *  account is told and focused; failing that, one still at the connect
 *  form is pointed at it; failing both, a new one opens on this server,
 *  with `?open=` for it to act on once logged in. A window on another
 *  server or account is never handed a notice that is not its own. */
async function follow(open: PushOpen): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = new URL('../../', self.registration.scope);
  const ours = windows
    .filter((w) => new URL(w.url).pathname.startsWith(app.pathname))
    .sort((a, b) => nearness(a) - nearness(b));
  const msg: PushOpenMessage = { type: 'hx-push-open', server, account, open, act: false };
  const replies = await Promise.all(ours.map((w) => ask(w, msg)));
  const target = ours.find((_, i) => replies[i] === 'match') ?? ours.find((_, i) => replies[i] === 'idle');
  // Asked again, since the page may have logged in or out in between.
  const took = target ? await ask(target, { ...msg, act: true }) : null;
  if (target && (took === 'match' || took === 'idle')) {
    await target.focus().catch(() => undefined);
    return;
  }
  app.searchParams.set('server', server);
  app.searchParams.set('account', account);
  const o = openParam(open);
  if (o) app.searchParams.set('open', o);
  await self.clients.openWindow(app.href);
}

/** The window somebody is looking at first, then one that is on screen. */
function nearness(w: WindowClient): number {
  return w.focused ? 0 : w.visibilityState === 'visible' ? 1 : 2;
}

/** How long a window has to answer. One that is still loading, or is
 *  a build of this client from before the question, may never do so. */
const ASK_MS = 1000;

function ask(w: WindowClient, msg: PushOpenMessage): Promise<PushOpenReply | null> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), ASK_MS);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      ch.port1.close();
      resolve(e.data as PushOpenReply);
    };
    w.postMessage(msg, [ch.port2]);
  });
}
