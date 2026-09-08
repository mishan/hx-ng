import { afterEach, describe, expect, it, vi } from 'vitest';

import { CborError, decodeCanonical } from '../src/cbor';
import {
  CAPS,
  AuthError,
  IdentityError,
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  decodeCard,
  decodeDeviceCert,
  fingerprintOf,
  hexToBytes,
  postAuth,
  signLoginProof,
  verifyEnvelope,
  wsToHttp,
  DEVICE_CERT_DOMAIN,
  CARD_DOMAIN,
} from '../src/identity';

import vectors from './identity-vectors.json';

/** WebCrypto has no `importKey('raw', seed, ...)` for an Ed25519
 *  *private* key (Node throws `Unsupported key usage`) — only PKCS8.
 *  RFC 8410's PKCS8 encoding of a raw 32-byte seed is this fixed
 *  16-byte prefix followed by the seed; test-only, since production
 *  code never sees a raw seed at all — device keys are generated
 *  in-browser and never imported from one. */
const PKCS8_ED25519_PREFIX = hexToBytes('302e020100300506032b657004220420');

async function importSeed(seedHex: string): Promise<CryptoKey> {
  const seed = hexToBytes(seedHex).subarray(0, 32);
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

describe('fingerprintOf', () => {
  it('matches hxd-ng for the identity and device test keys', async () => {
    expect(await fingerprintOf(hexToBytes(vectors.keys.identity.public_hex))).toBe(vectors.keys.identity.fingerprint);
    expect(await fingerprintOf(hexToBytes(vectors.keys.device.public_hex))).toBe(vectors.keys.device.fingerprint);
  });
});

describe('decodeDeviceCert', () => {
  it('matches hxd-ng field-for-field', () => {
    const cert = decodeDeviceCert(hexToBytes(vectors.device_cert.signed_hex));
    const f = vectors.device_cert.fields;
    expect(bytesToHex(cert.identity)).toBe(f.identity);
    expect(bytesToHex(cert.device)).toBe(f.device);
    expect(bytesToHex(cert.deviceEnc)).toBe(f.device_enc);
    expect(cert.issued).toBe(f.issued);
    expect(cert.expires).toBe(f.expires);
    expect(cert.caps).toBe(f.caps);
    expect(cert.caps).toBe(CAPS.WEB);
    expect(cert.name).toBe(f.name);
  });

  it('verifies against the identity key that signed it', async () => {
    const bytes = hexToBytes(vectors.device_cert.signed_hex);
    await expect(verifyEnvelope(bytes, hexToBytes(vectors.keys.identity.public_hex), DEVICE_CERT_DOMAIN)).resolves.toBeDefined();
  });
});

describe('decodeCard', () => {
  it('matches hxd-ng for the fields a Phase B client reads', () => {
    const card = decodeCard(hexToBytes(vectors.card.signed_hex));
    const f = vectors.card.fields;
    expect(bytesToHex(card.identity)).toBe(f.identity);
    expect(card.updated).toBe(f.updated);
    expect(card.name).toBe(f.name);
  });

  it('verifies against the identity key that signed it', async () => {
    const bytes = hexToBytes(vectors.card.signed_hex);
    await expect(verifyEnvelope(bytes, hexToBytes(vectors.keys.identity.public_hex), CARD_DOMAIN)).resolves.toBeDefined();
  });
});

describe('signLoginProof', () => {
  it('produces the exact bytes hxd-ng does, Ed25519 being deterministic', async () => {
    const deviceKey = await importSeed(vectors.keys.device.seed_hex);
    const f = vectors.login_proof.object.fields;
    const sealed = await signLoginProof(deviceKey, {
      challenge: hexToBytes(f.challenge),
      serverKey: hexToBytes(f.server_key),
      device: hexToBytes(f.device),
      time: f.time,
    });
    expect(bytesToHex(sealed)).toBe(vectors.login_proof.object.signed_hex);
  });
});

describe('wsToHttp', () => {
  it('swaps the scheme and drops the path', () => {
    expect(wsToHttp('ws://localhost:5700/ng')).toBe('http://localhost:5700');
    expect(wsToHttp('wss://hotline.example.org/ng')).toBe('https://hotline.example.org');
  });
});

describe('base64url codec', () => {
  it('round-trips through all three byte-length remainders', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 31, 32]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      expect(base64urlToBytes(bytesToBase64url(bytes))).toEqual(bytes);
    }
  });

  it('matches a known vector and uses no padding', () => {
    // "any carnal pleas" -> RFC 4648 §10's own base64 test vector, minus
    // the trailing "=" padding base64url omits.
    const text = new TextEncoder().encode('any carnal pleas');
    expect(bytesToBase64url(text)).toBe('YW55IGNhcm5hbCBwbGVhcw');
    expect(base64urlToBytes('YW55IGNhcm5hbCBwbGVhcw')).toEqual(text);
  });

  it('tolerates standard base64 characters and trailing padding on decode', () => {
    const bytes = Uint8Array.of(0xfb, 0xff, 0xbf);
    const url = bytesToBase64url(bytes);
    const standard = url.replace(/-/g, '+').replace(/_/g, '/');
    expect(base64urlToBytes(standard)).toEqual(bytes);
    expect(base64urlToBytes(`${standard}==`)).toEqual(bytes);
  });

  it('rejects a character outside the alphabet', () => {
    expect(() => base64urlToBytes('not valid base64url!')).toThrow(IdentityError);
  });
});

