/**
 * The account editor, end to end, in real browsers against a real
 * server: an administrator makes an account, its owner logs in, the
 * administrator takes a privilege away and the owner's next attempt is
 * refused, and deleting the account disconnects them. An editor who
 * holds less than an account is shown it and not offered a change.
 *
 * The unit tests cover what an edit sends. What only this can show is
 * the round trip: the server's answer to each frame, and a change
 * reaching the owner's session while it is logged in.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5760;

const USERS = 'read_users = true\ncreate_users = true\nmodify_users = true\ndelete_users = true\n';

const account = (name: string, access = '') => `name = "${name}"
password = "pw"
[access]
read_chat = true
send_chat = true
${access}`;

async function logIn(browser: Browser, server: RunningServer, login: string, password = 'pw'): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/?server=${encodeURIComponent(server.wsUrl)}`);
  await page.getByLabel('Account').fill(login);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
  return page;
}

async function say(page: Page, text: string): Promise<void> {
  await page.locator('.composer-input').fill(text);
  await page.locator('.composer-input').press('Enter');
}

test.describe('account administration against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, {
      accounts: {
        admin: account('Admin', `${USERS}disconnect_users = true\n`),
        // Edits users, but may not disconnect them: outranked by admin.
        deputy: account('Deputy', USERS),
        plain: account('Plain'),
        // May make accounts and nothing else: no list to read.
        maker: account('Maker', 'create_users = true\n'),
        // May read accounts, until an administrator says otherwise.
        clerk: account('Clerk', 'read_users = true\n'),
        // Held to no flood limit, which nothing in its bits says.
        bot: account('Bot', '[extra]\ncan_spam = true\n'),
      },
    });
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('an account is made, curbed while its owner is on, and deleted', async ({ browser }) => {
    const admin = await logIn(browser, server, 'admin');
    const plain = await logIn(browser, server, 'plain');
    await expect(plain.locator('.rail-item', { hasText: 'Accounts' })).toHaveCount(0);

    await admin.locator('.rail-item', { hasText: 'Accounts' }).click();
    const view = admin.locator('.accounts-view');
    await expect(view.locator('.accounts-row', { hasText: 'plain' })).toBeVisible();

    // --- make one ---------------------------------------------------------
    await view.getByRole('button', { name: 'New account' }).click();
    const editor = view.locator('.accounts-editor');
    await editor.getByRole('textbox', { name: 'Login' }).fill('carol');
    await editor.getByRole('textbox', { name: 'Name' }).fill('Carol');
    await editor.getByLabel('Password').fill('secret');
    await editor.getByLabel('Read chat', { exact: true }).check();
    await editor.getByLabel('Send chat').check();
    await editor.getByRole('button', { name: 'Make account' }).click();
    await expect(view.locator('.mod-notice')).toHaveText('Made carol.');
    await expect(view.locator('.accounts-row', { hasText: 'carol' })).toBeVisible();

    // --- its owner logs in, and loses a privilege while there --------------
    const carol = await logIn(browser, server, 'carol', 'secret');
    await say(carol, 'hello');
    await expect(carol.locator('.transcript .line.chat', { hasText: 'hello' })).toBeVisible();

    await editor.getByLabel('Send chat').uncheck();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(view.locator('.mod-notice')).toHaveText('Saved carol.');
    await say(carol, 'still here?');
    await expect(carol.locator('.line', { hasText: 'You do not have permission to do that.' }).first()).toBeVisible();

    // --- and is disconnected when it is deleted ----------------------------
    await editor.getByRole('button', { name: 'Delete' }).click();
    await admin.locator('dialog.ask').getByRole('button', { name: 'Delete' }).click();
    await expect(view.locator('.mod-notice')).toHaveText('Deleted carol.');
    await expect(view.locator('.accounts-row', { hasText: 'carol' })).toHaveCount(0);
    await expect(carol.locator('.line', { hasText: 'disconnected by an administrator' }).first()).toBeVisible();
  });

  test('an editor is shown an account above them, and not offered a change', async ({ browser }) => {
    const deputy = await logIn(browser, server, 'deputy');
    await deputy.locator('.rail-item', { hasText: 'Accounts' }).click();
    const view = deputy.locator('.accounts-view');
    await view.locator('.accounts-row', { hasText: 'admin' }).click();
    const editor = view.locator('.accounts-editor');
    await expect(editor).toContainText('This account holds privileges you do not');
    await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(editor.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // One below it may be changed, but not given what it does not hold.
    await view.locator('.accounts-row', { hasText: 'plain' }).click();
    await expect(editor.getByLabel('Disconnect users')).toBeDisabled();
    await expect(editor.getByLabel('Send chat')).toBeEnabled();
  });

  test('what the bits cannot say: making without reading, history, settings, and losing the pane', async ({ browser }) => {
    // A session that may make accounts and not read them sees what it made.
    const maker = await logIn(browser, server, 'maker');
    await maker.locator('.rail-item', { hasText: 'Accounts' }).click();
    const makerView = maker.locator('.accounts-view');
    await makerView.getByRole('button', { name: 'New account' }).click();
    await makerView.getByRole('textbox', { name: 'Login' }).fill('made');
    await makerView.getByRole('button', { name: 'Make account' }).click();
    await expect(makerView.locator('.mod-notice')).toHaveText('Made made.');
    await expect(makerView.locator('.mod-error')).toHaveCount(0);

    // Chat history goes with reading chat unless set apart.
    const admin = await logIn(browser, server, 'admin');
    await admin.locator('.rail-item', { hasText: 'Accounts' }).click();
    const view = admin.locator('.accounts-view');
    await view.getByRole('button', { name: 'New account' }).click();
    const editor = view.locator('.accounts-editor');
    await editor.getByLabel('Read chat', { exact: true }).check();
    await expect(editor.getByLabel('Read chat history')).toBeChecked();
    await editor.getByLabel('Read chat', { exact: true }).uncheck();
    await expect(editor.getByLabel('Read chat history')).not.toBeChecked();

    // An account above the deputy only by its file's settings is refused,
    // and from then on shown as what it is.
    const deputy = await logIn(browser, server, 'deputy');
    await deputy.locator('.rail-item', { hasText: 'Accounts' }).click();
    const deputyView = deputy.locator('.accounts-view');
    await deputyView.locator('.accounts-row', { hasText: 'bot' }).click();
    await deputyView.getByRole('textbox', { name: 'Name' }).fill('Robot');
    await deputyView.getByRole('button', { name: 'Save' }).click();
    await expect(deputyView.locator('.mod-error')).toContainText('something you may not');
    await expect(deputyView.locator('.accounts-editor')).toContainText('only the operator can see or change');
    await expect(deputyView.getByRole('button', { name: 'Save' })).toBeDisabled();

    // Losing the right to read accounts takes the pane away at once.
    const clerk = await logIn(browser, server, 'clerk');
    await expect(clerk.locator('.rail-item', { hasText: 'Accounts' })).toBeVisible();
    await view.locator('.accounts-row', { hasText: 'clerk' }).click();
    await expect(editor.locator('code')).toHaveText('clerk');
    await editor.getByLabel('Read accounts').uncheck();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(view.locator('.mod-notice')).toHaveText('Saved clerk.');
    await expect(clerk.locator('.rail-item', { hasText: 'Accounts' })).toHaveCount(0);
  });
});
