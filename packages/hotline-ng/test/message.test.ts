import { describe, expect, it } from 'vitest';

import { CborError, cBytes, cOptMap, cText, cUint, encode, type CborValue } from '../src/cbor';
import { CAPS, DEVICE_CERT_DOMAIN, IdentityError, bytesToHex, fingerprintToString, hexToBytes } from '../src/identity';
import {
  CHAT_DOMAIN,
  canonicalText,
  isCanonicalText,
  signatureDisplay,
  signedArticles,
  signedChatLines,
  signedPrivateMessages,
  type SignedForm,
  type SignedKind,
  type SignedOutcome,
  type SignedChatLine,
  type SignedParent,
  type SignedPrivateMessage,
} from '../src/message';

import vectors from './identity-vectors.json';

const V: Record<string, any> = vectors;
const AT: number = V.messages.at;
const SIGNER: string = V.keys.identity.fingerprint;
const hex = hexToBytes;
const textEncoder = new TextEncoder();

const PKCS8_ED25519_PREFIX = hexToBytes('302e020100300506032b657004220420');

async function importSeed(seedHex: string): Promise<CryptoKey> {
  const pkcs8 = new Uint8Array([...PKCS8_ED25519_PREFIX, ...hexToBytes(seedHex)]);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

async function signMap(key: CryptoKey, domain: string, entries: [string, CborValue | undefined][]): Promise<Uint8Array> {
  const input = new Uint8Array([...textEncoder.encode(domain), 0, ...encode(cOptMap(entries))]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, input));
  return encode(cOptMap([...entries, ['sig', cBytes(sig)]]));
}

/** An error as hl-identity's `Debug` prints it, which is how the vectors
 *  name the one each must fail with. */
function rustName(e: unknown): string {
  const pascal = (k: string) => k.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
  if (e instanceof CborError) return `Cbor(${pascal(e.kind)})`;
  if (!(e instanceof IdentityError)) throw e;
  if (e.kind === 'missing-field' || e.kind === 'bad-field') return `${pascal(e.kind)}("${e.detail}")`;
  if (e.kind === 'unsupported-version') return `UnsupportedVersion(${e.detail})`;
  return pascal(e.kind);
}

type AnyKind = SignedKind<any, any, any>;

/** A vector list, typed so each case is one row. */
const rows = (list: unknown): Record<string, any>[] => list as Record<string, any>[];

function kindOf(vector: string): AnyKind {
  if (vector.startsWith('chat_')) return signedChatLines;
  if (vector.startsWith('private_message')) return signedPrivateMessages;
  return signedArticles;
}

function parentOf(p: any): SignedParent | null {
  if (!p) return null;
  return p.id ? { article: p.article, signed: { id: hex(p.id), by: hex(p.by) } } : { article: p.article };
}

/** A vector's fields as the object a signer is handed. */
function objectOf(name: string): object {
  const f = V[name].fields;
  const common = { id: hex(f.id), sent: f.sent, cert: hex(f.cert) };
  if (name.startsWith('chat_')) {
    return { ...common, server: hex(f.in.server), room: f.in.room, text: f.text, act: f.act ?? false };
  }
  if (name.startsWith('private_message')) return { ...common, to: hex(f.to), text: f.text, auto: f.auto ?? false };
  return {
    ...common,
    server: hex(f.in.server),
    category: hex(f.in.category),
    parent: parentOf(f.parent) ?? undefined,
    subject: f.subject,
    body: f.body,
    mime: f.mime,
  };
}

describe('canonical text', () => {
  it.each(rows(V.canonical_text))('$name', (c) => {
    expect(canonicalText(c.input)).toBe(c.canonical);
    expect(isCanonicalText(c.canonical)).toBe(true);
  });
});

