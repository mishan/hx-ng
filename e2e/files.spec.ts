/**
 * Changing the file area, end to end, against a real server with a
 * writable root: a folder made, a file renamed into it, commented on and
 * the folder deleted with it, and a refusal shown where the change was
 * made. An account that may change nothing is offered nothing.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5780;

const EVERY_CHANGE = [
  'create_folders',
  'delete_files',
  'delete_folders',
  'rename_files',
  'rename_folders',
  'move_files',
  'move_folders',
  'comment_files',
  'comment_folders',
]
  .map((bit) => `${bit} = true\n`)
  .join('');

const account = (name: string, access = '') => `name = "${name}"
password = "pw"
[access]
read_chat = true
${access}`;

async function openFiles(browser: Browser, server: RunningServer, login: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/?server=${encodeURIComponent(server.wsUrl)}`);
  await page.getByLabel('Account').fill(login);
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
  await page.locator('.rail-item', { hasText: 'Files' }).click();
  return page;
}

test.describe('file changes against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, {
      files: { 'files/readme.txt': 'hello' },
      sections: `
[files]
root = "files"
`,
      accounts: {
        editor: account('Editor', EVERY_CHANGE),
        reader: account('Reader'),
      },
    });
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('an account that may change nothing is offered nothing', async ({ browser }) => {
    const page = await openFiles(browser, server, 'reader');
    const view = page.locator('.files-view');
    await expect(view.locator('.file-row', { hasText: 'readme.txt' })).toBeVisible();
    await expect(view.getByRole('button', { name: 'New folder' })).toHaveCount(0);
    await expect(view.locator('.file-more')).toHaveCount(0);
  });

  test('a folder is made, a file moved into it and commented on, and the folder deleted', async ({ browser }) => {
    const page = await openFiles(browser, server, 'editor');
    const view = page.locator('.files-view');
    const dialog = page.locator('dialog.ask');
    const row = (name: string) => view.locator('.file-line', { has: page.locator('.file-name', { hasText: name }) });

    await view.getByRole('button', { name: 'New folder' }).click();
    await dialog.getByLabel('Name').fill('Docs');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(row('Docs')).toBeVisible();

    // Taken: refused, and said so above the listing.
    await view.getByRole('button', { name: 'New folder' }).click();
    await dialog.getByLabel('Name').fill('Docs');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(view.getByRole('alert')).toContainText('already exists');

    await row('readme.txt').locator('.file-more').click();
    await page.getByRole('button', { name: 'Rename or move…' }).click();
    await dialog.getByLabel('New path').fill('Docs/notes.txt');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(row('readme.txt')).toHaveCount(0);

    await row('Docs').locator('.file-row').click();
    await row('notes.txt').locator('.file-more').click();
    await page.getByRole('button', { name: 'Comment…' }).click();
    await dialog.getByLabel('Comment').fill('moved here');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await row('notes.txt').locator('.file-row').click();
    await expect(view.locator('.file-info dd', { hasText: 'moved here' })).toBeVisible();

    await view.locator('.files-link', { hasText: 'Files' }).click();
    await row('Docs').locator('.file-more').click();
    await page.getByRole('button', { name: 'Delete…' }).click();
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(view.getByText('This folder is empty.')).toBeVisible();
  });
});
