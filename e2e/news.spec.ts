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
 * Its own port rather than the dev proxy's 5700: the page connects to
 * the server directly with `?server=`, including the authenticated
 * attachment HTTP route.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, loginNews, openAccount, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5710;

const account = (name: string, access: string) => `name = "${name}"
password = "pw"
[access]
read_chat = true
send_chat = true
${access}`;

const EDITOR = `read_news = true
post_news = true
send_media = true
delete_articles = true
create_categories = true
delete_categories = true
create_news_bundles = true
delete_news_bundles = true
`;

/** `noTimeline` plays a server older than the timeline: the socket is
 *  the real server's, but `news_timeline` is answered as it would not
 *  know it. `slowTimeline` holds the server's answers to it back a
 *  while, as a busy server would. `noSubs` has `news_subs` refused, as
 *  a failing store would. `sent` collects the frames the page sends. */
async function logIn(
  browser: Browser,
  server: RunningServer,
  login: string,
  opts: { noTimeline?: boolean; slowTimeline?: boolean; noSubs?: boolean; sent?: Record<string, unknown>[] } = {},
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  if (opts.noTimeline || opts.slowTimeline || opts.noSubs) {
    await page.routeWebSocket(/\/ng/, (ws) => {
      const real = ws.connectToServer();
      const slow = new Set<number>();
      ws.onMessage((m) => {
        const frame = JSON.parse(String(m)) as { id?: number; req?: string };
        if (opts.noSubs && frame.req === 'news_subs') {
          return ws.send(JSON.stringify({ reply: frame.id, error: { code: 'store_failed', text: 'The store failed.' } }));
        }
        if (frame.req !== 'news_timeline' || !(opts.noTimeline || opts.slowTimeline)) return real.send(m);
        if (opts.slowTimeline) {
          slow.add(frame.id!);
          return real.send(m);
        }
        ws.send(JSON.stringify({ reply: frame.id, error: { code: 'unknown_method', text: 'Unknown request.' } }));
      });
      real.onMessage((m) => {
        const frame = JSON.parse(String(m)) as { reply?: number };
        if (frame.reply !== undefined && slow.delete(frame.reply)) setTimeout(() => ws.send(m), 400);
        else ws.send(m);
      });
    });
  }
  const sent = opts.sent;
  if (sent) page.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(JSON.parse(String(f.payload)))));
  // A distinct hostname makes this a custom-server deployment rather
  // than the dev proxy's default :5700, so its HTTP attachment route is
  // exercised directly (and through hxd-ng's CORS policy).
  const customUrl = server.wsUrl.replace('127.0.0.1', 'localhost');
  await page.goto(`/?server=${encodeURIComponent(customUrl)}`);
  await page.getByLabel('Account').fill(login);
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
  return page;
}

/** Does the server answer the timeline? Only `unknown_method` says no:
 *  any other refusal is a failure, not a server too old to test. */
