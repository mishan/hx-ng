/**
 * A person's devices (hxd-ng's `docs/hotline-ng.md` §7.6): the page as
 * one device of a person, and the library in Node as another, which
 * ends the page's. The page says it was ended and does not come back.
 */

import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

import { Connection, type User } from '../packages/hotline-ng/src/index';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5866;
const PAM = 'name = "Pam"\npassword = "pw"\n[access]\nread_chat = true\nsend_chat = true\n[extra]\npersonal = true\n';
/** A person whose sessions may not detach, so a lost connection logs in
 *  afresh, as a new device. */
const KIT = 'name = "Kit"\npassword = "pw"\n[access]\nread_chat = true\nsend_chat = true\n[extra]\npersonal = true\ncan_detach = false\n';
const ENDED = 'This session was ended from one of your devices.';

test.describe('a person of two devices', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;
  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, { server: 'coalesce = true', accounts: { pam: PAM, kit: KIT } });
  });
  test.afterAll(() => server?.stop());

  async function logIn(page: Page, login = 'pam'): Promise<void> {
    await page.goto(`/?server=${encodeURIComponent(server.wsUrl)}`);
    await page.getByLabel('Account').fill(login);
    await page.getByLabel('Password').fill('pw');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.app')).toBeVisible();
  }

  /** How many sockets the page has opened to the server, so far. */
  function sockets(page: Page): () => number {
    let opened = 0;
    page.on('websocket', (ws) => {
      if (ws.url().includes(`:${NG_PORT}/ng`)) opened++;
    });
    return () => opened;
  }

  /** The page, ended, has opened no socket since `after`, by default
   *  now, for longer than a reconnect's first backoffs, and its pill
   *  stays offline. */
  async function staysOut(page: Page, opened: () => number, after = opened()): Promise<void> {
    await page.waitForTimeout(3000);
    expect(opened(), 'no socket opened once ended').toBe(after);
    await expect(page.locator('.pill')).toHaveClass(/offline/);
  }

  /** The person's other device, and every row it is told of it. */
  async function otherDevice(login = 'pam'): Promise<{ conn: Connection; rows: User[] }> {
    const rows: User[] = [];
    const conn = new Connection(
      { url: server.wsUrl, login, password: 'pw', nick: 'Pam', icon: 0, persons: true, deviceLabel: 'Node' },
      { onSnapshot: (ok) => rows.push(...ok.users.filter((u) => u.uid === ok.self.uid)) },
    );
    conn.on('user_changed', (d) => rows.push(d.user));
    await conn.start();
    return { conn, rows };
  }

  /** Log the page out with `/logout`, where it still has a session;
   *  never a reason for a case to fail. */
  async function logOut(page: Page): Promise<void> {
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('.composer-input').fill('/logout', { timeout: 2000 }).catch(() => {});
    await page.locator('.composer-input').press('Enter', { timeout: 2000 }).catch(() => {});
  }

  /** The page's own device: the newest but `other`, the person's devices
   *  being listed as they joined. */
  const pageDevice = (conn: Connection) => conn.self!.devices!.filter((d) => d.device !== conn.device).at(-1)!;

  test('each device lists the person\'s devices by label as they come, marks itself, and ends another', async ({ browser }) => {
    const desk = await (await browser.newContext()).newPage();
    const phone = await (await browser.newContext()).newPage();
    try {
      await logIn(desk);
      await logIn(phone);
      // The name the phone goes by, set here and sent at its next login.
      await phone.getByRole('button', { name: 'Settings' }).click();
      // Kept as it is typed, with nothing to save.
      await phone.getByLabel('Device name').fill('Phone');
      await phone.getByLabel('Device name').press('Escape');
      await logOut(phone);
      await expect(phone.getByLabel('Account')).toBeVisible();

      await desk.locator('button.identity').click();
      const devices = desk.getByRole('region', { name: 'Your devices' });
      await expect(devices.locator('li')).toHaveCount(1);
      // A device joining while the dialog is open is listed there.
      await logIn(phone);
      const opened = sockets(phone);
      await expect(devices.locator('li')).toHaveCount(2);
      const mine = devices.locator('li.mine');
      await expect(mine).toContainText('(this device)');
      await expect(mine).toContainText('password');
      await expect(mine.getByRole('button', { name: /^End this device \(.+ on .+\)$/ })).toBeVisible();
      await expect(devices.locator('li', { hasText: 'Phone' })).not.toContainText('(this device)');

      // Another device is one click.
      await devices.getByRole('button', { name: 'End Phone', exact: true }).click();
      await expect(devices.locator('li')).toHaveCount(1);
      await expect(desk.getByRole('dialog', { name: 'End this device?' })).toHaveCount(0);
      await expect(desk.getByRole('dialog', { name: 'Name and icon' }).getByRole('status')).toHaveText('Ended Phone');
      await expect(devices.getByRole('heading', { name: 'Your devices' })).toBeFocused();
      await expect(phone.getByText(ENDED).first()).toBeVisible();
      await staysOut(phone, opened);

      await desk.keyboard.press('Escape');
      await desk.locator('button.identity').click();
      await expect(devices.locator('li')).toHaveCount(1);
    } finally {
      await logOut(desk);
      await desk.context().close();
      await phone.context().close();
    }
  });

  test('an open list follows a fresh login that made this a new device, and still asks before ending it', async ({ page }) => {
    let away = false;
    const live: WebSocketRoute[] = [];
    await page.routeWebSocket(new RegExp(`:${NG_PORT}/ng`), (ws) => {
      if (away) return void ws.close();
      live.push(ws.connectToServer());
    });
    await logIn(page, 'kit');
    const other = await otherDevice('kit');
    try {
      await page.locator('button.identity').click();
      const devices = page.getByRole('region', { name: 'Your devices' });
      await expect(devices.locator('li')).toHaveCount(2);
      // The page's session ends with its connection, and the other device
      // leaves while it is away: it comes back by a fresh login, whose
      // roster is all it hears of either.
      away = true;
      for (const s of live) await s.close();
      await expect.poll(() => other.rows.at(-1)?.devices?.length).toBe(1);
      await other.conn.logout();
      away = false;
      await expect(page.locator('.pill')).toHaveClass(/online/, { timeout: 20_000 });

      await expect(devices.locator('li')).toHaveCount(1);
      await expect(devices.locator('li.mine')).toHaveCount(1);
      await devices.getByRole('button', { name: /^End this device/ }).click();
      const confirm = page.getByRole('dialog', { name: 'End this device?' });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.locator('.pill')).toHaveClass(/online/);
    } finally {
      await other.conn.logout().catch(() => {});
      await logOut(page);
    }
  });

  test('ending this device through the dialog is asked first, then logs it out for good', async ({ page }) => {
    const opened = sockets(page);
    await logIn(page);
    try {
      await page.locator('button.identity').click();
      const own = page.getByRole('region', { name: 'Your devices' }).getByRole('button', { name: /^End this device/ });
      const confirm = page.getByRole('dialog', { name: 'End this device?' });
      await own.click();
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toHaveCount(0);
      await expect(page.locator('.pill')).toHaveClass(/online/);

      await own.click();
      await confirm.getByRole('button', { name: 'End and log out' }).click();
      await expect(page.getByLabel('Account')).toBeVisible();
      const after = opened();
      await page.waitForTimeout(3000);
      expect(opened(), 'no socket opened once ended').toBe(after);
    } finally {
      await logOut(page);
    }
  });

  test('a device ended by another of its person says so, and logs in no more', async ({ page }) => {
    const opened = sockets(page);
    await logIn(page);
    const { conn, rows } = await otherDevice();
    try {
      const mine = pageDevice(conn);
      expect(mine.label, 'the page names itself by its browser').toMatch(/ on /);

      const before = opened();
      await conn.deviceEnd(mine.device);
      await expect(page.getByText(ENDED).first()).toBeVisible();
      await expect.poll(() => rows.at(-1)?.devices?.some((d) => d.device === mine.device)).toBe(false);
      await staysOut(page, opened, before);
      expect(rows.at(-1)?.devices?.map((d) => d.device)).not.toContain(mine.device);
    } finally {
      await conn.logout();
    }
  });

  test('a device ended while it was away says so when it comes back, and logs in no more', async ({ page }) => {
    // A resume of an ended session answered `ended`, which hxd-ng's
    // `resume-ended` added: a server before it says `session_expired`,
    // and the page logs in again.
    // The page's sockets pass through here, so one can be cut and the
    // next ones refused while the page is away.
    let away = false;
    const live: WebSocketRoute[] = [];
    const opened = sockets(page);
    await page.routeWebSocket(new RegExp(`:${NG_PORT}/ng`), (ws) => {
      if (away) return void ws.close();
      live.push(ws.connectToServer());
    });
    await logIn(page);
    const { conn, rows } = await otherDevice();
    try {
      const { device } = pageDevice(conn);
      away = true;
      for (const s of live) await s.close();
      await expect.poll(() => rows.at(-1)?.devices?.find((d) => d.device === device)?.status).toBe('detached');
      await conn.deviceEnd(device);
      await expect.poll(() => rows.at(-1)?.devices?.some((d) => d.device === device)).toBe(false);
      away = false;
      await expect(page.getByText(ENDED).first()).toBeVisible({ timeout: 20_000 });
      const before = rows.length;
      await staysOut(page, opened);
      expect(rows.slice(before).flatMap((r) => r.devices ?? []).some((d) => d.device !== conn.device), 'nothing joined the person again').toBe(false);
    } finally {
      await conn.logout();
    }
  });
});
