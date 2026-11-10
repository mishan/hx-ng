/**
 * The server's own emoji, end to end, in real browsers against a real
 * server whose catalog `hxd emoji` writes and SIGHUP applies: a name
 * drawn as its picture where its line's reference binds it, and as text
 * where nothing does; an animation still for a reader who asked for less
 * motion; the picker putting a name in a line and a private message; a
 * change to the catalog reaching pages already open; a server emoji
 * reacted with; and a server without them offering nothing new.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import { expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';

import { buildHxdNg, hxd, hxdNgAvailable, openAccount, startServer, type RunningServer } from './hxd-ng';

const NG_PORT = 5912;

const account = (name: string) => `name = "${name}"
password = "pw"
[access]
read_chat = true
send_chat = true
read_chat_history = true
send_msgs = true
`;

const ACCOUNTS = { alice: account('Alice'), bob: account('Bob'), carol: account('Carol'), dave: account('Dave') };

/** A disc of one color, as a PNG. */
function png(size: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'ascii');
    data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8;
  head[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) < size / 2 - 1;
      raw.set(inside ? [...rgb, 255] : [0, 0, 0, 0], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Checkers that move a square a frame, as a looping GIF of three
 *  colors. Its LZW codes stay three bits wide: a clear code goes before
 *  the table would grow past them. */
function gif(size: number): Buffer {
  const out = [Buffer.from('GIF89a', 'ascii')];
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(size, 0);
  screen.writeUInt16LE(size, 2);
  screen[4] = 0xf1;
  out.push(screen, Buffer.from([0, 0, 0, 230, 60, 60, 60, 200, 90, 60, 90, 230]));
  out.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 3, 1, 0, 0, 0]));
  for (let k = 0; k < 3; k++) {
    out.push(Buffer.from([0x21, 0xf9, 4, 0, 20, 0, 0, 0]));
    const at = Buffer.alloc(10);
    at[0] = 0x2c;
    at.writeUInt16LE(size, 5);
    at.writeUInt16LE(size, 7);
    out.push(at);
    const codes = [4];
    for (let i = 0; i < size * size; i++) {
      if (i % 2 === 0 && i) codes.push(4);
      codes.push(((Math.floor((i % size) / 8) + Math.floor(i / size / 8) + k) % 3) + 1);
    }
    codes.push(5);
    const bytes: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const c of codes) {
      acc |= c << bits;
      for (bits += 3; bits >= 8; bits -= 8, acc >>= 8) bytes.push(acc & 255);
    }
    if (bits) bytes.push(acc & 255);
    const data = [2];
    for (let i = 0; i < bytes.length; i += 255) data.push(Math.min(255, bytes.length - i), ...bytes.slice(i, i + 255));
    out.push(Buffer.from([...data, 0]));
  }
  out.push(Buffer.from([0x3b]));
  return Buffer.concat(out);
}

/** `hxd emoji add` with an image of the kind asked for, and no reload. */
function addEmoji(server: RunningServer, name: string, animated = false): void {
  const file = join(server.hlidDir, `${name}.${animated ? 'gif' : 'png'}`);
  writeFileSync(file, animated ? gif(48) : png(48, [250, 190, 40]));
  hxd(server, ['emoji', 'add', name, file]);
}

const contexts: BrowserContext[] = [];

