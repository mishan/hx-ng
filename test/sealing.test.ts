import { beforeEach, describe, expect, it } from 'vitest';

import type { User } from '@hotline-ng/client';

import { peers } from '../src/identity/storage';
import {
  PeerMemory,
  adoption,
  chooseDeniable,
  conversationIdentity,
  deniableChoice,
  lineFingerprint,
  neverSealedFallback,
  neverSeals,
  rememberIdentity,
  sealTarget,
  sealedBefore,
  sighting,
  signedTo,
  splitUtf8,
  type PeerConversation,
} from '../src/sealing';
import type { Line } from '../src/state';
import { installFakeIndexedDB } from './fake-idb';

const [F, G] = ['F'.repeat(52), 'G'.repeat(52)];
const SERVER = 'wss://hl.example';
/** One character as a reader sees it, of five code points. */
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';

function row(uid: number, fingerprint?: string, sealed = true): User {
  return {
    uid,
    nick: `u${uid}`,
    icon: 128,
    admin: false,
    status: 'active',
    transport: 'encrypted',
    ...(fingerprint ? { identity: { fingerprint, handle: null, ...(sealed ? { sealed } : {}) } } : {}),
  };
}

const conv = (uid?: number) => ({ title: 'Alice', peer: uid === undefined ? {} : { uid } });

beforeEach(() => {
  installFakeIndexedDB();
});

describe('sealTarget', () => {
  it('seals only to the identity a conversation was verified under, wherever the roster has it, or asks', () => {
    const cases: [string, number | undefined, string | null, User[], object, string?][] = [
      ['first contact, to the row', 7, null, [row(7, F)], { uid: 7, fingerprint: F }],
      ['first contact, a row that cannot open one', 7, null, [row(7, F, false)], { cannot: "Alice's session cannot open sealed messages" }],
      ['nobody at the uid', 7, F, [], { cannot: 'Alice is not here, and a sealed message is never stored' }],
      ['the row still under it', 7, F, [row(7, F)], { uid: 7, fingerprint: F }],
      ['another uid holding it', 7, F, [row(7, G), row(9, F)], { uid: 9, fingerprint: F }],
      ['a conversation known by login alone', undefined, F, [row(9, F)], { uid: 9, fingerprint: F }],
      ['another uid holding it, unable to open one', 7, F, [row(7, G), row(9, F, false)], { cannot: "the session holding Alice's identity cannot open sealed messages" }],
      ['the row under another, and nobody under it', 7, F, [row(7, G)], { changed: G, uid: 7, was: F }],
      ['a nick last seen under another, asked about', 7, null, [row(7, G)], { changed: G, uid: 7, was: F }, F],
      ['a nick last seen under the one shown', 7, null, [row(7, F)], { uid: 7, fingerprint: F }, F],
      [
        'a nick last seen under one another uid holds, never sent there',
        9,
        null,
        [row(9), row(3, F)],
        { cannot: "Alice's session cannot open sealed messages" },
        F,
      ],
      [
        'the row with no identity now',
        7,
        F,
        [row(7)],
        { cannot: 'the server no longer shows Alice with the identity their messages here were verified under' },
      ],
      [
        'the row under another that cannot open one',
        7,
        F,
        [row(7, G, false)],
        { cannot: 'the server no longer shows Alice with the identity their messages here were verified under' },
      ],
    ];
    for (const [name, uid, known, roster, want, hint] of cases) expect(sealTarget(conv(uid), known, roster, hint ?? null), name).toEqual(want);
  });
});

describe('lineFingerprint', () => {
  it('takes a received message by its signer where it verified or opened deniably, and one sent by who it went to', () => {
    const sig = (state: string, signer: string | null, to?: string) =>
      ({ state, signer, sentAtAnotherTime: false, signatureExpected: false, ...(to ? { to } : {}) }) as Line['signature'];
    const line = (over: Partial<Line>): Line => ({ t: 0, kind: 'chat', text: 'hi', ...over });
    const cases: [string, Line, string | null][] = [
      ['verified', line({ signature: sig('verified', F) }), F],
      ['deniable', line({ signature: sig('deniable', F) }), F],
      ['unverified', line({ signature: sig('unverified', F) }), null],
      ['invalid', line({ signature: sig('invalid', null) }), null],
      ['unsigned', line({}), null],
      ['sent sealed or signed', line({ local: true, signature: sig('verified', G, F) }), F],
      ['sent in the clear unsigned', line({ local: true }), null],
    ];
    for (const [name, l, want] of cases) expect(lineFingerprint(l), name).toBe(want);
  });
});

