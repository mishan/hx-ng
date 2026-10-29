import { describe, expect, it } from 'vitest';

import {
  base64urlToBytes,
  bytesToBase64url,
  checkFriendWithdrawal,
  cBytes,
  cOptMap,
  cUint,
  checkFriendship,
  encodeCbor,
  fingerprintFromString,
  DEVICE_CERT_DOMAIN,
  signFriendOffer,
  signFriendWithdrawal,
  hexToBytes,
  pairHash,
  WireFailure,
  type Friend,
  type FriendStateOk,
  type FriendshipsFetchOk,
  type FriendshipsPresentOk,
} from '@hotline-ng/client';

import { MemoryBookStore, OFFER_LIFETIME_SECONDS, PortableFriends, type KeeperConn } from '../src/friendships';
import vectors from '../packages/hotline-ng/test/identity-vectors.json';

const V: Record<string, any> = vectors;
const T0: number = V.friends.now;
const ALICE: string = V.keys.identity.fingerprint;
const BOB: string = V.keys.other.fingerprint;

const PKCS8_ED25519_PREFIX = hexToBytes('302e020100300506032b657004220420');
const importSeed = (seedHex: string) =>
  crypto.subtle.importKey('pkcs8', new Uint8Array([...PKCS8_ED25519_PREFIX, ...hexToBytes(seedHex)]), { name: 'Ed25519' }, false, ['sign']);

type Answer = (params: any) => unknown;

/** A server as far as the keeper reaches it: each request recorded and
 *  answered by the case's script. */
class Wire implements KeeperConn {
  readonly calls: { req: string; params: any }[] = [];
  constructor(private answers: Record<string, Answer> = {}) {}

  on(req: string, answer: Answer): this {
    this.answers[req] = answer;
    return this;
  }

  sent(req: string): any[] {
    return this.calls.filter((c) => c.req === req).map((c) => c.params);
  }

  private async call<T>(req: string, params: unknown): Promise<T> {
    this.calls.push({ req, params });
    const answer = this.answers[req];
    if (!answer) throw new Error(`nothing answers ${req}`);
    return answer(params) as T;
  }

  friendAdd(login: string, note?: string, offer?: string) {
    return this.call<FriendStateOk>('friend_add', { login, ...(note ? { note } : {}), ...(offer ? { offer } : {}) });
  }
  friendRespond(login: string, accept: boolean, friendship?: string) {
    return this.call<FriendStateOk>('friend_respond', { login, accept, ...(friendship ? { friendship } : {}) });
  }
  friendRemove(who: any) {
    return this.call<Record<string, never>>('friend_remove', typeof who === 'string' ? { login: who } : who);
  }
  findUser(who: any) {
    return this.call<any>('find_user', typeof who === 'string' ? { login: who } : who);
  }
  block(who: any) {
    return this.call<Record<string, never>>('block', who);
  }
  friendshipsPresent(params: any) {
    return this.call<FriendshipsPresentOk>('friendships_present', params);
  }
  friendshipsFetch(params: any) {
    return this.call<FriendshipsFetchOk>('friendships_fetch', params);
  }
}

const refuse = (code: string) => () => {
  throw new WireFailure({ code, text: code });
};
const shown = (fingerprint?: string) => () => ({ user: { login: 'bob', name: 'bob', ...(fingerprint ? { fingerprint } : {}) } });
const presentAll = (result = 'ok') => (p: any) => ({
  withdrawals: (p.withdrawals ?? []).map(() => ({ hash: 'h', result })),
  friendships: (p.friendships ?? []).map(() => ({ hash: 'h', result })),
});

interface Party {
  wire: Wire;
  keeper: PortableFriends;
  store: MemoryBookStore;
}

let clock = T0;

type Signer = { seed: string; cert: string };
const ALICE_DEVICE: Signer = { seed: V.keys.device.seed_hex, cert: V.message_cert.signed_hex };
const BOB_DEVICE: Signer = { seed: V.keys.other_device.seed_hex, cert: V.friend_objects.cert_other.signed_hex };
const SUCC: string = V.keys.successor.fingerprint;
const b64hex = (h: string) => bytesToBase64url(hexToBytes(h));

