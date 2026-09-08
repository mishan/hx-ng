/**
 * The enrolment ceremony (`docs/identity-keys.md` §7.1): build the
 * commands the identity panel shows, parse what the user pastes back,
 * and check it before it's ever trusted.
 *
 * `docs/identity-keys.md` §7.1 step 3 describes `hlid cert -o web.bundle`
 * writing the certificate and card together as one pasteable blob, and
 * §9 says plainly that `hlid` can't do either of those things yet — it
 * has no `--device-pub`/`--device-enc-pub` (it can only certify a device
 * seed it already holds) and no combined bundle output. So this module
 * accepts what today's `hlid cert` and `hlid card` actually produce:
 * one or two base64url blobs, in either order, told apart by shape
 * rather than position.
 */

import {
  CARD_DOMAIN,
  DEVICE_CERT_DOMAIN,
  IdentityError,
  base64urlToBytes,
  bytesToHex,
  decodeCard,
  decodeDeviceCert,
  fingerprintOf,
  verifyEnvelope,
  type Card,
  type DeviceCert,
} from '@hotline-ng/client';

export function buildHlidCertCommand(
  devicePubHex: string,
  deviceEncPubHex: string,
  opts: { days?: number; name?: string } = {},
): string {
  const days = opts.days ?? 90;
  const name = opts.name ?? 'browser';
  return `hlid cert --device-pub ${devicePubHex} --device-enc-pub ${deviceEncPubHex} --caps web --days ${days} --name "${name}" -o web.bundle`;
}

export function buildHlidLinkCommand(server: string, login: string): string {
  return `hlid link --server ${server} --login ${login} --password-stdin`;
}

export interface ParsedPaste {
  cert: Uint8Array;
  card: Uint8Array | null;
}

/** Which of `hlid`'s two output shapes a decoded blob is — told apart by
 *  which required fields decode successfully, not by position. */
function classify(bytes: Uint8Array): 'cert' | 'card' {
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
    throw new IdentityError('bad-field', 'this does not decode as either a device certificate or a card');
  }
}

/** One or two whitespace-separated base64url blobs — what pasting the
 *  output of `hlid cert -o cert.bin` and, optionally, `hlid card -o
 *  card.bin` on the same line or across two lines actually looks like. */
export function parseEnrolmentPaste(input: string): ParsedPaste {
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

  let cert: Uint8Array | null = null;
  let card: Uint8Array | null = null;
  for (const bytes of decoded) {
    if (classify(bytes) === 'cert') {
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

export interface EnrolmentResult {
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
export async function validateEnrolment(
  certBytes: Uint8Array,
  cardBytes: Uint8Array,
  devicePubHex: string,
  deviceEncPubHex: string,
  now: number,
): Promise<EnrolmentResult> {
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
 *  point §3.3 and §7.2 say to start nagging. */
export function needsRenewal(cert: DeviceCert, now: number): boolean {
  const lifetime = cert.expires - cert.issued;
  return now >= cert.issued + (lifetime * 2) / 3;
}

/** `GET /identity/card/<fingerprint>` — only useful for a *second*
 *  browser: the server can only serve a card it has already cached from
 *  this identity authenticating somewhere, so a first-time enrolment
 *  still needs the card pasted. `null` on 404, not an error — "no card
 *  cached yet" is the expected answer the first time. */
export async function fetchCardFallback(httpBase: string, fingerprint: string): Promise<Uint8Array | null> {
  const res = await fetch(`${httpBase}/identity/card/${fingerprint}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new IdentityError('server-error', `GET /identity/card: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