describe('postAuth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const req = { card: Uint8Array.of(1), deviceCert: Uint8Array.of(2), proof: Uint8Array.of(3) };

  it('parses a successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ token: 'tok', expires_in: 60, fingerprint: 'fp', outcome: 'guest' }),
            { status: 200 },
          ),
      ),
    );
    const success = await postAuth('https://host/identity/auth', req);
    expect(success).toMatchObject({ token: 'tok', outcome: 'guest', handle: null, account: null });
  });

  it('reports the server error code and text on a well-formed refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'bad_cert', text: 'nope' }), { status: 401 })),
    );
    await expect(postAuth('https://host/identity/auth', req)).rejects.toMatchObject({
      code: 'bad_cert',
      message: 'nope',
    });
  });

  it('reports a non-JSON error body as an AuthError naming the status, not a bare SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })));
    const failure = await postAuth('https://host/identity/auth', req).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AuthError);
    expect((failure as AuthError).message).toContain('502');
  });
});

describe('rejects', () => {
  // Some vectors fail at decode (a shape or field problem); "one bit
  // flipped in device_enc" decodes fine — device_enc is still 32 bytes,
  // just the wrong 32 bytes — and only fails once the signature is
  // checked, so it's routed through `verifyEnvelope` instead.
  const byName = (name: string): { hex: string } => {
    const found = vectors.rejects.find((r: { name: string }) => r.name === name);
    if (!found) throw new Error(`no reject vector named ${name}`);
    return found;
  };

  it.each([
    'duplicate map key, otherwise in canonical order',
    'map keys out of canonical order',
    'display name over 32 characters',
    'zero-width space in display name',
    'space-only display name',
    'trailing space in display name',
    'leading space in display name',
    'version 0',
  ])('card: %s', (name) => {
    const bytes = hexToBytes(byName(name).hex);
    expect(() => decodeCard(bytes)).toThrow();
  });

  it.each(['empty device certificate name', 'unsupported version 2'])('device_cert: %s', (name) => {
    const bytes = hexToBytes(byName(name).hex);
    expect(() => decodeDeviceCert(bytes)).toThrow(IdentityError);
  });

  it('device_cert: one bit flipped in device_enc decodes, but fails signature verification', async () => {
    const bytes = hexToBytes(byName('one bit flipped in device_enc').hex);
    const cert = decodeDeviceCert(bytes); // shape is fine
    expect(cert).toBeDefined();
    await expect(verifyEnvelope(bytes, hexToBytes(vectors.keys.identity.public_hex), DEVICE_CERT_DOMAIN)).rejects.toThrow(
      IdentityError,
    );
  });

  it.each(['non-shortest integer head', 'trailing byte'])('login_proof: %s', (name) => {
    const bytes = hexToBytes(byName(name).hex);
    expect(() => decodeCanonical(bytes)).toThrow(CborError);
  });
});