async function party(who: 'alice' | 'bob' | Signer, server: string, store = new MemoryBookStore(), wire = new Wire()): Promise<Party> {
  const { seed, cert } = who === 'alice' ? ALICE_DEVICE : who === 'bob' ? BOB_DEVICE : who;
  const keeper = await PortableFriends.open({
    conn: wire,
    server,
    signer: { key: await importSeed(seed), cert: hexToBytes(cert) },
    store,
    say: () => {},
    now: () => clock,
  });
  return { wire, keeper, store };
}

/** A second device of Alice's, or Bob's, certified by that identity's
 *  key. */
async function secondDevice(who: 'alice' | 'bob' = 'alice'): Promise<Signer> {
  const f = (who === 'alice' ? V.message_cert : V.friend_objects.cert_other).fields;
  const entries: [string, any][] = [
    ['v', cUint(1)],
    ['identity', cBytes(hexToBytes(f.identity))],
    ['device', cBytes(hexToBytes(V.keys.lost_device.public_hex))],
    ['device_enc', cBytes(hexToBytes(f.device_enc))],
    ['issued', cUint(f.issued)],
    ['expires', cUint(f.expires)],
    ['caps', cUint(3)],
  ];
  const input = new Uint8Array([...new TextEncoder().encode(DEVICE_CERT_DOMAIN), 0, ...encodeCbor(cOptMap(entries))]);
  const seed = (who === 'alice' ? V.keys.identity : V.keys.other).seed_hex;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, await importSeed(seed), input));
  const cert = encodeCbor(cOptMap([...entries, ['sig', cBytes(sig)]]));
  return { seed: V.keys.lost_device.seed_hex, cert: [...cert].map((b) => b.toString(16).padStart(2, '0')).join('') };
}

/** Alice offers on `server` at `start`, Bob accepts a minute later, and
 *  Alice reads the roster that names the friendship `wait` seconds after
 *  she offered. */
async function befriend(server: string, wait = 120, start = T0): Promise<{ alice: Party; bob: Party; hash: string; friendship: string }> {
  clock = start;
  const alice = await party('alice', server);
  const bob = await party('bob', server);
  alice.wire.on('friend_add', () => ({ state: 'pending_out' })).on('find_user', shown(BOB));
  await alice.keeper.add('bob', undefined);
  const offer: string = alice.wire.sent('friend_add')[0].offer;
  clock = start + 60;
  bob.wire.on('friend_respond', () => ({ state: 'accepted' }));
  await bob.keeper.accept({ login: 'alice', state: 'pending_in', fingerprint: ALICE, offer });
  const friendship: string = bob.wire.sent('friend_respond')[0].friendship;
  const hash = bytesToBase64url((await checkFriendship(base64urlToBytes(friendship), clock)).hash);
  clock = start + wait;
  alice.wire.on('friendships_fetch', () => ({ friendships: [{ hash, friendship }], rotations: [] }));
  await alice.keeper.onRoster([{ login: 'bob', state: 'accepted', fingerprint: BOB, friendships: [hash] }]);
  return { alice, bob, hash, friendship };
}

/** An offer from Alice's successor key to Bob, signed now. */
async function successorOffer(): Promise<string> {
  return bytesToBase64url(
    await signFriendOffer(await importSeed(V.keys.device.seed_hex), {
      from: hexToBytes(V.keys.successor.public_hex),
      to: fingerprintFromString(BOB)!,
      time: clock,
      expires: clock + 86400,
      cert: hexToBytes(V.friend_objects.cert_successor.signed_hex),
    }),
  );
}

/** A server that serves `records` for every fingerprint asked. */
const rotations = (records: string[]) => (p: any) => ({
  friendships: [],
  rotations: (p.fingerprints ?? []).map((fingerprint: string) => ({ fingerprint, records })),
});

