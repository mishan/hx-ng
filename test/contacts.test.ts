import { beforeEach, describe, expect, it } from 'vitest';

import { fingerprintToString } from '@hotline-ng/client';

import { canonicalFingerprint, contactList, contactLookup, groupFingerprint, signerLabel } from '../src/contacts';
import { peers } from '../src/identity/storage';
import { PeerMemory } from '../src/sealing';
import { installFakeIndexedDB } from './fake-idb';

const [F, G, H, S, U] = ['f', 'g', 'h', 's', 'u'].map((c) => c.repeat(52)) as [string, string, string, string, string];
const SERVER = 'wss://hl.example';
const ELSEWHERE = 'wss://elsewhere.example';
const later = () => new Promise((resolve) => setTimeout(resolve, 2));

beforeEach(() => {
  installFakeIndexedDB();
});

describe('the compared mark', () => {
  it("holds across a reload, and across tabs the user's last word wins", async () => {
    const tab = new PeerMemory(peers);
    await tab.note(F, SERVER, { login: 'alice', nick: 'Alice' });
    await tab.setCompared(F, 'Alice');

    const reloaded = new PeerMemory(peers);
    await reloaded.load();
    expect(reloaded.compared(F)).toBe(true);
    expect(reloaded.mark(F)).toMatchObject({ fingerprint: F, name: 'Alice' });

    // A tab that loaded while it was compared, and never heard of the
    // unmark, does not bring the mark back by writing records of its own.
    const stale = new PeerMemory(peers);
    await stale.load();
    await reloaded.setCompared(F, null);
    await stale.note(F, SERVER, { login: 'alice', nick: 'Alice' }, { sealed: true });
    await stale.setCompared(G, 'Bob');
    await tab.load();
    expect([tab.compared(F), tab.compared(G)]).toEqual([false, true]);

    // But its user marking it again, later, is the last word.
    await later();
    await stale.setCompared(F, 'Alice');
    await tab.load();
    expect(tab.compared(F)).toBe(true);
  });
});

describe('forgetting a contact', () => {
  it('removes its records on every server and its mark, from the store and from a tab that loads after', async () => {
    const tab = new PeerMemory(peers);
    await tab.note(F, SERVER, { login: 'alice', nick: 'Alice' }, { sealed: true });
    await tab.note(F, ELSEWHERE, { login: 'al', nick: 'Al' });
    await tab.note(G, SERVER, { login: 'bob', nick: 'Bob' });
    await tab.setCompared(F, 'Alice');
    const other = new PeerMemory(peers);
    await other.load();
    expect(Object.fromEntries(contactList(other).map((c) => [c.fingerprint, c.seen.length]))).toEqual({ [F]: 2, [G]: 1 });

    await tab.forget(F);
    for (const memory of [tab, other]) {
      await memory.load();
      expect(contactList(memory).map((c) => c.fingerprint)).toEqual([G]);
      expect([memory.byLogin(SERVER, 'alice'), memory.compared(F)]).toEqual([null, false]);
    }
    expect(await peers.marks()).toEqual([]);
    expect((await peers.all()).map((r) => r.fingerprint)).toEqual([G]);
  });
});

describe('a load', () => {
  it('keeps what was noted while it read, and takes nothing back that was forgotten while it was being written', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    // The store as read before the note below is written, handed back after.
    const snapshot = await peers.all();
    const slow = { ...peers, all: () => gate.then(() => snapshot) };
    const memory = new PeerMemory(slow);
    const loading = memory.load();
    await memory.note(F, SERVER, { login: 'alice', nick: 'Alice' }, { sealed: true, deniable: true, accepted: true });
    release();
    await loading;
    expect(memory.get(SERVER, F)).toMatchObject({ sealed: true, deniable: true, accepted: expect.any(Number) });

    const noting = memory.note(G, SERVER, { nick: 'Bob' }, { sealed: true });
    await memory.forget(G);
    await noting;
    expect(memory.get(SERVER, G)).toBeUndefined();

    // Forgotten here while a load read the store as it was before.
    await memory.setCompared(F, 'Alice');
    let reopen = () => {};
    const held = new Promise<void>((resolve) => (reopen = resolve));
    const before = [await peers.all(), await peers.marks()] as const;
    const reader = new PeerMemory({ ...peers, all: () => held.then(() => before[0]), marks: () => held.then(() => before[1]) });
    const reading = reader.load();
    await reader.forget(F);
    reopen();
    await reading;
    expect([reader.get(SERVER, F), reader.compared(F)]).toEqual([undefined, false]);
  });
});

