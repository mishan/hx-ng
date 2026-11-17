/**
 * A moderator and another person's devices (hxd-ng's
 * `docs/hotline-ng.md` §7.6): the page as a session with the kick bit,
 * shown the devices of a person whose two devices are library
 * `Connection`s in Node, disconnecting one of them, then the last, and
 * one already gone.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { Connection } from '../packages/hotline-ng/src/index';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5876;
const PAM = 'name = "Pam"\npassword = "pw"\n[access]\nread_chat = true\nsend_chat = true\n[extra]\npersonal = true\n';
const MOD = 'name = "Mod"\npassword = "pw"\n[access]\nread_chat = true\nsend_chat = true\ndisconnect_users = true\n';
const KICKED = 'You were disconnected by an administrator.';

test.describe('a moderator and a person of two devices', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;
  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, { server: 'coalesce = true', accounts: { pam: PAM, mod: MOD } });
  });
  test.afterAll(() => server?.stop());

  async function logIn(page: Page): Promise<void> {
    await page.goto(`/?server=${encodeURIComponent(server.wsUrl)}`);
    await page.getByLabel('Account').fill('mod');
    await page.getByLabel('Password').fill('pw');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.app')).toBeVisible();
  }

  /** One of Pam's devices, named `label`, and why it ended, once it has. */
  async function device(label: string): Promise<{ conn: Connection; ended: () => string | null }> {
    let ended: string | null = null;
    const conn = new Connection(
      { url: server.wsUrl, login: 'pam', password: 'pw', nick: 'Pam', icon: 0, persons: true, deviceLabel: label },
      { onEnded: (r) => (ended = r) },
    );
    await conn.start();
    return { conn, ended: () => ended };
  }

  /** The device picked from Pam's menu, up to its confirmation, once
   *  the list shows what `shown` waits for. */
  async function pick(page: Page, label: RegExp, shown: (list: Locator) => Promise<void> = async () => {}): Promise<void> {
    const list = page.getByRole('dialog', { name: "Pam's devices" });
    await expect(async () => {
      if (await list.isVisible()) await list.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'More for Pam' }).click();
      await page.getByRole('button', { name: 'Disconnect one device…' }).click();
      await shown(list);
    }).toPass({ timeout: 10_000 });
    await list.getByRole('button', { name: label }).click();
  }

  /** `ended` still says nothing after a moment. */
  async function stays(ended: () => string | null): Promise<void> {
    await new Promise((r) => setTimeout(r, 500));
    expect(ended()).toBeNull();
  }

  const pamOnRoster = (page: Page) => page.getByRole('button', { name: 'More for Pam' });
  const confirmOf = (page: Page) => page.getByRole('dialog', { name: 'Disconnect this device of Pam?' });

  test('is shown each device with its login and address, and disconnects one, then the last as the person', async ({ page }) => {
    await logIn(page);
    const desk = await device('Desk');
    const phone = await device('Phone');
    try {
      await pick(page, /"Phone"$/, async (list) => {
        await expect(list.getByRole('button', { name: /^ng, password, .*as pam from 127\.0\.0\.1 -- "Desk"$/ })).toBeVisible({ timeout: 1000 });
        await expect(list.getByRole('button', { name: /"Phone"$/ })).toBeVisible({ timeout: 1000 });
      });
      const confirm = confirmOf(page);
      await expect(confirm).toContainText('stays on their other devices');
      await expect(confirm).toContainText('-- "Phone"');
      await confirm.getByRole('button', { name: 'Disconnect' }).click();
      await expect.poll(phone.ended).toBe(KICKED);
      await stays(desk.ended);
      await expect(pamOnRoster(page)).toBeVisible();

      // Once the page itself has seen Phone go.
      await pick(page, /"Desk"$/, async (list) => {
        await expect(list.getByRole('button', { name: /"Phone"$/ })).toHaveCount(0, { timeout: 1000 });
      });
      await expect(confirm).toContainText('the last of theirs here');
      await confirm.getByRole('button', { name: 'Disconnect' }).click();
      await expect.poll(desk.ended).toBe(KICKED);
      await expect(pamOnRoster(page)).toHaveCount(0);
    } finally {
      await desk.conn.logout();
      await phone.conn.logout();
    }
  });

  test('asks again when the device picked became the last while it was asked about', async ({ page }) => {
    await logIn(page);
    const desk = await device('Desk');
    const phone = await device('Phone');
    try {
      await pick(page, /"Phone"$/);
      const confirm = confirmOf(page);
      await expect(confirm).toContainText('stays on their other devices');
      await desk.conn.logout();
      // Long enough for the page to hear Desk go.
      await new Promise((r) => setTimeout(r, 500));
      await confirm.getByRole('button', { name: 'Disconnect' }).click();
      await expect(confirm).toContainText('the last of theirs here');
      await stays(phone.ended);
      await confirm.getByRole('button', { name: 'Disconnect' }).click();
      await expect.poll(phone.ended).toBe(KICKED);
      await expect(pamOnRoster(page)).toHaveCount(0);
    } finally {
      await desk.conn.logout();
      await phone.conn.logout();
    }
  });

  test('is told a device that went while it was asked about has gone', async ({ page }) => {
    await logIn(page);
    const desk = await device('Desk');
    const phone = await device('Phone');
    try {
      await pick(page, /"Phone"$/);
      await phone.conn.logout();
      await confirmOf(page).getByRole('button', { name: 'Disconnect' }).click();
      await expect(page.getByText('That device has already gone.').first()).toBeVisible();
      await stays(desk.ended);
      await expect(pamOnRoster(page)).toBeVisible();
    } finally {
      await desk.conn.logout();
    }
  });
});
