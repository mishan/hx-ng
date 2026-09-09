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

import { expect, test, type Page } from '@playwright/test';

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

  /**
   * Enroll this browser with a certificate that is already most of the
   * way through its life, by *backdating the certificate* rather than
   * moving the page's clock.
   *
   * That distinction is the whole point. `hlid` is a separate process
   * with the real clock, and a browser whose clock disagrees with it by
   * seventy days does not have a renewal problem — it has a clock
   * problem, and the holder rejects its request as a replay
   * (`identity-enrollment.md` §4), exactly as the server rejects its
   * login proof. Faking the elapsed time on one side only tested a
   * client that could not log in either. Backdating the certificate
   * puts both clocks in the present, where they belong.
   */
  async function enrollAged(page: Page, hlidDir: string, ageDays: number): Promise<void> {
    await page.goto('/');
    await page.getByRole('button', { name: 'Identity keys…' }).click();
    const keyRows = page.locator('.identity-body .field-row code');
    const devicePub = await keyRows.nth(0).textContent();
    const deviceEncPub = await keyRows.nth(1).textContent();

    const issued = Math.floor(Date.now() / 1000) - ageDays * 24 * 3600;
    hlid(hlidDir, [
      'cert',
      '--device-pub', devicePub!,
      '--device-enc-pub', deviceEncPub!,
      '--caps', 'web',
      '--days', '90',
      '--issued', String(issued),
      '--name', 'Aged',
      '--bundle',
      '-o', 'aged.bundle',
    ]);
    const bundle = readFileSync(join(hlidDir, 'aged.bundle')).toString('base64url');
    await page.locator('.identity-body textarea.paste').fill(bundle);
    await page.getByRole('button', { name: 'Enroll from paste' }).click();
    await expect(page.locator('.identity-body')).toContainText('This browser is now a device of', {
      timeout: 20_000,
    });
  }

  test('renews itself with no code, against a running hlid agent', async ({ page }) => {
    // identity-enrollment.md §8: from one-third of its lifetime
    // remaining a browser posts its old certificate, and the mailbox
    // routes it by the identity that certificate names — straight to
    // `hlid agent`. Nobody types anything.
    const hlidDir = mkdtempSync(join(tmpdir(), 'hlid-renew-e2e-'));
    hlid(hlidDir, ['init', '--name', 'Alice']);

    // Seventy days into ninety: past two-thirds, so the client should
    // decide a renewal is due the next time it starts.
    await enrollAged(page, hlidDir, 70);
    const before = await page.locator('.identity-body').textContent();

    const agent = hlidAgent(hlidDir, ['--server', `http://127.0.0.1:${NG_PORT}`, '--renew', 'auto']);
    await agent.code;

    // No code box, no button, no prompt in the browser: the renewal
    // happens on its own at startup. The agent approves it because it
    // was started with --renew auto.
    await page.reload();
    await page.getByRole('button', { name: 'Identity keys…' }).click();
    await expect(page.locator('.identity-body')).toContainText('renewed automatically', {
      timeout: 20_000,
    });
    // A genuinely new certificate: the expiry moved.
    await expect(page.locator('.identity-body')).not.toHaveText(before!);

    // And it reached the agent as a *renewal*, not as another
    // enrollment: it was routed by identity with no code, and approved
    // without a prompt because of --renew auto.
    expect(agent.output()).toContain('Renew');
    expect(agent.output()).toContain('yes (--renew auto)');

    // The agent is still up, still holding the identity — the part
    // `hlid enroll` could not do.
    agent.stop();
  });

  test('renews for the lifetime it already had, not the panel default', async ({ page }) => {
    // The holder grants min(asked, its policy), so an automatic renewal
    // that asked for the panel's ninety-day default would quietly
    // shorten a longer certificate every time it ran — and the panel's
    // default is what `certDays` is at startup, before the user has
    // touched the day buttons. A renewal nobody asked for moves the
    // expiry date and changes nothing else.
    const hlidDir = mkdtempSync(join(tmpdir(), 'hlid-renew-days-e2e-'));
    hlid(hlidDir, ['init', '--name', 'Alice']);

    await page.goto('/');
    await page.getByRole('button', { name: 'Identity keys…' }).click();
    const keyRows = page.locator('.identity-body .field-row code');
    const devicePub = await keyRows.nth(0).textContent();
    const deviceEncPub = await keyRows.nth(1).textContent();

    // A 365-day certificate, 300 days in: past two-thirds, and longer
    // than the panel would ever ask for on its own.
    const issued = Math.floor(Date.now() / 1000) - 300 * 24 * 3600;
    hlid(hlidDir, [
      'cert',
      '--device-pub', devicePub!,
      '--device-enc-pub', deviceEncPub!,
      '--caps', 'web',
      '--days', '365',
      '--issued', String(issued),
      '--name', 'Long-lived',
      '--bundle',
      '-o', 'long.bundle',
    ]);
    const bundle = readFileSync(join(hlidDir, 'long.bundle')).toString('base64url');
    await page.locator('.identity-body textarea.paste').fill(bundle);
    await page.getByRole('button', { name: 'Enroll from paste' }).click();
    await expect(page.locator('.identity-body')).toContainText('This browser is now a device of', {
      timeout: 20_000,
    });

    // The agent's own policy has to allow it, or the floor would be the
    // holder's rather than the client's ask, and this would pass either
    // way.
    const agent = hlidAgent(hlidDir, [
      '--server', `http://127.0.0.1:${NG_PORT}`,
      '--renew', 'auto',
      '--days', '365',
    ]);
    await agent.code;

    await page.reload();
    await page.getByRole('button', { name: 'Identity keys…' }).click();
    await expect(page.locator('.identity-body')).toContainText('renewed automatically', {
      timeout: 20_000,
    });

    // Roughly a year out, not roughly ninety days: the renewal kept the
    // lifetime the certificate already had.
    const expiry = /Certificate expires ([^.]+)\./.exec(
      (await page.locator('.identity-body').textContent()) ?? '',
    )?.[1];
    expect(expiry).toBeTruthy();
    const daysOut = (Date.parse(expiry!) - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(300);

    agent.stop();
  });

  test('says it renewed itself even with the panel already open', async ({ page }) => {
    // The panel being closed is the easy case: `keep` has nothing to
    // paint on, and the notice survives to the next open. With the panel
    // open the paint is the one the user is looking at, and it used to
    // read "this browser is now a device of Alice" — true months ago,
    // not what just happened — because `keep` announced a first
    // enrollment unconditionally and the renewal flag was set after the
    // render that would have shown it.
    const hlidDir = mkdtempSync(join(tmpdir(), 'hlid-renew-open-e2e-'));
    hlid(hlidDir, ['init', '--name', 'Alice']);
    await enrollAged(page, hlidDir, 70);

    const agent = hlidAgent(hlidDir, ['--server', `http://127.0.0.1:${NG_PORT}`, '--renew', 'auto']);
    await agent.code;

    // The renewal's answer is held back so that it certainly arrives
    // *after* the panel is open. Without this the whole thing is over
    // before the first click on loopback, which is the closed-panel case
    // — the one that already worked, and the reason this bug was not
    // visible from a local run.
    await page.route('**/identity/enroll/requests/*', async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });

    await page.reload();
    await page.getByRole('button', { name: 'Identity keys…' }).click();

    const body = page.locator('.identity-body');
    await expect(body).toContainText('renewed automatically', { timeout: 20_000 });
    await expect(body).not.toContainText('This browser is now a device of');

    agent.stop();
  });

  test('offers "Renew now" the first time the panel is opened', async ({ page }) => {
    // The renewal banner needs the mailbox, and discovery is a round
    // trip that lands after the first paint. Repainting for it used to
    // be skipped for a device that had a certificate — which is every
    // device that could possibly renew — so the button was missing until
    // something else happened to repaint, and the copy that did appear
    // had closed over a null mailbox and did nothing when clicked.
    //
    // No agent is running here on purpose: this is about the button
    // being offered and actually reaching the mailbox, so `no_holder`
    // coming back is the proof it went somewhere.
    const hlidDir = mkdtempSync(join(tmpdir(), 'hlid-banner-e2e-'));
    hlid(hlidDir, ['init', '--name', 'Alice']);
    await enrollAged(page, hlidDir, 70);

    // Discovery held back, so the panel certainly paints before the
    // answer lands. On loopback it usually wins the race on its own,
    // which is exactly why this bug survived: the ordering that breaks
    // it is the one a real network produces and a local test does not.
    await page.route('**/.well-known/hotline', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    // A fresh page: the first open of the panel is the one under test.
    await page.reload();
    await page.getByRole('button', { name: 'Identity keys…' }).click();
    // Painted, and with no mailbox yet — so the button below can only
    // appear if the answer to discovery repaints the enrolled view.
    await expect(page.locator('.identity-body')).toContainText('Enrolled as');

    const renew = page.getByRole('button', { name: 'Renew now' });
    await expect(renew).toBeVisible({ timeout: 20_000 });

    await renew.click();
    await expect(page.locator('.identity-body')).toContainText('Nothing is listening', {
      timeout: 20_000,
    });
  });
});