async function hasTimeline(session: { ask: (req: string) => Promise<unknown> }): Promise<boolean> {
  return session.ask('news_timeline').then(
    () => true,
    (e: Error) => {
      if (/unknown_method/.test(e.message)) return false;
      throw e;
    },
  );
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

[news.attach]

[news.notify]

# The markdown test chats a screenful of lines, faster than anyone may.
[limits]
chat_lines = 0
spam_points = 0
ng_requests = 0
# The timeline test starts more threads than a page holds.
news_posts = 0
`,
      accounts: {
        editor: account('Editor', EDITOR),
        reader: account('Reader', 'read_news = true\npost_news = true\nsend_media = true\n'),
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
    await editor.locator('.news-compose input[type="file"]').setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await expect(editor.locator('.news-attachment-chip')).toContainText('pixel.png');
    await editor.getByRole('button', { name: 'Post', exact: true }).click();
    const starter = editor.locator('.news-article').first();
    await expect(starter.locator('.news-subject-line')).toHaveText('Phase 4 is open');
    const rootId = Number((await starter.locator('.news-id').textContent())!.slice(1));

    // The reader, looking at the category, sees it arrive with nothing
    // clicked: `news_posted` is cache invalidation, and this is the cache.
    await expect(reader.locator('.news-thread-subject')).toHaveText(['Phase 4 is open']);

    // --- the reader answers, citing the starter by number ----------------
    await reader.locator('.news-thread', { hasText: 'Phase 4 is open' }).click();
    await expect(reader.locator('.news-attachment')).toBeVisible();
    await expect
      .poll(() => reader.locator('.news-attachment').evaluate((img) => (img as { naturalWidth: number }).naturalWidth))
      .toBe(1);
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

    await expect(newsItem.locator('.badge')).toHaveText('1 unread');
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

  test('the timeline merges what is followed, keeps itself current, and marks seen only what was shown', async ({
    browser,
  }, testInfo) => {
    // The reader's other device: where it follows, and where the test
    // asks what the server holds, one session for the whole of it.
    const reader = await openAccount(server, 'reader', 'pw');
    const editor = await openAccount(server, 'editor', 'pw');
    try {
      /** The reader's timeline threads the server holds unread, by subject. */
      const unread = async () => {
        const out: string[] = [];
        let before: number | undefined;
        for (;;) {
          const ok = (await reader.ask('news_timeline', before === undefined ? { limit: 200 } : { before, limit: 200 })) as {
            threads: { article: { id: number; subject: string }; unread: boolean }[];
            has_more: boolean;
          };
          out.push(...ok.threads.filter((t) => t.unread).map((t) => t.article.subject));
          if (!ok.has_more) return out;
          before = ok.threads.at(-1)!.article.id;
        }
      };
      test.skip(!(await hasTimeline(reader)), 'this hxd-ng predates the news timeline');

      // The page logs in first, so the follows below are made where it
      // hears nothing of them: on another device, as far as it knows.
      const sent: Record<string, unknown>[] = [];
      const page = await logIn(browser, server, 'reader', { sent });
      const seenSent = () => sent.filter((f) => f.req === 'news_seen').map((f) => f.params as Record<string, unknown>);
      const category = async (name: string) =>
        ((await editor.ask('news_node_create', { kind: 'category', name })) as { node: { id: number } }).node.id;
      const [north, south, elsewhere] = [await category('North'), await category('South'), await category('Elsewhere')];
      await reader.ask('news_subscribe', { category: north });
      await reader.ask('news_subscribe', { category: south });
      // More than a page, across both followed categories and one that is not.
      const threads: { id: number; subject: string }[] = [];
      for (let i = 1; i <= 72; i++) {
        const [category, name] = i % 4 === 0 ? [elsewhere, 'Elsewhere'] : i % 2 ? [north, 'North'] : [south, 'South'];
        const subject = `${name} ${i}`;
        const ok = (await editor.ask('news_post', { category, subject, body: `Thread ${i}.` })) as { id: number };
        threads.push({ id: ok.id, subject });
      }
      const followed = threads.filter((t) => !t.subject.startsWith('Elsewhere')).reverse();
      const subjects = followed.map((t) => t.subject);
      expect(await unread()).toEqual(subjects);

      // --- opened, it is newest first across both, a page at a time ---------
      // Short, so a page of threads is several screens of them.
      await page.setViewportSize({ width: 1000, height: 500 });
      await openNews(page);
      await page.locator('.news-timeline').click();
      const rows = page.locator('.news .news-thread');
      await expect(rows).toHaveCount(50);
      await expect(rows.locator('.news-thread-subject')).toHaveText(subjects.slice(0, 50));
      await expect(rows.locator('.news-thread-category')).toHaveText(subjects.slice(0, 50).map((t) => t.split(' ')[0]!));
      await expect(rows.locator('.news-new')).toHaveCount(50);

      // The screenful shown is claimed, from its oldest thread to its
      // newest. Every category has an unread thread below it, so the
      // server moves no cursor past one never shown, and nothing is seen.
      await expect.poll(() => seenSent().length).toBe(1);
      const [first] = seenSent();
      expect(first).toMatchObject({ timeline: true, up_to: followed[0]!.id });
      expect(first!.from).toBeLessThan(followed[0]!.id);
      expect(first!.from).toBeGreaterThan(followed[49]!.id);
      await page.waitForTimeout(300);
      expect(await unread()).toEqual(subjects);

      // A row only peeking in at the foot has not been shown: scrolled so
      // the next one shows a fifth of itself, the run claimed stops above it.
      const peeking = await page.locator('.news-body').evaluate((pane) => {
        const foot = pane.getBoundingClientRect().bottom;
        const rows = [...pane.querySelectorAll('.news-thread')];
        const next = rows.find((r) => r.getBoundingClientRect().top >= foot)!;
        const r = next.getBoundingClientRect();
        pane.scrollTop += r.top + r.height * 0.2 - foot;
        return Number(next.getAttribute('data-root'));
      });
      // Rows are watched afresh on every draw, and the draw after this
      // claim's answer reports the peeking one as on screen at all.
      await expect.poll(() => seenSent().length).toBeGreaterThanOrEqual(2);
      await page.waitForTimeout(1000);
      expect(seenSent().map((f) => f.from as number).filter((from) => from <= peeking)).toEqual([]);

      // --- the rest paged in, and a jump to the bottom ------------------------
      await page.getByRole('button', { name: 'Older threads' }).click();
      await expect(rows).toHaveCount(followed.length);
      await expect(page.getByRole('button', { name: 'Older threads' })).toHaveCount(0);
      await rows.last().scrollIntoViewIfNeeded();
      // The end of the timeline is claimed from 0, and is seen; the middle,
      // skipped, is not, nor the top above it.
      await expect.poll(() => seenSent().at(-1)?.from).toBe(0);
      await expect.poll(async () => (await unread()).includes(subjects.at(-1)!)).toBe(false);
      const skipped = await unread();
      expect(skipped).toContain(subjects[0]);
      expect(skipped).toContain(subjects[25]);

      // --- scrolled back up through it, the whole timeline is seen -----------
      for (let i = 0; i < 60 && !(await rows.first().isVisible() && (await page.locator('.news-body').evaluate((el) => el.scrollTop)) === 0); i++) {
        await page.mouse.move(200, 400);
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(100);
      }
      await expect.poll(unread).toEqual([]);
      expect(seenSent().at(-1)).toEqual({ timeline: true, from: 0, up_to: followed[0]!.id });

      // --- live: a new thread lands on top, a reply in its own row -----------
      await editor.ask('news_post', { category: elsewhere, subject: 'Elsewhere late', body: 'Not followed.' });
      await editor.ask('news_post', { category: north, subject: 'North late', body: 'Just now.' });
      await editor.ask('news_post', {
        category: subjects[3]!.startsWith('North') ? north : south,
        parent: followed[3]!.id,
        subject: `Re: ${subjects[3]}`,
        body: 'An answer.',
      });
      await expect(rows).toHaveCount(followed.length + 1);
      await expect(rows.first().locator('.news-thread-subject')).toHaveText('North late');
      await expect(rows.first().locator('.news-new')).toBeVisible();
      await expect(rows.nth(4)).toContainText(subjects[3]!);
      await expect(rows.nth(4)).toContainText('1 reply');
      await expect(page.locator('.news .news-thread', { hasText: 'Elsewhere' })).toHaveCount(0);
      // Shown on top, it is seen too.
      await expect.poll(unread).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('news-timeline.png') });

      // --- and a row opens its thread, in its own category -------------------
      await rows.nth(4).click();
      await expect(page.locator('.news-article')).toHaveCount(2);
      await expect(page.locator('.crumb', { hasText: new RegExp(`^${subjects[3]!.split(' ')[0]}$`) })).toBeVisible();

      // --- deletions, and what changed while the view was away ---------------
      const subjectRow = (subject: string) => rows.locator('.news-thread-subject', { hasText: new RegExp(`^${subject}$`) });
      await page.locator('.crumb', { hasText: /^News$/ }).click();
      await page.locator('.news-timeline').click();
      // Opened afresh, a page again.
      await expect(rows).toHaveCount(50);
      // A starter with no replies leaves; one with a live reply stays, a
      // tombstone, where it was.
      await editor.ask('news_delete', { id: followed[5]!.id });
      await editor.ask('news_delete', { id: followed[3]!.id });
      await expect(rows).toHaveCount(49);
      await expect(subjectRow(subjects[5]!)).toHaveCount(0);
      await expect(rows.nth(4).locator('.news-thread-subject')).toHaveText('Deleted article');
      // Away in chat while a thread is started and another deleted: it is
      // all there on coming back.
      await page.locator('.rail-item', { hasText: 'Lobby' }).click();
      await expect(page.locator('.news')).toBeHidden();
      await editor.ask('news_post', { category: south, subject: 'South while away', body: 'Missed it.' });
      await editor.ask('news_delete', { id: followed[6]!.id });
      await openNews(page);
      await expect(rows.first().locator('.news-thread-subject')).toHaveText('South while away');
      await expect(subjectRow(subjects[6]!)).toHaveCount(0);
      // Reread as deep as it was paged, the new thread on top.
      await expect(rows).toHaveCount(49);
      // A followed category deleted takes its threads with it.
      await editor.ask('news_node_delete', { id: south });
      await expect(rows.locator('.news-thread-category', { hasText: 'North' })).not.toHaveCount(0);
      await expect(rows.locator('.news-thread-category', { hasText: 'South' })).toHaveCount(0);
    } finally {
      await Promise.all([reader.close(), editor.close()]);
    }
  });

  test('an empty timeline says why, asking again what is followed, and a server without it has it hidden', async ({
    browser,
  }) => {
    const probe = await openAccount(server, 'editor', 'pw');
    const supported = await hasTimeline(probe).finally(() => probe.close());
    test.skip(!supported, 'this hxd-ng predates the news timeline');
    const page = await logIn(browser, server, 'editor', { slowTimeline: true });
    await openNews(page);
    await page.locator('.news-timeline').click();
    // The editor follows no category in this file: an empty timeline,
    // said as such rather than as a server that has none.
    await expect(page.locator('.news-empty')).toHaveText(/^You follow no categories yet\./);
    // Followed from another device, which tells this page nothing: the
    // timeline asks again when it is opened.
    const other = await openAccount(server, 'editor', 'pw');
    let quiet: number;
    try {
      quiet = ((await other.ask('news_node_create', { kind: 'category', name: 'Quiet' })) as { node: { id: number } }).node.id;
      await other.ask('news_subscribe', { category: quiet });
    } finally {
      await other.close();
    }
    await page.locator('.crumb', { hasText: 'News' }).click();
    await page.locator('.news-timeline').click();
    await expect(page.locator('.news-empty')).toHaveText('Nothing has been started in the categories you follow yet.');
    // Not knowing what is followed is not following nothing.
    const unsure = await logIn(browser, server, 'editor', { noSubs: true });
    await openNews(unsure);
    await unsure.locator('.news-timeline').click();
    await expect(unsure.locator('.news-empty')).toHaveText('Nothing has been started in the categories you follow yet.');
    // Threads started into it as it stands empty, the second while the
    // first is still being read in, and a reply after.
    const poster = await openAccount(server, 'editor', 'pw');
    try {
      const first = (await poster.ask('news_post', { category: quiet, subject: 'Quiet one', body: '1' })) as { id: number };
      await page.waitForTimeout(300);
      await poster.ask('news_post', { category: quiet, subject: 'Quiet two', body: '2' });
      await expect(page.locator('.news .news-thread-subject')).toHaveText(['Quiet two', 'Quiet one']);
      await poster.ask('news_post', { category: quiet, parent: first.id, subject: 'Re: Quiet one', body: 'r' });
      await expect(page.locator('.news .news-thread').nth(1)).toContainText('1 reply');
      // Opened again, and a thread started and a starter deleted while its
      // first page is still out: both are there once it lands, the
      // deleted one a tombstone for its live reply.
      await page.locator('.crumb', { hasText: /^News$/ }).click();
      await page.locator('.news-timeline').click();
      await poster.ask('news_post', { category: quiet, subject: 'Quiet three', body: '3' });
      await poster.ask('news_delete', { id: first.id });
      await expect(page.locator('.news .news-thread-subject')).toHaveText(['Quiet three', 'Quiet two', 'Deleted article']);
      await poster.ask('news_post', { category: quiet, subject: 'Quiet four', body: '4' });
      await expect(page.locator('.news .news-thread-subject')).toHaveText(['Quiet four', 'Quiet three', 'Quiet two', 'Deleted article']);
    } finally {
      await poster.close();
    }

    // An older server, played by this one with the timeline refused: the
    // rest of the session is the real server's.
    const older = await logIn(browser, server, 'editor', { noTimeline: true });
    await openNews(older);
    await older.locator('.news-timeline').click();
    await expect(older.locator('.news-notice')).toHaveText('This server keeps no timeline.');
    await expect(older.locator('.news-timeline')).toHaveCount(0);
    await expect(older.locator('.news-following')).toBeVisible();
    await expect(older.locator('.crumb.current')).toHaveText('News');
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
    await editor
      .locator('.news-body-input')
      .fill(`# Heading\n\nSome **bold**, and \`#1\` in code.\n\n- one\n- two\n\n\`\`\`\n${'wide '.repeat(80)}\n\`\`\``);
    await editor.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(editor.locator('.news-preview').getByRole('heading', { name: 'Heading', level: 3 })).toBeVisible();
    await editor.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.getByRole('button', { name: 'Post', exact: true }).click();

    const body = editor.locator('.news-article').first().locator('.news-text');
    await expect(body.getByRole('heading', { name: 'Heading', level: 3 })).toBeVisible();
    await expect(body.locator('strong')).toHaveText('bold');
    await expect(body.locator('li')).toHaveText(['one', 'two']);
    await expect(body.locator('p code')).toHaveText('#1');
    // Wider than the column, the block scrolls, and a keyboard can reach it.
    await expect(body.getByRole('region', { name: 'Code' })).toHaveAttribute('tabindex', '0');

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

  test("the markdown setting keeps the reader's place, and a block message is a block on a phone", async ({ browser }) => {
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

    for (const drawn of [0, 40]) {
      await editor.getByRole('button', { name: 'Settings' }).click();
      await editor.getByRole('checkbox', { name: /Render markdown/ }).click();
      await editor.keyboard.press('Escape');
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
