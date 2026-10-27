import { afterEach, describe, expect, it, vi } from 'vitest';

import { CborError, cBytes, cMap, cText, cUint, decodeCanonical, encode, mapGet } from '../src/cbor';
import {
  CAPS,
  AuthError,
  IdentityError,
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  canonicalHost,
  decodeCard,
  decodeDeviceCert,
  fingerprintFromString,
  fingerprintOf,
  hexToBytes,
  postAuth,
  decodeBundle,
  decodeServerChallenge,
  fetchChallenge,
  fetchDiscovery,
  openBundle,
  pairTag,
  signEnrollRequest,
  signLoginProof,
  verifyEnvelope,
  verifyServerChallenge,
  wsToHttp,
  SERVER_CHALLENGE_SKEW_SECONDS,
  DEVICE_CERT_DOMAIN,
  CARD_DOMAIN,
  PAIRING_SECRET_BYTES,
  SERVER_CHALLENGE_REFUSED,
  WRONG_HOST,
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

describe('fingerprintFromString', () => {
  const id = vectors.keys.identity;
  const digest = (hexKey: string) => crypto.subtle.digest('SHA-256', hexToBytes(hexKey) as BufferSource);
  const fp = id.fingerprint;
  // keys.rs's own cases, and its Crockford confusables.
  it.each([
    ['its own display form', fp, true],
    ['in upper case', fp.toUpperCase(), true],
    ['with o for 0, I for 1 and l for 1', fp.replaceAll('0', 'o').replace('1', 'I').replace('1', 'l'), true],
    ['a digit short', fp.slice(0, 51), false],
    ['a digit long', `${fp}0`, false],
    ['with nonzero padding bits', `${fp.slice(0, 51)}z`, false],
    ['with a digit outside the alphabet', 'u'.repeat(52), false],
    ['with a separator', `${fp.slice(0, 26)}-${fp.slice(27)}`, false],
    ['with the Kelvin sign for k', fp.replace(/k/, String.fromCharCode(0x212a)), false],
  ])('%s', async (_, s, ok) => {
    const want = ok ? new Uint8Array(await digest(id.public_hex)) : null;
    expect(fingerprintFromString(s)).toEqual(want);
  });

  it('spells the ends of the range', () => {
    expect(fingerprintFromString('0'.repeat(52))).toEqual(new Uint8Array(32));
    expect(fingerprintFromString(`${'z'.repeat(51)}g`)).toEqual(new Uint8Array(32).fill(0xff));
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
    const f = vectors.login_proof_v2.object.fields;
    const fields = { challenge: hexToBytes(f.challenge), serverKey: hexToBytes(f.server_key), device: hexToBytes(f.device), time: f.time };
    // Signed in canonical form whatever form it was handed in.
    for (const host of [f.host, 'HL.Example:5700']) {
      expect(bytesToHex(await signLoginProof(deviceKey, { ...fields, host }))).toBe(vectors.login_proof_v2.object.signed_hex);
    }
    await expect(signLoginProof(deviceKey, { ...fields, host: 'https://hl.example' })).rejects.toThrow(IdentityError);
  });
});

describe('canonicalHost', () => {
  // `proof.rs`'s own table: the server compares these bytes.
  it.each([
    ['HL.Example', 'hl.example'],
    ['hl.example:443', 'hl.example'],
    ['hl.example:80', 'hl.example'],
    ['hl.example:080', 'hl.example'],
    ['hl.example:5700', 'hl.example:5700'],
    ['hl.example.', 'hl.example.'],
    ['[2001:DB8:0:0:0:0:0:1]:443', '[2001:db8::1]'],
    ['[::1]:5700', '[::1]:5700'],
    ['[fe80::1%25eth0]', null],
    ['127.0.0.1:80', '127.0.0.1'],
    ['b\u00fccher.example', 'xn--bcher-kva.example'],
    ['', null],
    ['hl.example/path', null],
    ['user@hl.example', null],
    ['hl example', null],
    ['hl.example:99999', null],
  ])('%j is %j', (given, want) => {
    expect(canonicalHost(given)).toBe(want);
  });
});

describe('verifyServerChallenge', () => {
  const sc = vectors.server_challenge.object;
  const given = { challenge: hexToBytes(sc.fields.challenge), serverKey: hexToBytes(sc.fields.server_key), host: sc.fields.host };
  const signedBytes = hexToBytes(sc.signed_hex);
  const signed = bytesToBase64url(signedBytes);
  // One bit of the signature, which starts after `{ v: 1, sig: bstr(64)` heads.
  const flippedBytes = signedBytes.slice();
  flippedBytes[10]! ^= 1;
  const flipped = bytesToBase64url(flippedBytes);
  const notCanonicalBytes = hexToBytes(vectors.rejects.find((r) => r.object === 'server_challenge')!.hex);
  const notCanonical = bytesToBase64url(notCanonicalBytes);

  it('decodes the reject vector to a refusal of its host', () => {
    expect(() => decodeServerChallenge(notCanonicalBytes)).toThrow(new IdentityError('bad-field', 'host'));
  });

  it.each([
    ['at its expiry', signed, given, sc.fields.expires],
    ['inside the skew past it', signed, given, sc.fields.expires + SERVER_CHALLENGE_SKEW_SECONDS],
  ])('accepts the vector %s', async (_, bytes, g, now) => {
    await expect(verifyServerChallenge(bytes, g, now)).resolves.toMatchObject({ host: g.host, next: undefined });
  });

  it.each([
    ['missing', undefined, given, sc.fields.expires],
    ['null', null, given, sc.fields.expires],
    ['not a string', 7, given, sc.fields.expires],
    ['not base64url', 'not base64url!', given, sc.fields.expires],
    ['another challenge', signed, { ...given, challenge: new Uint8Array(32) }, sc.fields.expires],
    ['another key than the reply named', signed, { ...given, serverKey: hexToBytes(vectors.keys.device.public_hex) }, sc.fields.expires],
    ['addressed as another host', signed, { ...given, host: 'b.example:5700' }, sc.fields.expires],
    ['addressed on another port', signed, { ...given, host: 'hl.example' }, sc.fields.expires],
    ['expired', signed, given, sc.fields.expires + SERVER_CHALLENGE_SKEW_SECONDS + 1],
    ['a bit flipped in its signature', flipped, given, sc.fields.expires],
    ['a host not in canonical form', notCanonical, given, sc.fields.expires],
  ])('refuses one %s', async (_, bytes, g, now) => {
    await expect(verifyServerChallenge(bytes, g, now)).rejects.toMatchObject({
      name: 'AuthError',
      code: SERVER_CHALLENGE_REFUSED,
    });
  });
});

describe('fetchChallenge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const sc = vectors.server_challenge.object;
  const reply = (over: Record<string, unknown> = {}) => {
    const fetched = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            challenge: bytesToBase64url(hexToBytes(sc.fields.challenge)),
            server_key: bytesToBase64url(hexToBytes(sc.fields.server_key)),
            expires_in: 60,
            server_challenge: bytesToBase64url(hexToBytes(sc.signed_hex)),
            ...over,
          }),
        ),
    );
    vi.stubGlobal('fetch', fetched);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(sc.fields.expires * 1000);
    return fetched;
  };

  it.each([
    ['an absolute endpoint, outside a browser', 'http://HL.example:5700/identity/challenge', undefined],
    ['a page-relative one, from the page', '/identity/challenge', { href: 'http://hl.example:5700/app/' }],
  ])('takes the host it was vouched for from %s', async (_, endpoint, page) => {
    if (page) vi.stubGlobal('location', page);
    reply();
    expect((await fetchChallenge(endpoint)).host).toBe(sc.fields.host);
  });

  it('refuses a reply that carries no server_challenge, rather than fall back to v = 1', async () => {
    reply({ server_challenge: undefined });
    await expect(fetchChallenge('http://hl.example:5700/identity/challenge')).rejects.toMatchObject({
      code: SERVER_CHALLENGE_REFUSED,
    });
  });

  it('refuses one vouched for under another name than this client addressed', async () => {
    reply();
    await expect(fetchChallenge('http://127.0.0.1:5700/identity/challenge')).rejects.toMatchObject({
      code: SERVER_CHALLENGE_REFUSED,
    });
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

describe('fetchDiscovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  const reply = (identity: unknown, extra: object = {}) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ v: 1, name: 'x', ng: { ws: '/ng' }, identity, ...extra }),
      })),
    );
  };

  it('leaves `web` absent rather than present-and-undefined', async () => {
    // Absence is the whole meaning of the field — it says there is
    // nowhere to point a QR code — so a caller testing `'web' in …` has
    // to be able to tell the two apart.
    reply({ enabled: true, endpoints: {} });
    const d = await fetchDiscovery('https://hl.example');
    expect(d.identity.enabled).toBe(true);
    if (!d.identity.enabled) return;
    expect('web' in d.identity).toBe(false);
  });

  it('carries `web` through when the server names one', async () => {
    reply({ enabled: true, endpoints: {}, web: 'https://hl.example/app/' });
    const d = await fetchDiscovery('https://hl.example');
    if (!d.identity.enabled) return;
    expect(d.identity.web).toBe('https://hl.example/app/');
  });

  it('decodes `server_handovers` in order, keeping the place of one that does not decode', async () => {
    reply({ enabled: false }, { server_handovers: [bytesToBase64url(Uint8Array.of(1, 2, 3)), '!', 7] });
    expect((await fetchDiscovery('https://hl.example')).serverHandovers).toEqual([
      Uint8Array.of(1, 2, 3),
      new Uint8Array(),
      new Uint8Array(),
    ]);
    reply({ enabled: false });
    expect((await fetchDiscovery('https://hl.example')).serverHandovers).toEqual([]);
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

  const req = { card: Uint8Array.of(1), deviceCert: Uint8Array.of(2), proof: Uint8Array.of(3), host: 'host' };

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

  it.each([
    ['https://a.example/identity/auth'],
    ['//a.example/identity/auth'],
    ['/\\a.example/identity/auth'],
  ])('sends no proof to %j, which is not where the page-relative challenge went', async (endpoint) => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ token: 'tok' })));
    vi.stubGlobal('fetch', fetched);
    vi.stubGlobal('location', { href: 'http://hl.example:5700/app/' });
    await expect(postAuth(endpoint, { ...req, host: 'hl.example:5700' })).rejects.toMatchObject({ code: WRONG_HOST });
    expect(fetched).not.toHaveBeenCalled();
    await expect(postAuth('/identity/auth', { ...req, host: 'hl.example:5700' })).resolves.toMatchObject({ token: 'tok' });
  });

  it.each([
    ['bad_cert', 401],
    ['unsupported_proof', 401],
    ['wrong_host', 421],
  ])('reports the server error code, text and status of a well-formed %s refusal', async (code, status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: code, text: 'nope' }), { status })));
    await expect(postAuth('https://host/identity/auth', req)).rejects.toMatchObject({ code, message: 'nope', status });
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

  it('card: small-order identity key decodes, but the key is refused', async () => {
    const bytes = hexToBytes(byName('small-order identity key').hex);
    await expect(verifyEnvelope(bytes, decodeCard(bytes).identity, CARD_DOMAIN)).rejects.toMatchObject({
      kind: 'invalid-key',
    });
  });

  it.each(['non-shortest integer head', 'trailing byte'])('login_proof: %s', (name) => {
    const bytes = hexToBytes(byName(name).hex);
    expect(() => decodeCanonical(bytes)).toThrow(CborError);
  });
});