describe('signerLabel', () => {
  it('names a key only by the name the user compared it as, and otherwise by the key, the server\'s nick always beside', async () => {
    const memory = new PeerMemory(peers);
    await memory.note(F, SERVER, { login: 'alice', nick: 'alice' });
    await memory.note(G, SERVER, { nick: 'alice' });
    await memory.note(H, SERVER, { nick: 'Carol' });
    await memory.setCompared(H, 'Carol');
    await memory.note(H, SERVER, { nick: 'Caz' });
    const contact = contactLookup(memory, S);
    const sig = (state: string, signer: string | null = F) => ({ state, signer });
    const key = (fp: string) => fp.slice(0, 16);
    const cases: [string, ReturnType<typeof sig> | undefined, string, object][] = [
      ['unsigned', undefined, 'alice', { name: 'alice', byKey: false, nick: null, compared: null }],
      ['a bad signature', sig('invalid', null), 'alice', { name: 'alice', byKey: false, nick: null, compared: null }],
      ['one key under a nick, not compared', sig('verified', F), 'alice', { name: key(F), byKey: true, nick: 'alice', compared: false }],
      ['another key under that nick, not compared', sig('verified', G), 'alice', { name: key(G), byKey: true, nick: 'alice', compared: false }],
      ['compared, its nick since changed', sig('verified', H), 'Caz', { name: 'Carol', byKey: false, nick: 'Caz', compared: true }],
      ['compared, under the name it was compared as', sig('verified', H), 'Carol', { name: 'Carol', byKey: false, nick: 'Carol', compared: true }],
      ['deniable, compared', sig('deniable', H), 'Caz', { name: 'Carol', byKey: false, nick: 'Caz', compared: true }],
      ['signed elsewhere, compared', sig('elsewhere', H), '', { name: 'Carol', byKey: false, nick: null, compared: true }],
      ['a first-contact key under a compared contact\'s nick', sig('verified', U), 'Carol', { name: key(U), byKey: true, nick: 'Carol', compared: false }],
      ['unverified, never by the name', sig('unverified', H), 'Carol', { name: key(H), byKey: true, nick: 'Carol', compared: null }],
      ["this user's own", sig('verified', S), 'Me', { name: key(S), byKey: true, nick: 'Me', compared: null }],
      ['a key that could not be checked', sig('verified', null), 'alice', { name: 'unknown key', byKey: true, nick: 'alice', compared: null }],
    ];
    for (const [name, s, nick, want] of cases) expect(signerLabel(s, nick, contact), name).toEqual(want);

    // Two compared keys given one name are told apart by their keys.
    await memory.setCompared(F, 'Carol');
    expect([F, H].map((fp) => signerLabel(sig('verified', fp), 'x', contact).name)).toEqual([`Carol (key ${key(F)})`, `Carol (key ${key(H)})`]);
  });
});

describe('canonicalFingerprint', () => {
  it('writes a key as the library does, whatever spelling the server gave, and refuses what is not one', () => {
    const fp = fingerprintToString(new Uint8Array(32).fill(7));
    const cases: [string, string, string | null][] = [
      ['as written', fp, fp],
      ['in capitals', fp.toUpperCase(), fp],
      ['not a fingerprint', 'alice', null],
    ];
    for (const [name, input, want] of cases) expect(canonicalFingerprint(input), name).toBe(want);
  });
});

describe('groupFingerprint', () => {
  it('cuts a fingerprint into fours to read aloud, losing nothing', () => {
    const fp = '0123456789abcdefghjkmnpqrstvwxyz0123456789abcdefghjk';
    const cases: [string, string, string][] = [
      ['a whole fingerprint', fp, '0123 4567 89ab cdef ghjk mnpq rstv wxyz 0123 4567 89ab cdef ghjk'],
      ['a short one, its last group short', 'abcdef', 'abcd ef'],
      ['nothing', '', ''],
    ];
    for (const [name, input, want] of cases) expect(groupFingerprint(input), name).toBe(want);
    expect(groupFingerprint(fp).replaceAll(' ', '')).toBe(fp);
  });
});
