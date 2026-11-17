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
const ENDED = 'This session was ended from one of your devices.';

test.describe('a person of two devices', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;
  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, { server: 'coalesce = true', accounts: { pam: PAM } });
  });
  test.afterAll(() => server?.stop());

  async function logIn(page: Page): Promise<void> {
    await page.goto(`/?server=${encodeURIComponent(server.wsUrl)}`);
    await page.getByLabel('Account').fill('pam');
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

  /** The page, ended, opens no socket again: its pill stays offline, and
   *  the server is not asked again, for longer than a reconnect's first
   *  backoffs. */
  async function staysOut(page: Page, opened: () => number): Promise<void> {
    const after = opened();
    await page.waitForTimeout(3000);
    expect(opened(), 'no socket opened once ended').toBe(after);
    await expect(page.locator('.pill')).toHaveClass(/offline/);
  }

  /** The person's other device, and every row it is told of it. */
  async function otherDevice(): Promise<{ conn: Connection; rows: User[] }> {
    const rows: User[] = [];
    const conn = new Connection(
      { url: server.wsUrl, login: 'pam', password: 'pw', nick: 'Pam', icon: 0, persons: true, deviceLabel: 'Node' },
      { onSnapshot: (ok) => rows.push(...ok.users.filter((u) => u.uid === ok.self.uid)) },
    );
    conn.on('user_changed', (d) => rows.push(d.user));
    await conn.start();
    return { conn, rows };
  }

  test('a device ended by another of its person says so, and logs in no more', async ({ page }) => {
    const opened = sockets(page);
    await logIn(page);
    const { conn, rows } = await otherDevice();
    try {
      const [mine, theirs] = conn.self!.devices!;
      expect(theirs!.device).toBe(conn.device);
      expect(mine!.label, 'the page names itself by its browser').toMatch(/ on /);

      await conn.deviceEnd(mine!.device);
      await expect(page.getByText(ENDED).first()).toBeVisible();
      await expect.poll(() => rows.at(-1)?.devices?.length).toBe(1);
      await staysOut(page, opened);
      expect(rows.at(-1)?.devices?.map((d) => d.device)).toEqual([conn.device]);
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
      const pageDevice = conn.self!.devices![0]!.device;
      away = true;
      for (const s of live) await s.close();
      await expect.poll(() => rows.at(-1)?.devices?.find((d) => d.device === pageDevice)?.status).toBe('detached');
      await conn.deviceEnd(pageDevice);
      await expect.poll(() => rows.at(-1)?.devices?.length).toBe(1);
      away = false;
      await expect(page.getByText(ENDED).first()).toBeVisible({ timeout: 20_000 });
      await staysOut(page, opened);
      expect(rows.at(-1)?.devices?.map((d) => d.device)).toEqual([conn.device]);
    } finally {
      await conn.logout();
    }
  });
});
