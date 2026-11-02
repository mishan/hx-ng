/**
 * Reactions, end to end, in real browsers against a real server: one
 * reader's reaction reaching another's chips live and taken away again,
 * a room's kept to the room, a read-only room's refusal said and its
 * offers taken away, the account's cap said before the server is asked,
 * and the picker driven from the keyboard alone.
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5886;

const account = (name: string) => `name = "${name}"
password = "pw"
[access]
read_chat = true
send_chat = true
read_chat_history = true
`;

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

const lineOf = (page: Page, text: string): Locator => page.locator('.transcript .line', { hasText: text }).last();
const chip = (line: Locator, name: string): Locator => line.getByRole('button', { name, exact: true });
const picker = (page: Page): Locator => page.getByRole('dialog', { name: 'Add a reaction' });

/** React to the line saying `text` with the picker's `name`, by pointer. */
async function react(page: Page, text: string, name: string): Promise<void> {
  const line = lineOf(page, text);
  await line.hover();
  await line.getByRole('button', { name: 'React', exact: true }).click();
  await picker(page).getByRole('button', { name, exact: true }).click();
  await expect(picker(page)).toBeHidden();
}

const room = (page: Page, name: string) => page.locator('.rail .rail-item', { hasText: name });

async function join(page: Page, name: string): Promise<void> {
  await room(page, name).click();
  await page.getByRole('button', { name: `Join #${name}` }).click();
  await expect(page.getByRole('button', { name: `Leave #${name}` })).toBeFocused();
}

