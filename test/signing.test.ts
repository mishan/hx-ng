import { describe, expect, it } from 'vitest';

import {
  CAPS,
  DEVICE_CERT_DOMAIN,
  base64urlToBytes,
  bytesToBase64url,
  fingerprintFromString,
  hexToBytes,
  signedChatLines,
  signedPrivateMessages,
  signChatRequest,
  signMsgRequest,
  signNewsPost,
  MemorySealedReplay,
  sealMsgRequest,
  type Events,
  type FollowedHandover,
  type HistoryLine,
  type NewsArticle,
  type NewsNode,
  type SignedParent,
  type StoredMessage,
  type User,
} from '@hotline-ng/client';

import { cBytes, cOptMap, cUint, encode, type CborValue } from '../packages/hotline-ng/src/cbor';
import { sealedReplay } from '../src/identity/storage';
import { ArticleReader, LineReader, MessageReader, beforeUnsigned, heldGuids, signsFor, type PinnedKey } from '../src/signing';
import { installFakeIndexedDB } from './fake-idb';
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

/** A certificate the vectors' identity signs, or another of theirs, for
 *  a device key made as a browser makes one, valid around `at`. */
async function certFor(
  device: Uint8Array,
  caps: number,
  o: { enc?: Uint8Array; identity?: { seed_hex: string; public_hex: string }; at?: number } = {},
): Promise<Uint8Array> {
  const identity = o.identity ?? V.keys.identity;
  const at = o.at ?? SENT;
  const entries: [string, CborValue][] = [
    ['v', cUint(1)],
    ['identity', cBytes(hexToBytes(identity.public_hex))],
    ['device', cBytes(device)],
    ['device_enc', cBytes(o.enc ?? hexToBytes(V.keys.device.public_enc_hex))],
    ['issued', cUint(at - 100)],
    ['expires', cUint(at + 900)],
    ['caps', cUint(caps)],
  ];
  const input = new Uint8Array([...new TextEncoder().encode(DEVICE_CERT_DOMAIN), 0, ...encode(cOptMap(entries))]);
  const key = await importSeed(identity.seed_hex);
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

describe('beforeUnsigned', () => {
  it.each([
    ['signing every lobby line, as the server has it', true, 'default', 'default', 'ask'],
    ['signing every lobby line, asked and not yet answered', true, 'default', 'able', 'ask'],
    ['turned off, the server not yet told', false, 'default', 'default', 'tell'],
    ['turned off, asked and not yet answered', false, 'able', 'default', 'tell'],
    ['turned off just as on was asked', false, 'default', 'able', 'tell'],
    ['signing every lobby line, the server not told', true, 'able', 'able', 'send'],
    ['on a server that carries none from this session', true, 'default', null, 'send'],
    ['not signing them, as the server has it', false, 'able', 'able', 'send'],
  ] as const)('%s', (_, on, signs, signing, want) => {
    expect(beforeUnsigned(on, { signs, signing })).toBe(want);
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
    // A linked user whose home server says it signs every lobby line.
    const linked = row({
      remote: { server: 'Far', tag: 'far', tagged: false, server_key: bytesToBase64url(LINKED) },
      identity: { fingerprint: OTHER, handle: null, signs: true },
    });
    expect((await lines.live(event(linked, 'hi'), linked)).signature).toEqual(expected);
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

/** The reader's own identity, which a private message to them names. */
const ME = OTHER;

/** A `msg` event as the server sends it. */
function msgEvent(from: User | { uid: 0; nick: string }, text: string, signed?: string, over: Partial<Events['msg']> = {}): Events['msg'] {
  return { from: { uid: from.uid, nick: from.nick }, text, at: SENT, queued: false, ...(signed ? { signed } : {}), ...over };
}

function inboxRow(id: number, text: string, signed?: string): StoredMessage {
  return { id, from: { nick: 'Alice', login: 'alice' }, text, at: SENT, read: false, ...(signed ? { signed } : {}) };
}

describe('MessageReader', () => {
  it('reads a message against the identity this session proved, naming its sender as the server does or by its certificate', async () => {
    const dev = await device();
    const sign = (to: string) => signMsgRequest(dev.key, { cert: dev.cert, to: fingerprintFromString(to)!, text: 'psst' }, SENT);
    const signer = row({ identity: { fingerprint: SIGNER, handle: null } });
    const linked = row({ remote: { server: 'Far', tag: 'far', tagged: false } });
    const cases: [string, string | null, string, User | undefined, number, string][] = [
      ['from a row naming its signer', ME, ME, signer, 7, 'verified'],
      ['from a row naming another signer', ME, ME, row({ identity: { fingerprint: OTHER, handle: null } }), 7, 'invalid'],
      ['from a row with no identity', ME, ME, row(), 7, 'unverified'],
      ['waiting for a sender who has gone', ME, ME, undefined, 0, 'verified'],
      ['from a linked user, by their certificate', ME, ME, linked, 7, 'verified'],
      ['signed to someone else', ME, SIGNER, signer, 7, 'elsewhere'],
      ['to a session that proved no identity', null, ME, signer, 7, 'unverified'],
    ];
    for (const [name, proved, to, from, uid, state] of cases) {
      const req = await sign(to);
      const read = await new MessageReader(proved).live(msgEvent({ ...(from ?? row()), uid } as User, req.text, req.signed), from);
      expect(read.signature?.state, name).toBe(state);
      if (state !== 'invalid') expect(read.signature?.signer, name).toBe(SIGNER);
    }
  });

  it('says who an elsewhere message was for, and why one is unverified to a session with no identity', async () => {
    const dev = await device();
    const req = await signMsgRequest(dev.key, { cert: dev.cert, to: fingerprintFromString(SIGNER)!, text: 'psst' }, SENT);
    const elsewhere = await new MessageReader(ME).stored(inboxRow(1, req.text, req.signed));
    expect(elsewhere.signature?.signedFor).toBe(`someone else, whose fingerprint begins ${SIGNER.slice(0, 16)}`);
    const nobody = await new MessageReader(null).stored(inboxRow(1, req.text, req.signed));
    expect(nobody.signature?.why).toMatch(/no identity/);
  });

  it('shows a message once across its live copy and its inbox rows, and the first of two under one id', async () => {
    const dev = await device();
    const to = fingerprintFromString(ME)!;
    const req = await signMsgRequest(dev.key, { cert: dev.cert, to, text: 'once' }, SENT);
    const first = await signedPrivateMessages.parseDetached(base64urlToBytes(req.signed), [req.text], SENT);
    const other = bytesToBase64url(
      (await signedPrivateMessages.parse(await signedPrivateMessages.sign(dev.key, { ...first.message, text: 'other words' }), SENT)).detached(),
    );
    const signer = row({ identity: { fingerprint: SIGNER, handle: null } });
    const messages = new MessageReader(ME);
    const cases: [string, () => Promise<{ duplicate: boolean }>, boolean][] = [
      ['delivered live, stored as 5', () => messages.live(msgEvent(signer, req.text, req.signed, { id: 5 }), signer), false],
      ['its inbox row', () => messages.stored(inboxRow(5, req.text, req.signed)), false],
      ['stored again as 6', () => messages.stored(inboxRow(6, req.text, req.signed)), true],
      ['other words under its id', () => messages.stored(inboxRow(7, 'other words', other)), true],
      ['other words under its id and its row', () => messages.stored(inboxRow(5, 'other words', other)), true],
      ['the same again live, unstored', () => messages.live(msgEvent(signer, req.text, req.signed), signer), true],
    ];
    for (const [name, read, duplicate] of cases) expect((await read()).duplicate, name).toBe(duplicate);
  });

  it('marks an unsigned message from someone seen signing to this session', async () => {
    const dev = await device();
    const signer = row({ identity: { fingerprint: SIGNER, handle: null } });
    const messages = new MessageReader(ME);
    expect((await messages.live(msgEvent(signer, 'plain'), signer)).signature).toBeNull();
    const req = await signMsgRequest(dev.key, { cert: dev.cert, to: fingerprintFromString(ME)!, text: 'signed' }, SENT);
    expect((await messages.live(msgEvent(signer, req.text, req.signed), signer)).signature?.state).toBe('verified');
    expect((await messages.live(msgEvent(signer, 'stripped'), signer)).signature).toMatchObject({ state: 'unsigned', signatureExpected: true });
  });
});

const CATEGORY = new Uint8Array(16).fill(4);
const OTHER_CATEGORY = new Uint8Array(16).fill(5);

function node(id: number, guid: Uint8Array | null = CATEGORY): NewsNode {
  return { id, parent: null, kind: 'category', name: 'General', count: 0, created_at: 0, ...(guid ? { guid: bytesToBase64url(guid) } : {}) };
}

function article(id: number, parent: number | null, post?: { subject: string; body: string; mime: string; signed: string }, over: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id,
    category: 1,
    parent,
    root: parent === null ? id : 1,
    depth: parent === null ? 0 : 1,
    from: { nick: 'Alice', login: 'alice', fingerprint: SIGNER },
    subject: post?.subject ?? 'plain',
    body: post?.body ?? 'unsigned',
    mime: post?.mime ?? 'text/plain',
    at: SENT,
    deleted: false,
    attachments: [],
    refs: [],
    referenced_by: 0,
    ...(post ? { signed: post.signed } : {}),
    ...over,
  };
}

describe('ArticleReader', () => {
  async function poster() {
    const dev = await device();
    return (over: { server?: Uint8Array; category?: Uint8Array; parent?: SignedParent; subject?: string; id?: Uint8Array } = {}) =>
      signNewsPost(
        dev.key,
        {
          cert: dev.cert,
          server: over.server ?? HERE,
          category: over.category ?? CATEGORY,
          ...(over.parent ? { parent: over.parent } : {}),
          ...(over.id ? { id: over.id } : {}),
          subject: over.subject ?? 'news',
          body: 'body',
          mime: 'text/markdown',
        },
        SENT,
      );
  }

  it('reads a thread starter against the pin, its category\'s guid and who the server says wrote it', async () => {
    const post = await poster();
    const cases: [string, PinnedKey | null, Awaited<ReturnType<typeof post>>, NewsNode, Partial<NewsArticle>, string][] = [
      ['as posted', PINNED, await post(), node(1), {}, 'verified'],
      ['by another than the server names', PINNED, await post(), node(1), { from: { nick: 'Alice', fingerprint: OTHER } }, 'invalid'],
      ['by nobody the server names', PINNED, await post(), node(1), { from: { nick: 'Alice' } }, 'unverified'],
      ['shown as another type', PINNED, await post(), node(1), { mime: 'text/plain' }, 'invalid'],
      ['its subject changed', PINNED, await post(), node(1), { subject: 'olds' }, 'invalid'],
      ['in another category', PINNED, await post({ category: OTHER_CATEGORY }), node(1), {}, 'elsewhere'],
      ['for another server', PINNED, await post({ server: LINKED }), node(1), {}, 'elsewhere'],
      ['as a reply, listed as a thread', PINNED, await post({ parent: { article: 9 } }), node(1), {}, 'elsewhere'],
      ['to a host whose key is not pinned', null, await post(), node(1), {}, 'unverified'],
      ['in a category with no guid', PINNED, await post(), node(1, null), {}, 'unverified'],
      ['for another server, in a category with no guid', PINNED, await post({ server: LINKED }), node(1, null), {}, 'elsewhere'],
    ];
    for (const [name, pinned, req, category, over, state] of cases) {
      const read = await new ArticleReader(pinned).read(article(1, null, req, over), category);
      expect(read.signature?.state, name).toBe(state);
      if (name === 'in a category with no guid') expect(read.signature?.why).toBe('this server gave the category no guid');
      if (state === 'verified') expect(read.article?.subject, name).toBe('news');
    }
  });

  it('reads a category guid two nodes give, in one listing or one session after another, as no scope at all', async () => {
    const post = await poster();
    const memory = heldGuids();
    const earlier = new ArticleReader(PINNED, memory);
    await earlier.categoryKey(node(1));
    const cases: [string, ArticleReader, NewsNode[], string][] = [
      ['one node', new ArticleReader(PINNED), [node(1)], 'verified'],
      ['two in one listing', new ArticleReader(PINNED), [node(1), { ...node(2), children: [node(3)] }], 'unverified'],
      ['another node in a later session', new ArticleReader(PINNED, memory), [node(2)], 'unverified'],
      ['the same node in a later session under another server key', new ArticleReader({ key: LINKED, followed: [] }, memory), [node(2)], 'elsewhere'],
    ];
    for (const [name, reader, nodes, state] of cases) {
      reader.nodes(nodes);
      const read = await reader.read(article(1, null, await post()), nodes.at(-1)!);
      expect(read.signature?.state, name).toBe(state);
      const key = await reader.categoryKey(nodes.at(-1)!);
      expect('why' in key ? key.why : null, name).toBe(state === 'unverified' ? 'this server gave its guid to more than one category' : null);
    }
  });

  it('holds a reply to the parent it is threaded under, as that parent was read', async () => {
    const post = await poster();
    const signedParent = await post();
    const parentId = new Uint8Array(16).fill(1);
    const by = fingerprintFromString(SIGNER)!;
    const cases: [string, (NewsArticle | null)[], Awaited<ReturnType<typeof post>>, string, RegExp | undefined][] = [
      ['under a signed parent', [article(1, null, { ...(await post({ id: parentId })) })], await post({ parent: { article: 1, signed: { id: parentId, by } } }), 'verified', undefined],
      ['under an unsigned parent', [article(1, null)], await post({ parent: { article: 1 } }), 'verified', undefined],
      ['naming a signed parent under an unsigned one', [article(1, null)], await post({ parent: { article: 1, signed: { id: parentId, by } } }), 'elsewhere', /as signed, which is shown here without a signature/],
      ['naming another signed parent', [article(1, null, signedParent)], await post({ parent: { article: 1, signed: { id: parentId, by } } }), 'elsewhere', /another article/],
      ['naming another parent', [article(1, null)], await post({ parent: { article: 8 } }), 'elsewhere', /a reply to article 8/],
      ['under a parent not read', [], await post({ parent: { article: 1, signed: { id: parentId, by } } }), 'unverified', undefined],
      ['under a deleted parent', [article(1, null, undefined, { deleted: true })], await post({ parent: { article: 1, signed: { id: parentId, by } } }), 'unverified', undefined],
    ];
    for (const [name, parents, req, state, where] of cases) {
      const reader = new ArticleReader(PINNED);
      for (const p of parents) await reader.read(p!, node(1));
      const read = await reader.read(article(2, 1, req), node(1));
      expect(read.signature?.state, name).toBe(state);
      if (where) expect(read.signature?.signedFor, name).toMatch(where);
    }
  });

  it('says what a reply signs as its parent, once the parent is read', async () => {
    const post = await poster();
    const id = new Uint8Array(16).fill(7);
    const reader = new ArticleReader(PINNED);
    expect(reader.replyParent(1)).toBeNull();
    await reader.read(article(1, null, await post({ id })), node(1));
    await reader.read(article(2, null), node(1));
    await reader.read(article(3, null, undefined, { deleted: true }), node(1));
    expect(reader.replyParent(1)).toEqual({ article: 1, signed: { id, by: fingerprintFromString(SIGNER) } });
    expect(reader.replyParent(2)).toEqual({ article: 2 });
    expect(reader.replyParent(3)).toBeNull();
  });

  it('shows an article once under its signer\'s id, whatever the server numbers it', async () => {
    const post = await poster();
    const id = new Uint8Array(16).fill(2);
    const first = await post({ id });
    const again = await post({ id });
    const reworded = await post({ id, subject: 'reworded' });
    const reader = new ArticleReader(PINNED);
    const cases: [string, NewsArticle, boolean][] = [
      ['the first', article(1, null, first), false],
      ['the same article listed again', article(1, null, first), false],
      ['signed again, posted as another', article(4, null, again), true],
      ['other words under its id', article(5, null, reworded), true],
    ];
    for (const [name, a, duplicate] of cases) expect((await reader.read(a, node(1))).duplicate, name).toBe(duplicate);
  });
});

/** Both of a device's keys made as a browser makes them, and a
 *  certificate for them from `identity`, valid now. */
async function sealingDevice(identity: { seed_hex: string; public_hex: string }) {
  const sign = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const enc = (await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
  const raw = async (k: CryptoKey) => new Uint8Array(await crypto.subtle.exportKey('raw', k));
  const now = Math.floor(Date.now() / 1000);
  const cert = await certFor(await raw(sign.publicKey), CAPS.WEB, { enc: await raw(enc.publicKey), identity, at: now });
  return { keys: { sign: sign.privateKey, enc: enc.privateKey }, cert };
}

describe('MessageReader, sealed', () => {
  it("opens a box with this device's key, in §8's states, naming its sender as §3.9 does", async () => {
    const [from, me, stranger] = [await sealingDevice(V.keys.identity), await sealingDevice(V.keys.other), await sealingDevice(V.keys.other)];
    const seal = (text: string, deniable = false) =>
      sealMsgRequest(from.keys, { cert: from.cert, to: fingerprintFromString(ME)!, text }, me.cert, deniable);
    const at = Math.floor(Date.now() / 1000);
    const event = (sealed: string, fingerprint?: string): Events['msg'] => ({
      from: { uid: 7, nick: 'Alice', ...(fingerprint ? { fingerprint } : {}) },
      text: '[Encrypted message]',
      at,
      queued: false,
      sealed,
    });
    const signer = row({ identity: { fingerprint: SIGNER, handle: null } });
    const cases: [string, Promise<{ sealed: string }>, string | undefined, User | undefined, CryptoKey | null, object][] = [
      ['a signed box from a row naming its signer', seal('hi'), SIGNER, signer, me.keys.enc, { state: 'verified', signer: SIGNER }],
      ['a deniable box', seal('hi', true), SIGNER, signer, me.keys.enc, { state: 'deniable', signer: SIGNER }],
      ['from a uid nobody holds now, by the fingerprint the event names', seal('hi'), SIGNER, undefined, me.keys.enc, { state: 'verified' }],
      ['from a row naming another', seal('hi'), SIGNER, row({ identity: { fingerprint: OTHER, handle: null } }), me.keys.enc, { state: 'invalid' }],
      ['from a row with no identity', seal('hi'), SIGNER, row(), me.keys.enc, { state: 'unverified', signer: SIGNER }],
      ['an event naming no fingerprint', seal('hi'), undefined, undefined, me.keys.enc, { state: 'unverified' }],
      ['sealed to another device', seal('hi'), SIGNER, signer, stranger.keys.enc, { state: 'unopened' }],
      ['to a session holding no key', seal('hi'), SIGNER, signer, null, { state: 'unopened' }],
      ['not a box at all', Promise.resolve({ sealed: '!!' }), SIGNER, signer, me.keys.enc, { state: 'unopened' }],
    ];
    for (const [name, req, fingerprint, sender, enc, want] of cases) {
      const reader = new MessageReader(ME, new MemorySealedReplay());
      reader.prove(ME, enc);
      const read = await reader.sealed(event((await req).sealed, fingerprint), sender);
      expect(read.signature, name).toMatchObject(want);
      const shown = read.signature?.state === 'verified' || read.signature?.state === 'deniable';
      expect(read.hidden ?? false, name).toBe(['invalid', 'unverified'].includes(read.signature!.state));
      if (shown || read.hidden) expect(read.text, name).toBe('hi');
      expect(read.whole !== undefined, name).toBe(read.signature?.state === 'verified' || read.signature?.state === 'unverified');
    }
  });

  it('shows a box once, whichever reader is handed it again', async () => {
    const [from, me] = [await sealingDevice(V.keys.identity), await sealingDevice(V.keys.other)];
    const req = await sealMsgRequest(from.keys, { cert: from.cert, to: fingerprintFromString(ME)!, text: 'once' }, me.cert);
    const event: Events['msg'] = {
      from: { uid: 7, nick: 'Alice', fingerprint: SIGNER },
      text: '[Encrypted message]',
      at: Math.floor(Date.now() / 1000),
      queued: false,
      sealed: req.sealed,
    };
    const replay = new MemorySealedReplay();
    const reader = () => {
      const r = new MessageReader(ME, replay);
      r.prove(ME, me.keys.enc);
      return r;
    };
    const first = reader();
    expect((await first.sealed(event, undefined)).duplicate).toBe(false);
    expect((await first.sealed(event, undefined)).duplicate).toBe(true);
    expect((await reader().sealed(event, undefined)).duplicate, 'another tab, the same memory').toBe(true);
  });

  it('opens a box again that was accepted and then not shown, its session replaced while it opened', async () => {
    installFakeIndexedDB();
    const [from, me] = [await sealingDevice(V.keys.identity), await sealingDevice(V.keys.other)];
    const event = async (text: string): Promise<Events['msg']> => ({
      from: { uid: 7, nick: 'Alice', fingerprint: SIGNER },
      text: '[Encrypted message]',
      at: Math.floor(Date.now() / 1000),
      queued: false,
      sealed: (await sealMsgRequest(from.keys, { cert: from.cert, to: fingerprintFromString(ME)!, text }, me.cert, text === 'deniably')).sealed,
    });
    const reader = () => {
      const r = new MessageReader(ME, sealedReplay);
      r.prove(ME, me.keys.enc);
      return r;
    };
    for (const text of ['signed', 'deniably']) {
      const box = await event(text);
      const replaced = reader();
      await replaced.unshown(await replaced.sealed(box, undefined));
      const read = await reader().sealed(box, undefined);
      expect([read.duplicate, read.text], text).toEqual([false, text]);
      expect((await reader().sealed(box, undefined)).duplicate, `${text}, once shown`).toBe(true);
    }
  });
});
