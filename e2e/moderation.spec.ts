/**
 * Moderation, end to end, in real browsers against a real server: one
 * person says something, another reports it, a moderator sees the report
 * arrive and redacts the line — and every page blanks it where it sits,
 * and the reporter is told how it ended. Then the moderator disconnects
 * the person who said it, from the user list.
 *
 * The unit tests cover the frames and the queue's arithmetic. What only
 * this can show is the round trip through three pages: the report
 * reaching a moderator as an event, the badge that event raises, and
 * `chat_redacted` reaching a line that was already drawn.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5750;

const account = (name: string, access = '') => `name = "${name}"
password = "pw"
[access]
read_chat = true
send_chat = true
${access}`;

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

test.describe('moderation against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, {
      sections: `
[history]
db = "server.sqlite"
`,
      accounts: {
        // The kick bit is what makes a moderator, with nothing else said.
        mod: account('Mod', 'disconnect_users = true\n'),
        alice: account('Alice'),
        bob: account('Bob'),
      },
    });
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('a line is reported, redacted, and its author disconnected', async ({ browser }) => {
    const mod = await logIn(browser, server, 'mod');
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');

    // Only the moderator is offered the reports.
    await expect(mod.locator('.rail-item', { hasText: 'Reports' })).toBeVisible();
    await expect(alice.locator('.rail-item', { hasText: 'Reports' })).toHaveCount(0);

    await say(bob, 'something unkind');
    const line = alice.locator('.transcript .line.chat', { hasText: 'something unkind' });
    await expect(line).toBeVisible();
    // Nobody is offered a report of their own line.
    await expect(bob.locator('.transcript .line.chat', { hasText: 'something unkind' }).locator('button[data-act]')).toHaveCount(0);

    // A keyboard reaches the buttons too: out of sight until then, and
    // not out of the tab order.
    const report = line.getByRole('button', { name: 'Report' });
    await expect(line.locator('.line-actions')).toHaveCSS('opacity', '0');
    await report.focus();
    await expect(line.locator('.line-actions')).toHaveCSS('opacity', '1');
    await report.blur();

    // --- alice reports it ------------------------------------------------
    await line.hover();
    await line.getByRole('button', { name: 'Report' }).click();
    const dialog = alice.locator('dialog.ask');
    await dialog.locator('textarea').fill('Not how we talk here');
    await dialog.getByRole('button', { name: 'Report' }).click();
    await expect(alice.locator('.line.system').last()).toContainText('is with the moderators');

    // --- the moderator hears of it, and redacts the line ------------------
    const reports = mod.locator('.rail-item', { hasText: 'Reports' });
    await expect(reports.locator('.badge')).toHaveText('1');
    await reports.click();
    const card = mod.locator('.mod-report').first();
    await expect(card).toContainText('alice reported a chat line from');
    await expect(card).toContainText('Not how we talk here');
    await expect(card).toContainText('something unkind');
    await card.getByRole('button', { name: 'Redact the line' }).click();
    await mod.locator('dialog.ask').getByRole('button', { name: 'Redact' }).click();

    // Every page blanks it where it was drawn.
    for (const page of [alice, bob]) {
      await expect(page.locator('.transcript .line.chat', { hasText: 'something unkind' })).toHaveCount(0);
      await expect(page.locator('.transcript .line.deleted')).toHaveCount(1);
    }
    // The report closed itself, and the reporter was told.
    await expect(reports.locator('.badge')).toHaveCount(0);
    await expect(mod.locator('.mod-report')).toHaveCount(0);
    await expect(alice.locator('.line.system', { hasText: 'was acted on' })).toBeVisible();

    // The act is on the record, with the words it took.
    await mod.locator('.mod-head').getByRole('button', { name: 'Log' }).click();
    await expect(mod.locator('.mod-act').first()).toContainText('mod redacted line');
    await expect(mod.locator('.mod-act').first()).toContainText('something unkind');

    // --- and disconnects bob from the user list ---------------------------
    await mod.locator('.rail-item', { hasText: 'Lobby' }).click();
    await mod.locator('.person', { hasText: 'Bob' }).locator('.person-more').click();
    await mod.locator('dialog.ask').getByRole('button', { name: 'Disconnect…' }).click();
    await mod.locator('dialog.ask').getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(bob.locator('.line', { hasText: 'disconnected by an administrator' }).first()).toBeVisible();
    await expect(alice.locator('.person', { hasText: 'Bob' })).toHaveCount(0);
  });
});
