/**
 * Replies, end to end, in real browsers against a real server: a line
 * answered from its Reply button is drawn with a quote of what it
 * answers, from the line on screen where a reader holds it and fetched
 * by `history`'s `ids` where it does not.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5845;

const account = (name: string) => `name = "${name}"
password = "pw"
[access]
read_chat = true
send_chat = true
read_chat_history = true
`;

async function logIn(browser: Browser, server: RunningServer, login: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/?server=${encodeURIComponent(server.wsUrl)}`);
  await page.getByLabel('Account').fill(login);
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
  return page;
}

async function say(page: Page, text: string): Promise<void> {
  await page.locator('.composer-input').fill(text);
  await page.locator('.composer-input').press('Enter');
}

async function replyTo(page: Page, text: string, answer: string): Promise<void> {
  const line = page.locator('.transcript .line.chat', { hasText: text });
  await line.hover();
  await line.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.locator('.reply-chip')).toContainText(`Replying to Bob: ${text}`);
  await say(page, answer);
  await expect(page.locator('.reply-chip')).toBeHidden();
}

test.describe('replies against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, {
      sections: `
[history]
db = "server.sqlite"

[limits]
chat_lines = 0
spam_points = 0
ng_requests = 0
`,
      accounts: { alice: account('Alice'), bob: account('Bob'), carol: account('Carol') },
    });
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('a reply quotes the line it answers, held or fetched by id', async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');

    await say(bob, 'lunch?');
    await replyTo(alice, 'lunch?', 'yes, at noon');
    const quote = bob.getByRole('button', { name: 'Replying to Bob: lunch?' });
    await expect(quote).toBeVisible();
    await quote.click();
    await expect(bob.locator('.transcript .line.chat', { hasText: 'lunch?' }).first()).toHaveClass(/flash/);

    // Past the newest page a later reader is handed, so it holds the
    // reply and not what it answers.
    await say(bob, 'dinner?');
    for (let i = 0; i < 55; i++) await say(bob, `filler ${i}`);
    await expect(alice.locator('.transcript .line.chat', { hasText: 'filler 54' })).toBeVisible();
    await replyTo(alice, 'dinner?', 'not tonight');

    const carol = await logIn(browser, server, 'carol');
    await expect(carol.locator('.transcript .line.chat', { hasText: 'not tonight' })).toBeVisible();
    await expect(carol.locator('.transcript .line.chat:not(:has(.quote))', { hasText: 'dinner?' })).toHaveCount(0);
    await expect(carol.getByRole('note', { name: 'Replying to Bob: dinner?' })).toBeVisible();
  });
});
