/**
 * Uploads against a real server: a file chosen in an upload folder
 * arrives on the server's disk and in the listing, where a folder the
 * account may not upload to offers no Upload at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5835;

test.describe('uploads against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, {
      files: { 'files/Uploads/readme.txt': 'put files here' },
      sections: `
[files]
root = "files"
`,
      accounts: {
        uploader: `name = "Uploader"
password = "pw"
[access]
read_chat = true
download_files = true
upload_files = true
`,
      },
    });
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('a file chosen in an upload folder arrives there', async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    // A distinct hostname makes this a custom-server deployment rather
    // than the dev proxy's default :5700, so the pieces go to the server
    // itself.
    await page.goto(`/?server=${encodeURIComponent(server.wsUrl.replace('127.0.0.1', 'localhost'))}`);
    await page.getByLabel('Account').fill('uploader');
    await page.getByLabel('Password').fill('pw');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('.rail-item', { hasText: 'Files' }).click();
    const view = page.locator('.files-view');
    await expect(view.locator('.file-row', { hasText: 'Uploads' })).toBeVisible();
    // Without upload_anywhere the root takes nothing.
    await expect(view.getByRole('button', { name: 'Upload', exact: true })).toHaveCount(0);

    await view.locator('.file-row', { hasText: 'Uploads' }).click();
    await expect(view.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
    await view.getByRole('button', { name: 'Upload', exact: true }).focus();
    await view.locator('.files-bar input[type=file]').setInputFiles({
      name: 'hello.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello from the browser'),
    });
    await expect(page.locator('.files-transfer')).toHaveText('Uploaded hello.txt.');
    await expect(page.locator('.files-outcome')).toHaveText('Uploaded hello.txt.');
    await expect(view.getByRole('button', { name: 'Upload', exact: true })).toBeFocused();
    await expect(view.locator('.file-row', { hasText: 'hello.txt' })).toBeVisible();
    expect(readFileSync(join(server.hlidDir, 'files/Uploads/hello.txt'), 'utf8')).toBe('hello from the browser');
  });
});
