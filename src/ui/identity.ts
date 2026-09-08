/**
 * The identity panel: generate this browser's device keys, show the
 * `hlid` commands that certify them, accept the paste back, and — once
 * enrolled — the fingerprint, the renewal nag, and "forget this device".
 *
 * Modelled directly on `DebugPanel`: a bottom-docked drawer, toggled the
 * same way, mounted as a sibling of the app shell rather than inside it.
 * Unlike the debug drawer, this one has to work *before* a connection
 * exists — enrolling is what a browser does in order to log in with
 * identity in the first place (`docs/identity-keys.md` §7.1) — so it
 * reads the server address from a hook rather than from a `Connection`.
 */

import {
  IdentityError,
  bytesToHex,
  decodeDeviceCert,
  fingerprintOf,
  wsToHttp,
} from '@hotline-ng/client';

import {
  buildHlidCertCommand,
  fetchCardFallback,
  needsRenewal,
  parseEnrollmentPaste,
  validateEnrollment,
} from '../identity/enroll';
import {
  attachCertificate,
  ensureActiveDevice,
  forgetActiveDevice,
  getActiveDevice,
  UnsupportedAlgorithm,
  type StoredDevice,
} from '../identity/storage';
import { fill, h } from './dom';

const RENEWAL_DAYS = [90, 180, 365];

export class IdentityPanel {
  readonly el: HTMLElement;
  open = false;

  private body: HTMLElement;
  private device: StoredDevice | null = null;
  private unsupported: UnsupportedAlgorithm | null = null;
  private certDays = 90;

  constructor(private serverUrl: () => string) {
    this.body = h('div', { class: 'identity-body' });
    const closeBtn = h('button', { class: 'ghost' }, 'Close');
    closeBtn.onclick = () => this.toggle(false);
    this.el = h(
      'section',
      { class: 'identity-panel', hidden: true },
      h('header', { class: 'identity-bar' }, h('strong', {}, 'Identity'), h('div', { class: 'spacer' }), closeBtn),
      this.body,
    );
  }

