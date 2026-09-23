/// <reference lib="webworker" />
/**
 * The service worker that receives this client's push notifications.
 *
 * One registration per server and account (push-notifications.md §8.1:
 * a subscription is bound to one server's key), each with its own scope
 * under `push/`, and the server and account ride in this script's own
 * URL so each copy knows whose it is. No page is ever inside those
 * scopes: this worker caches nothing and intercepts no fetch. All it
 * does is draw what arrives and open the app when it is tapped.
 *
 * Bundled on its own, so it imports the protocol module directly rather
 * than the package index — that would drag `Connection` and
 * `VoiceSession` into a worker that has no use for either.
 */

import { parsePushPayload } from '../packages/hotline-ng/src/protocol.js';
import { noticeFor, openFor, openParam, type PushOpen, type PushOpenMessage } from './push/notice';

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
    self.registration.showNotification(notice.title, {
      body: notice.body,
      tag: notice.tag,
      data: openFor(payload),
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(follow((e.notification.data ?? {}) as PushOpen));
});

/** Bring the app forward, on the thing the notice was about. A window
 *  that is already open is told and focused; otherwise a new one opens
 *  on this server, with `?open=` for it to act on once logged in. */
async function follow(open: PushOpen): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = new URL('../../', self.registration.scope);
  const ours = windows.filter((w) => new URL(w.url).pathname.startsWith(app.pathname));
  const target = ours.find((w) => w.focused) ?? ours.find((w) => w.visibilityState === 'visible') ?? ours[0];
  if (target) {
    const msg: PushOpenMessage = { type: 'hx-push-open', server, account, open };
    target.postMessage(msg);
    await target.focus().catch(() => undefined);
    return;
  }
  app.searchParams.set('server', server);
  const o = openParam(open);
  if (o) app.searchParams.set('open', o);
  await self.clients.openWindow(app.href);
}
