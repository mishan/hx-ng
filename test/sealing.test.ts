import { beforeEach, describe, expect, it } from 'vitest';

import { WireFailure, type MsgOk, type User, type WireError } from '@hotline-ng/client';

import { peers } from '../src/identity/storage';
import {
  CertProblem,
  OWN_PERSON,
  PeerMemory,
  PersonProbes,
  RESEALS,
  adoption,
  chooseDeniable,
  conversationIdentity,
  deniableChoice,
  lineFingerprint,
  neverSealedFallback,
  neverSeals,
  probeRow,
  probesPerson,
  sealingAfterSnapshot,
  rememberIdentity,
  sealToDevices,
  sealTarget,
  sealedBefore,
  sighting,
  signedTo,
  splitUtf8,
  type PeerConversation,
  type SealDevice,
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

  it('seals to a person whose devices were listed sealable under the identity its row shows, which its row alone cannot say', () => {
    const person = [row(7, F, false)];
    expect(sealTarget(conv(7), null, person, null, new Map([[7, F]]))).toEqual({ uid: 7, fingerprint: F });
    expect(sealTarget(conv(7), F, person, null, new Map([[7, F]]))).toEqual({ uid: 7, fingerprint: F });
    expect(sealTarget(conv(7), null, person, null, new Map([[7, G]]))).toEqual({ cannot: "Alice's session cannot open sealed messages" });
    expect(sealTarget(conv(7), F, [row(7, G), row(9, F, false)], null, new Map([[9, F]]))).toEqual({ uid: 9, fingerprint: F });
  });

  it('seals to no row of its own person, wherever it comes from, so a reply there is asked about where a sealed line came', () => {
    expect(sealTarget(conv(1), null, [row(1, F)], null, new Map(), 1)).toEqual({ cannot: OWN_PERSON });
    expect(sealTarget(conv(7), F, [row(7, G), row(1, F)], null, new Map(), 1)).toEqual({ cannot: OWN_PERSON });
    // Another of its devices sealed to it, so the clear one is asked about.
    const sealedIn = { lines: [{ t: 0, kind: 'chat' as const, text: '', sealed: true as const }], peer: { uid: 1 } };
    expect(sealedBefore(sealedIn, [null], new Map(), new PeerMemory(), SERVER)).toBe(true);
  });
});

describe('probesPerson', () => {
  it('asks a row its devices only with persons, sealing, and an identity its row does not already say can be sealed to, never its own', () => {
    const on = { persons: true, sealing: true, self: 1 };
    const cases: [string, typeof on, User | undefined, Map<number, string>, boolean][] = [
      ['a row with an identity and no sealed', on, row(7, F, false), new Map(), true],
      ['without persons', { ...on, persons: false }, row(7, F, false), new Map(), false],
      ['a session that cannot seal', { ...on, sealing: false }, row(7, F, false), new Map(), false],
      ['a row that says sealed', on, row(7, F), new Map(), false],
      ['a row with no identity', on, row(7), new Map(), false],
      ['nobody at the uid', on, undefined, new Map(), false],
      ['its own person', on, row(1, F, false), new Map(), false],
      ['listed already under that identity', on, row(7, F, false), new Map([[7, F]]), false],
      ['listed under another', on, row(7, F, false), new Map([[7, G]]), true],
    ];
    for (const [name, session, r, held, want] of cases) expect(probesPerson(session, r, held), name).toBe(want);
  });
});

describe('probeRow', () => {
  it('asks the row holding the identity a conversation is under, wherever it is now, and the conversation\'s own with none known', () => {
    const roster = [row(7, G, false), row(9, F, false)];
    expect(probeRow(conv(7), F, roster)?.uid).toBe(9);
    expect(probeRow(conv(9), F, roster)?.uid).toBe(9);
    expect(probeRow(conv(7), null, roster)?.uid).toBe(7);
    // Nobody holds it now: the conversation's row, which may offer the one it shows.
    expect(probeRow(conv(7), 'H'.repeat(52), roster)?.uid).toBe(7);
    expect(probeRow(conv(), null, roster)).toBeUndefined();
  });
});