describe('signed object vectors', () => {
  const names = [
    'chat_lobby',
    'chat_room',
    'chat_action',
    'private_message',
    'private_message_auto',
    'article_signed_parent',
    'article_unsigned_parent',
  ];

  it.each(names)('%s re-signs, parses and reassembles from every form', async (name) => {
    const e = V[name];
    const kind = kindOf(name);
    const built = objectOf(name);
    expect(kind.domain).toBe(e.domain);
    const signed = await kind.sign(await importSeed(V.keys.device.seed_hex), built);
    expect(bytesToHex(signed)).toBe(e.signed_hex);

    const whole = await kind.parse(signed, AT);
    expect(whole.message).toEqual(built);
    expect(fingerprintToString(whole.signer)).toBe(SIGNER);
    expect(bytesToHex(whole.detached())).toBe(e.detached_hex);
    expect(bytesToHex((await kind.parseDetached(hex(e.detached_hex), e.texts, AT)).whole())).toBe(e.signed_hex);
    if (e.link_hex) {
      expect(bytesToHex(await whole.link())).toBe(e.link_hex);
      const back = await kind.parseLink(hex(e.link_hex), e.texts, hex(V.message_cert.signed_hex), AT);
      expect(bytesToHex(back.whole())).toBe(e.signed_hex);
    }
  });
});

describe('message_reads', () => {
  it.each(rows(V.message_reads))('$name', async (r) => {
    const e = V[r.vector];
    const sender = r.sender === 'named' ? { named: SIGNER } : r.sender === 'other' ? { named: V.keys.other.fingerprint } : r.sender;
    const form: SignedForm<string[]> =
      r.form === 'whole'
        ? { form: 'whole', bytes: hex(e.signed_hex) }
        : r.form === 'detached'
          ? { form: 'detached', bytes: hex(e.detached_hex), texts: e.texts }
          : { form: 'link', bytes: hex(e.link_hex), texts: e.texts, ...(r.cert ? { cert: hex(V[r.cert].signed_hex) } : {}) };
    const s = r.scope;
    const scope = r.vector.startsWith('chat_')
      ? { server: s.server && hex(s.server), room: s.room }
      : r.vector.startsWith('private_message')
        ? r.reader
        : { server: hex(s.server), category: hex(s.category), parent: parentOf(s.parent) };
    const outcome = await kindOf(r.vector).read(form, { at: r.at ?? AT, sender, scope });
    // A link form read without the certificate it names, or with
    // another, names no signer (§8, state 3); the vectors' only invalid
    // read is a row naming another signer.
    const unnamed = r.form === 'link' && r.cert !== 'message_cert';
    const want = {
      verified: { state: 'verified', signer: SIGNER, sentApart: r.sent_apart ?? false },
      elsewhere: { state: 'elsewhere', signer: SIGNER, sentApart: r.sent_apart ?? false },
      unverified: { state: 'unverified', signer: unnamed ? null : SIGNER },
      invalid: { state: 'invalid', error: 'KeyMismatch' },
    }[r.expect as string];
    expect(outcome.state === 'invalid' ? { ...outcome, error: rustName(outcome.error) } : outcome).toEqual(want);
  });
});

describe('the certificate window', () => {
  it.each(rows(V.cert_window.cases))('$name', async (c) => {
    const got = await signedChatLines.parse(hex(c.signed_hex), c.sent).then((s) => [s.cert.issued, s.cert.expires], rustName);
    expect(got).toEqual(c.expect === 'ok' ? [c.issued, c.expires] : c.expect);
  });
});

describe('a mixed-order device key', () => {
  it('verifies under the cofactorless equation and not under the cofactored one alone', async () => {
    const m = V.mixed_order_key;
    const ok = await signedChatLines.parse(hex(m.accepted.signed_hex), AT);
    expect(bytesToHex(ok.cert.device)).toBe(m.device_hex);
    expect(bytesToHex(ok.cert.raw)).toBe(m.accepted.cert_hex);
    expect(await signedChatLines.parse(hex(m.rejected.signed_hex), AT).then(() => 'accepted', rustName)).toBe(m.rejected.error);
  });
});

