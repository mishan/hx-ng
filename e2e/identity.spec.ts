/**
 * Identity, end to end, against a real server: enroll a real browser
 * device key with a real `hlid`, then log in with it.
 *
 * This is the test that first caught the bug fixed alongside it —
 * `wsToHttp` built a cross-origin URL for the identity HTTP calls even
 * in the ordinary case of a client sitting in front of its own server,
 * which every unit test missed because none of them go through a real
 * browser's CORS policy or a real dev-proxy config. That's what this
 * file is for: the things only a real server, a real `hlid`, and a
 * real page can catch.
 *
 * `NG_PORT` is 5700 rather than an arbitrary free port on purpose — it
 * has to match `vite.config.ts`'s hardcoded dev-proxy target, so this
 * exercises that proxy rather than a same-port coincidence.
 */

import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  buildHxdNg,
  hlid,
  hlidAgent,
  hlidEnroll,
  hxdNgAvailable,
  startServer,
  type RunningServer,
} from './hxd-ng';

const NG_PORT = 5700;

test.describe('identity: enrollment and login against a real hxd-ng server', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  let server: RunningServer;

  test.beforeAll(async () => {
    buildHxdNg();
    server = await startServer(NG_PORT);
  });

  test.afterAll(() => {
    server?.stop();
  });

  test('enroll a real device key with hlid, then log in with it', async ({ page }) => {
    await page.goto('/');

    // --- 1. Generate this browser's device keys, via the panel -----------
    await page.getByRole('button', { name: 'Identity keys…' }).click();
    const keyRows = page.locator('.identity-body .field-row code');
    const devicePub = await keyRows.nth(0).textContent();
    const deviceEncPub = await keyRows.nth(1).textContent();
    expect(devicePub).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceEncPub).toMatch(/^[0-9a-f]{64}$/);

    // --- 2. Certify them with the real hlid, from an identity it mints ---
    const hlidDir = mkdtempSync(join(tmpdir(), 'hlid-e2e-'));
    const keygenOut = hlid(hlidDir, ['keygen', 'identity', 'identity.key']);
    const fingerprint = /fingerprint: (\S+)/.exec(keygenOut)?.[1];
    expect(fingerprint).toBeTruthy();

    hlid(hlidDir, [
      'cert',
      '--identity',
      'identity.key',
      '--device-pub',
      devicePub!,
      '--device-enc-pub',
      deviceEncPub!,
      '--caps',
      'web',
      '--days',
      '90',
      '--name',
      'Playwright',
      '-o',
      'cert.bin',
    ]);
    hlid(hlidDir, ['card', '--identity', 'identity.key', '--name', 'Alice', '-o', 'card.bin']);

    // `hlid -o FILE` writes raw CBOR, and the paste box wants base64url
    // text — the same manual step a real user needs today (a known
    // rough edge; see the PR this test landed with).
    const certB64 = readFileSync(join(hlidDir, 'cert.bin')).toString('base64url');
    const cardB64 = readFileSync(join(hlidDir, 'card.bin')).toString('base64url');

    // --- 3. Paste it back and enroll ---------------------------------------
    await page.locator('.identity-body textarea.paste').fill(`${certB64} ${cardB64}`);
    await page.getByRole('button', { name: 'Enroll from paste' }).click();
    await expect(page.locator('.identity-body')).toContainText('Enrolled as Playwright');
    await expect(page.locator('.identity-body')).toContainText(fingerprint!);
    await page.getByRole('button', { name: 'Close' }).click();

    // --- 4. Log in with it, for real ---------------------------------------
    const identityLoginBtn = page.getByRole('button', { name: 'Log in with identity' });
    await expect(identityLoginBtn).toBeVisible();
    await identityLoginBtn.click();

    await expect(page.locator('.pill')).toContainText('online', { timeout: 10_000 });
    await expect(page.locator('.person')).toContainText('guest');

    // The login reply itself, off the wire trace — confirms this is
    // actually an identity session, not a lucky guest login, and that
    // the fingerprint the server saw is the one `hlid` printed.
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('D');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    const frames = page.locator('.debug .frame .raw');
    const loginFrameText = await frames
      .filter({ hasText: 'unattested_guest' })
      .first()
      .textContent({ timeout: 10_000 });
    expect(loginFrameText).toContain(fingerprint);
    expect(loginFrameText).toContain('"caps":["identity"]');

    // --- 5. Resume still works — the identity path is only for a fresh
    //        login, and a dropped socket must not need it again. -------
    await page.locator('.composer-input').fill('/drop');
    await page.locator('.composer-input').press('Enter');
    await expect(page.locator('.pill')).toContainText('online', { timeout: 10_000 });
  });

  test('enroll with a pairing code, with hlid holding the identity key', async ({ page }) => {
    // The route that replaces the paste: nothing is copied between the
    // two screens except eight characters the user types, and the
    // fingerprint they compare.
    await page.goto('/');
    await page.getByRole('button', { name: 'Identity keys…' }).click();

    const hlidDir = mkdtempSync(join(tmpdir(), 'hlid-enroll-e2e-'));
    const initOut = hlid(hlidDir, ['init', '--name', 'Alice']);
    const fingerprint = /fingerprint: (\S+)/.exec(initOut)?.[1];
    expect(fingerprint).toBeTruthy();

    // The panel only draws the code box once discovery says this server
    // has a mailbox, which is a round trip after the panel opens.
    const codeBox = page.locator('.identity-body .code-entry');
    await expect(codeBox).toBeVisible({ timeout: 10_000 });

    // The fingerprint the user is asked to compare. It has to be on this
    // screen, because a hostile mailbox's substituted request is caught
    // by a human seeing that the two do not match.
    const deviceFp = await page.locator('.identity-body .device-fp').textContent();
    expect(deviceFp).toMatch(/^[0-9a-z]{8}$/);

    const holder = hlidEnroll(hlidDir, ['--server', `http://127.0.0.1:${NG_PORT}`, '--days', '90'], true);
    const code = await holder.code;
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    await codeBox.fill(code);
    await page.getByRole('button', { name: 'Enroll with code' }).click();

    // §5.5: having typed a code rather than run their own command, the
    // user is told whose device this browser has become.
    await expect(page.locator('.identity-body')).toContainText('This browser is now a device of', {
      timeout: 20_000,
    });
    await expect(page.locator('.identity-body')).toContainText('Alice');
    await expect(page.locator('.identity-body')).toContainText(fingerprint!);

    expect(await holder.exited).toBe(0);
    // And the holder showed the same device fingerprint, which is the
    // whole of what the human comparison is.
    expect(holder.output()).toContain(deviceFp!);
    expect(holder.output()).toContain('Compare the device fingerprint');

    // It can log in with what it just got, the same as the pasted path.
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Log in with identity' }).click();
    await expect(page.locator('.pill')).toContainText('online', { timeout: 10_000 });
  });

  test('a scanned QR code fills everything in and needs no comparison', async ({ page }) => {
    // What a phone does: the camera opens this client at the URL in the
    // QR code, with the pairing code, the mailbox, the identity to pin
    // and the pairing secret already in the fragment.
    const hlidDir = mkdtempSync(join(tmpdir(), 'hlid-scan-e2e-'));
    const initOut = hlid(hlidDir, ['init', '--name', 'Alice']);
    const fingerprint = /fingerprint: (\S+)/.exec(initOut)?.[1];

    const holder = hlidEnroll(
      hlidDir,
      // `--web` because the page is on another origin from the server:
      // the user says where the QR points, rather than the server.
      ['--server', `http://127.0.0.1:${NG_PORT}`, '--web', 'http://localhost:5701/', '--show-url'],
      true,
    );
    const url = await holder.scanUrl;
    const fragment = url.slice(url.indexOf('#'));
    expect(fragment).toContain(`identity=${fingerprint}`);

    await page.goto(`/${fragment}`);

    // The panel opens itself: the user is standing in front of a
    // terminal and the code expires in ten minutes.
    const codeBox = page.locator('.identity-body .code-entry');
    await expect(codeBox).toBeVisible({ timeout: 10_000 });
    await expect(codeBox).toHaveValue(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    // The fragment is out of the address bar — it carries the pairing
    // secret, and a URL that stays there gets copied and bookmarked.
    expect(page.url()).not.toContain('#enroll=');
    expect(page.url()).not.toContain('pair=');

    // No fingerprint to compare: the scan made that check in software.
    await expect(page.locator('.identity-body .device-fp')).toHaveCount(0);

    await page.getByRole('button', { name: 'Enroll with code' }).click();
    await expect(page.locator('.identity-body')).toContainText('This browser is now a device of', {
      timeout: 20_000,
    });
    await expect(page.locator('.identity-body')).toContainText('Alice');

    expect(await holder.exited).toBe(0);
    // And the holder saw a request whose pairing proof verified, so it
    // did not ask for the comparison either.
    expect(holder.output()).toContain('(scanned)');
    expect(holder.output()).not.toContain('Compare the device fingerprint');

    // --- Already a device, and handed another code ----------------------
    // The panel read the fragment, cleared it from the address bar, and
    // then drew the enrolled view — which had no code box in it. The
    // scan vanished with nothing on screen and nothing to retry with,
    // because the fragment was already gone.
    const again = hlidEnroll(hlidDir, ['--server', `http://127.0.0.1:${NG_PORT}`, '--web', 'http://localhost:5701/', '--show-url'], true);
    const againUrl = await again.scanUrl;
    // `goto` to a fragment on the page already loaded is a same-document
    // navigation and re-runs nothing; the reload is what makes this a
    // scan rather than a no-op.
    await page.goto(`/${againUrl.slice(againUrl.indexOf('#'))}`);
    await page.reload();
    await expect(page.locator('.identity-body .code-entry')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.identity-body')).toContainText('Enrolled as');
    again.stop();

    // --- And one for somebody else's identity ---------------------------
    // The QR's `identity` is checked against the *answer*; it says
    // nothing about the identity this browser already has. Overwriting
    // that is the question the typed and pasted paths both ask, and a
    // scan should not answer it silently.
    const bobDir = mkdtempSync(join(tmpdir(), 'hlid-scan-e2e-bob-'));
    hlid(bobDir, ['init', '--name', 'Bob']);
    const bob = hlidEnroll(bobDir, ['--server', `http://127.0.0.1:${NG_PORT}`, '--web', 'http://localhost:5701/', '--show-url'], true);
    const bobUrl = await bob.scanUrl;
    await page.goto(`/${bobUrl.slice(bobUrl.indexOf('#'))}`);
    await page.reload();
    await expect(page.locator('.identity-body .code-entry')).toBeVisible({ timeout: 10_000 });

    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await page.getByRole('button', { name: 'Enroll with code' }).click();
    await expect.poll(() => asked, { timeout: 10_000 }).toContain('Only continue if you meant to change identities');
    expect(asked).toContain(fingerprint!);

    // Dismissed, so nothing was stored: still Alice's device.
    await expect(page.locator('.identity-body')).toContainText('Kept the identity this browser already had');
    await expect(page.locator('.identity-body')).toContainText('Enrolled as');
    bob.stop();
  });

  test('renews itself with no code, against a running hlid agent', async ({ page }) => {
    // identity-enrollment.md §8: from one-third of its lifetime
    // remaining a browser posts its old certificate, and the mailbox
    // routes it by the identity that certificate names — straight to
    // `hlid agent`. Nobody types anything.
    const hlidDir = mkdtempSync(join(tmpdir(), 'hlid-renew-e2e-'));
    hlid(hlidDir, ['init', '--name', 'Alice']);

    const agent = hlidAgent(hlidDir, ['--server', `http://127.0.0.1:${NG_PORT}`, '--renew', 'auto']);
    const code = await agent.code;

    // The page's clock is controlled from the start, so that time can be
    // moved past two-thirds of the certificate's life without waiting
    // sixty days for it. `hlid` is a separate process and keeps the real
    // clock, which is what makes the renewed certificate genuinely new.
    const start = Date.now();
    await page.clock.install({ time: start });
    await page.goto('/');

    await page.getByRole('button', { name: 'Identity keys…' }).click();
    const codeBox = page.locator('.identity-body .code-entry');
    await expect(codeBox).toBeVisible({ timeout: 10_000 });
    await codeBox.fill(code);
    await page.getByRole('button', { name: 'Enroll with code' }).click();
    await expect(page.locator('.identity-body')).toContainText('This browser is now a device of', {
      timeout: 20_000,
    });
    // Seventy days on: past two-thirds of ninety, so the client should
    // decide a renewal is due the next time it starts.
    await page.clock.setSystemTime(start + 70 * 24 * 3600 * 1000);
    await page.reload();

    // No code box, no button, no prompt in the browser: the renewal
    // happens on its own at startup. The agent approves it because it
    // was started with --renew auto.
    await page.getByRole('button', { name: 'Identity keys…' }).click();
    await expect(page.locator('.identity-body')).toContainText('renewed automatically', {
      timeout: 20_000,
    });

    // And it reached the agent as a *renewal*, not as another
    // enrollment: it was routed by identity with no code, and approved
    // without a prompt because of --renew auto. The certificate's own
    // expiry is no use as evidence here — the agent signs both with the
    // same ninety-day policy, seconds apart on the real clock.
    expect(agent.output()).toContain('Renew');
    expect(agent.output()).toContain('yes (--renew auto)');

    // The agent is still up, still holding the identity — the part
    // `hlid enroll` could not do.
    agent.stop();
  });
});
