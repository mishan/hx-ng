import { afterEach, describe, expect, it, vi } from 'vitest';

import { CborError, cBytes, cMap, cText, cUint, decodeCanonical, encode, mapGet } from '../src/cbor';
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
  decodeBundle,
  openBundle,
  pairTag,
  signEnrollRequest,
  signLoginProof,
  verifyEnvelope,
  wsToHttp,
  DEVICE_CERT_DOMAIN,
  CARD_DOMAIN,
  PAIRING_SECRET_BYTES,
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

/** A minimally-populated card signed by an arbitrary key — for building
 *  the one case the vectors cannot hold, a bundle whose two halves name
 *  different identities. Production code never signs a card. */
async function signCardAs(seedHex: string, publicHex: string, name: string): Promise<Uint8Array> {
  const key = await importSeed(seedHex);
  const unsigned: [string, ReturnType<typeof cUint>][] = [
    ['v', cUint(1)],
    ['identity', cBytes(hexToBytes(publicHex))],
    ['name', cText(name)],
    ['updated', cUint(1757116860)],
  ];
  const body = encode(cMap(unsigned));
  const message = new Uint8Array([...new TextEncoder().encode(CARD_DOMAIN), 0, ...body]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message));
  return encode(cMap([...unsigned, ['sig', cBytes(sig)]]));
}