describe('message_rejects', () => {
  const kinds: Record<string, AnyKind> = {
    chat_line: signedChatLines,
    private_message: signedPrivateMessages,
    article: signedArticles,
  };
  // A padded plaintext is a sealed box's, not a signed object's.
  const rejects = V.message_rejects.filter((r: any) => r.object !== 'padded_plaintext');

  it.each(rows(rejects))('$name', async (r) => {
    const kind = kinds[r.object]!;
    const b = hex(r.hex);
    const parsing =
      r.form === 'whole'
        ? kind.parse(b, AT)
        : r.form === 'detached'
          ? kind.parseDetached(b, r.texts, AT)
          : kind.parseLink(b, r.texts, hex(r.cert_hex), AT);
    expect(await parsing.then(() => 'accepted', rustName)).toBe(r.error);
  });
});

// Round trips with a device key made the way a browser makes one,
// non-extractable, under a certificate the vectors' identity signs.

const SENT = 1_700_000_000;
const SERVER = hex(V.keys.server.public_hex);
const OTHER_SERVER = hex(V.keys.registrar.public_hex);
const CATEGORY = new Uint8Array(16).fill(6);

async function certFor(
  device: Uint8Array,
  opts: { issued?: number; expires?: number | bigint; caps?: number } = {},
): Promise<Uint8Array> {
  return signMap(await importSeed(V.keys.identity.seed_hex), DEVICE_CERT_DOMAIN, [
    ['v', cUint(1)],
    ['identity', cBytes(hex(V.keys.identity.public_hex))],
    ['device', cBytes(device)],
    ['device_enc', cBytes(hex(V.keys.device.public_enc_hex))],
    ['issued', cUint(opts.issued ?? SENT - 100)],
    ['expires', cUint(opts.expires ?? SENT + 900)],
    ['caps', cUint(opts.caps ?? CAPS.WEB)],
  ]);
}

async function browserDevice(): Promise<{ key: CryptoKey; public: Uint8Array; cert: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { key: pair.privateKey, public: pub, cert: await certFor(pub) };
}

const otherFingerprint = async () =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', hex(V.keys.other.public_hex) as BufferSource));

