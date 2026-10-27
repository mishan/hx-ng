import { describe, expect, it } from 'vitest';

import {
  CAPS,
  DEVICE_CERT_DOMAIN,
  base64urlToBytes,
  bytesToBase64url,
  hexToBytes,
  signedChatLines,
  signChatRequest,
  type Events,
  type FollowedHandover,
  type HistoryLine,
  type User,
} from '@hotline-ng/client';

import { cBytes, cOptMap, cUint, encode, type CborValue } from '../packages/hotline-ng/src/cbor';
import { LineReader, signsFor, type PinnedKey } from '../src/signing';
import vectors from '../packages/hotline-ng/test/identity-vectors.json';

const V: Record<string, any> = vectors;
const SIGNER: string = V.keys.identity.fingerprint;
const OTHER: string = V.keys.other.fingerprint;
const SENT = 1_700_000_000;
const HERE = hexToBytes(V.keys.server.public_hex);
const OLD = hexToBytes(V.keys.other.public_hex);
const LINKED = hexToBytes(V.keys.registrar.public_hex);

async function importSeed(seedHex: string): Promise<CryptoKey> {
  const pkcs8 = new Uint8Array([...hexToBytes('302e020100300506032b657004220420'), ...hexToBytes(seedHex)]);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

/** A certificate the vectors' identity signs, for a device key made as
 *  a browser makes one. */
async function certFor(device: Uint8Array, caps: number): Promise<Uint8Array> {
  const entries: [string, CborValue][] = [
    ['v', cUint(1)],
    ['identity', cBytes(hexToBytes(V.keys.identity.public_hex))],
    ['device', cBytes(device)],
    ['device_enc', cBytes(hexToBytes(V.keys.device.public_enc_hex))],
    ['issued', cUint(SENT - 100)],
    ['expires', cUint(SENT + 900)],
    ['caps', cUint(caps)],
  ];
  const input = new Uint8Array([...new TextEncoder().encode(DEVICE_CERT_DOMAIN), 0, ...encode(cOptMap(entries))]);
  const key = await importSeed(V.keys.identity.seed_hex);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, input));
  return encode(cOptMap([...entries, ['sig', cBytes(sig)]]));
}

async function device(caps: number = CAPS.WEB): Promise<{ key: CryptoKey; cert: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { key: pair.privateKey, cert: await certFor(pub, caps) };
}

function row(over: Partial<User> = {}): User {
  return { uid: 7, nick: 'Alice', icon: 128, admin: false, status: 'active', transport: 'encrypted', ...over };
}

const PINNED: PinnedKey = { key: HERE, followed: [] };

describe('signsFor', () => {
  it.each([
    ['a certificate that allows messages, signing the lobby', CAPS.WEB, true, 'default'],
    ['a certificate that allows messages, not signing the lobby', CAPS.WEB, false, 'able'],
    ['a certificate for logging in alone', CAPS.LOGIN, true, undefined],
  ] as const)('%s', async (_, caps, lobby, want) => {
    expect(signsFor((await device(caps)).cert, lobby)).toBe(want);
  });

  it('says nothing without a certificate', () => {
    expect(signsFor(undefined, true)).toBeUndefined();
  });
});

/** A `chat` event as the server sends it. */
function event(from: User, text: string, signed?: string, over: Partial<Events['chat']> = {}): Events['chat'] {
  return { from: { uid: from.uid, nick: from.nick }, text, style: 'normal', at: SENT, ...(signed ? { signed } : {}), ...over };
}

