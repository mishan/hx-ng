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
  CAPS,
  IdentityError,
  bytesToHex,
  decodeDeviceCert,
  fetchDiscovery,
  fingerprintOf,
  hexToBytes,
  wsToHttp,
} from '@hotline-ng/client';

import {
  buildHlidCertCommand,
  enrollWithCode,
  fetchCardFallback,
  needsRenewal,
  parseEnrollmentPaste,
  validateEnrollment,
  type EnrollmentResult,
} from '../identity/enroll';
import { mailboxFrom, type Mailbox } from '../identity/mailbox';
import {
  attachCertificate,
  ensureActiveDevice,
  forgetActiveDevice,
  getActiveDevice,
  pinIdentity,
  pinnedIdentity,
  UnsupportedAlgorithm,
  type StoredDevice,
} from '../identity/storage';
import { fill, h } from './dom';

const RENEWAL_DAYS = [90, 180, 365];

/** A label for the holder's prompt, so whoever approves it sees
 *  something more useful than "unnamed". The holder may edit it. */
function defaultDeviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser =
    /Firefox\//.test(ua) ? 'Firefox'
    : /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  const platform =
    /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  return platform ? `${browser} on ${platform}` : browser;
}

export class IdentityPanel {
  readonly el: HTMLElement;
  open = false;

