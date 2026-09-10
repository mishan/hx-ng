/**
 * News, end to end, in a real browser against a real server: build a
 * category, start a thread, answer it with a reference, follow the
 * reference — and watch a second reader's view refresh on its own when
 * the first one posts.
 *
 * The unit tests cover the library's frames and the reader's pure
 * decisions. What only this can show is the view itself: that the
 * breadcrumb, the compose forms and the thread's indentation work in a
 * page, and that `news_posted` reaching another browser refreshes what
 * that browser is showing rather than raising anything.
 *
 * Its own port rather than the dev proxy's 5700: news needs no HTTP
 * route, so the page connects to the server directly with `?server=`,
 * and this spec can run beside the identity one without either caring.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5710;

const account = (name: string, access: string) => `name = "${name}"
password = "pw"
[access]
read_chat = true
send_chat = true
${access}`;

const EDITOR = `read_news = true
post_news = true
delete_articles = true
create_categories = true
delete_categories = true
create_news_bundles = true
delete_news_bundles = true
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

async function openNews(page: Page): Promise<void> {
  await page.locator('.rail-item', { hasText: 'News' }).click();
  await expect(page.locator('.news')).toBeVisible();
  await expect(page.locator('.chat-pane')).toBeHidden();
}

test.describe('news against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, {
      sections: `
[inbox]
db = "server.sqlite"

[news]
max_depth = 4
`,
      accounts: {
        editor: account('Editor', EDITOR),
        reader: account('Reader', 'read_news = true\npost_news = true\n'),
      },
    });
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('a thread is started, answered, cited and followed', async ({ browser }, testInfo) => {
    const editor = await logIn(browser, server, 'editor');
    const reader = await logIn(browser, server, 'reader');
    await openNews(editor);
    await expect(editor.locator('.news-empty')).toHaveText('There is no news here yet.');

    // --- the editor makes a category -------------------------------------
    await editor.locator('.news-bar').getByRole('button', { name: 'Manage' }).click();
    await editor.getByRole('button', { name: 'New category' }).click();
    await editor.getByPlaceholder('Category name').fill('General');
    await editor.getByPlaceholder('Category name').press('Enter');
    await expect(editor.locator('.news-node', { hasText: 'General' })).toBeVisible();
    await editor.locator('.news-bar').getByRole('button', { name: 'Manage' }).click();

    // The reader opens news after the category exists, and goes into it.
    await openNews(reader);
    await reader.locator('.news-node', { hasText: 'General' }).click();
    await expect(reader.locator('.news-empty')).toHaveText('No threads here yet.');

    // --- the editor starts a thread --------------------------------------
    await editor.locator('.news-node', { hasText: 'General' }).click();
    await editor.getByRole('button', { name: 'New thread' }).click();
    await editor.locator('.news-subject-input').fill('Phase 4 is open');
    await editor.locator('.news-body-input').fill('News, finally.\nThreads, references, the lot.');
    await editor.getByRole('button', { name: 'Post', exact: true }).click();
    const starter = editor.locator('.news-article').first();
    await expect(starter.locator('.news-subject-line')).toHaveText('Phase 4 is open');
    const rootId = Number((await starter.locator('.news-id').textContent())!.slice(1));

    // The reader, looking at the category, sees it arrive with nothing
    // clicked: `news_posted` is cache invalidation, and this is the cache.
    await expect(reader.locator('.news-thread-subject')).toHaveText(['Phase 4 is open']);

    // --- the reader answers, citing the starter by number ----------------
    await reader.locator('.news-thread', { hasText: 'Phase 4 is open' }).click();
    await reader.locator('.news-article').first().getByRole('button', { name: 'Reply' }).click();
    await expect(reader.locator('.news-subject-input')).toHaveValue('Re: Phase 4 is open');
    await reader.locator('.news-body-input').fill(`About time. See #${rootId}, and #99999 which is nothing.`);
    await reader.getByRole('button', { name: 'Post reply' }).click();
    await expect(reader.locator('.news-article')).toHaveCount(2);

    // The editor's open thread refreshes on its own too, and the reply
    // sits under the article it answers.
    await expect(editor.locator('.news-article')).toHaveCount(2);
    const reply = editor.locator('.news-article').nth(1);
    await expect(reply).toHaveAttribute('style', /--depth: 1\b/);
    // Only the number the server resolved is a link.
    await expect(reply.locator('.news-ref')).toHaveText([`#${rootId}`]);
    await expect(reply.locator('.news-text')).toContainText('#99999 which is nothing');
    await expect(editor.locator('.news-article').first().getByRole('button', { name: 'Cited by 1' })).toBeVisible();

    await editor.screenshot({ path: testInfo.outputPath('news-thread.png'), fullPage: true });

    // --- following a reference lands on the article it names -------------
    await editor.locator('.crumb', { hasText: 'General' }).click();
    await editor.locator('.news-thread', { hasText: 'Phase 4 is open' }).click();
    await editor.locator('.news-article').nth(1).locator('.news-ref').click();
    await expect(editor.locator(`#news-${rootId}`)).toHaveClass(/focus/);

    // --- searching finds it, marks it, and opens it where it sits --------
    await editor.locator('.crumb', { hasText: 'General' }).click();
    await editor.locator('.news-search').fill('prose finally');
    await editor.locator('.news-search').press('Enter');
    await expect(editor.locator('.news-search-head')).toContainText('Nothing matches');
    await editor.locator('.news-search').fill('finally');
    await editor.locator('.news-search').press('Enter');
    await expect(editor.locator('.news-search-head')).toContainText('1 result for “finally” in “General”');
    await expect(editor.locator('.news-hit mark')).toHaveText(['finally']);
    await editor.screenshot({ path: testInfo.outputPath('news-search.png'), fullPage: true });
    await editor.locator('.news-hit').click();
    await expect(editor.locator(`#news-${rootId}`)).toHaveClass(/focus/);

    // --- and back to chat, where the composer is waiting ------------------
    await editor.locator('.rail-item', { hasText: 'Lobby' }).click();
    await expect(editor.locator('.news')).toBeHidden();
    await expect(editor.locator('.composer-input')).toBeVisible();

    await reader.screenshot({ path: testInfo.outputPath('news-reader.png'), fullPage: true });
  });
});