describe('signed here, read here', () => {
  it('verifies each object in every form, its texts canonicalized however they arrive', async () => {
    const dev = await browserDevice();
    const to = await otherFingerprint();
    const parent = { article: 41, signed: { id: new Uint8Array(16).fill(3), by: to } };
    const common = { id: new Uint8Array(16).fill(9), sent: SENT, cert: dev.cert };
    const cases: [AnyKind, object, unknown, string[]][] = [
      [signedChatLines, { ...common, server: SERVER, room: 5, text: 'a\r\nb\rc', act: true }, { server: SERVER, room: 5 }, ['a\rb\rc']],
      [signedPrivateMessages, { ...common, to, text: 'hi', auto: true }, V.keys.other.fingerprint, ['hi']],
      [
        signedArticles,
        { ...common, server: SERVER, category: CATEGORY, parent, subject: 's', body: 'b\r\nc', mime: 'text/markdown' },
        { server: SERVER, category: CATEGORY, parent },
        ['s', 'b\nc'],
      ],
    ];
    for (const [kind, message, scope, texts] of cases) {
      const whole = await kind.sign(dev.key, message);
      const signed = await kind.parse(whole, SENT);
      const ctx = { at: SENT, sender: { named: SIGNER }, scope };
      const forms: SignedForm<string[]>[] = [
        { form: 'whole', bytes: whole },
        { form: 'detached', bytes: signed.detached(), texts },
      ];
      // An article never crosses a link, and its scope is past a link
      // form's bound.
      if (kind !== signedArticles) forms.push({ form: 'link', bytes: await signed.link(), texts, cert: dev.cert });
      for (const form of forms) {
        expect(await kind.read(form, ctx)).toEqual({ state: 'verified', signer: SIGNER, sentApart: false });
      }
      expect(bytesToHex((await kind.parseDetached(signed.detached(), texts, SENT)).whole())).toBe(bytesToHex(whole));
    }
  });

  it('refuses to sign what a reader would refuse', async () => {
    const dev = await browserDevice();
    const stranger = await browserDevice();
    const to = await otherFingerprint();
    const line = { id: new Uint8Array(16), sent: SENT, server: SERVER, room: 0, cert: dev.cert, text: 'hi' };
    const pm = { id: new Uint8Array(16), sent: SENT, to, cert: dev.cert, text: 'hi' };
    const loginOnly = await certFor(dev.public, { caps: CAPS.LOGIN });
    const expired = await certFor(dev.public, { issued: SENT - 5000, expires: SENT - 4000 });
    const cases: [string, () => Promise<unknown>, string][] = [
      ['another device key', () => signedChatLines.sign(stranger.key, line), 'KeyMismatch'],
      ['a certificate without bit 1', () => signedChatLines.sign(dev.key, { ...line, cert: loginOnly }), 'CapabilityMissing'],
      ['a certificate expired at sent', () => signedChatLines.sign(dev.key, { ...line, cert: expired }), 'Expired'],
      ['empty text', () => signedChatLines.sign(dev.key, { ...line, text: '' }), 'BadField("text")'],
      ['a bell', () => signedChatLines.sign(dev.key, { ...line, text: String.fromCharCode(7) }), 'BadField("text")'],
      ['an empty quote', () => signedPrivateMessages.sign(dev.key, { ...pm, quote: '' }), 'BadField("quote")'],
      [
        'message text past the bound of a whole map',
        () => signedPrivateMessages.sign(dev.key, { ...pm, text: 'x'.repeat(8193) }),
        'BadField("text")',
      ],
    ];
    for (const [name, signing, want] of cases) {
      expect(await signing().then(() => 'signed', rustName), name).toBe(want);
    }
  });

  it('detaches a private message only within the cleartext limits', async () => {
    const dev = await browserDevice();
    const pm = { id: new Uint8Array(16), sent: SENT, to: await otherFingerprint(), cert: dev.cert, text: 'hi' };
    const read = async (m: SignedPrivateMessage) => signedPrivateMessages.parse(await signedPrivateMessages.sign(dev.key, m), SENT);
    const quoted = await read({ ...pm, quote: 'earlier' });
    expect(quoted.message.quote).toBe('earlier');
    expect(() => quoted.detached()).toThrow('bad-field: quote');
    await expect(read({ ...pm, text: 'x'.repeat(4097) }).then((s) => s.detached())).rejects.toThrow('bad-field: text');
    expect((await read({ ...pm, text: 'x'.repeat(4096) })).detached().length).toBeGreaterThan(0);
  });

  it('carries unknown keys through every form, covered by the signature', async () => {
    const key = await importSeed(V.keys.device.seed_hex);
    const f = V.chat_lobby.fields;
    const whole = await signMap(key, CHAT_DOMAIN, [
      ['v', cUint(1)],
      ['id', cBytes(hex(f.id))],
      ['sent', cUint(f.sent)],
      ['in', cOptMap([['server', cBytes(SERVER)], ['room', cUint(0)]])],
      ['cert', cBytes(hex(V.message_cert.signed_hex))],
      ['text', cText(f.text)],
      ['future', cUint(1)],
    ]);
    const signed = await signedChatLines.parse(whole, AT);
    const link = await signed.link();
    expect(bytesToHex((await signedChatLines.parseLink(link, [f.text], hex(V.message_cert.signed_hex), AT)).whole())).toBe(
      bytesToHex(whole),
    );
    expect(await signedChatLines.linkContentSha256(link, [f.text])).toEqual(await signed.contentSha256());
  });

  it('tells a line signed again from another line', async () => {
    const dev = await browserDevice();
    const line = { id: new Uint8Array(16).fill(9), sent: SENT, server: SERVER, room: 0, cert: dev.cert, text: 'hi' };
    const content = async (l: SignedChatLine) => (await signedChatLines.parse(await signedChatLines.sign(dev.key, l), SENT)).contentSha256();
    const first = await content(line);
    expect(await content({ ...line, sent: SENT + 60 })).toEqual(first);
    expect(await content({ ...line, text: 'ho' })).not.toEqual(first);
    expect(await content({ ...line, room: 5 })).not.toEqual(first);
  });

  it('reads a certificate that never expires, and a room past 2^53 as elsewhere, stricter than hl-identity', async () => {
    const dev = await browserDevice();
    const lasting = await certFor(dev.public, { expires: 2n ** 64n - 1n });
    const room = 2 ** 53 + 2;
    const line = { id: new Uint8Array(16), sent: SENT, server: SERVER, room, cert: lasting, text: 'hi' };
    const ctx = (r: number) => ({ at: SENT, sender: 'certificate' as const, scope: { server: SERVER, room: r } });
    const whole = await signedChatLines.sign(dev.key, line);
    expect(await signedChatLines.read({ form: 'whole', bytes: whole }, ctx(room))).toMatchObject({ state: 'elsewhere' });
    const lobby = await signedChatLines.sign(dev.key, { ...line, room: 0 });
    expect(await signedChatLines.read({ form: 'whole', bytes: lobby }, ctx(0))).toMatchObject({ state: 'verified' });
  });

  it('takes a server key the scope says is an alias, at the time it was signed', async () => {
    const dev = await browserDevice();
    const line = { id: new Uint8Array(16), sent: SENT, server: OTHER_SERVER, room: 0, cert: dev.cert, text: 'hi' };
    const signed = await signedChatLines.parse(await signedChatLines.sign(dev.key, line), SENT);
    const oldKeyUntil = (until: number) => (k: Uint8Array, sent: number) => bytesToHex(k) === bytesToHex(OTHER_SERVER) && sent <= until;
    const cases: [string, ((k: Uint8Array, sent: number) => boolean) | undefined, SignedOutcome['state']][] = [
      ['no alias', undefined, 'elsewhere'],
      ['an alias while it was the key', oldKeyUntil(SENT), 'verified'],
      ['an alias only from before it was signed', oldKeyUntil(SENT - 1), 'elsewhere'],
    ];
    for (const [name, alias, want] of cases) {
      const scope = { server: SERVER, room: 0, ...(alias ? { alias } : {}) };
      expect(signed.check({ at: SENT, sender: 'certificate', scope }).state, name).toBe(want);
    }
  });
});