  /** Has this browser enrolled a device? The connect screen uses this to
   *  decide whether to offer an identity login at all. */
  async hasEnrolledDevice(): Promise<boolean> {
    const device = await getActiveDevice();
    return !!device?.cert;
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.el.hidden = !this.open;
    if (!this.open) return;
    if (this.device || this.unsupported) this.render();
    else void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.device = await ensureActiveDevice();
    } catch (e) {
      if (!(e instanceof UnsupportedAlgorithm)) throw e;
      this.unsupported = e;
    }
    this.render();
  }

  private render(): void {
    if (this.unsupported) {
      fill(this.body, h('p', { class: 'error' }, this.unsupported.message));
      return;
    }
    if (!this.device) {
      fill(this.body, h('p', { class: 'muted' }, 'Loading…'));
      return;
    }
    if (this.device.cert) this.renderEnrolled(this.device);
    else this.renderEnroll(this.device);
  }

  private renderEnroll(device: StoredDevice): void {
    const devicePubHex = device.devicePub;
    const deviceEncPubHex = bytesToHex(device.deviceEncPub);

    const certCmd = buildHlidCertCommand(devicePubHex, deviceEncPubHex, { days: this.certDays });
    const certPre = h('pre', { class: 'cmd' }, certCmd);

    const paste = h('textarea', {
      class: 'paste',
      rows: 4,
      spellcheck: false,
      placeholder: 'paste the certificate here — and the card too, if hlid wrote it to a separate file',
    });
    const error = h('p', { class: 'error', hidden: true });
    const enrollBtn = h('button', { class: 'primary' }, 'Enroll');
    enrollBtn.onclick = () => void this.submitPaste(device, paste.value, error, enrollBtn);

    fill(
      this.body,
      h(
        'p',
        { class: 'muted' },
        'This browser is a device, not an identity: it holds a key certified by your identity key, which stays in hlid. Run the command below wherever hlid is, then paste back what it writes.',
      ),
      h('div', { class: 'field-row' }, h('span', { class: 'k' }, 'Device signing key'), h('code', {}, devicePubHex), copyButton(() => devicePubHex)),
      h('div', { class: 'field-row' }, h('span', { class: 'k' }, 'Device encryption key'), h('code', {}, deviceEncPubHex), copyButton(() => deviceEncPubHex)),
      h('h3', {}, '1. Certify this device'),
      h('div', { class: 'cmd-row' }, certPre, copyButton(() => certCmd)),
      h(
        'p',
        { class: 'note' },
        "hlid doesn't write the certificate and card together yet (docs/identity-keys.md §9), so this writes just the certificate — paste it below, and this identity's card too if you have it separately (a second browser can skip the card; the server already has it cached).",
      ),
      h('h3', {}, '2. Paste it back'),
      paste,
      error,
      enrollBtn,
    );
  }

  private async submitPaste(device: StoredDevice, raw: string, error: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    error.hidden = true;
    btn.disabled = true;
    try {
      const parsed = parseEnrollmentPaste(raw);
      let cardBytes = parsed.card;
      if (!cardBytes) {
        const cert = decodeDeviceCert(parsed.cert);
        const identityFingerprint = await fingerprintOf(cert.identity);
        const server = this.serverUrl().trim();
        cardBytes = server ? await fetchCardFallback(wsToHttp(server), identityFingerprint) : null;
        if (!cardBytes) {
          throw new IdentityError(
            'bad-field',
            'no card was pasted, and this server has none cached yet for this identity — paste the card too',
          );
        }
      }
      const result = await validateEnrollment(
        parsed.cert,
        cardBytes,
        device.devicePub,
        bytesToHex(device.deviceEncPub),
        Math.floor(Date.now() / 1000),
      );
      await attachCertificate(device.devicePub, {
        cert: parsed.cert,
        card: cardBytes,
        fingerprint: result.fingerprint,
        certExpires: result.cert.expires,
        label: result.cert.name,
      });
      this.device = await getActiveDevice();
      this.render();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
      error.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  private renderEnrolled(device: StoredDevice): void {
    const cert = decodeDeviceCert(device.cert!);
    const now = Math.floor(Date.now() / 1000);

    const forgetBtn = h('button', { class: 'ghost danger' }, 'Forget this device');
    forgetBtn.onclick = () => void this.forget();

    fill(
      this.body,
      h('p', {}, 'Enrolled as ', h('strong', {}, device.label || '(unnamed device)')),
      h('div', { class: 'field-row' }, h('span', { class: 'k' }, 'Fingerprint'), h('code', {}, device.fingerprint ?? '')),
      h('p', { class: 'muted' }, `Certificate expires ${new Date(cert.expires * 1000).toLocaleString()}.`),
      needsRenewal(cert, now) ? this.renewalBanner(device) : null,
      h(
        'p',
        { class: 'muted' },
        "Forgetting this device stops this browser logging in as you again. It does not end a session someone else already holds with a stolen device key — for that, ask the server operator to remove the link and kick the session first (docs/identity-keys.md §10).",
      ),
      forgetBtn,
    );
  }

  private renewalBanner(device: StoredDevice): HTMLElement {
    const dayBtns = RENEWAL_DAYS.map((d) => {
      const b = h('button', { class: `ghost ${d === this.certDays ? 'on' : ''}` }, `${d} days`);
      b.onclick = () => {
        this.certDays = d;
        this.render();
      };
      return b;
    });
    const cmd = buildHlidCertCommand(device.devicePub, bytesToHex(device.deviceEncPub), {
      days: this.certDays,
      name: device.label,
    });
    return h(
      'div',
      { class: 'renewal-nag' },
      h('p', {}, "This certificate is past two-thirds of its lifetime — renew it with the same command, run again:"),
      h('div', {}, ...dayBtns),
      h('div', { class: 'cmd-row' }, h('pre', { class: 'cmd' }, cmd), copyButton(() => cmd)),
      h(
        'p',
        { class: 'note' },
        'Longer bounds how long a copied browser profile can keep logging in as you (docs/identity-keys.md §7.2) — pick it with that trade-off in mind, not just to clear this banner.',
      ),
    );
  }

  private async forget(): Promise<void> {
    await forgetActiveDevice();
    this.device = null;
    this.certDays = 90;
    await this.load();
  }
}

function copyButton(getText: () => string): HTMLButtonElement {
  const btn = h('button', { class: 'ghost' }, 'Copy');
  btn.onclick = () => void copyText(getText(), btn);
  return btn;
}

async function copyText(text: string, btn: HTMLButtonElement): Promise<void> {
  const was = btn.textContent;
  try {
    // `navigator.clipboard` itself can be `undefined` — an insecure
    // context, an old browser, or a blocked permission — in which case
    // reading `.writeText` off it throws synchronously rather than
    // rejecting a promise. The `try` catches both.
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => (btn.textContent = was), 1400);
}
