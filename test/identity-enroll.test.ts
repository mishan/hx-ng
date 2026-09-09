import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  hexToBytes,
  pairTag,
  type DeviceCert,
} from '@hotline-ng/client';
import { decodeCanonical, mapGet } from '../packages/hotline-ng/src/cbor';

import {
  buildHlidCertCommand,
  enrollWithCode,
  needsRenewal,
  parseEnrollmentPaste,
  renewWithoutCode,
  validateEnrollment,
} from '../src/identity/enroll';
import type { StoredDevice } from '../src/identity/storage';
import { IdentityError } from '@hotline-ng/client';
import vectors from '../packages/hotline-ng/test/identity-vectors.json';

const certBytes = () => hexToBytes(vectors.device_cert.signed_hex);
const cardBytes = () => hexToBytes(vectors.card.signed_hex);
const devicePubHex = vectors.keys.device.public_hex;
const deviceEncPubHex = vectors.keys.device.public_enc_hex;

describe('buildHlidCertCommand', () => {
  it('embeds the device keys and the web capability', () => {
    const cmd = buildHlidCertCommand('aa'.repeat(32), 'bb'.repeat(32), { days: 90, name: 'Firefox' });
    expect(cmd).toContain('--device-pub aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(cmd).toContain('--device-enc-pub bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(cmd).toContain('--caps web');
    expect(cmd).toContain('--days 90');
    expect(cmd).toContain("'Firefox'");
    // One blob to paste, and the same object the mailbox path carries.
    expect(cmd).toContain('--bundle');
  });

  it('shell-quotes a name, server, or login that would otherwise break the command', () => {
    // A space alone would already split into extra shell words; the
    // quote is the sharper case, since it also has to survive *inside*
    // the quoting this function adds.
    const cmd = buildHlidCertCommand('aa'.repeat(32), 'bb'.repeat(32), { name: `Alice's phone` });
    expect(cmd).toContain(String.raw`--name 'Alice'\''s phone'`);
  });
});

describe('parseEnrollmentPaste', () => {
  it('accepts the certificate and card as two blobs, in either order', () => {
    const certB64 = bytesToBase64url(certBytes());
    const cardB64 = bytesToBase64url(cardBytes());

    const a = parseEnrollmentPaste(`${certB64} ${cardB64}`);
    expect(a.cert).toEqual(certBytes());
    expect(a.card).toEqual(cardBytes());

    const b = parseEnrollmentPaste(`${cardB64}\n${certB64}`);
    expect(b.cert).toEqual(certBytes());
    expect(b.card).toEqual(cardBytes());
  });

  it('accepts the certificate alone, leaving the card to a later step', () => {
    const parsed = parseEnrollmentPaste(bytesToBase64url(certBytes()));
    expect(parsed.cert).toEqual(certBytes());
    expect(parsed.card).toBeNull();
  });

  it('rejects nothing, garbage, or two of the same kind', () => {
    expect(() => parseEnrollmentPaste('   ')).toThrow();
    expect(() => parseEnrollmentPaste('not-base64url-cbor')).toThrow();
    const certB64 = bytesToBase64url(certBytes());
    expect(() => parseEnrollmentPaste(`${certB64} ${certB64}`)).toThrow();
  });
});

describe('validateEnrollment', () => {
  const issued = vectors.device_cert.fields.issued as number;
  const expires = vectors.device_cert.fields.expires as number;

  it('accepts a cert+card pair that matches this browser and each other', async () => {
    const result = await validateEnrollment(certBytes(), cardBytes(), devicePubHex, deviceEncPubHex, issued + 10);
    expect(result.fingerprint).toBe(vectors.keys.identity.fingerprint);
    expect(result.cert.name).toBe('browser');
    expect(result.card.name).toBe('Alice');
  });

  it('refuses a certificate for a different device key', async () => {
    await expect(validateEnrollment(certBytes(), cardBytes(), 'ff'.repeat(32), deviceEncPubHex, issued + 10)).rejects.toThrow();
  });

  it('refuses a certificate that has already expired', async () => {
    await expect(validateEnrollment(certBytes(), cardBytes(), devicePubHex, deviceEncPubHex, expires + 1)).rejects.toThrow();
  });
});

describe('needsRenewal', () => {
  const cert = (issued: number, expires: number) => ({ issued, expires }) as DeviceCert;

  it('is false well within the lifetime and true past two-thirds of it', () => {
    const issued = 1_000_000;
    const expires = issued + 90 * 24 * 3600;
    const oneThirdRemaining = issued + ((expires - issued) * 2) / 3;
    expect(needsRenewal(cert(issued, expires), issued)).toBe(false);
    expect(needsRenewal(cert(issued, expires), oneThirdRemaining - 1)).toBe(false);
    expect(needsRenewal(cert(issued, expires), oneThirdRemaining)).toBe(true);
    expect(needsRenewal(cert(issued, expires), expires)).toBe(true);
  });
});


// --- the bundle, and enrolling with a code ------------------------------

/** WebCrypto has no raw-seed import for an Ed25519 private key, only
 *  PKCS8; RFC 8410's encoding of a raw seed is this prefix plus the
 *  seed. Test-only — a real device key is generated in the browser and
 *  never imported from a seed at all. */
const PKCS8_ED25519_PREFIX = hexToBytes('302e020100300506032b657004220420');

async function importSeed(seedHex: string): Promise<CryptoKey> {
  const seed = hexToBytes(seedHex).subarray(0, 32);
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

async function storedDevice(): Promise<StoredDevice> {
  return {
    devicePub: devicePubHex,
    deviceSign: await importSeed(vectors.keys.device.seed_hex),
    // Never used for signing here; the request carries the public half.
    deviceEnc: await importSeed(vectors.keys.device.seed_hex),
    deviceEncPub: hexToBytes(deviceEncPubHex),
  };
}

function fetchReturning(replies: { status: number; body?: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = replies.shift();
      if (!next) throw new Error(`unexpected fetch: ${url}`);
      return { ok: next.status < 300, status: next.status, json: async () => next.body } as Response;
    }),
  );
  return calls;
}