describe('portable friends', () => {
  it.each([
    { name: 'within its expiry', wait: 120, adopted: true },
    { name: 'past its expiry and the skew', wait: OFFER_LIFETIME_SECONDS + 601, adopted: false },
    { name: 'at its expiry and the skew', wait: OFFER_LIFETIME_SECONDS + 600, adopted: true },
  ])('adopts an offer of this device that comes back accepted $name', async ({ wait, adopted }) => {
    const { alice, bob, hash } = await befriend('ws://a', wait);
    expect(bob.keeper.book.friendships.map((k) => [k.hash, k.friend, bob.keeper.adopted(k), k.presented])).toEqual([[hash, ALICE, true, ['ws://a']]]);
    expect(alice.keeper.book.friendships.map((k) => [k.friend, alice.keeper.adopted(k), k.presented])).toEqual(adopted ? [[BOB, true, ['ws://a']]] : []);
  });

  it.each([
    { name: 'that links an identity shown here', fingerprint: BOB, offered: true },
    { name: 'whose link is not shown', fingerprint: undefined, offered: false },
  ])('asks a login $name with an offer only where the server shows its key', async ({ fingerprint, offered }) => {
    const alice = await party('alice', 'ws://a', new MemoryBookStore(), new Wire({ find_user: shown(fingerprint), friend_add: () => ({ state: 'pending_out' }) }));
    await alice.keeper.add('bob', 'hi');
    expect(alice.wire.sent('find_user')).toEqual([{ login: 'bob' }]);
    expect(alice.wire.sent('friend_add').map((p) => 'offer' in p)).toEqual([offered]);
  });

  it.each([
    { name: 'its own presentation, first', order: (h: string) => [h, 'another'], presented: ['ws://b'] },
    { name: "the friend's, second", order: (h: string) => ['another', h], presented: [] },
  ])('records a fetched friendship as presented here only where it is $name', async ({ order, presented }) => {
    const { hash, friendship } = await befriend('ws://a');
    const fresh = await party('bob', 'ws://b', new MemoryBookStore());
    fresh.wire.on('friendships_fetch', () => ({ friendships: [{ hash, friendship }, { hash: 'another' }], rotations: [] }));
    await fresh.keeper.onRoster([{ login: 'alice', state: 'accepted', fingerprint: ALICE, friendships: order(hash) }]);
    expect(fresh.keeper.book.friendships.map((k) => [k.presented, k.seen])).toEqual([[presented, ['ws://b']]]);
  });

  it("follows a rotation it checked, accepts the successor's offer when asked, and retires the old key once the move is done", async () => {
    const { bob } = await befriend('ws://a');
    bob.wire.on('friendships_fetch', rotations([b64hex(V.rotate.signed_hex)])).on('friendships_present', presentAll());
    const entry: Friend = { login: 'alice', state: 'accepted', fingerprint: SUCC, offer: await successorOffer() };
    await bob.keeper.onFriend(entry);
    expect(bob.keeper.rotatedFrom(SUCC)).toBe(ALICE);
    expect(bob.wire.sent('friend_respond')).toHaveLength(1);

    await bob.keeper.accept(entry);
    const made: string = bob.wire.sent('friend_respond')[1].friendship;
    expect(bob.keeper.with(SUCC).map((k) => [bob.keeper.adopted(k), k.bringTo])).toEqual([[true, ['ws://a']]]);

    const hash = bytesToBase64url((await checkFriendship(base64urlToBytes(made), clock)).hash);
    const fetched = bob.wire.sent('friendships_fetch').length;
    await bob.keeper.onRoster([{ login: 'alice', state: 'accepted', fingerprint: SUCC, friendships: [hash] }]);
    const [w] = bob.wire.sent('friendships_present').at(-1).withdrawals;
    const pair = [fingerprintFromString(BOB)!, fingerprintFromString(ALICE)!] as const;
    expect((await checkFriendWithdrawal(base64urlToBytes(w), clock, pair)).before).toBe(clock);
    expect(bob.keeper.with(ALICE)).toEqual([]);
    expect(bob.wire.sent('friendships_fetch')).toHaveLength(fetched);
  });

  it("retires no old key while the successor's friendship waits for this device's word", async () => {
    const { bob } = await befriend('ws://a');
    bob.wire.on('friendships_fetch', rotations([b64hex(V.rotate.signed_hex)])).on('friendships_present', presentAll());
    const entry: Friend = { login: 'alice', state: 'accepted', fingerprint: SUCC, offer: await successorOffer() };
    await bob.keeper.onFriend(entry);
    await bob.keeper.accept(entry);
    const hash = bytesToBase64url((await checkFriendship(base64urlToBytes(bob.wire.sent('friend_respond')[1].friendship), clock)).hash);
    const presented = bob.wire.sent('friendships_present').length;
    const newer = await party(await secondDevice('bob'), 'ws://a', bob.store, bob.wire);
    await newer.keeper.onRoster([{ login: 'alice', state: 'accepted', fingerprint: SUCC, friendships: [hash] }]);
    expect(bob.wire.sent('friendships_present')).toHaveLength(presented);
    expect(newer.keeper.with(ALICE)).toHaveLength(1);
  });

  it.each([
    { name: 'a request, accepted plainly', state: 'pending_in' as const, refused: false },
    { name: 'an upgrade offer, refused', state: 'accepted' as const, refused: true },
  ])('takes an offer under a changed key with no checked rotation as someone new: $name', async ({ state, refused }) => {
    const { bob } = await befriend('ws://a');
    bob.wire.on('friendships_fetch', rotations([]));
    const entry: Friend = { login: 'alice', state, fingerprint: SUCC, offer: await successorOffer() };
    if (state === 'accepted') await bob.keeper.onFriend(entry);
    const accepting = bob.keeper.accept(entry);
    if (refused) await expect(accepting).rejects.toThrow(/no rotation/);
    else await accepting;
    expect(bob.wire.sent('friend_respond').slice(1)).toEqual(refused ? [] : [{ login: 'alice', accept: true }]);
    expect(bob.keeper.with(SUCC)).toEqual([]);
  });

  it("takes a withdrawal of the old pair from a friend's verified successor", async () => {
    // Made before the rotation, which the successor's cutoff may not pass.
    const rotatedAt: number = V.rotate.fields.time;
    const { bob } = await befriend('ws://a', 120, V.friend_objects.offer.fields.time);
    clock = rotatedAt + 600;
    bob.wire.on('friendships_fetch', rotations([b64hex(V.rotate.signed_hex)]));
    await bob.keeper.onRoster([{ login: 'alice', state: 'accepted', fingerprint: SUCC }]);
    const withdraw = await signFriendWithdrawal(await importSeed(V.keys.device.seed_hex), {
      from: hexToBytes(V.keys.successor.public_hex),
      pair: await pairHash(fingerprintFromString(ALICE)!, fingerprintFromString(BOB)!),
      party: fingerprintFromString(ALICE)!,
      before: rotatedAt,
      time: clock,
      cert: hexToBytes(V.friend_objects.cert_successor.signed_hex),
    });
    await bob.keeper.onFriend({ login: 'alice', state: 'removed', fingerprint: SUCC, withdraw: bytesToBase64url(withdraw) });
    expect(bob.keeper.with(ALICE)).toEqual([]);
    expect(bob.keeper.book.cutoffs.map((c) => [c.party, c.before])).toEqual([[ALICE, rotatedAt]]);
  });

  it('presents only where the user brings friends, finding each first, and leaves out whom they choose before any is presented', async () => {
    const { alice } = await befriend('ws://a');
    const b = await party('alice', 'ws://b', alice.store, new Wire({ find_user: () => ({}), friendships_present: presentAll() }));
    await b.keeper.onRoster([]);
    expect(b.wire.calls).toEqual([]);

    await b.keeper.setBring(true);
    expect(b.wire.sent('find_user')).toEqual([{ fingerprint: BOB }]);
    expect(b.wire.sent('friendships_present')).toEqual([{ friendships: [alice.keeper.book.friendships[0]!.raw] }]);
    expect(b.keeper.book.friendships[0]!.presented).toEqual(['ws://a', 'ws://b']);

    const c = await party('alice', 'ws://c', alice.store, new Wire({ find_user: () => ({}), friendships_present: presentAll() }));
    await c.keeper.setBring(true, [BOB]);
    expect(c.wire.calls).toEqual([]);
    await c.keeper.setBring(false);
    await c.keeper.setBring(true, []);
    expect(c.keeper.choice.leftOut).toEqual([]);
    expect(c.wire.sent('friendships_present')).toHaveLength(1);
  });

  it.each([
    { name: 'where it presented them, drops what it presented', server: 'ws://a', removed: [{ fingerprint: BOB }] },
    { name: 'where it never did, tells the server nothing', server: 'ws://c', removed: [] },
  ])('leaving a friend out $name', async ({ server, removed }) => {
    const { alice } = await befriend('ws://a');
    const there = await party('alice', server, alice.store, new Wire({ friend_remove: () => ({}) }));
    await there.keeper.leaveOut(BOB, true);
    expect(there.wire.sent('friend_remove')).toEqual(removed);
    expect(there.keeper.book.friendships[0]!.presented).toEqual(server === 'ws://a' ? [] : ['ws://a']);
  });

  it('tries a friend this server cannot find again at a later login', async () => {
    const { alice } = await befriend('ws://a');
    const b = await party('alice', 'ws://b', alice.store, new Wire({ find_user: refuse('no_such_user'), friendships_present: presentAll() }));
    await b.keeper.setBring(true);
    expect(b.wire.sent('friendships_present')).toEqual([]);
    b.wire.on('find_user', () => ({}));
    await b.keeper.onRoster([]);
    expect(b.wire.sent('friendships_present')).toHaveLength(1);
  });

  it('removes with a withdrawal, and owes it, signed afresh, to every other server it was presented on', async () => {
    const { alice } = await befriend('ws://a');
    const b = await party('alice', 'ws://b', alice.store, new Wire({ find_user: () => ({}), friendships_present: presentAll() }));
    await b.keeper.setBring(true);

    clock += 3600;
    const removedAt = clock;
    alice.wire.on('friend_remove', () => ({}));
    await alice.keeper.remove({ login: 'bob', state: 'accepted', fingerprint: BOB });
    const pair = [fingerprintFromString(ALICE)!, fingerprintFromString(BOB)!] as const;
    const sent = await checkFriendWithdrawal(base64urlToBytes(alice.wire.sent('friend_remove')[0].withdraw), clock, pair);
    expect([sent.before, sent.party]).toEqual([removedAt, undefined]);
    expect(alice.keeper.book.friendships).toEqual([]);
    expect(alice.keeper.book.cutoffs.map((c) => [c.party, c.before, c.owed])).toEqual([[ALICE, removedAt, ['ws://b']]]);

    clock += 60;
    const again = await party('alice', 'ws://b', alice.store, new Wire({ friendships_present: presentAll() }));
    await again.keeper.presentWithdrawals();
    const [spread] = again.wire.sent('friendships_present')[0].withdrawals;
    const w = await checkFriendWithdrawal(base64urlToBytes(spread), clock, pair);
    expect([w.before, w.time]).toEqual([removedAt, clock]);
    expect(again.keeper.book.cutoffs[0]!.owed).toEqual([]);
  });

  it("checks a friend's withdrawal handed over in a removal, drops what it ends, and spreads it under its party", async () => {
    const { alice, bob } = await befriend('ws://a');
    const b = await party('bob', 'ws://b', bob.store, new Wire({ find_user: () => ({}), friendships_present: presentAll() }));
    await b.keeper.setBring(true);

    alice.wire.on('friend_remove', () => ({}));
    clock += 3600;
    await alice.keeper.remove({ login: 'bob', state: 'accepted', fingerprint: BOB });
    const withdraw: string = alice.wire.sent('friend_remove')[0].withdraw;

    await bob.keeper.onFriend({ login: 'alice', state: 'removed', fingerprint: ALICE, withdraw: 'not one' });
    expect(bob.keeper.book.friendships).toHaveLength(1);
    await bob.keeper.onFriend({ login: 'alice', state: 'removed', fingerprint: ALICE, withdraw });
    expect(bob.keeper.book.friendships).toEqual([]);
    expect(bob.keeper.book.cutoffs.map((c) => [c.party, c.before, c.owed])).toEqual([[ALICE, clock, ['ws://b']]]);

    clock += 60;
    const again = await party('bob', 'ws://b', bob.store, new Wire({ friendships_present: presentAll() }));
    await again.keeper.presentWithdrawals();
    const [spread] = again.wire.sent('friendships_present')[0].withdrawals;
    const pair = [fingerprintFromString(ALICE)!, fingerprintFromString(BOB)!] as const;
    const w = await checkFriendWithdrawal(base64urlToBytes(spread), clock, pair);
    expect(w.party && bytesToBase64url(w.party)).toBe(bytesToBase64url(fingerprintFromString(ALICE)!));
    expect(bytesToBase64url(w.pair)).toBe(bytesToBase64url(await pairHash(pair[0], pair[1])));
  });

  it('presents again at once, though friends are not brought here, what this server ended without a withdrawal or dropped from its roster', async () => {
    const { alice, hash } = await befriend('ws://a');
    alice.wire.on('find_user', () => ({})).on('friendships_present', presentAll());
    await alice.keeper.onFriend({ login: 'bob', state: 'removed', fingerprint: BOB });
    expect(alice.wire.sent('friendships_present')).toHaveLength(1);

    await alice.keeper.onRoster([{ login: 'bob', state: 'accepted', fingerprint: BOB, friendships: [hash] }]);
    await alice.keeper.onRoster([]);
    expect(alice.wire.sent('friendships_present')).toHaveLength(2);
  });

  it('stops presenting here, and opts the user in to nothing, where the server answers withdrawn of its own', async () => {
    const { alice, hash } = await befriend('ws://a');
    alice.wire.on('find_user', () => ({})).on('friendships_present', presentAll('withdrawn'));
    await alice.keeper.onFriend({ login: 'bob', state: 'removed', fingerprint: BOB });
    expect(alice.keeper.book.servers['ws://a']).toEqual({ bring: false, leftOut: [], refused: [hash] });
  });

  it('holds what another device adopted for the user to confirm on a new device, and presents it only then', async () => {
    const { alice, hash } = await befriend('ws://a');
    const wire = new Wire({ find_user: () => ({}), friendships_present: presentAll() });
    const newer = await party(await secondDevice(), 'ws://b', alice.store, wire);
    expect(newer.keeper.with(BOB).map((k) => newer.keeper.adopted(k))).toEqual([false]);
    await newer.keeper.setBring(true);
    expect(wire.sent('friendships_present')).toEqual([]);
    await newer.keeper.confirm(hash, true);
    expect(wire.sent('friendships_present')).toHaveLength(1);
  });

  it('accepts plainly where the offer is not for this identity, and keeps nothing', async () => {
    clock = T0;
    const alice = await party('alice', 'ws://a');
    alice.wire.on('friend_add', () => ({ state: 'pending_out' })).on('find_user', shown(BOB));
    await alice.keeper.add('bob', undefined);
    const offer: string = alice.wire.sent('friend_add')[0].offer;
    const other = await party('alice', 'ws://a', new MemoryBookStore(), new Wire({ friend_respond: () => ({ state: 'accepted' }) }));
    await other.keeper.accept({ login: 'bob', state: 'pending_in', offer } as Friend);
    expect(other.wire.sent('friend_respond')).toEqual([{ login: 'bob', accept: true }]);
    expect(other.keeper.book.friendships).toEqual([]);
  });
});