describe('PeerMemory', () => {
  it('remembers across a reload who was sealed to, under which login or nick, and the deniable switch', async () => {
    const before = new PeerMemory(peers);
    await before.note(F, SERVER, { login: 'alice', nick: 'Alice' }, { sealed: true });
    await before.note(F, SERVER, { login: 'alice', nick: 'Alice' }, { deniable: true });
    await before.note(G, SERVER, { nick: 'Bob' });

    const after = new PeerMemory(peers);
    await after.load();
    expect(after.get(SERVER, F)).toMatchObject({ sealed: true, deniable: true, logins: ['alice'] });
    expect(after.byLogin(SERVER, 'ALICE')).toBe(F);
    expect(after.byNick(SERVER, 'Bob')).toBe(G);
    expect(after.byLogin(SERVER, 'bob')).toBeNull();
    expect(after.byLogin('wss://elsewhere.example', 'alice')).toBeNull();

    // Another tab's later word on a record this one holds is taken.
    const other = new PeerMemory(peers);
    await other.load();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await other.note(F, SERVER, { login: 'alice', nick: 'Alice' }, { deniable: false });
    await after.load();
    expect(after.get(SERVER, F)).toMatchObject({ sealed: true, deniable: false });
  });

  it('keeps each server and each login an identity was seen under, and an accepted identity over a later sighting of the old one', async () => {
    const ELSEWHERE = 'wss://elsewhere.example';
    const memory = new PeerMemory(peers);
    await memory.note(F, SERVER, { login: 'alice', nick: 'Alice' }, { sealed: true });
    await memory.note(F, ELSEWHERE, { login: 'al', nick: 'Al' });
    await memory.note(F, SERVER, { login: 'alice2', nick: 'Alice' });
    const reloaded = new PeerMemory(peers);
    await reloaded.load();
    const alice = { title: 'Alice', peer: { uid: 7, login: 'alice' } };
    expect(conversationIdentity(alice, reloaded, SERVER).known, 'still known here').toBe(F);
    expect(reloaded.byLogin(SERVER, 'alice2')).toBe(F);
    expect(reloaded.byLogin(ELSEWHERE, 'al')).toBe(F);
    // Back here with her identity stripped, the confirmation still holds.
    expect(sealedBefore({ lines: [], peer: alice.peer }, [F], new Map(), reloaded, SERVER), 'sealed with here').toBe(true);
    expect(sealedBefore({ lines: [], peer: alice.peer }, [F], new Map(), reloaded, ELSEWHERE), 'never sealed with there').toBe(false);

    // A tab that never heard G accepted sees F again, later.
    await reloaded.note(G, SERVER, { login: 'alice', nick: 'Alice' }, { accepted: true });
    const stale = new PeerMemory(peers);
    await stale.load();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await new PeerMemory(peers).note(F, SERVER, { login: 'alice', nick: 'Alice' });
    await stale.load();
    expect(stale.byLogin(SERVER, 'alice')).toBe(G);
    // Nor can it lose what other tabs wrote of F by writing its own.
    expect(stale.get(SERVER, F)).toMatchObject({ sealed: true, logins: ['alice', 'alice2'] });
  });
});

