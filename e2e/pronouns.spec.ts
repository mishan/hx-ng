/**
 * Pronouns, end to end, in real browsers against a real server: set from
 * Settings and shown in another reader's user list, isolated and read
 * out as pronouns, a second change inside the server's interval refused
 * with its wait, a value the server would refuse said before it is
 * asked, a guest refused in words, and no field on a server that shows
 * none.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5926;
const OFF_PORT = 5927;

const account = (name: string) => `name = "${name}"
password = "pw"
[access]
read_chat = true
send_chat = true
`;

const SECTIONS = `
[limits]
chat_lines = 0
spam_points = 0
ng_requests = 0
`;

const contexts: BrowserContext[] = [];

async function logIn(browser: Browser, server: RunningServer, login: string | null): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`/?server=${encodeURIComponent(server.wsUrl)}`);
  if (login !== null) {
    await page.getByLabel('Account').fill(login);
    await page.getByLabel('Password').fill('pw');
  }
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
  return page;
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByRole('dialog', { name: 'Settings' });
}

const row = (page: Page, nick: string) => page.locator('.person', { has: page.locator('.nick', { hasText: nick }) });

test.describe('pronouns against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;
  let off: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, {
      sections: SECTIONS,
      accounts: { alice: account('Alice'), bob: account('Bob') },
    });
    off = await startServer(OFF_PORT, {
      server: 'pronouns = false',
      sections: SECTIONS,
      accounts: { alice: account('Alice') },
    });
  });

  test.afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  test.afterAll(() => {
    server?.stop();
    off?.stop();
  });

  test('set in Settings, shown to everyone beside the name, and paced by the server', async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');

    const settings = await openSettings(alice);
    await expect(settings).toContainText('everyone on this server');
    const field = settings.getByLabel('Your pronouns');
    await expect(field).toHaveValue('');

    // A value the server would refuse is said before it is asked.
    await field.fill('she  her');
    await expect(settings.getByRole('status')).toHaveText(/two spaces in a row/);
    await expect(field).toHaveAttribute('aria-invalid', 'true');

    // A quick pick fills the field and leaves it to be saved.
    await settings.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'she/her' }).click();
    await expect(field).toHaveValue('she/her');
    await expect(field).toBeFocused();
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('Saved.');

    for (const page of [bob, alice]) {
      const shown = row(page, 'Alice').locator('bdi.pronouns');
      await expect(shown).toHaveText('she/her');
      await expect(shown).toHaveCSS('unicode-bidi', 'isolate');
      await expect(row(page, 'Alice').locator('.nick')).toHaveText('Alice');
    }
    await expect(row(bob, 'Alice').getByRole('button', { name: /^Alice\s*, pronouns:\s*she\/her$/ })).toBeVisible();
    await expect(row(bob, 'Bob').locator('.pronouns')).toHaveCount(0);

    // One change in the server's interval: the second is refused with a wait.
    await field.fill('they/them');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText(/Try again in \d+ seconds?\./);
    await expect(row(bob, 'Alice').locator('bdi.pronouns')).toHaveText('she/her');
  });

  test('a guest is told it may not, in words', async ({ browser }) => {
    const guest = await logIn(browser, server, null);
    const settings = await openSettings(guest);
    await settings.getByLabel('Your pronouns').fill('they/them');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText(/may not set pronouns/);
  });

  test('no field on a server that shows none', async ({ browser }) => {
    const alice = await logIn(browser, off, 'alice');
    const settings = await openSettings(alice);
    await expect(settings.getByRole('group', { name: 'Theme' })).toBeVisible();
    await expect(settings.getByLabel('Your pronouns')).toHaveCount(0);
  });
});
