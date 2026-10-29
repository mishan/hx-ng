import { describe, expect, it } from 'vitest';

import type { Friend } from '@hotline-ng/client';

import { FriendBook } from '../src/friends';
import { messageAddress, Store } from '../src/state';

const row = (login: string, state: Friend['state'], over: Partial<Friend> = {}): Friend => ({ login, state, ...over });

describe('the friend book', () => {
  it('groups rows by state, friends most available first and then by name', () => {
    const book = new FriendBook();
    book.replace([
      row('zed', 'accepted', { presence: 'online' }),
      row('amy', 'accepted', { presence: 'away' }),
      row('bob', 'accepted', { presence: 'online', alias: 'Bobby' }),
      row('cat', 'accepted'),
      row('dan', 'pending_in', { note: 'hi' }),
      row('eve', 'pending_out'),
      row('mal', 'blocked'),
    ]);
    const g = book.groups();
    expect(g.friends.map((f) => f.login)).toEqual(['bob', 'zed', 'amy', 'cat']);
    expect([g.incoming, g.outgoing, g.blocked].map((l) => l.map((f) => f.login))).toEqual([['dan'], ['eve'], ['mal']]);
  });

  it.each<[string, (b: FriendBook) => void, Friend | undefined]>([
    ['replaces a row whole with its friend event', (b) => b.apply(row('Bob', 'accepted', { presence: 'busy' })), row('Bob', 'accepted', { presence: 'busy' })],
    ['forgets a row removed', (b) => b.apply(row('bob', 'removed')), undefined],
    [
      'takes presence and drops a status no longer sent',
      (b) => b.presence({ login: 'bob', state: 'away' }),
      row('bob', 'accepted', { presence: 'away' }),
    ],
    ['takes no presence for a row that is not a friendship', (b) => b.presence({ login: 'eve', state: 'online' }), row('bob', 'accepted', { presence: 'online', status_text: 'lunch' })],
    ['leaves a friendship as it is on a friend request', (b) => b.request({ login: 'bob', note: 'again?' }), row('bob', 'accepted', { presence: 'online', status_text: 'lunch' })],
  ])('%s', (_, act, want) => {
    const book = new FriendBook();
    book.replace([row('bob', 'accepted', { presence: 'online', status_text: 'lunch' }), row('eve', 'pending_out')]);
    act(book);
    expect(book.get('bob')).toEqual(want);
  });

  it('makes a row of a friend request that came before it', () => {
    const book = new FriendBook();
    book.request({ login: 'dan', note: 'hi, it is Dan' });
    expect(book.groups().incoming).toEqual([row('dan', 'pending_in', { note: 'hi, it is Dan' })]);
    expect(book.isFriend('dan')).toBe(false);
  });
});

describe('receipts', () => {
  it.each<[string, boolean[], 'delivered' | 'read']>([
    ['marks delivered', [false], 'delivered'],
    ['moves on to read', [false, true], 'read'],
    ['keeps read when delivered comes after', [true, false], 'read'],
  ])('%s', (_, reads, want) => {
    const store = new Store();
    const conv = store.openPm({ login: 'bob', nick: 'Bob' });
    store.add(conv.id, { t: 1, kind: 'chat', text: 'hi', local: true, guid: 'g-1' });
    for (const read of reads) store.receipt('BOB', 'g-1', read);
    expect(conv.lines[0]?.receipt).toBe(want);
  });

  it('marks nothing for a guid this client did not send', () => {
    const store = new Store();
    const conv = store.openPm({ login: 'bob', nick: 'Bob' });
    store.add(conv.id, { t: 1, kind: 'chat', text: 'hi', guid: 'g-1' });
    expect(store.receipt('bob', 'g-1', true)).toBeUndefined();
    expect(store.receipt('bob', 'g-2', true)).toBeUndefined();
    expect(conv.lines[0]?.receipt).toBeUndefined();
  });
});

describe('the address a message goes to', () => {
  const bob = { uid: 7, nick: 'Bob', icon: 128, admin: false, status: 'active' as const, transport: 'encrypted' as const };

  it.each<[string, { takesPart?: boolean; friend?: boolean; approved?: boolean; resynced?: boolean }, object]>([
    ['a friend, by login', { friend: true }, { to_login: 'bob' }],
    ['someone under an approval, by login', { approved: true }, { to_login: 'bob' }],
    ['a present non-friend, by uid', {}, { to: 7 }],
    ['a present non-friend where this account takes no part, by login', { takesPart: false }, { to_login: 'bob' }],
    ['a non-friend after a resync, by login, since the uid may be another now', { resynced: true }, { to_login: 'bob' }],
  ])('%s', (_, o, want) => {
    const store = new Store();
    store.replaceRoster([bob]);
    const conv = store.openPm({ uid: 7, login: 'bob', nick: 'Bob' });
    if (o.resynced) store.replaceRoster([bob]);
    const address = messageAddress(conv, {
      takesPart: o.takesPart ?? true,
      present: (uid) => store.user(uid) !== undefined,
      mayIm: () => !!(o.friend || o.approved),
    });
    expect(address).toEqual(want);
  });

  it('keeps the uid of a conversation with no login across a resync', () => {
    const store = new Store();
    store.replaceRoster([bob]);
    const conv = store.openPm({ uid: 7, nick: 'Bob' });
    store.replaceRoster([bob]);
    expect(conv.peer.uid).toBe(7);
  });
});