test.describe('reactions against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, {
      sections: `
[history]
db = "server.sqlite"

[reactions]
enabled = true
max_per_user = 2
burst = 100
read_only_rooms = "deny"

[limits]
chat_lines = 0
spam_points = 0
ng_requests = 0
`,
      files: {
        'rooms.toml': `
[[room]]
name = "lounge"

[[room]]
name = "notices"
post = ["carol"]
`,
      },
      accounts: { alice: account('Alice'), bob: account('Bob'), carol: account('Carol') },
    });
  });

  test.afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('a reaction reaches another reader live, toggled on and off from its chip', async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');
    await say(bob, 'lunch?');
    await expect(lineOf(alice, 'lunch?')).toBeVisible();

    await react(alice, 'lunch?', 'thumbs up');
    const own = chip(lineOf(alice, 'lunch?'), 'thumbs up, 1, including you');
    await expect(own).toHaveAttribute('aria-pressed', 'true');
    await expect(own).toHaveAttribute('data-who', 'You');
    const theirs = chip(lineOf(bob, 'lunch?'), 'thumbs up, 1');
    await expect(theirs).toHaveAttribute('aria-pressed', 'false');
    await expect(theirs).toHaveAttribute('data-who', '1 person');

    await theirs.click();
    await expect(chip(lineOf(bob, 'lunch?'), 'thumbs up, 2, including you')).toHaveAttribute('data-who', 'You and 1 other');
    await expect(chip(lineOf(alice, 'lunch?'), 'thumbs up, 2, including you')).toBeVisible();

    await chip(lineOf(alice, 'lunch?'), 'thumbs up, 2, including you').click();
    await expect(chip(lineOf(alice, 'lunch?'), 'thumbs up, 1')).toHaveAttribute('aria-pressed', 'false');
    await expect(chip(lineOf(bob, 'lunch?'), 'thumbs up, 1, including you')).toBeVisible();
    await chip(lineOf(bob, 'lunch?'), 'thumbs up, 1, including you').click();
    await expect(lineOf(alice, 'lunch?').locator('.reaction')).toHaveCount(0);
    await expect(lineOf(bob, 'lunch?').locator('.reaction')).toHaveCount(0);

    // A later reader is handed what is on the line by history.
    await react(bob, 'lunch?', 'red heart');
    const carol = await logIn(browser, server, 'carol');
    await expect(chip(lineOf(carol, 'lunch?'), 'red heart, 1')).toBeVisible();
  });

  test("a room's reaction stays in the room, and a read-only room's refusal takes the offers away", async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');
    await join(alice, 'lounge');
    await join(bob, 'lounge');
    await say(bob, 'in the lounge');
    await react(alice, 'in the lounge', 'party popper');
    await expect(chip(lineOf(bob, 'in the lounge'), 'party popper, 1')).toBeVisible();

    await bob.locator('.rail .rail-item', { hasText: 'Lobby' }).click();
    await expect(bob.locator('.transcript')).not.toContainText('in the lounge');
    await expect(bob.getByRole('button', { name: /^party popper/ })).toHaveCount(0);

    const carol = await logIn(browser, server, 'carol');
    await join(carol, 'notices');
    await say(carol, 'read this');
    await join(alice, 'notices');
    // Offered, since a server may allow it, and refused by this one.
    await react(alice, 'read this', 'thumbs up');
    const notice = lineOf(alice, 'read this');
    await expect(notice.locator('.reaction-note')).toHaveText('You may not react here.');
    await expect(alice.locator('.app [role="log"]')).toContainText('You may not react here.');
    await expect(notice).toBeFocused();
    await notice.hover();
    await expect(notice.getByRole('button', { name: 'React', exact: true })).toHaveCount(0);
  });

  test('the picker works from the keyboard, and says what the cap leaves', async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');
    await say(bob, 'shipped it');
    await expect(lineOf(alice, 'shipped it')).toBeVisible();

    const line = lineOf(alice, 'shipped it');
    await line.getByRole('button', { name: 'React', exact: true }).focus();
    await alice.keyboard.press('Enter');
    await expect(picker(alice).getByRole('searchbox', { name: 'Search emoji' })).toBeFocused();
    await alice.keyboard.type('tada');
    await alice.keyboard.press('Enter');
    await expect(picker(alice)).toBeHidden();
    await expect(line.getByRole('button', { name: 'React', exact: true })).toBeFocused();
    await expect(chip(line, 'party popper, 1, including you')).toBeVisible();

    // Escape leaves it, whatever was typed, and the focus where it was.
    await alice.keyboard.press('Enter');
    await alice.keyboard.type('hea');
    await alice.keyboard.press('Escape');
    await expect(picker(alice)).toBeHidden();
    await expect(line.getByRole('button', { name: 'React', exact: true })).toBeFocused();

    // Into the grid and along it: the second of the frequent ones.
    await alice.keyboard.press('Enter');
    await alice.keyboard.press('ArrowDown');
    await alice.keyboard.press('ArrowRight');
    await expect(picker(alice).getByRole('button', { name: 'red heart', exact: true })).toBeFocused();
    await alice.keyboard.press('Enter');
    await expect(chip(line, 'red heart, 1, including you')).toBeVisible();
    await expect(chip(lineOf(bob, 'shipped it'), 'red heart, 1')).toBeVisible();

    // At the account's cap a new key is refused here, and said.
    await alice.keyboard.press('Enter');
    await expect(picker(alice).getByRole('status')).toContainText('as many reactions on this line as you may (2)');
    await alice.keyboard.type('fire');
    await alice.keyboard.press('Enter');
    await expect(line.locator('.reaction-note')).toContainText('as many reactions on this line as you may (2)');
    await expect(line.locator('.reaction')).toHaveCount(2);

    // A chip toggles from the keyboard too, and keeps the focus.
    const heart = chip(line, 'red heart, 1, including you');
    await heart.focus();
    await alice.keyboard.press('Enter');
    await expect(chip(line, 'party popper, 1, including you')).toBeFocused();
    await expect(chip(lineOf(bob, 'shipped it'), 'party popper, 1')).toBeVisible();
    await expect(lineOf(bob, 'shipped it').locator('.reaction')).toHaveCount(1);

    // One already held, chosen in the picker, is taken away; with the
    // last chip gone, the focus is on the React button.
    await line.getByRole('button', { name: 'React', exact: true }).focus();
    await alice.keyboard.press('Enter');
    await expect(picker(alice).getByRole('button', { name: 'party popper, yours', exact: true })).toBeVisible();
    await alice.keyboard.type('tada');
    await alice.keyboard.press('Enter');
    await expect(line.locator('.reaction')).toHaveCount(0);
    await react(alice, 'shipped it', 'party popper');
    await chip(line, 'party popper, 1, including you').focus();
    await alice.keyboard.press('Enter');
    await expect(line.locator('.reaction')).toHaveCount(0);
    await expect(line.getByRole('button', { name: 'React', exact: true })).toBeFocused();
  });
});