describe('sealingAfterSnapshot', () => {
  it('keeps what this session saw sealed over a roster-only snapshot, and starts again for a fresh one', () => {
    const fresh = () => ({ sealedRows: new Map([[3, G]]), certs: new Map([[3, { fingerprint: G, devices: [] }]]) });
    const stale = fresh();
    sealingAfterSnapshot(stale, [row(7, F)], true);
    expect([...stale.sealedRows]).toEqual([
      [3, G],
      [7, F],
    ]);
    expect(stale.certs.size).toBe(1);
    const again = fresh();
    sealingAfterSnapshot(again, [row(7, F), row(8, F, false)], false);
    expect([...again.sealedRows]).toEqual([[7, F]]);
    expect(again.certs.size).toBe(0);
  });
});

describe('PersonProbes', () => {
  const devices: SealDevice[] = [{ device: 3, cert: new Uint8Array([3]) }];
  const wire = (code: string) => new WireFailure({ code, text: `${code}.` });

  it('asks once for probes made together, and not again for a person it cannot seal to until told, or a while', async () => {
    let now = 0;
    const probes = new PersonProbes(() => now, 1000);
    let asked = 0;
    const listing = async () => (asked++, devices);
    const [a, b] = await Promise.all([probes.probe(7, F, listing), probes.probe(7, F, listing)]);
    expect([a, b, asked]).toEqual([devices, devices, 1]);

    const refusing = async () => {
      asked++;
      throw wire('not_sealed');
    };
    expect(await probes.probe(8, F, refusing)).toBeNull();
    expect(await probes.probe(8, F, refusing)).toBeNull();
    expect(asked).toBe(2);
    expect(await probes.probe(8, G, refusing)).toBeNull();
    expect(asked).toBe(3);
    now = 1001;
    await probes.probe(8, F, refusing);
    expect(asked).toBe(4);
    probes.forget(8);
    await probes.probe(8, F, refusing);
    expect(asked).toBe(5);
  });

  it('lets no probe begun before its row changed answer a later one, or keep a refusal for it', async () => {
    for (const drop of [(p: PersonProbes) => p.forget(7), (p: PersonProbes) => p.clear()]) {
      const probes = new PersonProbes();
      const answers: ((v: SealDevice[] | Error) => void)[] = [];
      let asked = 0;
      const listing = () => {
        asked++;
        return new Promise<SealDevice[]>((resolve, reject) => answers.push((v) => (v instanceof Error ? reject(v) : resolve(v))));
      };
      const first = probes.probe(7, F, listing);
      drop(probes);
      const second = probes.probe(7, F, listing);
      expect(asked, 'the second asks afresh').toBe(2);
      // The first is answered late, a refusal it was told to forget.
      answers[0]!(wire('not_sealed'));
      answers[1]!(devices);
      expect(await second).toEqual(devices);
      await first.catch(() => {});
      expect(await probes.probe(7, F, async () => (asked++, devices))).toEqual(devices);
      expect(asked, 'the late refusal was not kept').toBe(3);
    }
  });

  it('takes not_sealed and blocked for a person it cannot seal to, and refuses to send on anything else', async () => {
    const probes = new PersonProbes();
    expect(await probes.probe(7, F, async () => Promise.reject(wire('blocked')))).toBeNull();
    await expect(probes.probe(8, F, async () => Promise.reject(wire('rate_limited')))).rejects.toThrow('Not sent: rate_limited');
    let asked = 0;
    await probes.probe(8, F, async () => (asked++, devices));
    expect(asked).toBe(1);
  });
});

