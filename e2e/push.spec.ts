/**
 * Notifications, in a real browser against a real server: turn them on,
 * see the registration accepted, have a push drawn by the service
 * worker, and turn them off again.
 *
 * A headless browser has no push service to subscribe with, so the one
 * thing faked is `PushManager`: it hands back a subscription carrying a
 * real P-256 key, which is all the server checks at registration. The
 * push itself is delivered to the worker over the DevTools protocol, as
 * a push service would deliver it after the browser decrypted it.
 *
 * The full Chromium build in its new headless mode, not the default
 * headless shell: the shell refuses notification permission whatever
 * the context grants, so nothing could ever be drawn.
 */

import { expect, test, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5740;

let server: RunningServer | null = null;

test.use({ channel: 'chromium' });

test.skip(!hxdNgAvailable(), 'needs a sibling hxd-ng checkout and cargo');

test.beforeAll(async () => {
  buildHxdNg();
  server = await startServer(NG_PORT, {
    sections: `
[inbox]
db = "server.sqlite"

[push]
contact = "mailto:admin@example.org"
content = "sender"
`,
    accounts: {
      ann: `name = "Ann"
password = "pw"
[access]
read_chat = true
send_chat = true
send_messages = true
`,
    },
  });
});

test.afterAll(() => server?.stop());

/** A `PushManager` that subscribes without a push service. Runs in the
 *  page, which this program has no DOM types for, hence the `any`. */
function fakePushManager(): void {
  const w = globalThis as any;
  const subs = new WeakMap<object, unknown>();
  const b64url = (b: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  w.PushManager.prototype.getSubscription = async function (this: object) {
    return subs.get(this) ?? null;
  };
  w.PushManager.prototype.subscribe = async function (this: object, opts: { applicationServerKey: Uint8Array }) {
    const pair: any = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const p256dh = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
    const auth = b64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
    const endpoint = `https://push.example.com/send/${auth}`;
    const sub = {
      endpoint,
      expirationTime: null,
      options: { applicationServerKey: opts.applicationServerKey.buffer, userVisibleOnly: true },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
      unsubscribe: async () => subs.delete(this),
    };
    subs.set(this, sub);
    return sub;
  };
}

/** The notifications a worker scope has on screen, read from the page. */
function shownIn(scope: string): Promise<{ title: string; body: string; tag: string }[]> {
  const w = globalThis as any;
  return w.navigator.serviceWorker
    .getRegistration(scope)
    .then((reg: any) => reg.getNotifications())
    .then((ns: { title: string; body: string; tag: string }[]) =>
      ns.map((n) => ({ title: n.title, body: n.body, tag: n.tag })),
    );
}

function registered(scope: string): Promise<boolean> {
  const w = globalThis as any;
  return w.navigator.serviceWorker.getRegistration(scope).then((r: unknown) => !!r);
}

async function logIn(page: Page): Promise<void> {
  const url = server!.wsUrl.replace('127.0.0.1', 'localhost');
  await page.goto(`/?server=${encodeURIComponent(url)}`);
  await page.getByLabel('Account').fill('ann');
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
}

test('notifications turn on, draw a push, and turn off', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  await page.addInitScript(fakePushManager);
  await logIn(page);

  const notify = page.getByRole('button', { name: 'Notify' });
  await expect(notify).toBeVisible();
  await expect(notify).toHaveAttribute('aria-pressed', 'false');

  // What the server will send is said before anything is asked.
  let asked = '';
  page.once('dialog', (d) => {
    asked = d.message();
    void d.accept();
  });
  await notify.click();
  await expect(page.locator('.transcript')).toContainText('Notifications are on');
  await expect(notify).toHaveAttribute('aria-pressed', 'true');
  expect(asked).toMatch(/who wrote to you, but not what they said/);

  // The worker draws what a push carries, as the server wrote it under
  // `content = "sender"`.
  const cdp = await context.newCDPSession(page);
  const registrations = new Map<string, string>();
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
    for (const r of e.registrations) if (!r.isDeleted) registrations.set(r.scopeURL, r.registrationId);
  });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => [...registrations.keys()].some((s) => s.includes('/push/'))).toBe(true);
  const [scope, registrationId] = [...registrations].find(([s]) => s.includes('/push/'))!;
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: new URL(scope).origin,
    registrationId,
    data: JSON.stringify({ kind: 'message', id: '7', unread: 2, from: 'bob', from_nick: 'Bob' }),
  });
  await expect.poll(() => page.evaluate(shownIn, scope)).toEqual([{ title: 'Bob', body: 'Sent you a private message (2 unread).', tag: 'msg:bob' }]);

  // And off: the server is told, and the worker goes with the subscription.
  await notify.click();
  await expect(page.locator('.transcript')).toContainText('Notifications are off');
  await expect(notify).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(registered, scope)).toBe(false);
});

/** Ask the page what the service worker asks it when a notice is
 *  tapped, and return its answer. Dispatched on the container directly:
 *  a headless browser has no way to tap a notification. */
function askPage(msg: { server: string; account: string; open: object; act: boolean }): Promise<string> {
  const w = globalThis as any;
  return new Promise((resolve) => {
    const ch = new w.MessageChannel();
    ch.port1.onmessage = (e: { data: string }) => resolve(e.data);
    w.navigator.serviceWorker.dispatchEvent(
      new w.MessageEvent('message', { data: { type: 'hx-push-open', ...msg }, ports: [ch.port2] }),
    );
  });
}

test('a tapped notice goes only to a page logged in as its account', async ({ page }) => {
  await logIn(page);
  const url = server!.wsUrl.replace('127.0.0.1', 'localhost');
  const bobs = { server: url, account: 'bob', open: { msg: 'carol', nick: 'Carol' }, act: true };
  expect(await page.evaluate(askPage, bobs)).toBe('other');
  expect(await page.evaluate(askPage, { ...bobs, server: 'wss://elsewhere.example', account: 'ann' })).toBe('other');
  await expect(page.locator('.rail-item', { hasText: 'Carol' })).toHaveCount(0);

  expect(await page.evaluate(askPage, { ...bobs, account: 'ann', act: false })).toBe('match');
  await expect(page.locator('.rail-item', { hasText: 'Carol' })).toHaveCount(0);
  expect(await page.evaluate(askPage, { ...bobs, account: 'ann' })).toBe('match');
  await expect(page.locator('.rail-item.on', { hasText: 'Carol' })).toBeVisible();
});

test('a notice tapped at the connect form opens once logged in', async ({ page }) => {
  const url = server!.wsUrl.replace('127.0.0.1', 'localhost');
  await page.goto('/');
  await expect(page.getByLabel('Account')).toBeVisible();
  const anns = { server: url, account: 'ann', open: { msg: 'carol', nick: 'Carol' }, act: true };
  expect(await page.evaluate(askPage, anns)).toBe('idle');
  await expect(page.getByLabel('Account')).toHaveValue('ann');
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
  await expect(page.locator('.rail-item.on', { hasText: 'Carol' })).toBeVisible();
});

test('a server without push offers no switch', async ({ page }) => {
  const plain = await startServer(NG_PORT + 1, {
    sections: `
[inbox]
db = "server.sqlite"
`,
    accounts: { ann: `name = "Ann"\npassword = "pw"\n[access]\nread_chat = true\n` },
  });
  try {
    await page.goto(`/?server=${encodeURIComponent(plain.wsUrl.replace('127.0.0.1', 'localhost'))}`);
    await page.getByLabel('Account').fill('ann');
    await page.getByLabel('Password').fill('pw');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.app')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Notify' })).toBeHidden();
  } finally {
    plain.stop();
  }
});
