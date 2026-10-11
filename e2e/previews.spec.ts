/**
 * File previews against a real server: the start of a long text, read
 * as the server decoded it, and a video handed to the browser's player
 * as the file itself.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5820;

/** A WebM's EBML header: what the server knows the container by. */
const WEBM = new Uint8Array(4096);
WEBM.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]);
WEBM.set(new TextEncoder().encode('webm'), 12);

async function openFile(browser: Browser, server: RunningServer, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  // A distinct hostname makes this a custom-server deployment rather
  // than the dev proxy's default :5700, so a preview is fetched from the
  // server itself.
  const customUrl = server.wsUrl.replace('127.0.0.1', 'localhost');
  await page.goto(`/?server=${encodeURIComponent(customUrl)}`);
  await page.getByLabel('Account').fill('viewer');
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
  await page.locator('.rail-item', { hasText: 'Files' }).click();
  await page.locator('.files-view .file-row', { hasText: name }).click();
  return page;
}

test.describe('file previews against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, {
      files: { 'files/long.txt': 'line\r\n'.repeat(50_000), 'files/clip.webm': WEBM },
      sections: `
[files]
root = "files"
`,
      accounts: {
        viewer: `name = "Viewer"
password = "pw"
[access]
read_chat = true
download_files = true
`,
      },
    });
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('a long text previews from its start under its details', async ({ browser }) => {
    const preview = (await openFile(browser, server, 'long.txt')).locator('.file-preview');
    await expect(preview.locator('pre')).toContainText('line');
    await expect(preview.locator('.file-preview-note')).toHaveText(/^Showing the start of this .+ file\.$/);
  });

  test('a video is handed to the player as the file, from the server', async ({ browser }) => {
    const preview = (await openFile(browser, server, 'clip.webm')).locator('.file-preview');
    await expect(preview.locator('video')).toHaveAttribute(
      'src',
      new RegExp(`^http://localhost:${NG_PORT}/files/[A-Za-z0-9_-]+$`),
    );
  });
});