describe('sealToDevices', () => {
  const cert = (n: number) => new Uint8Array([n]);
  const wire = (code: string, extra: Partial<WireError> = {}) => new WireFailure({ code, text: `${code}.`, ...extra });
  const OK: MsgOk = { queued: false };

  /** A server scripted by what each send answers, recording what was
   *  asked and sent. */
  function server(answers: (Error | MsgOk)[], listed: SealDevice[] = [{ device: 1, cert: cert(1) }]) {
    const asked: string[] = [];
    const sent: SealDevice[][] = [];
    return {
      asked,
      sent,
      wire: {
        list: async () => (asked.push('list'), listed),
        one: async (device: number) => (asked.push(`one ${device}`), cert(device + 100)),
        send: async (devices: SealDevice[]) => {
          sent.push(devices);
          const a = answers.shift()!;
          if (a instanceof Error) throw a;
          return a;
        },
      },
    };
  }

  it('seals to the devices held, or asks for them', async () => {
    const held = server([OK]);
    expect(await sealToDevices(held.wire, [{ device: 2, cert: cert(2) }])).toEqual({ ok: OK, devices: [{ device: 2, cert: cert(2) }] });
    expect(held.asked).toEqual([]);
    const asked = server([OK]);
    expect(await sealToDevices(asked.wire, null)).toEqual({ ok: OK, devices: [{ device: 1, cert: cert(1) }] });
    expect(asked.asked).toEqual(['list']);
  });

  it('seals again to the devices a devices_changed lists, and refetches the one a cert_changed names', async () => {
    const s = server([wire('devices_changed', { devices: [{ device: 3, cert: 'Aw' }, { device: 4, cert: 'BA' }] }), wire('cert_changed', { device: 4 }), OK]);
    const got = await sealToDevices(s.wire, [{ device: 2, cert: cert(2) }]);
    expect(s.sent).toEqual([
      [{ device: 2, cert: cert(2) }],
      [{ device: 3, cert: cert(3) }, { device: 4, cert: cert(4) }],
      [{ device: 3, cert: cert(3) }, { device: 4, cert: cert(104) }],
    ]);
    expect(s.asked).toEqual(['one 4']);
    expect(got).toEqual({ ok: OK, devices: s.sent[2] });
  });

  it('asks the whole list again for a cert_changed that names no device, as a session alone answers', async () => {
    const s = server([wire('cert_changed'), OK], [{ device: null, cert: cert(9) }]);
    await sealToDevices(s.wire, [{ device: null, cert: cert(8) }]);
    expect(s.asked).toEqual(['list']);
    expect(s.sent[1]).toEqual([{ device: null, cert: cert(9) }]);
  });

  it('gives up after so many reseals, and never sends in the clear', async () => {
    const s = server(Array.from({ length: RESEALS + 1 }, () => wire('devices_changed', { devices: [{ device: 3, cert: 'Aw' }] })));
    await expect(sealToDevices(s.wire, null)).rejects.toThrow('Not sent: devices_changed');
    expect(s.sent).toHaveLength(RESEALS + 1);
  });

  it('says why it cannot be sealed where the server says so, and fails anything else', async () => {
    expect(await sealToDevices(server([wire('not_sealed')]).wire, null)).toEqual({ why: 'not_sealed' });
    expect(await sealToDevices(server([wire('not_delivered')]).wire, null)).toEqual({ why: 'not_delivered' });
    await expect(sealToDevices(server([wire('mailbox_full')]).wire, null)).rejects.toThrow('Not sent: mailbox_full');
  });

  it('asks the list again where the device a cert_changed names is gone, or was never held', async () => {
    const gone = server([wire('cert_changed', { device: 2 }), OK], [{ device: 5, cert: cert(5) }]);
    gone.wire.one = async () => Promise.reject(wire('no_such_device'));
    await sealToDevices(gone.wire, [{ device: 2, cert: cert(2) }]);
    expect(gone.sent[1]).toEqual([{ device: 5, cert: cert(5) }]);
    const stray = server([wire('cert_changed', { device: 9 }), OK], [{ device: 5, cert: cert(5) }]);
    await sealToDevices(stray.wire, [{ device: 2, cert: cert(2) }]);
    expect(stray.asked).toEqual(['list']);
  });

  it('fails, never seals in the clear, where asking for devices fails, or the server lists more than a message carries', async () => {
    const paced = server([wire('cert_changed', { device: 2 })]);
    paced.wire.one = async () => Promise.reject(wire('rate_limited'));
    await expect(sealToDevices(paced.wire, [{ device: 2, cert: cert(2) }])).rejects.toThrow('Not sent: rate_limited');
    const gone = server([wire('devices_changed')]);
    gone.wire.list = async () => Promise.reject(wire('not_sealed'));
    expect(await sealToDevices(gone.wire, [{ device: 2, cert: cert(2) }])).toEqual({ why: 'not_sealed' });
    const many = Array.from({ length: 12 }, (_, i) => ({ device: i + 1, cert: 'AQ' }));
    const flood = server([wire('devices_changed', { devices: many })]);
    await expect(sealToDevices(flood.wire, [{ device: 2, cert: cert(2) }])).rejects.toThrow('Not sent');
    expect(flood.sent).toHaveLength(1);
  });

  it('asks again where a held certificate did not pass, and says why where an answer did not', async () => {
    const held = server([new CertProblem('expired'), OK]);
    expect(await sealToDevices(held.wire, [{ device: 2, cert: cert(2) }])).toMatchObject({ ok: OK });
    expect(held.asked).toEqual(['list']);
    const fresh = server([new CertProblem('expired')]);
    expect(await sealToDevices(fresh.wire, null)).toEqual({ why: 'the certificate the server gave for them did not pass: expired' });
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