describe('parseEnrollmentPaste, given a bundle', () => {
  it('takes one blob from `hlid cert --bundle` as both halves', () => {
    const parsed = parseEnrollmentPaste(bytesToBase64url(hexToBytes(vectors.bundle.encoded_hex)));
    expect(bytesToHex(parsed.cert)).toBe(vectors.device_cert.signed_hex);
    expect(bytesToHex(parsed.card!)).toBe(vectors.card.signed_hex);
  });

  it('refuses a bundle pasted alongside something else', () => {
    // A bundle already carries the card, so a second blob is a
    // contradiction rather than something to reconcile.
    const both = `${bytesToBase64url(hexToBytes(vectors.bundle.encoded_hex))} ${bytesToBase64url(cardBytes())}`;
    expect(() => parseEnrollmentPaste(both)).toThrow(/on its own/);
  });
});

describe('enrollWithCode', () => {
  const mailbox = { base: 'https://hl.example/identity/enroll' };
  const bundle = () => bytesToBase64url(hexToBytes(vectors.bundle.encoded_hex));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** The published certificate has a real expiry, so the clock is put
   *  inside its window rather than the vector being reissued. */
  function insideTheCertificatesLifetime() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date((vectors.device_cert.fields.issued + 60) * 1000));
  }

  it('signs for this browser, posts under the code, and keeps what verifies', async () => {
    insideTheCertificatesLifetime();
    const calls = fetchReturning([
      { status: 201, body: { request: 'sekrit' } },
      { status: 200, body: { bundle: bundle() } },
    ]);

    const outcome = await enrollWithCode({
      mailbox,
      code: 'K7PM-4XWE',
      device: await storedDevice(),
      name: 'Firefox on Linux',
      pinned: null,
    });

    expect(outcome.kind).toBe('enrolled');
    if (outcome.kind !== 'enrolled') return;
    expect(outcome.result.fingerprint).toBe(vectors.keys.identity.fingerprint);
    expect(bytesToHex(outcome.cert)).toBe(vectors.device_cert.signed_hex);

    // The request that went out is signed by this browser's key and
    // names its two public halves — the holder verifies exactly that.
    const posted = JSON.parse(calls[0]!.init!.body as string);
    expect(posted.code).toBe('K7PM-4XWE');
    expect(base64urlToBytes(posted.request).length).toBeGreaterThan(64);
  });

  it('stops on an identity it has not seen before, rather than storing it', async () => {
    // A hostile mailbox can hand back a bundle in which every signature
    // verifies and the identity is somebody else's. Nothing in the
    // codec catches that; what catches it is that this browser was
    // already somebody's device.
    insideTheCertificatesLifetime();
    fetchReturning([
      { status: 201, body: { request: 'sekrit' } },
      { status: 200, body: { bundle: bundle() } },
    ]);

    const outcome = await enrollWithCode({
      mailbox,
      code: 'K7PM-4XWE',
      device: await storedDevice(),
      pinned: 'a-different-identity-fingerprint',
    });

    expect(outcome.kind).toBe('identity-changed');
    if (outcome.kind !== 'identity-changed') return;
    expect(outcome.was).toBe('a-different-identity-fingerprint');
    expect(outcome.now).toBe(vectors.keys.identity.fingerprint);
  });

  it('passes a denial and an expiry back rather than throwing', async () => {
    insideTheCertificatesLifetime();
    fetchReturning([
      { status: 201, body: { request: 's' } },
      { status: 403, body: { denied: 'not_mine' } },
    ]);
    expect(await enrollWithCode({ mailbox, code: 'C', device: await storedDevice(), pinned: null })).toEqual({
      kind: 'denied',
      reason: 'not_mine',
    });

    fetchReturning([{ status: 201, body: { request: 's' } }, { status: 410 }]);
    expect(await enrollWithCode({ mailbox, code: 'C', device: await storedDevice(), pinned: null })).toEqual({
      kind: 'gone',
    });
  });

  it('folds a pairing tag into the request when the page was scanned', async () => {
    insideTheCertificatesLifetime();
    const calls = fetchReturning([
      { status: 201, body: { request: 's' } },
      { status: 200, body: { bundle: bundle() } },
    ]);
    const pairingSecret = new Uint8Array(16).fill(0x5a);

    await enrollWithCode({
      mailbox,
      code: 'K7PM-4XWE',
      device: await storedDevice(),
      // A scan pins the identity it expects before asking, so this is
      // the fingerprint off the QR code rather than one remembered from
      // a previous enrollment.
      pinned: vectors.keys.identity.fingerprint,
      pairingSecret,
    });

    const posted = JSON.parse(calls[0]!.init!.body as string);
    const decoded = decodeCanonical(base64urlToBytes(posted.request));
    const pair = mapGet(decoded, 'pair');
    expect(pair?.t).toBe('bytes');
    // The holder recomputes exactly this under the secret it drew, and
    // refuses the request outright if it does not match.
    const expected = await pairTag(pairingSecret, hexToBytes(devicePubHex));
    expect(bytesToHex((pair as { v: Uint8Array }).v)).toBe(bytesToHex(expected));
  });

  it('reports a scanned answer from the wrong identity without asking', async () => {
    // With a scan the pin came off the QR code, so a mismatch is not a
    // user changing identities — it is the answer not being from the
    // identity whose screen they photographed.
    insideTheCertificatesLifetime();
    fetchReturning([
      { status: 201, body: { request: 's' } },
      { status: 200, body: { bundle: bundle() } },
    ]);
    const outcome = await enrollWithCode({
      mailbox,
      code: 'K7PM-4XWE',
      device: await storedDevice(),
      pinned: 'zzzz'.repeat(13),
      pairingSecret: new Uint8Array(16).fill(0x5a),
    });
    expect(outcome.kind).toBe('identity-changed');
  });

  it('refuses a bundle certifying a device that is not this one', async () => {
    // The mailbox substituting an answer meant for somebody else. The
    // check is `validateEnrollment`'s, unchanged from the paste path —
    // which is the point of both routes carrying the same object.
    insideTheCertificatesLifetime();
    fetchReturning([
      { status: 201, body: { request: 's' } },
      { status: 200, body: { bundle: bundle() } },
    ]);
    const stranger = { ...(await storedDevice()), devicePub: 'ff'.repeat(32) };
    await expect(enrollWithCode({ mailbox, code: 'C', device: stranger, pinned: null })).rejects.toThrow(
      /different device key/,
    );
  });
});