  private body: HTMLElement;
  private device: StoredDevice | null = null;
  private unsupported: UnsupportedAlgorithm | null = null;
  private certDays = 90;
  /** The mailbox this server advertises, looked up once when the panel
   *  opens. `null` means it hosts none, and the code box is not drawn —
   *  offering one that cannot work is worse than not offering it. */
  private mailbox: Mailbox | null = null;
  /** Live while a request is out, so closing the panel stops the poll
   *  rather than leaving a fetch loop running for ten minutes. */
  private waiting: AbortController | null = null;
  /** This browser's device fingerprint, first eight characters — the
   *  same form `hlid` prints, so the two screens can be compared. */
  private shortDeviceFp: string | null = null;
  /** Whose device this browser just became, shown once after enrolling
   *  (`identity-enrollment.md` §5.5). */
  private becameLabel: string | null = null;

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
    if (!this.open) {
      this.waiting?.abort();
      this.waiting = null;
      return;
    }
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
    if (this.device) this.shortDeviceFp = (await fingerprintOf(hexToBytes(this.device.devicePub))).slice(0, 8);
    this.render();
    // After the first paint: discovery is a round trip, and the panel
    // has plenty to show without it. A server that cannot be reached, or
    // that has no mailbox, simply leaves the paste as the only route.
    void this.findMailbox();
  }

  private async findMailbox(): Promise<void> {
    const server = this.serverUrl().trim();
    if (!server) return;
    try {
      const httpBase = wsToHttp(server);
      const discovery = await fetchDiscovery(httpBase);
      this.mailbox = discovery.identity.enabled
        ? mailboxFrom(httpBase, discovery.identity.endpoints.enroll)
        : null;
    } catch {
      // Unreachable, or not a Hotline-ng server. Nothing to report: the
      // panel still works, and the connect screen is where a bad server
      // address gets said out loud.
      this.mailbox = null;
    }
    if (this.open && this.device && !this.device.cert) this.render();
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
    const enrollBtn = h('button', { class: 'primary' }, 'Enroll from paste');
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
      this.codeSection(device),
      h('h3', {}, this.mailbox ? 'Or paste it, if you would rather' : '1. Certify this device'),
      h('div', { class: 'cmd-row' }, certPre, copyButton(() => certCmd)),
      h(
        'p',
        { class: 'note' },
        "This writes just the certificate — paste it below, and this identity's card too if you have it separately (a second browser can skip the card; the server already has it cached). hlid can write both as one blob with --bundle; this panel does not read that format yet (docs/identity-keys.md §9).",
      ),
      h('h3', {}, this.mailbox ? 'Paste it back' : '2. Paste it back'),
      paste,
      error,
      enrollBtn,
    );
  }

  /**
   * The code box (`identity-enrollment.md` §5), drawn only when the
   * server advertises a mailbox.
   *
   * The device fingerprint sits beside it, and that is not decoration:
   * the holder's prompt shows the same eight characters, and a user
   * seeing them match is the one check a hostile mailbox cannot fake
   * (§9). If it were only in the terminal there would be nothing to
   * compare it against.
   */
  private codeSection(device: StoredDevice): HTMLElement | null {
    if (!this.mailbox) return null;

    const input = h('input', {
      type: 'text',
      class: 'code-entry',
      placeholder: 'K7PM-4XWE',
      spellcheck: false,
      autocomplete: 'off',
    });
    const status = h('p', { class: 'muted', hidden: true });
    const error = h('p', { class: 'error', hidden: true });
    const submit = h('button', { class: 'primary' }, 'Enroll with code');
    submit.onclick = () => void this.submitCode(device, input.value, status, error, submit);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit.click();
    };

    return h(
      'div',
      { class: 'enroll-code' },
      h('h3', {}, 'Enroll with a code'),
      h(
        'p',
        { class: 'muted' },
        'Run ',
        h('code', {}, 'hlid enroll --server …'),
        ' wherever your identity key is, and type the code it shows.',
      ),
      h('div', { class: 'code-row' }, input, submit),
      h(
        'div',
        { class: 'field-row' },
        h('span', { class: 'k' }, 'This device'),
        h('code', { class: 'device-fp' }, this.shortDeviceFp ?? '…'),
        h('span', { class: 'note' }, 'hlid will show the same eight characters — check that they match.'),
      ),
      status,
      error,
    );
  }

  private async submitCode(
    device: StoredDevice,
    typed: string,
    status: HTMLElement,
    error: HTMLElement,
    btn: HTMLButtonElement,
  ): Promise<void> {
    const code = typed.trim();
    error.hidden = true;
    if (!code) {
      error.textContent = 'Type the code hlid is showing.';
      error.hidden = false;
      return;
    }
    if (!this.mailbox) return;

    btn.disabled = true;
    status.hidden = false;
    status.textContent = 'Waiting for the other end to approve…';
    this.waiting?.abort();
    this.waiting = new AbortController();
    try {
      const outcome = await enrollWithCode({
        mailbox: this.mailbox,
        code,
        device,
        name: defaultDeviceName(),
        caps: CAPS.WEB,
        days: this.certDays,
        pinned: await pinnedIdentity(),
        signal: this.waiting.signal,
      });
      switch (outcome.kind) {
        case 'denied':
          throw new IdentityError('bad-field', `The other end declined this device (${outcome.reason}).`);
        case 'gone':
          throw new IdentityError('bad-field', 'That request expired before it was answered. Try again with a fresh code.');
        case 'identity-changed': {
          // Not an error, and not something to decide for the user:
          // people do change identities. But it is the shape a
          // substituted answer has (§9), so it stops here and says so.
          status.hidden = true;
          const ok = confirm(
            `This browser was enrolled with identity ${outcome.was}.\n\n` +
              `The certificate that just arrived is from ${outcome.now}.\n\n` +
              'Only continue if you meant to change identities.',
          );
          if (!ok) {
            throw new IdentityError('bad-field', 'Kept the identity this browser already had; nothing was stored.');
          }
          await this.keep(device, outcome.cert, outcome.card, outcome.result);
          break;
        }
        case 'enrolled':
          await this.keep(device, outcome.cert, outcome.card, outcome.result);
          break;
      }
    } catch (e) {
      status.hidden = true;
      error.textContent = e instanceof Error ? e.message : String(e);
      error.hidden = false;
    } finally {
      btn.disabled = false;
      this.waiting = null;
    }
  }

  /** Store a certificate that has already been validated, whichever way
   *  it arrived, and pin the identity it names. */
  private async keep(
    device: StoredDevice,
    cert: Uint8Array,
    card: Uint8Array,
    result: EnrollmentResult,
  ): Promise<void> {
    await attachCertificate(device.devicePub, {
      cert,
      card,
      fingerprint: result.fingerprint,
      certExpires: result.cert.expires,
      label: result.cert.name,
    });
    await pinIdentity(result.fingerprint);
    this.becameLabel = result.card.name;
    this.device = await getActiveDevice();
    this.render();
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
      const pinned = await pinnedIdentity();
      if (pinned !== null && pinned !== result.fingerprint) {
        const ok = confirm(
          `This browser was enrolled with identity ${pinned}.\n\n` +
            `What you pasted is from ${result.fingerprint}.\n\n` +
            'Only continue if you meant to change identities.',
        );
        if (!ok) throw new IdentityError('bad-field', 'Kept the identity this browser already had; nothing was stored.');
      }
      await this.keep(device, parsed.cert, cardBytes, result);
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
      this.becameLabel
        ? h(
            'p',
            { class: 'became' },
            'This browser is now a device of ',
            h('strong', {}, this.becameLabel),
            '  ',
            h('code', {}, (device.fingerprint ?? '').slice(0, 8)),
          )
        : null,
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