async function logIn(browser: Browser, server: RunningServer, login: string, options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext(options);
  contexts.push(context);
  const page = await context.newPage();
  // Another hostname than the page's, so the image route is the server's
  // own rather than the dev proxy's.
  await page.goto(`/?server=${encodeURIComponent(server.wsUrl.replace('127.0.0.1', 'localhost'))}`);
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

const lineOf = (page: Page, text: string): Locator => page.locator('.transcript .line', { hasText: text }).last();
const emoji = (where: Locator, name: string): Locator => where.getByRole('img', { name: `:${name}:`, exact: true });
const insertButton = (page: Page): Locator => page.getByRole('button', { name: "Insert one of this server's emoji" });
const insertPicker = (page: Page): Locator => page.getByRole('dialog', { name: "This server's emoji" });

/** The type of the bytes an image on the page was drawn from. */
const drawnType = (img: Locator): Promise<string> =>
  img.evaluate(async (el) => (await (await fetch(el.getAttribute('src')!)).blob()).type);

test.describe('server emoji against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT, {
      sections: `
[history]
db = "server.sqlite"

[inbox]
db = "server.sqlite"

[reactions]
enabled = true

[emoji]
enabled = true

[limits]
chat_lines = 0
spam_points = 0
ng_requests = 0
avatar_fetches_per_minute = 0
`,
      accounts: ACCOUNTS,
    });
    addEmoji(server, 'party');
    addEmoji(server, 'blob_party', true);
    server.reload();
  });

  test.afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('a name is drawn as its picture where its line\'s reference binds it, and stays text where none does', async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');
    await expect(insertButton(bob)).toBeVisible();

    await say(bob, 'hello :party: and :blob_party: but not :nope:');
    const line = lineOf(alice, 'hello');
    await expect(emoji(line, 'party')).toBeVisible();
    await expect(emoji(line, 'blob_party')).toBeVisible();
    await expect(line).toContainText(':nope:');
    // In code a name is shown, not said.
    await say(bob, 'code: `:party:` prose: :party:');
    const code = lineOf(alice, 'code:');
    await expect(code.locator('code')).toHaveText(':party:');
    await expect(emoji(code, 'party')).toHaveCount(1);
    await expect(emoji(line, 'party')).toHaveAttribute('title', ':party:');
    expect(await drawnType(emoji(line, 'party'))).toBe('image/png');
    expect(await drawnType(emoji(line, 'blob_party'))).toBe('image/gif');
    // The sender's own echo is drawn the same.
    await expect(emoji(lineOf(bob, 'hello'), 'party')).toBeVisible();

    // A session that never said `emoji` sends its references to nobody:
    // the same words, and nothing makes them a picture.
    const carol = await openAccount(server, 'carol', 'pw');
    await expect(carol.ask('emoji_list')).rejects.toThrow('not_available');
    await carol.ask('chat', { text: 'raw :party:', emoji: [{ name: 'party', id: 1 }] });
    await carol.close();
    const raw = lineOf(alice, 'raw :party:');
    await expect(raw).toBeVisible();
    await expect(raw.getByRole('img')).toHaveCount(0);

    // A later reader is handed the references by history, and one who
    // asked for less motion is drawn the animation's first frame.
    const dave = await logIn(browser, server, 'dave', { reducedMotion: 'reduce' });
    const kept = lineOf(dave, 'hello');
    await expect(emoji(kept, 'blob_party')).toBeVisible();
    expect(await drawnType(emoji(kept, 'blob_party'))).toBe('image/png');
    await expect(lineOf(dave, 'raw :party:').getByRole('img')).toHaveCount(0);
  });

  test('the picker puts a name in a line and in a private message, and the send names it', async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');

    await alice.locator('.composer-input').fill('look');
    await insertButton(alice).click();
    const picker = insertPicker(alice);
    await expect(picker.getByRole('button', { name: ':party:', exact: true })).toBeVisible();
    await expect(picker.getByRole('button', { name: ':blob_party:', exact: true })).toBeVisible();
    // Found by a word of its name.
    await picker.getByRole('searchbox', { name: 'Search emoji' }).fill('blob');
    await expect(picker.getByRole('button', { name: ':party:', exact: true })).toHaveCount(0);
    await alice.keyboard.press('Enter');
    await expect(picker).toBeHidden();
    await expect(alice.locator('.composer-input')).toBeFocused();
    await expect(alice.locator('.composer-input')).toHaveValue('look :blob_party: ');
    await alice.keyboard.type('there');
    await alice.keyboard.press('Enter');
    await expect(emoji(lineOf(bob, 'look'), 'blob_party')).toBeVisible();

    // Put between two words, it is a word of its own.
    await alice.locator('.composer-input').fill('ab');
    await alice.locator('.composer-input').evaluate((el) => (el as unknown as { setSelectionRange(a: number, b: number): void }).setSelectionRange(1, 1));
    await insertButton(alice).click();
    await insertPicker(alice).getByRole('button', { name: ':party:', exact: true }).click();
    await expect(alice.locator('.composer-input')).toHaveValue('a :party: b');
    await alice.locator('.composer-input').fill('');

    // Escape leaves it with nothing put in.
    await insertButton(alice).click();
    await alice.keyboard.press('Escape');
    await expect(insertPicker(alice)).toBeHidden();
    await expect(alice.locator('.composer-input')).toHaveValue('');

    await say(alice, '/msg Bob psst');
    await insertButton(alice).click();
    await insertPicker(alice).getByRole('button', { name: ':party:', exact: true }).click();
    await alice.keyboard.type('whisper');
    await alice.keyboard.press('Enter');
    await bob.locator('.rail-item', { hasText: 'Alice' }).click();
    await expect(emoji(lineOf(bob, 'whisper'), 'party')).toBeVisible();
    await expect(emoji(lineOf(alice, 'whisper'), 'party')).toBeVisible();

    // A reload resumes into a page that holds no catalog: it asks again,
    // and the mailbox and history hand the references back.
    await bob.reload();
    await expect(bob.locator('.app')).toBeVisible();
    await expect(emoji(lineOf(bob, 'look'), 'blob_party')).toBeVisible();
    await bob.locator('.rail-item', { hasText: 'Alice' }).click();
    await expect(emoji(lineOf(bob, 'whisper'), 'party')).toBeVisible();
  });

  test('a change to the catalog reaches pages already open', async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');
    await expect(insertButton(bob)).toBeVisible();

    addEmoji(server, 'owl_hoot');
    server.reload();
    await expect(async () => {
      await insertButton(bob).click();
      try {
        await expect(insertPicker(bob).getByRole('button', { name: ':owl_hoot:', exact: true })).toBeVisible({ timeout: 500 });
      } finally {
        await bob.keyboard.press('Escape');
      }
    }).toPass();
    await say(bob, 'birds: :owl_hoot: and :blob_party:');
    const line = lineOf(alice, 'birds:');
    await expect(emoji(line, 'owl_hoot')).toBeVisible();

    // Removed, it is drawn as the words it was, whatever bytes are held.
    hxd(server, ['emoji', 'remove', 'owl_hoot']);
    // Renamed, a line already said keeps its picture under the name it
    // was said with, and the picker offers the new one.
    hxd(server, ['emoji', 'rename', 'blob_party', 'conga']);
    server.reload();
    await expect(emoji(line, 'owl_hoot')).toHaveCount(0);
    await expect(line).toContainText(':owl_hoot:');
    await expect(emoji(line, 'blob_party')).toBeVisible();
    await insertButton(alice).click();
    await expect(insertPicker(alice).getByRole('button', { name: ':conga:', exact: true })).toBeVisible();
    await expect(insertPicker(alice).getByRole('button', { name: ':blob_party:', exact: true })).toHaveCount(0);
    await expect(insertPicker(alice).getByRole('button', { name: ':owl_hoot:', exact: true })).toHaveCount(0);
    await alice.keyboard.press('Escape');

    // A name the catalog no longer has is sent as the words alone.
    await say(alice, 'still :owl_hoot:?');
    await expect(lineOf(bob, 'still :owl_hoot:?').getByRole('img')).toHaveCount(0);
  });

  test('a server emoji is reacted with, and its chip read out by its name', async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    const bob = await logIn(browser, server, 'bob');
    await say(bob, 'react to me');
    const line = lineOf(alice, 'react to me');
    await line.hover();
    await line.getByRole('button', { name: 'React', exact: true }).click();
    const picker = alice.getByRole('dialog', { name: 'Add a reaction' });
    // The server's own come first, and a search finds them by name,
    // from the keyboard too.
    await expect(picker.getByRole('button').first()).toHaveAccessibleName(/^:[a-z0-9_]+:$/);
    await alice.keyboard.type(':par');
    await alice.keyboard.press('ArrowDown');
    await expect(picker.getByRole('button', { name: ':party:', exact: true })).toBeFocused();
    await alice.keyboard.press('Enter');

    const own = line.getByRole('button', { name: ':party:, 1, including you', exact: true });
    await expect(own).toHaveAttribute('aria-pressed', 'true');
    await expect(own.locator('img.emoji')).toBeVisible();
    const theirs = lineOf(bob, 'react to me').getByRole('button', { name: ':party:, 1', exact: true });
    await expect(theirs).toBeVisible();
    await theirs.click();
    await expect(lineOf(alice, 'react to me').getByRole('button', { name: ':party:, 2, including you', exact: true })).toBeVisible();

    // Removed, its chip says the name it had, and can still be taken back.
    addEmoji(server, 'brief');
    server.reload();
    await say(bob, 'react again');
    const again = lineOf(alice, 'react again');
    // The picker draws what the catalog held as it opened.
    await expect(async () => {
      await again.hover();
      await again.getByRole('button', { name: 'React', exact: true }).click();
      try {
        await picker.getByRole('button', { name: ':brief:', exact: true }).click({ timeout: 500 });
      } catch (e) {
        await alice.keyboard.press('Escape');
        throw e;
      }
    }).toPass();
    hxd(server, ['emoji', 'remove', 'brief']);
    server.reload();
    const gone = again.getByRole('button', { name: ':brief:, 1, including you', exact: true });
    await expect(gone).toHaveText(':brief:1');
    await expect(gone.locator('img')).toHaveCount(0);
    // Another reader may not add it, so it is no toggle of theirs.
    await expect(lineOf(bob, 'react again').getByRole('img', { name: ':brief:, 1', exact: true })).toBeVisible();
    await gone.click();
    await expect(again.locator('.reaction')).toHaveCount(0);
  });
});

test.describe('a server without emoji', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT + 1, { sections: '[history]\ndb = "server.sqlite"\n', accounts: ACCOUNTS });
  });

  test.afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('offers no picker, and a name stays the words it is', async ({ browser }) => {
    const alice = await logIn(browser, server, 'alice');
    await say(alice, 'just :party: here');
    await expect(lineOf(alice, 'just :party: here')).toBeVisible();
    await expect(insertButton(alice)).toBeHidden();
    await expect(lineOf(alice, 'just :party: here').getByRole('img')).toHaveCount(0);
  });
});
