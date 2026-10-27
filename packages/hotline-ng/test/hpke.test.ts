// rfc9180-vectors.json is hxd-ng's crates/hl-identity/tests/rfc9180-vectors.json,
// byte for byte: the CFRG's test-vectors.json from
// github.com/cfrg/draft-irtf-cfrg-hpke at commit
// 5f503c564da00b0687b3de75f1dfbdfc4079ad31, cut to a sealed message's suite
// (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM) in base and auth
// mode and to each one's first encryption, the only one a single-shot seal
// makes.

import { describe, expect, it } from 'vitest';

import { HpkeError, deriveX25519Secret, hpkeOpen, hpkeSeal, importX25519Secret, x25519PublicKey } from '../src/hpke';
import { bytesToHex, hexToBytes } from '../src/identity';

import vectors from './rfc9180-vectors.json';

const V = vectors as Record<string, any>[];
const hex = hexToBytes;

describe('RFC 9180 vectors', () => {
  it.each(V.map((v) => [v.mode, v] as const))('mode %i', async (_, v) => {
    expect([v.kem_id, v.kdf_id, v.aead_id]).toEqual([0x20, 1, 2]);
    const pairs: [string, string, string][] = [
      [v.ikmR, v.skRm, v.pkRm],
      [v.ikmE, v.skEm, v.pkEm],
    ];
    if (v.ikmS) pairs.push([v.ikmS, v.skSm, v.pkSm]);
    for (const [ikm, sk, pk] of pairs) {
      expect(bytesToHex(await deriveX25519Secret(hex(ikm)))).toBe(sk);
      expect(bytesToHex(await x25519PublicKey(await importX25519Secret(hex(sk))))).toBe(pk);
    }
    const sender = v.skSm ? { sk: await importX25519Secret(hex(v.skSm)), pk: hex(v.pkSm) } : null;
    const c = v.encryptions[0];
    const { enc, ct } = await hpkeSeal(hex(v.pkRm), hex(v.info), hex(c.aad), hex(c.pt), sender, hex(v.ikmE));
    expect(bytesToHex(enc)).toBe(v.enc);
    expect(bytesToHex(ct)).toBe(c.ct);
    const skR = await importX25519Secret(hex(v.skRm));
    const opened = await hpkeOpen(enc, skR, hex(v.info), hex(c.aad), ct, sender?.pk ?? null);
    expect(bytesToHex(opened)).toBe(c.pt);
  });
});

describe('an X25519 result of all zeros', () => {
  const zero = new Uint8Array(32);
  const one = new Uint8Array(32);
  one[0] = 1;

  it('is refused in either mode, sealing or opening', async () => {
    const recipient = await importX25519Secret(new Uint8Array(32).fill(8));
    const pkR = await x25519PublicKey(recipient);
    const sender = { sk: await importX25519Secret(new Uint8Array(32).fill(2)), pk: zero };
    const info = new Uint8Array([1]);
    const pt = new Uint8Array([2]);
    const { enc, ct } = await hpkeSeal(pkR, info, info, pt, null, new Uint8Array(32).fill(1));
    const cases: [string, () => Promise<unknown>][] = [
      ['sealed to the zero point', () => hpkeSeal(zero, info, info, pt, null)],
      ['sealed to a point of order 4', () => hpkeSeal(one, info, info, pt, null)],
      ['sealed in auth mode to the zero point', () => hpkeSeal(zero, info, info, pt, sender)],
      ['opened from the zero point as enc', () => hpkeOpen(zero, recipient, info, info, ct, null)],
      ['opened in auth mode from the zero point as pkS', () => hpkeOpen(enc, recipient, info, info, ct, zero)],
    ];
    for (const [name, run] of cases) {
      await expect(run(), name).rejects.toBeInstanceOf(HpkeError);
    }
    expect(await hpkeOpen(enc, recipient, info, info, ct, null)).toEqual(pt);
  });
});