describe('signatureDisplay', () => {
  const verified: SignedOutcome = { state: 'verified', signer: SIGNER, sentApart: false };
  it.each([
    ['unsigned', null, {}, { state: 'unsigned', sentAtAnotherTime: false, signatureExpected: false }],
    ['unsigned from a signer seen here', null, { seenSigning: true }, { state: 'unsigned', sentAtAnotherTime: false, signatureExpected: true }],
    ['unsigned from a row that signs', null, { rowSigns: true }, { state: 'unsigned', sentAtAnotherTime: false, signatureExpected: true }],
    ['unsigned in a room that requires signing', null, { roomRequiresSigning: true }, { state: 'unsigned', sentAtAnotherTime: false, signatureExpected: true }],
    ['verified', verified, { rowSigns: true }, { state: 'verified', sentAtAnotherTime: false, signatureExpected: false }],
    ['verified, sent apart', { ...verified, sentApart: true }, {}, { state: 'verified', sentAtAnotherTime: true, signatureExpected: false }],
    ['elsewhere, sent apart', { ...verified, state: 'elsewhere', sentApart: true }, {}, { state: 'elsewhere', sentAtAnotherTime: true, signatureExpected: false }],
    ['unverified', { state: 'unverified', signer: null }, {}, { state: 'unverified', sentAtAnotherTime: false, signatureExpected: false }],
    ['invalid', { state: 'invalid', error: new Error('x') }, {}, { state: 'invalid', sentAtAnotherTime: false, signatureExpected: false }],
  ] as const)('%s', (_, outcome, expected, want) => {
    expect(signatureDisplay(outcome as SignedOutcome | null, expected)).toEqual(want);
  });
});