describe('renewWithoutCode', () => {
  const mailbox = { base: 'https://hl.example/identity/enroll' };
  const bundle = () => bytesToBase64url(hexToBytes(vectors.bundle.encoded_hex));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function insideLifetime() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date((vectors.device_cert.fields.issued + 60) * 1000));
  }

  const renew = async (over: Record<string, unknown> = {}) =>
    renewWithoutCode({
      mailbox,
      device: await storedDevice(),
      prev: hexToBytes(vectors.device_cert.signed_hex),
      pinned: vectors.keys.identity.fingerprint,
      ...over,
    });

  it('posts the old certificate and no code at all', async () => {
    insideLifetime();
    const calls = fetchReturning([
      { status: 201, body: { request: 's' } },
      { status: 200, body: { bundle: bundle() } },
    ]);
    const outcome = await renew();
    expect(outcome.kind).toBe('renewed');

    const posted = JSON.parse(calls[0]!.init!.body as string);
    // No code: the mailbox routes this by the identity `prev` names,
    // straight to whoever is running `hlid agent` (§8). That is the
    // whole reason the user types nothing.
    expect(posted).not.toHaveProperty('code');

    const decoded = decodeCanonical(base64urlToBytes(posted.request));
    expect(mapGet(decoded, 'prev')?.t).toBe('bytes');
    // And no `caps`: absent means "whatever your policy gives", and a
    // renewal is narrowed by the certificate it replaces anyway. Naming
    // them here would only be a way to ask for less by accident.
    expect(mapGet(decoded, 'caps')).toBeUndefined();
  });

  it('reports no-holder rather than throwing, since it is the ordinary case', async () => {
    // No `hlid agent` running. Nothing is wrong; there is just nobody
    // to ask, and the panel falls back to a code or the paste.
    insideLifetime();
    fetchReturning([{ status: 404, body: { error: 'no_holder' } }]);
    expect((await renew()).kind).toBe('no-holder');
  });

  it('tells no-holder from any other 404 by the code, not the wording', async () => {
    // The message is for a person and will be reworded or localized.
    // Branching on it — as this first did — makes editing a sentence
    // change what the program does.
    insideLifetime();
    fetchReturning([{ status: 404, body: { error: 'unknown_code' } }]);
    await expect(renew()).rejects.toThrow(IdentityError);

    fetchReturning([{ status: 404, body: {} }]);
    await expect(renew()).rejects.toThrow(IdentityError);
  });

  it('passes a denial back rather than papering over it', async () => {
    // A renewal for a browser its owner was not using is the one signal
    // a copied profile gives, so a "no" is worth surfacing.
    insideLifetime();
    fetchReturning([
      { status: 201, body: { request: 's' } },
      { status: 403, body: { denied: 'not_mine' } },
    ]);
    expect(await renew()).toEqual({ kind: 'denied', reason: 'not_mine' });
  });

  it('refuses a renewal that comes back from a different identity', async () => {
    // Unlike a first enrollment there is nothing to ask about: this
    // browser already belongs to somebody and asked *them*.
    insideLifetime();
    fetchReturning([
      { status: 201, body: { request: 's' } },
      { status: 200, body: { bundle: bundle() } },
    ]);
    await expect(renew({ pinned: 'zzzz'.repeat(13) })).rejects.toThrow(/came back from identity/);
  });
});