describe('sealedBefore', () => {
  it('holds a conversation to the confirmation once it could have been sealed, whatever its row says now', async () => {
    const memory = new PeerMemory(peers);
    await memory.note(F, SERVER, { nick: 'Alice' }, { sealed: true });
    await memory.note(G, SERVER, { nick: 'Bob' });
    const reloaded = new PeerMemory(peers);
    await reloaded.load();
    const pm = (lines: Partial<Line>[] = [], uid = 7) => ({ lines: lines.map((l) => ({ t: 0, kind: 'chat' as const, text: '', ...l })), peer: { uid } });
    const cases: [string, ReturnType<typeof pm>, (string | null)[], Map<number, string>, boolean][] = [
      ['a sealed message in it', pm([{ sealed: true }]), [null], new Map(), true],
      ['its row said sealed, and has lost its identity since', pm(), [null], new Map([[7, F]]), true],
      ['its identity seen sealed at another uid', pm(), [F], new Map([[9, F]]), true],
      ['its identity sealed to before the reload', pm(), [F], new Map(), true],
      ['its identity only verified before', pm(), [G], new Map(), false],
      ['nothing known', pm([{ sealed: false }]), [null], new Map(), false],
    ];
    for (const [name, c, fps, rows, want] of cases) expect(sealedBefore(c, fps, rows, reloaded, SERVER), name).toBe(want);
  });
});

describe('a message under an identity', () => {
  it('gives a conversation its identity only where nothing remembered says otherwise, and seals to another only once asked', async () => {
    const memory = new PeerMemory(peers);
    await memory.note(F, SERVER, { login: 'alice', nick: 'Alice' }, { sealed: true });
    // Alice is remembered under F; a server can put G on any uid it calls Alice.
    const cases: [string, PeerConversation, string, User[], 'adopt' | 'warn', object][] = [
      ['nothing remembered', { title: 'Carol', peer: { uid: 9 } }, G, [row(9, G)], 'adopt', { uid: 9, fingerprint: G }],
      ['the login remembered under it', { title: 'Alice', peer: { uid: 9, login: 'alice' } }, F, [row(9, F)], 'adopt', { uid: 9, fingerprint: F }],
      ['the login remembered under another', { title: 'Alice', peer: { uid: 9, login: 'alice' } }, G, [row(9, G)], 'warn', { changed: G, uid: 9, was: F }],
      ['no login, a nick remembered under another', { title: 'Alice', peer: { uid: 9 } }, G, [row(9, G)], 'warn', { changed: G, uid: 9, was: F }],
      ['another login, a nick remembered under another', { title: 'Alice', peer: { uid: 9, login: 'alice2' } }, G, [row(9, G)], 'warn', { changed: G, uid: 9, was: F }],
      ['the conversation already under another', { title: 'Alice', peer: { uid: 9 }, verified: F }, G, [row(9, G)], 'warn', { changed: G, uid: 9, was: F }],
    ];
    for (const [name, conv, fp, roster, want, target] of cases) {
      const ids = conversationIdentity(conv, memory, SERVER);
      expect(adoption(ids, fp), name).toBe(want);
      if (want === 'adopt') conv.verified = fp;
      const after = conversationIdentity(conv, memory, SERVER);
      expect(sealTarget(conv, after.known, roster, after.hint), name).toEqual(target);
    }
  });
});

describe('sighting', () => {
  it('remembers a login only from a message verified or deniable under the identity its conversation is under', () => {
    const sig = (state: string, signer: string | null) => ({ state, signer });
    const from = { login: 'alice', nick: 'Alice' };
    const seen = { fingerprint: F, who: from };
    const cases: [string, { state: string; signer: string | null } | undefined, string | null, object | null][] = [
      ['verified under it', sig('verified', F), F, seen],
      ['deniable under it', sig('deniable', F), F, seen],
      ['verified under another', sig('verified', G), F, null],
      ['unverified', sig('unverified', F), F, null],
      ['invalid', sig('invalid', null), F, null],
      ['unsigned', undefined, F, null],
    ];
    for (const [name, s, known, want] of cases) expect(sighting(s, known, from), name).toEqual(want);
  });
});

describe('signedTo', () => {
  it('signs to the identity a conversation is under, never the roster over it unasked, and to nobody under no identity', () => {
    const cases: [string, string | null, string | null, string | null | undefined, object][] = [
      ['under one the row shows', F, null, F, { to: F }],
      ['under one, the row showing another', F, null, G, { changed: G, was: F }],
      ['under one, the row showing none', F, null, null, { to: null }],
      ['under one, nobody here', F, null, undefined, { to: F }],
      ['first contact, to the row', null, null, G, { to: G }],
      ['a nick last seen under the one shown', null, F, F, { to: F }],
      ['a nick last seen under another', null, F, G, { changed: G, was: F }],
      ['a nick, nobody here', null, F, undefined, { to: null }],
    ];
    for (const [name, known, hint, roster, want] of cases) expect(signedTo({ known, hint }, roster), name).toEqual(want);
  });
});

