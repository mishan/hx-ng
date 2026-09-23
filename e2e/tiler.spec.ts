/**
 * The tiled shell, in a real browser against a real server: the shell
 * laid out by mullion, the three views that used to take turns in one
 * space switching as tabs of one leaf, and a narrow window proving the
 * shell comes back.
 */

import { expect, test, type Page } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5730;

const WIDE = { width: 1500, height: 900 };
const NARROW = { width: 560, height: 900 };

let server: RunningServer | null = null;

test.skip(!hxdNgAvailable(), 'needs a sibling hxd-ng checkout and cargo');

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
      ann: `name = "Ann"
password = "pw"
[access]
read_chat = true
send_chat = true
read_news = true
post_news = true
`,
    },
  });
});

test.afterAll(() => server?.stop());

async function logIn(page: Page): Promise<void> {
  const url = server!.wsUrl.replace('127.0.0.1', 'localhost');
  await page.goto(`/?server=${encodeURIComponent(url)}`);
  await page.getByLabel('Account').fill('ann');
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.app')).toBeVisible();
}

test('the shell tiles, and the three views become tabs', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await logIn(page);

  await expect(page.locator('body')).toHaveClass(/tiled/);

  // Every panel the catalog names ended up in a pane of its own, with
  // its id intact -- which is the claim that lets everything that finds
  // these by selector go on finding them.
  for (const id of ['rail', 'chat', 'news', 'files', 'roster']) {
    await expect(page.locator(`#pane-${id}`)).toHaveCount(1);
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }

  // Chat, News and Files are one leaf. In the untiled shell they take
  // turns by hiding each other; here the tab strip is the switch.
  const leaf = page.locator('#pane-chat').locator('..');
  await expect(leaf.locator('.panetab')).toHaveCount(3);
  await expect(page.locator('#panetab-chat')).toHaveAttribute('aria-selected', 'true');

  await page.screenshot({ path: 'test-results/tiler-wide.png' });

  // The rail's own News button still works, and now raises a tab.
  await page.locator('.rail-item', { hasText: 'News' }).click();
  await expect(page.locator('#panetab-news')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#pane-news')).toBeVisible();
  await expect(page.locator('#pane-chat')).toBeHidden();
  // The reader itself, not only the pane around it: the view's own
  // `hidden` is set on every connect, and a pane can be on screen and
  // empty.
  await expect(page.locator('#news')).toBeVisible();

  await page.screenshot({ path: 'test-results/tiler-news.png' });

  // And the tab strip is a switch in its own right, which the shell
  // never had: back to chat without going through the rail.
  await page.click('#panetab-chat');
  await expect(page.locator('#pane-chat')).toBeVisible();
  await expect(page.locator('#chat')).toBeVisible();

  // Files, the same way.
  await page.click('#panetab-files');
  await expect(page.locator('#files')).toBeVisible();
  await page.click('#panetab-chat');

  // A pane closed to the drawer and brought back.
  await page.click('#paneshut-roster');
  await expect(page.locator('#panereopen-roster')).toBeVisible();
  await expect(page.locator('#pane-roster')).toBeHidden();
  await page.click('#panereopen-roster');
  await expect(page.locator('#pane-roster')).toBeVisible();
});

test('a narrow window is the shell it always was', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await logIn(page);
  await expect(page.locator('body')).toHaveClass(/tiled/);

  await page.setViewportSize(NARROW);
  await expect(page.locator('body')).not.toHaveClass(/tiled/);

  // Back under their own parents, with the grid the stylesheet describes.
  await expect(page.locator('.panes > .rail')).toHaveCount(1);
  await expect(page.locator('.panes > .roster')).toHaveCount(1);
  await expect(page.locator('.panes > main > .chat-pane')).toHaveCount(1);
  await expect(page.locator('.tiler')).toBeEmpty();

  await page.screenshot({ path: 'test-results/tiler-narrow.png' });
});

test('a phone keeps the title bar on the screen, the rest behind ⋯', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await logIn(page);

  // Nothing in the bar reaches past the right edge of the screen.
  const buttons = page.locator('.topbar button');
  for (let i = 0; i < (await buttons.count()); i++) {
    const b = await buttons.nth(i).boundingBox();
    if (b && b.width > 0) expect(b.x + b.width).toBeLessThanOrEqual(320);
  }

  // The buttons that do not fit are a menu, which a pick and a tap
  // outside both close.
  const menu = page.locator('.topbar-extras');
  await expect(page.getByRole('button', { name: 'Identity' })).toBeHidden();
  await page.locator('.topbar-more').tap();
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: 'Markdown' }).tap();
  await expect(menu).toBeHidden();
  await page.locator('.topbar-more').tap();
  // Left of the menu, and on something with no listener of its own.
  await page.locator('.transcript').tap({ position: { x: 8, y: 8 } });
  await expect(menu).toBeHidden();

  // A finger's worth of button.
  const box = await page.locator('.topbar-more').boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await context.close();
});

test('a tablet is not given the phone’s buttons', async ({ browser }) => {
  // Coarse and wide: the finger-sized rules apply, the phone layout
  // does not, so its People, ⋯ and roster × have nothing to do here.
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await logIn(page);
  await expect(page.locator('.people-toggle')).toBeHidden();
  await expect(page.locator('.topbar-more')).toBeHidden();
  await expect(page.locator('.roster-close')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Identity' })).toBeVisible();
  await context.close();
});