describe('LineReader', () => {
  it('reads a live line against the pinned key, or a linked user against their row', async () => {
    const dev = await device();
    const sign = (server: Uint8Array, sent = SENT) =>
      signChatRequest(dev.key, { cert: dev.cert, server, room: 0, text: 'hi' }, sent);
    const ghost = { server: 'Far', tag: 'far', tagged: false };
    const followed: FollowedHandover = { old: OLD, sha256: new Uint8Array(32), time: SENT - 200, next: undefined };
    const signer = row({ identity: { fingerprint: SIGNER, handle: null } });
    const cases: [string, PinnedKey | null, User, Uint8Array, number, string | null][] = [
      ['from a row naming its signer', PINNED, signer, HERE, SENT, 'verified'],
      ['from a row naming another signer', PINNED, row({ identity: { fingerprint: OTHER, handle: null } }), HERE, SENT, 'invalid'],
      ['from a row with no identity', PINNED, row(), HERE, SENT, 'unverified'],
      ['to a host whose key is not pinned', null, signer, HERE, SENT, 'unverified'],
      ['signed for another server', PINNED, signer, LINKED, SENT, 'elsewhere'],
      ['signed under a key a followed handover keeps', { key: HERE, followed: [followed] }, signer, OLD, SENT, 'verified'],
      ['signed under that key after the handover', { key: HERE, followed: [followed] }, signer, OLD, SENT + 700, 'elsewhere'],
      ['from a linked user, against their home key', PINNED, row({ remote: { ...ghost, server_key: bytesToBase64url(LINKED) } }), LINKED, SENT, 'verified'],
      ['from a linked user whose row gives no key', PINNED, row({ remote: ghost }), LINKED, SENT, 'unverified'],
    ];
    for (const [name, pinned, from, server, sent, state] of cases) {
      const req = await sign(server, sent);
      const read = await new LineReader(pinned).live(event(from, req.text, req.signed, { at: sent }), from);
      expect(read.signature?.state, name).toBe(state);
    }
  });

  it('names a signed line by its signer and signed time, and a linked user\'s by the home and key their row gives', async () => {
    const dev = await device();
    const remote = (server: string, key: Uint8Array) => ({ server, tag: 'far', tagged: false, server_key: bytesToBase64url(key) });
    const cases: [string, User, Uint8Array, object][] = [
      ['a local row', row({ nick: 'Bob', identity: { fingerprint: SIGNER, handle: null } }), HERE, {}],
      ['a linked user', row({ nick: 'Bob', remote: remote('Far', LINKED) }), LINKED, { home: 'Far', foreignKey: true }],
      ['a linked user whose row names no server', row({ nick: 'Bob', remote: remote('', LINKED) }), LINKED, { home: 'a linked server', foreignKey: true }],
      ['a linked user said to share this key', row({ nick: 'Bob', remote: remote('Far', HERE) }), HERE, { home: 'Far', foreignKey: false }],
    ];
    for (const [name, from, server, where] of cases) {
      const req = await signChatRequest(dev.key, { cert: dev.cert, server, room: 0, text: 'hi' }, SENT - 650);
      const read = await new LineReader(PINNED).live(event(from, req.text, req.signed), from);
      expect(read.signature, name).toMatchObject({ state: 'verified', signer: SIGNER, sent: SENT - 650, sentAtAnotherTime: true, ...where });
      if (!('home' in where)) expect(read.signature?.home, name).toBeUndefined();
    }
  });

  it('says where a line signed for elsewhere was signed', async () => {
    const dev = await device();
    const signer = row({ identity: { fingerprint: SIGNER, handle: null } });
    const cases: [Uint8Array, number, RegExp][] = [
      [HERE, 3, /^room 3$/],
      [LINKED, 0, /^the server whose key begins /],
    ];
    for (const [server, room, where] of cases) {
      const req = await signChatRequest(dev.key, { cert: dev.cert, server, room, text: 'hi' }, SENT);
      const read = await new LineReader(PINNED).live(event(signer, req.text, req.signed), signer);
      expect(read.signature?.state).toBe('elsewhere');
      expect(read.signature?.signedFor).toMatch(where);
    }
  });

  it('refuses a line shown in another style than it was signed in', async () => {
    const dev = await device();
    const signer = row({ identity: { fingerprint: SIGNER, handle: null } });
    for (const [act, style, state] of [
      [true, 'action', 'verified'],
      [true, 'normal', 'invalid'],
      [false, 'action', 'invalid'],
    ] as const) {
      const req = await signChatRequest(dev.key, { cert: dev.cert, server: HERE, room: 0, text: 'waves', act }, SENT);
      const read = await new LineReader(PINNED).live(event(signer, req.text, req.signed, { style }), signer);
      expect(read.signature?.state, `${act} as ${style}`).toBe(state);
    }
  });

  it('marks an unsigned line where a signature was expected, and no other, even straight after a signed one', async () => {
    const dev = await device();
    const signer = row({ identity: { fingerprint: SIGNER, handle: null } });
    const lines = new LineReader(PINNED);

    expect((await lines.live(event(signer, 'hi'), signer)).signature).toBeNull();
    const expected = { state: 'unsigned', signatureExpected: true, sentAtAnotherTime: false, signer: null };
    const signs = row({ identity: { fingerprint: OTHER, handle: null, signs: true } });
    expect((await lines.live(event(signs, 'hi'), signs)).signature).toEqual(expected);
    // An image alone, which nobody can sign.
    expect((await lines.live(event(signs, ''), signs)).signature).toBeNull();

    // Handed over together, as two events arriving at once are: the
    // stripped one is read after the signed one is.
    const req = await signChatRequest(dev.key, { cert: dev.cert, server: HERE, room: 0, text: 'signed' }, SENT);
    const [first, second] = await Promise.all([
      lines.live(event(signer, req.text, req.signed), signer),
      lines.live(event(signer, 'stripped'), signer),
    ]);
    expect(first.signature?.state).toBe('verified');
    expect(second.signature).toEqual(expected);
  });

  it('keeps the first line under a signer\'s id and drops any other copy', async () => {
    const dev = await device();
    const signer = row({ identity: { fingerprint: SIGNER, handle: null } });
    const req = await signChatRequest(dev.key, { cert: dev.cert, server: HERE, room: 0, text: 'once' }, SENT);
    const again = await signChatRequest(dev.key, { cert: dev.cert, server: HERE, room: 0, text: 'twice' }, SENT);
    // The same id, signed again over other words (§3.6).
    const first = await signedChatLines.parseDetached(base64urlToBytes(req.signed), [req.text], SENT);
    const other = bytesToBase64url(
      (await signedChatLines.parse(await signedChatLines.sign(dev.key, { ...first.message, text: 'other words' }), SENT)).detached(),
    );
    const link = bytesToBase64url(await first.link());
    const lines = new LineReader(PINNED);
    const cases: [string, Events['chat'], boolean][] = [
      ['a link form, its certificate not held', event(signer, req.text, link, { id: 20 }), false],
      ['that link form logged again', event(signer, req.text, link, { id: 21 }), true],
      ['the first copy', event(signer, req.text, req.signed, { id: 10 }), false],
      ['the same line again, as a refetched page has it', event(signer, req.text, req.signed, { id: 10 }), false],
      ['other words under its id and its server id', event(signer, 'other words', other, { id: 10 }), true],
      ['the same line logged again', event(signer, req.text, req.signed, { id: 11 }), true],
      ['other words under its id', event(signer, 'other words', other, { id: 12 }), true],
      ['another line', event(signer, again.text, again.signed, { id: 13 }), false],
    ];
    for (const [name, line, duplicate] of cases) {
      expect((await lines.live(line, signer)).duplicate, name).toBe(duplicate);
    }
  });

  it('reads a history line by its certificate, against the key its row was checked against', async () => {
    const dev = await device();
    const here = await signChatRequest(dev.key, { cert: dev.cert, server: HERE, room: 0, text: 'hi' }, SENT);
    const linked = await signChatRequest(dev.key, { cert: dev.cert, server: LINKED, room: 0, text: 'hi' }, SENT);
    const line = (signed: string, remote?: { server_key?: string }): HistoryLine => ({
      id: 1,
      at: SENT,
      from: { nick: 'Alice', icon: 128, ...(remote ? { remote } : {}) },
      text: 'hi',
      style: 'normal',
      signed,
    });
    const cases: [string, HistoryLine, string][] = [
      ['said here', line(here.signed), 'verified'],
      ['a linked user\'s, with the key it was checked against', line(linked.signed, { server_key: bytesToBase64url(LINKED) }), 'verified'],
      ['a linked user\'s, with none', line(linked.signed, {}), 'unverified'],
      ['signed for another server', line(linked.signed), 'elsewhere'],
    ];
    for (const [name, l, state] of cases) {
      const read = await new LineReader(PINNED).history(l);
      expect(read.signature?.state, name).toBe(state);
      expect(read.signature?.signer, name).toBe(SIGNER);
    }
  });
});