describe('the deniable switch', () => {
  it('is kept across a reload under a known identity, on the conversation alone under one only the roster names, and under the identity it gains', async () => {
    const memory = new PeerMemory(peers);
    await memory.note(F, SERVER, { login: 'alice', nick: 'Alice' });
    const known: PeerConversation = { title: 'Alice', peer: { uid: 7, login: 'alice' } };
    const unknown: PeerConversation = { title: 'Bob', peer: { uid: 8 } };
    await chooseDeniable(known, memory, SERVER, true);
    await chooseDeniable(unknown, memory, SERVER, true);
    expect([deniableChoice(known, memory, SERVER), deniableChoice(unknown, memory, SERVER)]).toEqual([true, true]);

    const reloaded = new PeerMemory(peers);
    await reloaded.load();
    expect(deniableChoice({ title: 'Alice', peer: { uid: 3, login: 'alice' } }, reloaded, SERVER)).toBe(true);
    expect(deniableChoice({ title: 'Bob', peer: { uid: 8 } }, reloaded, SERVER)).toBeUndefined();
    expect((await peers.all()).map((r) => r.fingerprint)).toEqual([F]);

    // Bob's identity, once his first sealed message gives it, keeps the
    // choice made before it.
    await rememberIdentity(unknown, memory, SERVER, G, { login: 'bob', nick: 'Bob' }, { sealed: true });
    const later = new PeerMemory(peers);
    await later.load();
    expect(deniableChoice({ title: 'Bob', peer: { uid: 4, login: 'bob' } }, later, SERVER)).toBe(true);
  });
});

describe('neverSealedFallback', () => {
  it('asks each time where an identity session writes to someone sealed with before, its server silent on sealing, and only then', () => {
    const cases: [string, boolean, boolean, string][] = [
      ['an identity session, sealed with before', true, true, 'ask'],
      ['an identity session, never sealed with', true, false, 'note'],
      ['a password login, sealed with before', false, true, 'note'],
      ['a password login', false, false, 'note'],
    ];
    for (const [name, device, before, want] of cases) expect(neverSealedFallback({ device }, before), name).toBe(want);
  });
});

describe('neverSeals', () => {
  it('says why a session can never seal, so it is told rather than asked, and nothing where it can', () => {
    const cases: [string, { sealing: boolean; device: boolean }, boolean][] = [
      ['a password login', { sealing: false, device: false }, true],
      ['an identity the server did not echo', { sealing: false, device: true }, true],
      ['a sealing session', { sealing: true, device: true }, false],
    ];
    for (const [name, session, never] of cases) expect(neverSeals(session) !== null, name).toBe(never);
  });
});

describe('splitUtf8', () => {
  it('cuts a message the server would cut into pieces it carries, between characters, and between code points only inside one too long', () => {
    const cases: [string, string, number, number][] = [
      ['short', 'hello', 4096, 1],
      ['empty', '', 4096, 1],
      ['exactly the limit', 'a'.repeat(4096), 4096, 1],
      ['one byte over', 'a'.repeat(4097), 4096, 2],
      ['four-byte characters across the edge', 'a'.repeat(4094) + '\u{1F600}\u{1F600}', 4096, 2],
      ['twice over in two-byte characters', '\u00e9'.repeat(4097), 4096, 3],
      ['a joined emoji across the edge, kept whole', 'a'.repeat(4090) + FAMILY, 4096, 2],
      ['one character longer than a piece', FAMILY, 8, 3],
    ];
    const bytes = (t: string) => new TextEncoder().encode(t).length;
    for (const [name, text, max, n] of cases) {
      const pieces = splitUtf8(text, max);
      expect(pieces.length, name).toBe(n);
      expect(pieces.join(''), name).toBe(text);
      for (const p of pieces) expect(bytes(p), name).toBeLessThanOrEqual(max);
      for (const p of pieces) expect(/\p{Cs}/u.test(p), name).toBe(false);
    }
    expect(splitUtf8('a'.repeat(4090) + FAMILY, 4096)[1]).toBe(FAMILY);
  });
});
