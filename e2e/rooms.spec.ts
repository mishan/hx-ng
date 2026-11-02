/**
 * Rooms, end to end, in real browsers against a real server: a room
 * listed before it is joined, joined from its bar, talked in by two
 * clients without a word reaching the lobby, counted unread while
 * another conversation is on screen, answered with a reply quoting a
 * line of that room, held or fetched from that room by id, a line there
 * redacted where it sits, and a read-only room's box refusing with why.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5856;

const account = (name: string, extra = '') => `name = "${name}"
password = "pw"
[access]
read_chat = true
send_chat = true
read_chat_history = true
${extra}`;

const contexts: BrowserContext[] = [];

async function logIn(browser: Browser, server: RunningServer, login: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
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

const room = (page: Page, name: string) => page.locator('.rail .rail-item', { hasText: name });

async function join(page: Page, name: string): Promise<void> {
  await room(page, name).click();
  await page.getByRole('button', { name: `Join #${name}` }).click();
  await expect(page.getByRole('button', { name: `Leave #${name}` })).toBeFocused();
}

async function replyTo(page: Page, text: string, answer: string): Promise<void> {
  const line = page.locator('.transcript .line.chat', { hasText: text });
  await line.hover();
  await line.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.locator('.reply-chip')).toContainText(`Replying to Bob: ${text}`);
  await say(page, answer);
}

test.describe('rooms against a real hxd-ng server', () => {
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
      files: {
        'rooms.toml': `
[[room]]
name = "lounge"
topic = "anything goes"

[[room]]
name = "notices"
post = ["carol"]
`,
      },
      accounts: {
        alice: account('Alice'),
        bob: account('Bob'),
        carol: account('Carol'),
        // The kick bit is what makes a moderator.
        mod: account('Mod', 'disconnect_users = true\n'),
      },
    });
  });

  test.afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('a room joined, talked in, counted unread and replied in, apart from the lobby', async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');

    await expect(alice.locator('.rail .rail-head', { hasText: 'Rooms' })).toBeVisible();
    await expect(room(alice, 'lounge')).toHaveClass(/joinable/);
    await room(alice, 'lounge').click();
    await expect(alice.locator('.room-bar')).toContainText('anything goes');
    await expect(alice.locator('.composer-input')).toHaveAttribute('placeholder', 'Join #lounge to talk here.');
    await say(alice, 'not in yet');
    await expect(alice.locator('.line.system').last()).toContainText('Join #lounge to talk here.');

    await join(alice, 'lounge');
    await expect(alice.locator('.room-bar')).toContainText('1 here');
    await join(bob, 'lounge');
    await expect(alice.locator('.room-bar')).toContainText('2 here');
    await say(bob, 'hello room');
    await expect(alice.locator('.transcript .line.chat', { hasText: 'hello room' })).toBeVisible();

    await alice.locator('.rail .rail-item', { hasText: 'Lobby' }).click();
    await expect(alice.locator('.transcript')).not.toContainText('hello room');
    await say(bob, 'are you there?');
    await expect(room(alice, 'lounge').locator('.badge')).toHaveText('1 unread');

    await room(alice, 'lounge').click();
    await expect(room(alice, 'lounge').locator('.badge')).toHaveCount(0);
    await replyTo(alice, 'are you there?', 'yes, here');
    await expect(bob.locator('.transcript .line.chat', { hasText: 'yes, here' })).toBeVisible();
    await expect(bob.getByRole('button', { name: 'Replying to Bob: are you there?' })).toBeVisible();
    await bob.locator('.rail .rail-item', { hasText: 'Lobby' }).click();
    await expect(bob.locator('.transcript')).not.toContainText('yes, here');
  });

  test("a quote of a room's line not held is fetched from that room", async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');
    await join(alice, 'lounge');
    await join(bob, 'lounge');
    // Past the newest page a later reader is handed.
    await say(bob, 'dinner?');
    for (let i = 0; i < 55; i++) await say(bob, `filler ${i}`);
    await expect(alice.locator('.transcript .line.chat', { hasText: 'filler 54' })).toBeVisible();
    await replyTo(alice, 'dinner?', 'not tonight');

    const carol = await logIn(browser, server, 'carol');
    await join(carol, 'lounge');
    await expect(carol.locator('.transcript .line.chat', { hasText: 'not tonight' })).toBeVisible();
    await expect(carol.locator('.transcript .line.chat:not(:has(.quote))', { hasText: 'dinner?' })).toHaveCount(0);
    await expect(carol.getByRole('note', { name: 'Replying to Bob: dinner?' })).toBeVisible();
  });

  test("a room's line redacted is blanked in that room alone", async ({ browser }) => {
    const mod = await logIn(browser, server, 'mod');
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');
    await join(alice, 'lounge');
    await join(bob, 'lounge');
    await join(mod, 'lounge');
    await alice.locator('.rail .rail-item', { hasText: 'Lobby' }).click();
    await say(alice, 'something kind');
    await room(alice, 'lounge').click();
    await say(bob, 'something unkind');

    const line = mod.locator('.transcript .line.chat', { hasText: 'something unkind' });
    await line.hover();
    await line.getByRole('button', { name: 'Redact' }).click();
    await mod.locator('dialog.ask').getByLabel('Reason').fill('Not how we talk here');
    await mod.locator('dialog.ask').getByRole('button', { name: 'Redact' }).click();

    await expect(alice.locator('.transcript .line.chat', { hasText: 'something unkind' })).toHaveCount(0);
    await expect(alice.locator('.transcript .line.deleted')).toHaveCount(1);
    await alice.locator('.rail .rail-item', { hasText: 'Lobby' }).click();
    await expect(alice.locator('.transcript .line.chat', { hasText: 'something kind' })).toBeVisible();
    await expect(alice.locator('.transcript .line.deleted')).toHaveCount(0);
  });

  test('a read-only room is read, and its box says why it takes nothing', async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    await join(alice, 'notices');
    const why = '#notices is read-only: you may read it but not post here.';
    await expect(alice.locator('.composer-input')).toHaveAttribute('placeholder', why);
    await expect(alice.locator('.composer-input')).toHaveAccessibleDescription(why);
    await say(alice, 'hello?');
    await expect(alice.locator('.line.system').last()).toContainText(why);
  });
});
