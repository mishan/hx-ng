/**
 * The enrollment ceremony (`docs/identity-keys.md` §7.1): build the
 * commands the identity panel shows, parse what the user pastes back,
 * and check it before it's ever trusted.
 *
 * The paste is now the fallback rather than the ceremony — a pairing
 * code and a mailbox (`identity-enrollment.md`) is the ordinary path,
 * and this is what a device does when the server hosts no mailbox or
 * nothing is listening. It still has to work, and it accepts everything
 * `hlid` can write: one blob from `hlid cert --bundle`, or the
 * certificate and card as separate blobs in either order, told apart by
 * shape rather than by position.
 *
 * Whichever way a certificate arrives, `validateEnrollment` is what
 * decides whether to keep it. That is the point of the bundle sharing a
 * format with the mailbox's answer: one verifier, not one per route.
 */

import type { StoredDevice } from './storage';
import { awaitAnswer, postEnrollRequest, type Mailbox } from './mailbox';

import {
  CARD_DOMAIN,
  DEVICE_CERT_DOMAIN,
  IdentityError,
  base64urlToBytes,
  bytesToHex,
  decodeBundle,
  decodeCard,
  decodeDeviceCert,
  fingerprintOf,
  hexToBytes,
  pairTag,
  signEnrollRequest,
  verifyEnvelope,
  type Card,
  type DeviceCert,
} from '@hotline-ng/client';

/** POSIX single-quote a shell argument: wrap it in `'...'`, escaping any
 *  embedded `'` as `'\''` — the standard trick, since nothing can be
 *  escaped *inside* a single-quoted string. These commands are meant to
 *  be copied straight into a terminal, so a device label or account
 *  name with a space, a `$`, or a `"` in it would otherwise silently
 *  turn into a different command than the one on screen. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildHlidCertCommand(
  devicePubHex: string,
  deviceEncPubHex: string,
  opts: { days?: number; name?: string } = {},
): string {
  const days = opts.days ?? 90;
  const name = opts.name ?? 'browser';
  // `--bundle` writes the certificate and this identity's card as one
  // object, which is one blob to paste instead of two and — the part
  // that matters — the same object the mailbox path carries, so both
  // routes end at the same verifier.
  return `hlid cert --device-pub ${devicePubHex} --device-enc-pub ${deviceEncPubHex} --caps web --days ${days} --name ${shq(name)} --bundle -o web.bundle`;
}

export interface ParsedPaste {
  cert: Uint8Array;
  card: Uint8Array | null;
}

/** Which of `hlid`'s output shapes a decoded blob is — told apart by
 *  which required fields decode successfully, not by position. */
function classify(bytes: Uint8Array): 'bundle' | 'cert' | 'card' {
  // Bundle first: it is the only one of the three that is unsigned, so
  // it fails the other two parsers immediately and they fail it, but
  // trying it first means one blob is recognised as a whole rather than
  // as a certificate that happens not to verify.
  try {
    decodeBundle(bytes);
    return 'bundle';
  } catch {
    /* not a bundle; try the two halves below */
  }
  try {
    decodeDeviceCert(bytes);
    return 'cert';
  } catch {
    /* not a certificate; try a card below */
  }
  try {
    decodeCard(bytes);
    return 'card';
  } catch {
    throw new IdentityError(
      'bad-field',
      'this does not decode as a bundle, a device certificate, or a card',
    );
  }
}

/** What a paste can be: one blob from `hlid cert --bundle`, or the
 *  certificate and (optionally) the card that `hlid cert` and `hlid
 *  card` write separately, on one line or across two. */
export function parseEnrollmentPaste(input: string): ParsedPaste {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new IdentityError('bad-field', 'nothing pasted');
  if (tokens.length > 2) {
    throw new IdentityError('bad-field', 'expected the certificate and, optionally, the card — two blobs at most');
  }
  const decoded = tokens.map((t) => {
    try {
      return base64urlToBytes(t);
    } catch {
      throw new IdentityError('bad-field', 'not valid base64url');
    }
  });

  // A bundle is the whole paste; pairing it with anything else is a
  // contradiction rather than something to reconcile.
  if (decoded.length === 1 && classify(decoded[0]!) === 'bundle') {
    const b = decodeBundle(decoded[0]!);
    return { cert: b.cert, card: b.card };
  }

  let cert: Uint8Array | null = null;
  let card: Uint8Array | null = null;
  for (const bytes of decoded) {
    const kind = classify(bytes);
    if (kind === 'bundle') {
      throw new IdentityError('bad-field', 'a bundle already carries the card — paste it on its own');
    }
    if (kind === 'cert') {
      if (cert) throw new IdentityError('bad-field', 'pasted two certificates and no card');
      cert = bytes;
    } else {
      if (card) throw new IdentityError('bad-field', 'pasted two cards and no certificate');
      card = bytes;
    }
  }
  if (!cert) throw new IdentityError('bad-field', 'no certificate found in the paste');
  return { cert, card };
}

export interface EnrollmentResult {
  cert: DeviceCert;
  card: Card;
  fingerprint: string;
}

/**
 * §7.1 step 4's checks, plus local signature verification (worth doing,
 * per the doc, "if the codec is already there" — it is): does this
 * certificate name *this* browser's keys, does the card name the same
 * identity as the certificate, has it not expired, and do both
 * signatures actually verify. A mismatch here is a paste error, and
 * should say so — discovering it at `/identity/auth` as `bad_cert` is a
 * worse place to find out.
 */
