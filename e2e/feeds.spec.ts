/**
 * Feed-backed news in a real browser against a real server: a feed the
 * server polls from a local HTTP server, read as a category that shows
 * whose it is, where no thread can be started, and where replying is
 * the feed's to allow.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5770;

const EDITOR = `name = "Editor"
password = "pw"
[access]
read_chat = true
send_chat = true
read_news = true
post_news = true
delete_articles = true
`;

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Mobius</title>
<item><guid>v2</guid><title>Mobius 2.0</title><author>jeff@example.org (Jeff)</author>
<description>&lt;p&gt;Faster.&lt;/p&gt;</description></item>
<item><guid>v1</guid><title>Mobius 1.0</title><author>jeff@example.org (Jeff)</author>
<description>&lt;p&gt;First.&lt;/p&gt;</description></item>
</channel></rss>`;

async function logIn(browser: Browser, server: RunningServer): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/?server=${encodeURIComponent(server.wsUrl)}`);
  await page.getByLabel('Account').fill('editor');
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
  await page.locator('.rail-item', { hasText: 'News' }).click();
  await expect(page.locator('.news')).toBeVisible();
  return page;
}

test.describe('feeds against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let feed: Server;
  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    feed = createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(RSS);
    });
    await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/feed.xml`;
    server = await startServer(NG_PORT, {
      sections: `
[inbox]
db = "server.sqlite"

[news]

[[news.feed]]
name = "mobius"
url = "${url}"
category = "Software/Mobius"

[[news.feed]]
name = "discussed"
url = "${url}"
category = "Discussed"
replies = true
`,
      accounts: { editor: EDITOR },
    });
  });

  test.afterAll(() => {
    server?.stop();
    feed?.close();
  });

  test('a feed category says whose it is, and takes what the feed allows', async ({ browser }) => {
    const page = await logIn(browser, server);
    await page.locator('.news-node', { hasText: 'Software' }).click();
    const category = page.locator('.news-node', { hasText: 'Mobius' });
    await expect(category.locator('.news-feed')).toHaveText('mobius');
    await category.click();

    const newThread = page.getByRole('button', { name: 'New thread' });
    await expect(newThread).toBeDisabled();
    await expect(newThread).toHaveAttribute('title', 'The feed mobius fills this category.');

    await page.locator('.news-thread', { hasText: 'Mobius 2.0' }).click();
    const article = page.locator('.news-article').first();
    await expect(article.locator('.news-author')).toHaveText('Jeff');
    await expect(article.locator('.news-feed')).toHaveText('mobius');
    await expect(article.getByRole('button', { name: 'Reply' })).toHaveCount(0);

    await page.locator('.news-bar').getByRole('button', { name: 'News' }).click();
    await page.locator('.news-node', { hasText: 'Discussed' }).click();
    await expect(page.getByRole('button', { name: 'New thread' })).toBeDisabled();
    await page.locator('.news-thread', { hasText: 'Mobius 2.0' }).click();
    await expect(page.locator('.news-article').first().getByRole('button', { name: 'Reply' })).toBeVisible();
  });
});