describe('weak Ed25519 encodings', () => {
  const P = 2n ** 255n - 19n;
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const le = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
  const leUint = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
  const order8 = 2707385501144840649318225287225658788936804267575313519463743609750303402022n;
  // Each y either sign, and y + p wherever it fits in 255 bits.
  const smallOrder = [0n, 1n, P - 1n, order8, P - order8, P, P + 1n].flatMap((y) => [le(y), le(y | (1n << 255n))]);
  // A point of large order, y = 3, in its second encoding.
  const alias = le(3n + P);
  // R = the neutral element, S = 0: a signature on anything for an
  // engine that takes a small-order key.
  const anything = Uint8Array.of(1, ...new Uint8Array(63));
  const sc = vectors.server_challenge.object;

  function replaced(signedHex: string, fields: Record<string, Uint8Array>): Uint8Array {
    const v = decodeCanonical(hexToBytes(signedHex));
    if (v.t !== 'map') throw new Error('not a map');
    return encode(
      cMap(v.v.map(([k, x]) => {
        const name = (k as { v: string }).v;
        return [name, name in fields ? cBytes(fields[name]!) : x] as const;
      })),
    );
  }

  it.each([...smallOrder, alias].map((k) => [bytesToHex(k), k] as const))(
    'refuses %s as the key of a device certificate, a card and a server challenge',
    async (_, key) => {
      const cert = hexToBytes(vectors.device_cert.signed_hex);
      const card = hexToBytes(vectors.card.signed_hex);
      const weak = (hex: string, field: string) => replaced(hex, { [field]: key, sig: anything });
      await expect(openBundle(encodeBundle(weak(vectors.device_cert.signed_hex, 'identity'), card))).rejects.toMatchObject({
        kind: 'invalid-key',
      });
      await expect(openBundle(encodeBundle(cert, weak(vectors.card.signed_hex, 'identity')))).rejects.toMatchObject({
        kind: 'invalid-key',
      });
      const challenge = bytesToBase64url(weak(sc.signed_hex, 'server_key'));
      const given = { challenge: hexToBytes(sc.fields.challenge), serverKey: key, host: sc.fields.host };
      await expect(verifyServerChallenge(challenge, given, sc.fields.expires)).rejects.toMatchObject({
        code: SERVER_CHALLENGE_REFUSED,
        message: expect.stringContaining('invalid-key'),
      });
    },
  );

  it('refuses the key in its second encoding as invalid, and verifies the first only against its signature', async () => {
    const bytes = hexToBytes(vectors.card.signed_hex);
    await expect(verifyEnvelope(bytes, alias, CARD_DOMAIN)).rejects.toMatchObject({ kind: 'invalid-key' });
    await expect(verifyEnvelope(bytes, le(3n), CARD_DOMAIN)).rejects.toMatchObject({ kind: 'bad-signature' });
  });

  it('refuses a small-order R even from the key it verifies under', async () => {
    // S = k·a makes [S]B - [k]A the neutral element, so this holds under
    // the equation, and Chromium's and Firefox's WebCrypto accept it.
    const sha512 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-512', b as BufferSource));
    const h = await sha512(hexToBytes(vectors.keys.identity.seed_hex));
    const a = (leUint(h.subarray(0, 32)) & ((1n << 254n) - 8n)) | (1n << 254n);
    const R = le(1n);
    const A = hexToBytes(vectors.keys.identity.public_hex);
    const k = leUint(await sha512(new Uint8Array([...R, ...A, ...hexToBytes(vectors.card.signature_input_hex)]))) % L;
    const sig = new Uint8Array([...R, ...le((k * a) % L)]);
    const bytes = replaced(vectors.card.signed_hex, { sig });
    await expect(verifyEnvelope(bytes, A, CARD_DOMAIN)).rejects.toMatchObject({ kind: 'bad-signature' });
  });
});