export async function validateEnrollment(
  certBytes: Uint8Array,
  cardBytes: Uint8Array,
  devicePubHex: string,
  deviceEncPubHex: string,
  now: number,
): Promise<EnrollmentResult> {
  const cert = decodeDeviceCert(certBytes);
  const card = decodeCard(cardBytes);

  if (bytesToHex(cert.device) !== devicePubHex) {
    throw new IdentityError('bad-field', "this certificate is for a different device key than this browser's");
  }
  if (bytesToHex(cert.deviceEnc) !== deviceEncPubHex) {
    throw new IdentityError('bad-field', "this certificate carries a different encryption key than this browser's");
  }
  if (bytesToHex(cert.identity) !== bytesToHex(card.identity)) {
    throw new IdentityError('bad-field', 'the certificate and the card name different identities');
  }
  if (now >= cert.expires) {
    throw new IdentityError('bad-field', 'this certificate has already expired');
  }

  await verifyEnvelope(certBytes, cert.identity, DEVICE_CERT_DOMAIN);
  await verifyEnvelope(cardBytes, card.identity, CARD_DOMAIN);

  return { cert, card, fingerprint: await fingerprintOf(cert.identity) };
}

/** True from one-third of the certificate's lifetime remaining — the
 *  point hxd-ng's `docs/hotline-ng-identity.md` §3.3 (in the cert's own
 *  field table) and this repo's `docs/identity-keys.md` §7.2 both say to
 *  start nagging. */
export function needsRenewal(cert: DeviceCert, now: number): boolean {
  const lifetime = cert.expires - cert.issued;
  return now >= cert.issued + (lifetime * 2) / 3;
}

/** `GET /identity/card/<fingerprint>` — only useful for a *second*
 *  browser: the server can only serve a card it has already cached from
 *  this identity authenticating somewhere, so a first-time enrollment
 *  still needs the card pasted. `null` on 404, not an error — "no card
 *  cached yet" is the expected answer the first time. */
export async function fetchCardFallback(httpBase: string, fingerprint: string): Promise<Uint8Array | null> {
  const res = await fetch(`${httpBase}/identity/card/${fingerprint}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new IdentityError('server-error', `GET /identity/card: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export interface CodeEnrollment {
  mailbox: Mailbox;
  code: string;
  /** This browser's record; its private keys never leave WebCrypto. */
  device: StoredDevice;
  /** A label for the holder's prompt. It may edit or ignore it. */
  name?: string;
  /** What to ask for. The holder grants this or less, never more. */
  caps?: number;
  days?: number;
  /** The identity this browser has enrolled with before, if any. */
  pinned: string | null;
  /**
   * The pairing secret from a scanned QR code (§5.6). Present, the
   * request carries a keyed tag proving it came from whoever scanned
   * the holder's screen, and `pinned` will have been set from the same
   * scan — so the answer is checked against an identity this browser
   * knew *before* it asked, rather than one it learned from the answer.
   */
  pairingSecret?: Uint8Array;
  signal?: AbortSignal;
}

export type CodeOutcome =
  | { kind: 'enrolled'; result: EnrollmentResult; cert: Uint8Array; card: Uint8Array }
  | { kind: 'denied'; reason: string }
  | { kind: 'gone' }
  /** The answer is for an identity this browser has not seen before, and
   *  it has seen one. Nothing is stored until the user confirms. */
  | { kind: 'identity-changed'; was: string; now: string; result: EnrollmentResult; cert: Uint8Array; card: Uint8Array };

/**
 * The enrollee's half of the flow: sign a request for this browser's
 * keys, post it under the code the user typed, wait, and check what
 * comes back exactly as the paste path checks a paste.
 *
 * The check is not weaker for having come through a mailbox — it is the
 * same `validateEnrollment`, on the same bundle format `hlid cert
 * --bundle` writes. What the mailbox route adds is one thing the paste
 * did not need: the user typed a code rather than their identity's own
 * command, so *who this browser has become* is something to show them
 * and, after the first time, to check (`identity-enrollment.md` §5.5).
 */
export async function enrollWithCode(opts: CodeEnrollment): Promise<CodeOutcome> {
  const deviceEncPubHex = bytesToHex(opts.device.deviceEncPub);
  const device = hexToBytes(opts.device.devicePub);
  const request = await signEnrollRequest(opts.device.deviceSign, {
    device,
    deviceEnc: opts.device.deviceEncPub,
    name: opts.name,
    caps: opts.caps,
    days: opts.days,
    time: Math.floor(Date.now() / 1000),
    pair: opts.pairingSecret ? await pairTag(opts.pairingSecret, device) : undefined,
  });

  const secret = await postEnrollRequest(opts.mailbox, request, opts.code);
  const answer = await awaitAnswer(opts.mailbox, secret, opts.signal);
  if (answer.kind === 'denied') return { kind: 'denied', reason: answer.reason };
  if (answer.kind === 'gone') return { kind: 'gone' };

  const { cert, card } = decodeBundle(answer.bundle);
  const result = await validateEnrollment(
    cert,
    card,
    opts.device.devicePub,
    deviceEncPubHex,
    Math.floor(Date.now() / 1000),
  );
  if (opts.pinned !== null && opts.pinned !== result.fingerprint) {
    return { kind: 'identity-changed', was: opts.pinned, now: result.fingerprint, result, cert, card };
  }
  return { kind: 'enrolled', result, cert, card };
}
