/**
 * Notifications on this device, for one server and one account.
 *
 * The server never asks for a device (push-notifications.md §8.1). This
 * asks the user, subscribes with the key the login reply offered, and
 * registers what the browser gave back. A subscription is bound to one
 * server's key, so each server and account gets a service worker
 * registration of its own, with its own scope. Turning one off leaves
 * the others alone, and two people sharing a browser are not notified
 * about each other's mail.
 *
 * Whether it is on is the browser's own record, the subscription,
 * rather than a flag kept beside it that could disagree with it.
 */

import {
  pushSubscriptionParams,
  type Connection,
  type PushConfig,
} from '@hotline-ng/client';

import swUrl from '../sw.ts?worker&url';

/** The browser can do this at all. Needs a secure context: outside one
 *  `navigator.serviceWorker` is `undefined` rather than merely failing,
 *  as `mediaDevices` is. */
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** What the user has told the browser about notifications from here. */
export function pushPermission(): NotificationPermission {
  return pushSupported() ? Notification.permission : 'denied';
}

/** Where a server and account's worker lives: a scope no page is ever
 *  in, named by a digest so neither the server's address nor the login
 *  ends up in a path. */
async function scopeFor(server: string, account: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${server}\n${account}`));
  const hex = [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new URL(`push/${hex}/`, document.baseURI).href;
}

async function existing(server: string, account: string): Promise<ServiceWorkerRegistration | undefined> {
  return navigator.serviceWorker.getRegistration(await scopeFor(server, account));
}

async function register(server: string, account: string): Promise<ServiceWorkerRegistration> {
  const url = new URL(swUrl, document.baseURI);
  url.searchParams.set('server', server);
  url.searchParams.set('account', account);
  const reg = await navigator.serviceWorker.register(url.href, {
    scope: await scopeFor(server, account),
    // In development Vite serves the worker as an ES module; the build
    // bundles it into one classic script.
    type: import.meta.env.DEV ? 'module' : 'classic',
  });
  await activated(reg);
  return reg;
}

/** `navigator.serviceWorker.ready` is no use here: it waits for a worker
 *  that controls *this page*, and none ever will. A subscription needs
 *  an active worker, so wait for this registration's own. */
function activated(reg: ServiceWorkerRegistration): Promise<void> {
  if (reg.active) return Promise.resolve();
  const worker = reg.installing ?? reg.waiting;
  if (!worker) return Promise.resolve();
  return new Promise((resolve, reject) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve();
      else if (worker.state === 'redundant') reject(new Error('The notification worker failed to start.'));
    });
  });
}

/** Is this device getting notifications for that account on that server? */
export async function pushEnabled(server: string, account: string): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await existing(server, account);
  return !!(reg && (await reg.pushManager.getSubscription()));
}

/**
 * Ask, subscribe and register. Throws if the user says no, or if the
 * server refuses the registration.
 */
export async function enablePush(conn: Connection, server: string, account: string): Promise<void> {
  const push = conn.push;
  if (!push || !pushSupported()) throw new Error('This server does not send notifications to this browser.');
  // Asked from the click that called this: a browser that wants a user
  // gesture for the prompt has one.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser’s site settings first.'
        : 'Notifications were not allowed.',
    );
  }
  await subscribeAndRegister(conn, push, await register(server, account));
}

/**
 * A login on a device that already has notifications on. Registering
 * again is idempotent. It is also how a changed endpoint, or a server
 * that has changed its key since, gets put right. Quiet: nothing here is
 * worth interrupting a login over.
 */
export async function refreshPush(conn: Connection, server: string, account: string): Promise<void> {
  const push = conn.push;
  if (!push || !pushSupported()) return;
  const reg = await existing(server, account);
  if (!reg || !(await reg.pushManager.getSubscription())) return;
  if (Notification.permission !== 'granted') {
    // Revoked in the browser's settings since. The subscription is dead
    // either way, and a registration left pointing at it only costs the
    // server a refused POST until it notices.
    await forget(reg);
    return;
  }
  await activated(reg);
  await subscribeAndRegister(conn, push, reg);
}

/** Stop notifying this device, and forget the subscription. The server
 *  is told first; if it cannot be, the subscription goes anyway, and
 *  the server drops the registration the first time its push is refused. */
export async function disablePush(conn: Connection | null, server: string, account: string): Promise<void> {
  if (!pushSupported()) return;
  const reg = await existing(server, account);
  let failure: unknown = null;
  if (conn?.push) {
    try {
      // The id the server filed this device under, which on an identity
      // session is the certificate's and not ours.
      const scope = await scopeFor(server, account);
      await conn.pushUnregister({ devid: filedAs(scope) ?? deviceId() });
      fileAs(scope, null);
    } catch (e) {
      failure = e;
    }
  }
  if (reg) await forget(reg);
  if (failure) throw failure;
}

async function subscribeAndRegister(conn: Connection, push: PushConfig, reg: ServiceWorkerRegistration): Promise<void> {
  const key = base64url(push.vapid);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made under a key the server no longer holds (`hxd
  // push rekey`) can never be pushed to again: the push service checks
  // every push against the key it was made with.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  // Our id goes on every registration. A password session needs it; an
  // identity session is named by its certificate and the server ignores
  // it.
  const params = pushSubscriptionParams(sub.toJSON(), deviceId());
  if (!params) throw new Error('The browser gave back a subscription without its keys.');
  const ok = await conn.pushRegister(params);
  fileAs(reg.scope, ok.devid);
}

async function forget(reg: ServiceWorkerRegistration): Promise<void> {
  const sub = await reg.pushManager.getSubscription();
  await sub?.unsubscribe().catch(() => false);
  await reg.unregister().catch(() => false);
}

const DEVID_KEY = 'hx-push-devid';

/**
 * This install's device id: 8 to 64 printable ASCII characters, kept for
 * good. A new one per registration would add a row every time rather
 * than replace one, until the server's per-account cap refused it
 * (webpush-gateway.md §7). The prefix keeps it from ever being spelled
 * like an identity device's fingerprint, which the server refuses from
 * a password session.
 */
export function deviceId(): string {
  try {
    const kept = localStorage.getItem(DEVID_KEY);
    if (kept) return kept;
  } catch {
    /* storage off: a fresh id, and this device registers anew next time */
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = `hx-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  try {
    localStorage.setItem(DEVID_KEY, id);
  } catch {
    /* as above */
  }
  return id;
}

/** The `devid` a registration came back with, by worker scope. */
function filedAs(scope: string): string | null {
  try {
    return localStorage.getItem(`${DEVID_KEY}:${scope}`);
  } catch {
    return null;
  }
}

function fileAs(scope: string, devid: string | null): void {
  try {
    if (devid === null) localStorage.removeItem(`${DEVID_KEY}:${scope}`);
    else localStorage.setItem(`${DEVID_KEY}:${scope}`, devid);
  } catch {
    /* as above */
  }
}

function base64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** What a notification from this server will say, in words for the
 *  question asked before turning them on. */
export function contentWords(content: PushConfig['content']): string {
  switch (content) {
    case 'full':
      return 'Notifications from this server include the text of your messages. It is encrypted to this browser, so the push service in between cannot read it.';
    case 'generic':
      return 'Notifications from this server say only that something arrived — not who sent it or what it says.';
    default:
      return 'Notifications from this server say who wrote to you, but not what they said.';
  }
}