function encodeBundle(cert: Uint8Array, card: Uint8Array): Uint8Array {
  return encode(cMap([['v', cUint(1)], ['card', cBytes(card)], ['cert', cBytes(cert)]]));
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

describe('signEnrollRequest', () => {
  it('produces the exact bytes hxd-ng does, every field populated', async () => {
    // The vector is a renewal that also carries a scanned `pair`, so one
    // case covers every optional field at once. Ed25519 is
    // deterministic, so "the same bytes" is a meaningful assertion
    // rather than "a valid signature".
    const deviceKey = await importSeed(vectors.keys.device.seed_hex);
    const f = vectors.enroll_request.fields;
    const signed = await signEnrollRequest(deviceKey, {
      device: hexToBytes(f.device),
      deviceEnc: hexToBytes(f.device_enc),
      name: f.name,
      caps: f.caps,
      days: f.days,
      time: f.time,
      // `prev` is the device certificate the file publishes above, not a
      // second invented one — a renewal is about a certificate that
      // already exists.
      prev: hexToBytes(vectors.device_cert.signed_hex),
      pair: hexToBytes(f.pair),
    });
    expect(bytesToHex(signed)).toBe(vectors.enroll_request.signed_hex);
  });

  it('omits what was not asked for rather than sending a default', async () => {
    // A request with no `caps` means "whatever your policy gives a
    // device of this kind" (§4). Encoding a zero there would mean "no
    // capabilities", which is a different and much worse thing to ask
    // for.
    const deviceKey = await importSeed(vectors.keys.device.seed_hex);
    const signed = await signEnrollRequest(deviceKey, {
      device: hexToBytes(vectors.keys.device.public_hex),
      deviceEnc: hexToBytes(vectors.keys.device.public_enc_hex),
      time: 1757116860,
    });
    const decoded = decodeCanonical(signed);
    for (const absent of ['caps', 'days', 'name', 'prev', 'pair']) {
      expect(mapGet(decoded, absent), absent).toBeUndefined();
    }
  });

  it('refuses a device name a certificate could not carry', async () => {
    const deviceKey = await importSeed(vectors.keys.device.seed_hex);
    const req = (name: string) =>
      signEnrollRequest(deviceKey, {
        device: hexToBytes(vectors.keys.device.public_hex),
        deviceEnc: hexToBytes(vectors.keys.device.public_enc_hex),
        time: 1757116860,
        name,
      });
    // Refusing here rather than letting the holder rewrite it: the name
    // goes into a certificate as offered, and one the certificate rules
    // reject is a request that cannot be granted as asked.
    await expect(req('  padded  ')).rejects.toThrow(IdentityError);
    await expect(req('   ')).rejects.toThrow(IdentityError);
    await expect(req('x'.repeat(65))).rejects.toThrow(IdentityError);
  });
});

describe('pairTag', () => {
  it('matches hxd-ng, and binds one device to one secret', async () => {
    const secret = hexToBytes(vectors.enroll_request.pairing_secret_hex);
    const device = hexToBytes(vectors.keys.device.public_hex);
    expect(secret.length).toBe(PAIRING_SECRET_BYTES);
    expect(bytesToHex(await pairTag(secret, device))).toBe(vectors.enroll_request.fields.pair);

    // A different device under the same secret is a different tag —
    // which is what stops a mailbox splicing a real tag onto a key of
    // its own (§5.6).
    const other = hexToBytes(vectors.keys.identity.public_hex);
    expect(bytesToHex(await pairTag(secret, other))).not.toBe(vectors.enroll_request.fields.pair);
  });

  it('refuses a secret that is not 16 bytes', async () => {
    await expect(pairTag(new Uint8Array(15), new Uint8Array(32))).rejects.toThrow(IdentityError);
  });
});

describe('decodeBundle / openBundle', () => {
  const encoded = () => hexToBytes(vectors.bundle.encoded_hex);

  it('decodes to the exact certificate and card hxd-ng put in it', () => {
    const b = decodeBundle(encoded());
    expect(bytesToHex(b.cert)).toBe(vectors.device_cert.signed_hex);
    expect(bytesToHex(b.card)).toBe(vectors.card.signed_hex);
  });

  it('opens to both objects and the identity they agree on', async () => {
    const { cert, card } = await openBundle(encoded());
    expect(bytesToHex(cert.identity)).toBe(vectors.keys.identity.public_hex);
    expect(bytesToHex(card.identity)).toBe(bytesToHex(cert.identity));
    expect(card.name).toBe(vectors.card.fields.name);
  });

  it('refuses a card belonging to an identity other than the certificate names', async () => {
    // Both halves genuine, both signatures valid, and the name shown
    // beside the fingerprint would be somebody else's — a hostile
    // mailbox's substituted answer (§9). Nothing but this comparison
    // catches it, so the case is worth building rather than assuming.
    //
    // The stand-in second identity is the device key from the vectors:
    // it is a real Ed25519 key this test can sign with, and it is not
    // the identity the certificate names, which is all that matters.
    const foreignCard = await signCardAs(vectors.keys.device.seed_hex, vectors.keys.device.public_hex, 'Mallory');
    const bundle = encodeBundle(hexToBytes(vectors.device_cert.signed_hex), foreignCard);

    // It decodes fine — the shape is not what is wrong with it.
    expect(decodeBundle(bundle).card).toEqual(foreignCard);
    await expect(openBundle(bundle)).rejects.toThrow(/different identities/);

    // And the card on its own is genuine, so the rejection is the
    // pairing and not a broken signature.
    await expect(verifyEnvelope(foreignCard, hexToBytes(vectors.keys.device.public_hex), CARD_DOMAIN)).resolves.toBeDefined();
  });

  it('refuses a bundle bigger than its members could be', () => {
    expect(() => decodeBundle(new Uint8Array(4 * 1024 + 16 * 1024 + 257))).toThrow(IdentityError);
  });
});

describe('wsToHttp', () => {
  it('swaps the scheme and drops the path when there is no page origin to be relative to', () => {
    // Node has no `location` global, so this exercises the "outside a
    // browser" branch — the same one a bot or a bridge gets.
    expect(wsToHttp('ws://localhost:5700/ng')).toBe('http://localhost:5700');
    expect(wsToHttp('wss://hotline.example.org/ng')).toBe('https://hotline.example.org');
  });

  describe('in a browser', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('is page-relative when the target shares this page\'s hostname', () => {
      // The identity endpoints and the ng WebSocket are almost never on
      // the page's own origin (a different port) — a same-hostname
      // target is "the client sitting in front of its own server", and
      // an absolute cross-origin URL there would just be refused by
      // the browser, since nothing in hxd-ng sends CORS headers.
      vi.stubGlobal('location', { hostname: 'localhost' });
      expect(wsToHttp('ws://localhost:5700/ng')).toBe('');
    });

    it('is absolute for a genuinely different server', () => {
      vi.stubGlobal('location', { hostname: 'localhost' });
      expect(wsToHttp('wss://hotline.example.org/ng')).toBe('https://hotline.example.org');
    });
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
