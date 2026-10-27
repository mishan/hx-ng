import { describe, expect, it } from 'vitest';

import { decodeCanonical, encode, mapGet, mapWithout, type CborValue } from '../src/cbor';
import { isStrongKey, verifyStrict } from '../src/ed25519';
import { hexToBytes } from '../src/identity';

import vectors from './identity-vectors.json';
import rfc8032 from './rfc8032-vectors.json';

const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function bytesOf(v: CborValue | undefined): Uint8Array {
  if (v?.t !== 'bytes') throw new Error('not a byte string');
  return v.v;
}

/** The key, signature and signed message of a whole lobby line, its key
 *  the `device` of the certificate it carries. */
function chatLine(hex: string) {
  const line = decodeCanonical(hexToBytes(hex));
  const cert = decodeCanonical(bytesOf(mapGet(line, 'cert')));
  const unsigned = encode(mapWithout(line, 'sig'));
  return {
    key: bytesOf(mapGet(cert, 'device')),
    sig: bytesOf(mapGet(line, 'sig')),
    message: new Uint8Array([...new TextEncoder().encode('hl-identity/chat/v1'), 0, ...unsigned]),
  };
}

function withS(sig: Uint8Array, s: bigint): Uint8Array {
  const out = sig.slice();
  for (let i = 0; i < 32; i++) out[32 + i] = Number((s >> BigInt(8 * i)) & 0xffn);
  return out;
}

describe('verifyStrict', () => {
  it.each(rfc8032.map((v) => [v.name, v] as const))('accepts RFC 8032 §7.1 %s', async (_, v) => {
    const key = hexToBytes(v.public_hex);
    expect(isStrongKey(key)).toBe(true);
    await expect(verifyStrict(key, hexToBytes(v.message_hex), hexToBytes(v.signature_hex))).resolves.toBe(true);
  });

  it('refuses a signature changed anywhere, and S + L, which only S < L keeps out', async () => {
    const v = rfc8032.find((t) => t.name === 'TEST 2')!;
    const key = hexToBytes(v.public_hex);
    const message = hexToBytes(v.message_hex);
    const sig = hexToBytes(v.signature_hex);
    for (const at of [0, 31, 32, 63]) {
      const bad = sig.slice();
      bad[at]! ^= 1;
      await expect(verifyStrict(key, message, bad)).resolves.toBe(false);
    }
    await expect(verifyStrict(key, Uint8Array.of(message[0]! ^ 1), sig)).resolves.toBe(false);
    const s = hexToBytes(v.signature_hex.slice(64)).reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
    await expect(verifyStrict(key, message, withS(sig, s + L))).resolves.toBe(false);
  });

  it('accepts a mixed-order key under the cofactorless equation, and refuses one only the cofactored holds for', async () => {
    const { accepted, rejected, device_hex } = vectors.mixed_order_key;
    expect(isStrongKey(hexToBytes(device_hex))).toBe(true);
    const ok = chatLine(accepted.signed_hex);
    await expect(verifyStrict(ok.key, ok.message, ok.sig)).resolves.toBe(true);
    const bad = chatLine(rejected.signed_hex);
    await expect(verifyStrict(bad.key, bad.message, bad.sig)).resolves.toBe(false);
  });

  // The rest of message_rejects are refused before any signature is checked.
  const refusedBySignature = vectors.message_rejects.filter(
    (r) => r.object === 'chat_line' && r.form === 'whole' && (r.error === 'InvalidKey' || r.error === 'BadSignature'),
  );

  it.each(refusedBySignature.map((r) => [r.name, r] as const))('refuses %s', async (_, r) => {
    const { key, message, sig } = chatLine(r.hex);
    expect(isStrongKey(key)).toBe(r.error !== 'InvalidKey');
    await expect(verifyStrict(key, message, sig)).resolves.toBe(false);
  });

  it('verifies what WebCrypto signs, and nothing else', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const key = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    for (let i = 0; i < 16; i++) {
      const message = crypto.getRandomValues(new Uint8Array(i * 37));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, message));
      await expect(verifyStrict(key, message, sig)).resolves.toBe(true);
      const other = new Uint8Array([...message, 0]);
      await expect(verifyStrict(key, other, sig)).resolves.toBe(false);
    }
  });
});
