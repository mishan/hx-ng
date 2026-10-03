/**
 * A classic Hotline server, end to end: a real `hxd` reached only on its
 * classic port, through a real `hlrelay`, from a real browser — two of
 * them, one by the relay's own address and one by the classic address a
 * tracker would list, found the way hxd-ng's `docs/hotline-ng-auth.md`
 * §5.1 says to look.
 *
 * The unit tests drive `ClassicConnection` against scripted frames. What
 * only this shows is the whole path: the wasm session in a page, the
 * relay, a server that thinks it is talking to a classic client, and the
 * views drawing what comes back.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { buildHxdNg, buildRelay, relayAvailable, startRelay, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 6900;
/** Where `startServer` puts the classic port: the ng port less 100. */
const CLASSIC_PORT = NG_PORT - 100;
/** Where a client looks for a classic port's relay: the port plus 200. */
const RELAY_PORT = CLASSIC_PORT + 200;

async function logIn(browser: Browser, server: string, nick: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/?server=${encodeURIComponent(server)}`);
  await page.getByLabel('Nickname').fill(nick);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
  return page;
}

async function say(page: Page, text: string): Promise<void> {
  await page.locator('.composer-input').fill(text);
  await page.locator('.composer-input').press('Enter');
}

test.describe('a classic server through hlrelay', () => {
  test.skip(!relayAvailable(), 'requires a sibling hxd-ng checkout with hlrelay (HXD_NG_DIR to point elsewhere), and cargo');

  let server: RunningServer;
  let relay: { stop(): void };

  test.beforeAll(async () => {
    // A first run compiles the server; nothing after it does.
    test.setTimeout(600_000);
    buildHxdNg();
    buildRelay();
    server = await startServer(NG_PORT, {
      sections: `
[files]
root = "files"
`,
      files: { 'files/read me.txt': 'Hello from a classic server.\n', 'files/Docs/a.txt': 'a\n' },
    });
    relay = await startRelay(`127.0.0.1:${CLASSIC_PORT}`, `127.0.0.1:${RELAY_PORT}`);
  });

  test.afterAll(() => {
    relay?.stop();
    server?.stop();
  });

  test('two browsers chat, write to each other, and browse files', async ({ browser }) => {
    // One by the relay's own address, one by the classic address.
    const amy = await logIn(browser, `ws://127.0.0.1:${RELAY_PORT}`, 'Amy');
    const bo = await logIn(browser, `hotline://127.0.0.1:${CLASSIC_PORT}`, 'Bo');

    // Each is on the other's roster.
    await expect(amy.locator('.roster', { hasText: 'Bo' })).toBeVisible();
    await expect(bo.locator('.roster', { hasText: 'Amy' })).toBeVisible();

    // Public chat crosses, with the sender named.
    await say(amy, 'hello from the browser, café');
    const line = bo.locator('.transcript .line.chat', { hasText: 'hello from the browser, café' });
    await expect(line).toBeVisible();
    await expect(line).toContainText('Amy');

    // A private message reaches the one it was written to.
    await say(bo, '/msg Amy psst');
    await expect(amy.locator('.rail-item', { hasText: 'Bo' })).toBeVisible();
    await amy.locator('.rail-item', { hasText: 'Bo' }).click();
    await expect(amy.locator('.transcript .line.chat', { hasText: 'psst' })).toBeVisible();

    // The files pane lists the server's root.
    await say(amy, '/files');
    await expect(amy.locator('.files-view')).toContainText('read me.txt');
    await expect(amy.locator('.files-view')).toContainText('Docs');
  });
});
