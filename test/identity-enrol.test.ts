import { describe, expect, it } from 'vitest';

import { bytesToBase64url, hexToBytes, type DeviceCert } from '@hotline-ng/client';

import {
  buildHlidCertCommand,
  buildHlidLinkCommand,
  needsRenewal,
  parseEnrolmentPaste,
  validateEnrolment,
} from '../src/identity/enrol';
import vectors from '../packages/hotline-ng/test/identity-vectors.json';

const certBytes = () => hexToBytes(vectors.device_cert.signed_hex);
const cardBytes = () => hexToBytes(vectors.card.signed_hex);
const devicePubHex = vectors.keys.device.public_hex;
const deviceEncPubHex = vectors.keys.device.public_enc_hex;

describe('buildHlidCertCommand / buildHlidLinkCommand', () => {
  it('embeds the device keys and the web capability', () => {
    const cmd = buildHlidCertCommand('aa'.repeat(32), 'bb'.repeat(32), { days: 90, name: 'Firefox' });
    expect(cmd).toContain('--device-pub aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(cmd).toContain('--device-enc-pub bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(cmd).toContain('--caps web');
    expect(cmd).toContain('--days 90');
    expect(cmd).toContain('"Firefox"');
  });

  it('names the server and account for the link line', () => {
    expect(buildHlidLinkCommand('https://hotline.example.org', 'alice')).toBe(
      'hlid link --server https://hotline.example.org --login alice --password-stdin',
    );
  });
});

describe('parseEnrolmentPaste', () => {
  it('accepts the certificate and card as two blobs, in either order', () => {
    const certB64 = bytesToBase64url(certBytes());
    const cardB64 = bytesToBase64url(cardBytes());

    const a = parseEnrolmentPaste(`${certB64} ${cardB64}`);
    expect(a.cert).toEqual(certBytes());
    expect(a.card).toEqual(cardBytes());

    const b = parseEnrolmentPaste(`${cardB64}\n${certB64}`);
    expect(b.cert).toEqual(certBytes());
    expect(b.card).toEqual(cardBytes());
  });

  it('accepts the certificate alone, leaving the card to a later step', () => {
    const parsed = parseEnrolmentPaste(bytesToBase64url(certBytes()));
    expect(parsed.cert).toEqual(certBytes());
    expect(parsed.card).toBeNull();
  });

  it('rejects nothing, garbage, or two of the same kind', () => {
    expect(() => parseEnrolmentPaste('   ')).toThrow();
    expect(() => parseEnrolmentPaste('not-base64url-cbor')).toThrow();
    const certB64 = bytesToBase64url(certBytes());
    expect(() => parseEnrolmentPaste(`${certB64} ${certB64}`)).toThrow();
  });
});

describe('validateEnrolment', () => {
  const issued = vectors.device_cert.fields.issued as number;
  const expires = vectors.device_cert.fields.expires as number;

  it('accepts a cert+card pair that matches this browser and each other', async () => {
    const result = await validateEnrolment(certBytes(), cardBytes(), devicePubHex, deviceEncPubHex, issued + 10);
    expect(result.fingerprint).toBe(vectors.keys.identity.fingerprint);
    expect(result.cert.name).toBe('browser');
    expect(result.card.name).toBe('Alice');
  });

  it('refuses a certificate for a different device key', async () => {
    await expect(validateEnrolment(certBytes(), cardBytes(), 'ff'.repeat(32), deviceEncPubHex, issued + 10)).rejects.toThrow();
  });

  it('refuses a certificate that has already expired', async () => {
    await expect(validateEnrolment(certBytes(), cardBytes(), devicePubHex, deviceEncPubHex, expires + 1)).rejects.toThrow();
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
