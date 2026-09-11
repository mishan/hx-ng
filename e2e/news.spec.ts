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
 * that browser is showing rather than raising anything — and that
 * `news_notify`, which is addressed to one account, is what does.
 *
 * Its own port rather than the dev proxy's 5700: news needs no HTTP
 * route, so the page connects to the server directly with `?server=`,
 * and this spec can run beside the identity one without either caring.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, loginNews, startServer, type RunningServer } from './hxd-ng';

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

[news.notify]
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

  test('a followed thread tells its follower about a reply, and seeing it clears the badge', async ({ browser }, testInfo) => {
    // Whether there are subscriptions to test is the server's to say, not
    // the page's: a Follow button that fails to draw is a failure here,
    // never a skip. Absent is a server older than them; anything but true
    // on this config is a server that has them and refused this account.
    const subscribe = (await loginNews(server, 'reader', 'pw'))?.subscribe;
    test.skip(subscribe === undefined, 'this hxd-ng predates news subscriptions');
    expect(subscribe, 'the reader may follow news on this server').toBe(true);

    const editor = await logIn(browser, server, 'editor');
    const reader = await logIn(browser, server, 'reader');

    // A category of its own, so nothing here leans on the other test.
    await openNews(editor);
    await editor.locator('.news-bar').getByRole('button', { name: 'Manage' }).click();
    await editor.getByRole('button', { name: 'New category' }).click();
    await editor.getByPlaceholder('Category name').fill('Releases');
    await editor.getByPlaceholder('Category name').press('Enter');
    await expect(editor.locator('.news-node', { hasText: 'Releases' })).toBeVisible();
    await editor.locator('.news-bar').getByRole('button', { name: 'Manage' }).click();
    await editor.locator('.news-node', { hasText: 'Releases' }).click();
    await editor.getByRole('button', { name: 'New thread' }).click();
    await editor.locator('.news-subject-input').fill('Release notes');
    await editor.locator('.news-body-input').fill('What changed, and why.');
    await editor.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(editor.locator('.news-article').first().locator('.news-subject-line')).toHaveText('Release notes');

    // --- the reader follows it -------------------------------------------
    await openNews(reader);
    await reader.locator('.news-node', { hasText: 'Releases' }).click();
    await reader.locator('.news-thread', { hasText: 'Release notes' }).click();
    await expect(reader.locator('.news-article')).toHaveCount(1);
    const follow = reader.locator('.news-bar').getByRole('button', { name: 'Follow', exact: true });
    await expect(follow).toBeVisible();
    await follow.click();
    await expect(reader.locator('.news-bar').getByRole('button', { name: 'Following', exact: true })).toBeVisible();

    // Back in chat, where a notice has somewhere to land.
    await reader.locator('.rail-item', { hasText: 'Lobby' }).click();
    const newsItem = reader.locator('.rail-item', { hasText: 'News' });
    await expect(newsItem.locator('.badge')).toHaveCount(0);

    // --- the editor answers their own thread -------------------------------
    // Nobody is notified about their own article, so the one bell this
    // rings is the follower's.
    await editor.locator('.news-article').first().getByRole('button', { name: 'Reply' }).click();
    await editor.locator('.news-body-input').fill('One more thing.');
    await editor.getByRole('button', { name: 'Post reply' }).click();
    await expect(editor.locator('.news-article')).toHaveCount(2);
    const replyId = Number((await editor.locator('.news-article').nth(1).locator('.news-id').textContent())!.slice(1));

    await expect(newsItem.locator('.badge')).toHaveText('1');
    const notice = reader.locator('.line.notice a.news-notice');
    await expect(notice).toContainText('posted in “Re: Release notes”');
    await reader.screenshot({ path: testInfo.outputPath('news-notified.png'), fullPage: true });

    // --- following the notice opens the reply, and seeing it is seen -----
    await notice.click();
    await expect(reader.locator('.news')).toBeVisible();
    await expect(reader.locator(`#news-${replyId}`)).toHaveClass(/focus/);
    await expect(newsItem.locator('.badge')).toHaveCount(0);

    // --- and the Following screen lists it, and leads back to it ---------
    await reader.locator('.crumb', { hasText: 'News' }).click();
    await reader.locator('.news-following').click();
    const row = reader.locator('.news-node', { hasText: 'Release notes' });
    await expect(row).toBeVisible();
    await row.click();
    await expect(reader.locator('.news-article')).toHaveCount(2);
  });

  test('markdown is drawn in chat and in an article, and sent as typed', async ({ browser }) => {
    const editor = await logIn(browser, server, 'editor');

    // Chat needs nothing of the server: the wire carries the text as
    // typed, and drawing it is this client's business.
    await editor.locator('.composer-input').fill('**hi** and `code`');
    await editor.locator('.composer-input').press('Enter');
    const said = editor.locator('.line.chat').last();
    await expect(said.locator('strong')).toHaveText('hi');
    await expect(said.locator('code')).toHaveText('code');

    await openNews(editor);
    await editor.locator('.news-bar').getByRole('button', { name: 'Manage' }).click();
    await editor.getByRole('button', { name: 'New category' }).click();
    await editor.getByPlaceholder('Category name').fill('Notes');
    await editor.getByPlaceholder('Category name').press('Enter');
    await expect(editor.locator('.news-node', { hasText: 'Notes' })).toBeVisible();
    await editor.locator('.news-bar').getByRole('button', { name: 'Manage' }).click();
    await editor.locator('.news-node', { hasText: 'Notes' }).click();
    await editor.getByRole('button', { name: 'New thread' }).click();

    // The switch is drawn exactly when the login reply lists
    // `text/markdown`, which a server with `news.markdown = "off"` does not.
    const toggle = editor.locator('.news-md-toggle input');
    test.skip(!(await toggle.isVisible()), 'this server takes plain-text articles only (news.markdown is off, or it predates markdown)');
    await expect(toggle).toBeChecked();

    await editor.locator('.news-subject-input').fill('Formatting');
    await editor.locator('.news-body-input').fill('# Heading\n\nSome **bold**, and `#1` in code.\n\n- one\n- two');
    await editor.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(editor.locator('.news-preview h1')).toHaveText('Heading');
    await editor.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.getByRole('button', { name: 'Post', exact: true }).click();

    const body = editor.locator('.news-article').first().locator('.news-text');
    await expect(body.locator('h1')).toHaveText('Heading');
    await expect(body.locator('strong')).toHaveText('bold');
    await expect(body.locator('li')).toHaveText(['one', 'two']);
    await expect(body.locator('code')).toHaveText('#1');

    // --- a hostile answer, drawn -----------------------------------------
    // The library's tests say what the runs are; only a page shows what
    // they become: which links are elements, what they carry, and what
    // stays text.
    const id = Number((await editor.locator('.news-article').first().locator('.news-id').textContent())!.slice(1));
    await editor.locator('.news-article').first().getByRole('button', { name: 'Reply' }).click();
    await editor.locator('.news-body-input').fill(
      [
        '[click](javascript:alert(1)) and [a `site` here](https://example.com/a) and <https://example.com/b>',
        '',
        '<div>',
        `**not bold** #${id} https://example.com/c`,
        '</div>',
        '',
        `See [the first](news:${id}), ![a picture](news:${id}) and ![pixel](https://tracker.example/p.gif).`,
      ].join('\n'),
    );
    await editor.getByRole('button', { name: 'Post reply' }).click();
    await expect(editor.locator('.news-article')).toHaveCount(2);
    const hostile = editor.locator('.news-article').nth(1).locator('.news-text');

    // A refused scheme is no element at all, just what was typed.
    await expect(hostile).toContainText('[click](javascript:alert(1))');
    await expect(hostile.locator('a[href^="javascript"]')).toHaveCount(0);
    // A real link is one element around its whole label, and opens
    // elsewhere with nothing of this page behind it.
    const site = hostile.locator('a[href="https://example.com/a"]');
    await expect(site).toHaveCount(1);
    await expect(site).toHaveText('a site here');
    await expect(site.locator('code')).toHaveText('site');
    await expect(site).toHaveAttribute('target', '_blank');
    await expect(site).toHaveAttribute('rel', 'noreferrer noopener');
    await expect(hostile.locator('a[href="https://example.com/b"]')).toHaveText('https://example.com/b');
    // An HTML block is text: no emphasis, no reference, not even its URL.
    const block = hostile.locator('.md-html');
    await expect(block).toContainText(`**not bold** #${id} https://example.com/c`);
    await expect(block.locator('strong, a')).toHaveCount(0);
    // References, by link and by image, go to the article; an image by
    // URL is a link to it, and nothing is fetched.
    await expect(hostile.locator('.news-ref')).toHaveText(['the first', 'a picture']);
    await expect(hostile.locator('a[href="https://tracker.example/p.gif"]')).toHaveText('pixel');
    await expect(hostile.locator('img')).toHaveCount(0);
  });

  test("the Markdown switch keeps the reader's place, and a block message is a block on a phone", async ({ browser }) => {
    const editor = await logIn(browser, server, 'editor');
    await editor.setViewportSize({ width: 1000, height: 500 });
    const input = editor.locator('.composer-input');
    for (let k = 0; k < 40; k++) {
      await input.fill(`line ${k} **bold**`);
      await input.press('Enter');
      await expect(editor.locator('.line.chat').last()).toContainText(`line ${k} bold`);
    }

    // Back in the history, which line is at the top of the view and how
    // far into it the view begins.
    const transcript = editor.locator('.transcript');
    const place = () =>
      transcript.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const lines = [...el.children];
        const index = lines.findIndex((c) => c.getBoundingClientRect().bottom > top);
        return { index, offset: lines[index]!.getBoundingClientRect().top - top };
      });
    await transcript.evaluate((el) => (el.scrollTop = (el.scrollHeight - el.clientHeight) / 2));
    const before = await place();
    expect(before.index).toBeGreaterThan(0);

    const toggle = editor.getByRole('button', { name: 'Markdown', exact: true });
    for (const drawn of [0, 40]) {
      await toggle.click();
      await expect(transcript.locator('strong')).toHaveCount(drawn);
      const after = await place();
      expect(after.index).toBe(before.index);
      expect(Math.abs(after.offset - before.offset)).toBeLessThan(2);
    }

    // On a phone the body runs on beside the nick, unless it holds a
    // block, which then starts on a line of its own.
    await editor.setViewportSize({ width: 400, height: 700 });
    await input.fill('> quoted\nand said');
    await input.press('Enter');
    const quoted = editor.locator('.line.chat').last();
    await expect(quoted.locator('div.text > blockquote')).toHaveText('quoted');
    await expect(quoted.locator('.text')).toHaveCSS('display', 'block');
    await expect(editor.locator('.line.chat').nth(-2).locator('.text')).toHaveCSS('display', 'inline');
  });
});
