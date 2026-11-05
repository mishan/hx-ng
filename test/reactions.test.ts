import { describe, expect, it } from 'vitest';

import { Connection, WireFailure, type HistoryLine, type HistoryOk, type ReactionChange } from '@hotline-ng/client';
import { FakeServer } from '../packages/hotline-ng/src/testing';

import {
  afterOwn,
  changesByConv,
  chipLabel,
  chipWho,
  historyReactions,
  LIVE_LINES,
  reactableAs,
  ReactionDesk,
  refetchLines,
  summaryOf,
  whyNotAdd,
} from '../src/reactions';
import { holderOf, LOBBY, mergeMail, mergePage, publicId, Sequencer, Store, type ConvId, type Line, type Reaction } from '../src/state';

const UP = '\u{1F44D}';
const HEART = '\u2764\u{FE0F}';
const TADA = '\u{1F389}';

const kept = (id: number, extra: Partial<HistoryLine> = {}): HistoryLine => ({
  id,
  at: id,
  from: { nick: 'Bob', icon: 128 },
  text: `line ${id}`,
  style: 'normal',
  ...extra,
});
const asLine = (l: HistoryLine): Line => ({ t: l.at * 1000, kind: 'chat', text: l.text, id: l.id, reactions: historyReactions(l) });
const counts = (...keys: [string, number][]) => keys.map(([emoji, count]) => ({ key: { emoji }, count }));
const held = (store: Store, id: number, conv = LOBBY) => store.conversation(conv)!.lines.find((l) => l.id === id)!.reactions;

function withRoom(): Store {
  const store = new Store();
  store.putRoom({ id: 8, name: 'lounge', topic: '', position: 0, members: 1, may_post: true });
  return store;
}

describe('a line\'s reactions', () => {
  it('are seeded from a history page, and restated by a later page that shares the line', async () => {
    const store = new Store();
    const seq = new Sequencer();
    const page = (lines: HistoryLine[]) => () => Promise.resolve(lines.map(asLine));
    const told: [number, number[]][] = [];
    const merged = (added: number, restated: Line[]) => void told.push([added, restated.map((l) => l.id!)]);
    const first = { conv: LOBBY, hasMore: false, direction: 'older' as const };
    await mergePage(store, seq, first, page([kept(1, { reactions: counts([UP, 2], [HEART, 1]), reactions_mine: [1] }), kept(2)]), merged);
    expect(held(store, 1)).toEqual([
      { emoji: UP, count: 2, mine: false },
      { emoji: HEART, count: 1, mine: true },
    ]);
    expect(held(store, 2)).toBeUndefined();

    // As a later page answers: nothing new, the shared line restated.
    await mergePage(store, seq, { ...first, direction: 'newer' }, page([kept(1, { reactions: counts([UP, 3]), reactions_mine: [0] }), kept(2)]), merged);
    expect(held(store, 1)).toEqual([{ emoji: UP, count: 3, mine: true }]);
    expect(told).toEqual([
      [2, []],
      [0, [1]],
    ]);
    expect(store.conversation(LOBBY)!.lines.map((l) => l.id)).toEqual([1, 2]);
  });

  it('told while a page is being read stand after the page', async () => {
    const store = new Store();
    store.mergeHistory([asLine(kept(1, { reactions: counts([UP, 1]) }))], false, 'older');
    const seq = new Sequencer();
    let read!: () => void;
    const reading = new Promise<void>((r) => (read = r));
    // The page was read before the batch was sent, and says what was so then.
    const paged = mergePage(
      store,
      seq,
      { conv: LOBBY, hasMore: false, direction: 'newer' },
      async () => {
        await reading;
        return [asLine(kept(1, { reactions: counts([UP, 1]) }))];
      },
      () => {},
    );
    const batch = seq.run(() => store.setReactions(LOBBY, [[1, [{ emoji: UP, count: 2, mine: true }]]]));
    read();
    await Promise.all([paged, batch]);
    expect(held(store, 1)).toEqual([{ emoji: UP, count: 2, mine: true }]);
  });

  it('are replaced whole by a change group, in the room it names alone', () => {
    const store = withRoom();
    const room = publicId(8);
    store.mergeHistory([asLine(kept(5, { reactions: counts([UP, 2], [HEART, 1]), reactions_mine: [0] }))], false, 'older');
    store.mergeHistory([asLine(kept(5, { reactions: counts([TADA, 1]) }))], false, 'older', room);
    const changes: ReactionChange[] = [{ target: { line: 5, room: 8 }, action: 'summary', keys: counts([HEART, 3], [TADA, 1]), mine: [1] }];
    for (const [conv, updates] of changesByConv(changes)) store.setReactions(conv, updates);
    expect(held(store, 5, room)).toEqual([
      { emoji: HEART, count: 3, mine: false },
      { emoji: TADA, count: 1, mine: true },
    ]);
    // The lobby's line 5 is another line.
    expect(held(store, 5)).toEqual([
      { emoji: UP, count: 2, mine: true },
      { emoji: HEART, count: 1, mine: false },
    ]);
  });

  it('are gone after a clear, an emptied summary, or a redaction', () => {
    const store = new Store();
    const page = [1, 2, 3].map((id) => asLine(kept(id, { reactions: counts([UP, 1]) })));
    store.mergeHistory(page, false, 'older');
    const changes: ReactionChange[] = [
      { target: { line: 1 }, action: 'clear' },
      { target: { line: 2 }, action: 'summary', keys: [] },
      // A line not held waits for the history that shows it.
      { target: { line: 9 }, action: 'clear' },
    ];
    const changed = [...changesByConv(changes)].flatMap(([conv, updates]) => store.setReactions(conv, updates));
    expect(changed.map((l) => l.id)).toEqual([1, 2]);
    store.redact(3);
    expect([held(store, 1), held(store, 2), held(store, 3)]).toEqual([undefined, undefined, undefined]);
  });

  it('say which keys are this reader\'s, and follow its own act at once', () => {
    const mine = summaryOf(counts([UP, 2], [HEART, 1], [TADA, 4]), [0, 2]);
    expect(mine?.map((r) => r.mine)).toEqual([true, false, true]);
    expect(mine!.map((r) => chipLabel(r, r.emoji === UP ? 'thumbs up' : 'x'))[0]).toBe('thumbs up, 2, including you');
    expect(mine!.map(chipWho)).toEqual(['You and 1 other', '1 person', 'You and 3 others']);

    const one: Reaction[] = [{ emoji: UP, count: 1, mine: true }];
    expect(afterOwn(one, UP, false, 0)).toBeUndefined();
    expect(afterOwn(one, HEART, true, 2)).toEqual([...one, { emoji: HEART, count: 2, mine: true }]);
    expect(afterOwn([{ emoji: UP, count: 3, mine: false }], UP, true, 4)).toEqual([{ emoji: UP, count: 4, mine: true }]);
  });

  it('hold this account to the server\'s caps on new keys alone', () => {
    const caps = { max_keys: 2, max_per_user: 1 };
    const full: Reaction[] = [
      { emoji: UP, count: 1, mine: false },
      { emoji: HEART, count: 1, mine: false },
    ];
    expect(whyNotAdd(full, TADA, caps)).toMatch(/as many different reactions/);
    expect(whyNotAdd(full, UP, caps)).toBeNull();
    const held: Reaction[] = [{ emoji: UP, count: 1, mine: true }];
    expect(whyNotAdd(held, HEART, caps)).toMatch(/as many reactions on this line as you may \(1\)/);
    expect(whyNotAdd(held, UP, caps)).toBeNull();
    expect(whyNotAdd(full, TADA, caps, 'pm')).toBe('This message has as many different reactions as it may.');
    expect(whyNotAdd(held, HEART, caps, 'im')).toBeNull();
  });
});

describe('a private message\'s reactions', () => {
  const GUID = '5f5e1000-1234-4abc-89ab-000000000001';
  const ALL = ['line', 'im', 'pm'] as const;
  const bobsPm = (): Line => ({ t: 1, kind: 'chat', text: 'hi', from: { uid: 0, nick: 'Bob', login: 'bob' }, id: 4, ref: 'AAEC' });
  const bobsIm = (): Line => ({ t: 2, kind: 'chat', text: 'yo', from: { nick: 'Bob', login: 'bob' }, guid: GUID });

  function withBob() {
    const store = new Store();
    store.me = () => 'alice';
    const bob = store.openPm({ login: 'bob', nick: 'Bob' });
    const carol = store.openPm({ login: 'carol', nick: 'Carol' });
    return { store, bob, carol };
  }

  it.each([
    ['a lobby line', LOBBY, { t: 1, kind: 'chat', text: 'x', id: 7 }, ALL, { kind: 'line', target: { line: 7 } }],
    ['a lobby line, where only messages are taken', LOBBY, { t: 1, kind: 'chat', text: 'x', id: 7 }, ['im', 'pm'], null],
    ['a received message', 'bob', bobsPm(), ALL, { kind: 'pm', target: { pm: 'AAEC' } }],
    ['one this reader sent, under a guid', 'bob', { t: 1, kind: 'chat', text: 'x', local: true, guid: GUID, ref: 'AAED' }, ALL, { kind: 'pm', target: { pm: 'AAED' } }],
    ['one this reader sent as an instant message', 'bob', { t: 1, kind: 'chat', text: 'x', local: true, im: true, guid: GUID, ref: 'AAED' }, ALL, { kind: 'im', target: { im: { login: 'alice', guid: GUID } }, with: 'bob' }],
    ['a sent one never stored', 'bob', { t: 1, kind: 'chat', text: 'x', local: true, guid: GUID }, ALL, null],
    ['an instant message', 'bob', bobsIm(), ALL, { kind: 'im', target: { im: { login: 'bob', guid: GUID } }, with: 'bob' }],
    ['an instant message kept as mail, by its guid and not its ref', 'bob', { ...bobsIm(), ref: 'AAEE' }, ALL, { kind: 'im', target: { im: { login: 'bob', guid: GUID } }, with: 'bob' }],
    ['an identity guest\'s instant message', 'bob', { ...bobsIm(), from: { nick: 'guest' } }, ALL, null],
    ['an instant message, where lines alone are taken', 'bob', bobsIm(), ['line'], null],
    ['a message, where lines alone are taken', 'bob', bobsPm(), ['line'], null],
  ] as const)('names %s', (_, where, line, kinds, want) => {
    const { bob } = withBob();
    const conv = where === LOBBY ? new Store().conversation(LOBBY)! : bob;
    expect(reactableAs(line as Line, conv, kinds, 'alice')).toEqual(want);
  });

  it('take a summary for the message its ref names, and leave one not held alone', async () => {
    const { store, bob, carol } = withBob();
    store.add(bob.id, bobsPm());
    store.add(carol.id, { ...bobsPm(), from: { uid: 0, nick: 'Carol', login: 'carol' }, ref: 'AAEF', reactions: [{ emoji: UP, count: 1, mine: false }] });
    const drawn: [ConvId, string[]][] = [];
    const desk = new ReactionDesk({} as never, {
      store,
      seq: new Sequencer(),
      changed: (conv, lines) => void drawn.push([conv, lines.map((l) => l.ref!)]),
      refused: () => expect.unreachable(),
    });
    await desk.changed([
      { target: { pm: 'AAEC' }, action: 'summary', keys: counts([HEART, 2]), mine: [0] },
      { target: { pm: 'ZZZZ' }, action: 'summary', keys: counts([HEART, 1]) },
    ]);
    expect(drawn).toEqual([[bob.id, ['AAEC']]]);
    expect(bob.lines[0]!.reactions).toEqual([{ emoji: HEART, count: 2, mine: true }]);
    expect(carol.lines[0]!.reactions).toEqual([{ emoji: UP, count: 1, mine: false }]);
  });

  it('on an instant message are tallied here, from its other party\'s changes and this reader\'s own, even before it is shown', async () => {
    const { store, bob } = withBob();
    const sent: unknown[] = [];
    const conn = {
      reactions: { targets: ['line', 'im', 'pm'], max_keys: 1, max_per_user: 1 },
      react: async (...args: unknown[]) => (sent.push(args), {}),
    } as never;
    const desk = new ReactionDesk(conn, { store, seq: new Sequencer(), changed: () => {}, refused: () => expect.unreachable() });
    const im = { im: { login: 'bob', guid: GUID } };
    const told = (action: 'add' | 'remove', emoji: string): ReactionChange => ({ target: im, action, key: { emoji }, from: { login: 'bob' } });

    // Told before the message is: kept for it. A server's own emoji is
    // not drawn.
    const custom = { ...told('add', UP), key: { custom: 'party' } } as never;
    await desk.changed([told('add', UP), told('add', HEART), told('remove', HEART), custom]);
    store.add(bob.id, bobsIm());
    const line = bob.lines[0]!;
    expect(line.reactions).toEqual([{ emoji: UP, count: 1, mine: false }]);

    // Past the caps a line would be held to: nothing keeps an instant message's.
    await desk.toggle(line, bob, UP, true);
    await desk.toggle(line, bob, TADA, true);
    expect(sent).toEqual([
      [im, { emoji: UP }, { remove: false, with: 'bob' }],
      [im, { emoji: TADA }, { remove: false, with: 'bob' }],
    ]);
    expect(line.reactions).toEqual([
      { emoji: UP, count: 2, mine: true },
      { emoji: TADA, count: 1, mine: true },
    ]);
    await desk.changed([told('remove', UP), told('add', TADA)]);
    await desk.toggle(line, bob, TADA, false);
    expect(line.reactions).toEqual([
      { emoji: UP, count: 1, mine: true },
      { emoji: TADA, count: 1, mine: false },
    ]);
  });

  it('on an instant message this reader sent reach its line from its other party, even before it is shown', async () => {
    const { store, bob } = withBob();
    const desk = new ReactionDesk({} as never, { store, seq: new Sequencer(), changed: () => {}, refused: () => expect.unreachable() });
    const told = (guid: string, emoji: string): ReactionChange => ({ target: { im: { login: 'Alice', guid } }, action: 'add', key: { emoji }, from: { login: 'bob' } });
    const sent = (guid: string): Line => ({ t: 1, kind: 'chat', text: 'x', local: true, im: true, guid });
    store.add(bob.id, sent(GUID));
    // Bob's own instant message under the same guid is another message.
    store.add(bob.id, bobsIm());
    await desk.changed([told(GUID, UP), told('later', HEART)]);
    store.add(bob.id, sent('later'));
    expect(bob.lines.map((l) => l.reactions)).toEqual([[{ emoji: UP, count: 1, mine: false }], undefined, [{ emoji: HEART, count: 1, mine: false }]]);
  });

  it('told while an inbox page\'s rows are read stand after the page', async () => {
    const { store, bob } = withBob();
    store.add(bob.id, bobsPm());
    const seq = new Sequencer();
    const desk = new ReactionDesk({} as never, { store, seq, changed: () => {}, refused: () => expect.unreachable() });
    let read!: () => void;
    const reading = new Promise<void>((r) => (read = r));
    // The page says the message has none, as it had when it was sent.
    const placed = mergeMail(
      seq,
      () => reading,
      () => (store.setPmReactions('AAEC', undefined), 0),
    );
    const told = desk.changed([{ target: { pm: 'AAEC' }, action: 'summary', keys: counts([HEART, 2]), mine: [0] }]);
    read();
    await Promise.all([placed, told]);
    expect(bob.lines[0]!.reactions).toEqual([{ emoji: HEART, count: 2, mine: true }]);
  });

  it('held are read again after a catch-up, the newest first, the first conversation first, as many as one request takes at a time and so many in all', async () => {
    const { store, bob, carol } = withBob();
    store.add(carol.id, { ...bobsPm(), from: { uid: 0, nick: 'Carol', login: 'carol' }, ref: 'C' });
    const refs = Array.from({ length: LIVE_LINES + 10 }, (_, i) => `R${i}`);
    for (const [i, ref] of refs.entries()) store.add(bob.id, i % 2 ? { ...bobsPm(), id: i, ref } : { t: i, kind: 'chat', text: 'x', local: true, guid: `g${i}`, ref });
    store.add(bob.id, { ...bobsIm(), ref: 'IM' });
    const asked: string[][] = [];
    let limited = false;
    const conn = {
      reactions: { targets: ['line', 'im', 'pm'], max_keys: 5, max_per_user: 5 },
      reactionsGet: async (targets: { pm: string }[]) => {
        asked.push(targets.map((t) => t.pm));
        if (asked.length === 2 && !limited) {
          limited = true;
          throw new WireFailure({ code: 'rate_limited', text: 'Slow down.', retry_after: 1 });
        }
        return { reactions: targets.map((target) => ({ target, keys: counts([UP, 1]) })) };
      },
    } as never;
    const desk = new ReactionDesk(conn, { store, seq: new Sequencer(), changed: () => {}, refused: () => expect.unreachable(), wait: async () => {} });
    // Asked again while reading, twice: run once more, for the latest.
    await Promise.all([desk.refetchMessages([carol, bob]), desk.refetchMessages([bob]), desk.refetchMessages([carol])]);
    const want = ['C', ...refs.slice(11).reverse()];
    expect(want).toHaveLength(200);
    expect(asked).toEqual([want.slice(0, 50), want.slice(50, 100), want.slice(50, 100), want.slice(100, 150), want.slice(150), ['C']]);
    expect(bob.lines.map((l) => l.reactions?.[0]?.count)).toEqual([...refs.map((_, i) => (i < 11 ? undefined : 1)), undefined]);
  });

  it.each([
    ['a password login', undefined, 'Alice', 'wss://a login:alice'],
    ['an identity login landing on an account', { account: 'Alice', fingerprint: 'FP' }, null, 'wss://a login:alice'],
    ['an identity guest', { account: null, fingerprint: 'FP' }, null, 'wss://a fp:FP'],
    ['a guest', undefined, null, 'wss://a '],
  ])('are held under %s', (_, identity, login, want) => {
    const self = { uid: 1, nick: 'a', icon: 0, ...(identity ? { identity } : {}) } as never;
    expect(holderOf('wss://a', self, login)).toBe(want);
  });

  it('are offered on nothing held under another server or account, and are again back under it', async () => {
    const { store, bob } = withBob();
    const [a, b] = ['wss://a login:alice', 'wss://b login:alice'];
    store.heldBy(a);
    store.add(bob.id, bobsPm());
    store.add(bob.id, bobsIm());
    store.heldBy(a);
    expect(reactableAs(bob.lines[0]!, bob, ALL, 'alice')).not.toBeNull();
    store.heldBy(b);
    store.add(bob.id, { ...bobsPm(), ref: 'AAEF' });
    const kinds = () => bob.lines.map((l) => reactableAs(l, bob, ALL, 'alice')?.kind ?? null);
    expect(kinds()).toEqual([null, null, 'pm']);
    const desk = new ReactionDesk({} as never, { store, seq: new Sequencer(), changed: () => expect.unreachable(), refused: () => expect.unreachable() });
    await desk.changed([
      { target: { pm: 'AAEC' }, action: 'summary', keys: counts([UP, 1]) },
      { target: { im: { login: 'bob', guid: GUID } }, action: 'add', key: { emoji: UP }, from: { login: 'bob' } },
    ]);
    expect(bob.lines.map((l) => l.reactions)).toEqual([undefined, undefined, undefined]);
    store.heldBy(a);
    expect(kinds()).toEqual(['pm', 'im', null]);
  });

  it('told before their message under another server or account are not kept for it', async () => {
    const { store, bob } = withBob();
    store.heldBy('wss://a login:alice');
    const desk = new ReactionDesk({} as never, { store, seq: new Sequencer(), changed: () => {}, refused: () => expect.unreachable() });
    await desk.changed([{ target: { im: { login: 'bob', guid: GUID } }, action: 'add', key: { emoji: UP }, from: { login: 'bob' } }]);
    store.heldBy('wss://b login:alice');
    store.add(bob.id, bobsIm());
    expect(bob.lines[0]!.reactions).toBeUndefined();
  });

  it.each(['im', 'pm'] as const)('answered to a desk closed while its answer waited its turn change nothing (%s)', async (kind) => {
    const { store, bob } = withBob();
    store.add(bob.id, kind === 'im' ? bobsIm() : bobsPm());
    const line = bob.lines[0]!;
    const seq = new Sequencer();
    let open = (): void => {};
    const conn = {
      reactions: { targets: ['im', 'pm'], max_keys: 5, max_per_user: 5 },
      react: async () => {
        // The next turn is held until the desk has been closed.
        void seq.run(() => new Promise<void>((r) => (open = r)));
        return {};
      },
      reactionsGet: async () => ({ reactions: [{ target: { pm: 'AAEC' }, keys: counts([UP, 1]) }] }),
    } as never;
    const desk = new ReactionDesk(conn, { store, seq, changed: () => {}, refused: () => expect.unreachable() });
    const toggled = desk.toggle(line, bob, UP, true);
    await new Promise((r) => setTimeout(r));
    desk.close();
    open();
    await toggled;
    expect(line.reactions).toBeUndefined();
  });

  it('after this reader\'s own are what the server reads back, not what was asked', async () => {
    const { store, bob } = withBob();
    store.add(bob.id, { ...bobsPm(), reactions: [{ emoji: UP, count: 1, mine: false }] });
    const line = bob.lines[0]!;
    const asked: unknown[] = [];
    // A key past the caps is answered as any other, and dropped.
    const conn = {
      reactions: { targets: ['line', 'pm'], max_keys: 5, max_per_user: 5 },
      react: async (...args: unknown[]) => (asked.push(['react', ...args]), {}),
      reactionsGet: async (targets: unknown) => {
        asked.push(['reactions', targets]);
        // Someone else's came in meanwhile.
        return { reactions: [{ target: { pm: 'AAEC' }, keys: counts([UP, 2]) }] };
      },
    } as never;
    const desk = new ReactionDesk(conn, { store, seq: new Sequencer(), changed: () => {}, refused: () => expect.unreachable() });
    await desk.toggle(line, bob, HEART, true);
    expect(asked).toEqual([
      ['react', { pm: 'AAEC' }, { emoji: HEART }, { remove: false }],
      ['reactions', [{ pm: 'AAEC' }]],
    ]);
    expect(line.reactions).toEqual([{ emoji: UP, count: 2, mine: false }]);
  });

  it('after this reader\'s own stay as they were where the read back fails, and the reaction is not said to be refused', async () => {
    const { store, bob } = withBob();
    store.add(bob.id, bobsPm());
    const conn = {
      reactions: { targets: ['pm'], max_keys: 5, max_per_user: 5 },
      react: async () => ({}),
      reactionsGet: async () => {
        throw new WireFailure({ code: 'not_available', text: 'no' });
      },
    } as never;
    const desk = new ReactionDesk(conn, { store, seq: new Sequencer(), changed: () => {}, refused: () => expect.unreachable() });
    await desk.toggle(bob.lines[0]!, bob, UP, true);
    expect(bob.lines[0]!.reactions).toBeUndefined();
  });
});

describe('refetching after a resync', () => {
  it('asks for the lines on screen by id, as many as one request takes, and restates each', async () => {
    const store = new Store();
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    store.mergeHistory(ids.map((id) => asLine(kept(id, { reactions: counts([UP, 1]), reactions_mine: [0] }))), false, 'older');
    const asked: number[][] = [];
    const waited: number[] = [];
    let limited = false;
    const fetch = async (want: number[]): Promise<HistoryOk> => {
      asked.push(want);
      if (want[0] === 51 && !limited) {
        limited = true;
        throw new WireFailure({ code: 'rate_limited', text: 'Slow down.', retry_after: 2 });
      }
      // A full reply: the highest of the second batch left out.
      const shown = want[0] === 51 ? want.slice(0, 30) : want;
      return { lines: shown.map((id) => kept(id, id === 60 ? { reactions: counts([HEART, 2]) } : {})), has_more: shown !== want };
    };
    await refetchLines(
      ids,
      fetch,
      (lines) => store.setReactions(LOBBY, lines.map((l) => [l.id, historyReactions(l)] as const)),
      async (ms) => void waited.push(ms),
    );
    expect(asked.map((a) => [a[0], a.at(-1)])).toEqual([[1, 50], [51, 100], [51, 100], [81, 120]]);
    expect(waited).toEqual([2000]);
    expect(held(store, 1)).toBeUndefined();
    expect(held(store, 60)).toEqual([{ emoji: HEART, count: 2, mine: false }]);
    expect(held(store, 120)).toBeUndefined();
  });

  it('leaves the lines as they were on a refusal that will stand', async () => {
    const asked: number[][] = [];
    await refetchLines(
      [1, 2],
      async (want) => {
        asked.push(want);
        throw new WireFailure({ code: 'not_available', text: 'no' });
      },
      () => expect.unreachable(),
    );
    expect(asked).toEqual([[1, 2]]);
  });
});

describe('the reaction desk, against a server', () => {
  const ACCOUNTS = [
    { login: 'alice', password: 'pw', nick: 'Alice' },
    { login: 'bob', password: 'pw', nick: 'Bob' },
  ];
  async function asking(server: FakeServer, login: string): Promise<Connection> {
    const conn = new Connection(server.credentials({ login, password: 'pw', reactions: true, replies: true }));
    await conn.start();
    return conn;
  }
  async function until(what: string, ok: () => boolean): Promise<void> {
    for (const end = Date.now() + 5000; !ok(); await new Promise((r) => setTimeout(r, 5))) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    }
  }

  /** Alice's client: her store seeded from history, a desk on her
   *  connection fed its batches, and the clock the test moves. */
  async function aliceClient(server: FakeServer) {
    const conn = await asking(server, 'alice');
    const store = new Store();
    const seq = new Sequencer();
    const drawn: [ConvId, number[]][] = [];
    const refused: string[] = [];
    let now = 1_000_000;
    const desk = new ReactionDesk(conn, {
      store,
      seq,
      changed: (conv, lines) => void drawn.push([conv, lines.map((l) => l.id!)]),
      refused: (_line, _conv, text) => void refused.push(text),
      wait: async () => {},
      now: () => now,
    });
    let batches = 0;
    conn.on('reactions_changed', (d) => {
      batches++;
      void desk.changed(d.changes);
    });
    const seed = async (room = 0) => {
      if (room) store.putRoom({ id: room, name: 'lounge', topic: '', position: 0, members: 1, may_post: true }).joined = true;
      for (let before: number | undefined, more = true; more; ) {
        const page = await conn.history({ limit: 200, ...(room ? { room } : {}), ...(before ? { before } : {}) });
        store.mergeHistory(page.lines.map(asLine), page.has_more, 'older', publicId(room));
        [before, more] = [page.lines[0]?.id, page.has_more];
      }
    };
    return { conn, store, seq, desk, drawn, refused, seed, batches: () => batches, tick: (ms: number) => (now += ms) };
  }

  it("routes a batch to the room it names, and applies one's own answer after a batch that came before it", async () => {
    const server = new FakeServer({ accounts: ACCOUNTS, rooms: [{ name: 'lounge' }] });
    const a = await aliceClient(server);
    const bob = await asking(server, 'bob');
    const room = a.conn.login!.rooms!.list[0]!.id;
    await a.conn.roomJoin(room);
    await bob.roomJoin(room);
    const { id: lobbyLine } = await bob.chat({ text: 'lunch?' });
    const { id: roomLine } = await bob.chat({ text: 'here', room });
    await a.seed();
    await a.seed(room);

    await bob.react({ line: roomLine!, room }, { emoji: TADA });
    server.flushReactions();
    await until('the batch', () => a.batches() === 1);
    await a.seq.run(() => {});
    expect(a.drawn).toEqual([[publicId(room), [roomLine]]]);
    expect(held(a.store, roomLine!, publicId(room))).toEqual([{ emoji: TADA, count: 1, mine: false }]);
    expect(held(a.store, lobbyLine!)).toBeUndefined();

    // The turn is held, as a line's signature being read holds it, while
    // Bob's batch and then Alice's own answer come in.
    let free!: () => void;
    void a.seq.run(() => new Promise<void>((r) => (free = r)));
    await bob.react({ line: lobbyLine! }, { emoji: UP });
    server.flushReactions();
    await until('the batch', () => a.batches() === 2);
    const line = a.store.conversation(LOBBY)!.lines.find((l) => l.id === lobbyLine)!;
    const toggled = a.desk.toggle(line, a.store.conversation(LOBBY)!, UP, true);
    await until('the answer', () => server.requests.some((r) => r.req === 'react' && r.from?.login === 'alice'));
    await new Promise((r) => setTimeout(r, 20));
    free();
    await toggled;
    await a.seq.run(() => {});
    expect(held(a.store, lobbyLine!)).toEqual([{ emoji: UP, count: 2, mine: true }]);
  });

  it('reads an older line again once it comes into view, not again within a minute, and a resync reads the conversation on screen first', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS, rooms: [{ name: 'lounge' }] });
    const a = await aliceClient(server);
    const bob = await asking(server, 'bob');
    const room = a.conn.login!.rooms!.list[0]!.id;
    await a.conn.roomJoin(room);
    await bob.roomJoin(room);
    const ids: number[] = [];
    for (let i = 0; i <= LIVE_LINES; i++) ids.push((await bob.chat({ text: `line ${i}` })).id!);
    const { id: roomLine } = await bob.chat({ text: 'here', room });
    await a.seed();
    await a.seed(room);
    // Changed where nothing tells it live, as past hxd-ng's window.
    await bob.react({ line: ids[0]! }, { emoji: UP });
    await bob.react({ line: roomLine!, room }, { emoji: UP });
    const lobby = a.store.conversation(LOBBY)!;
    const asked = () => server.requests.filter((r) => r.req === 'history' && r.from?.login === 'alice' && r.params && 'ids' in (r.params as object));

    const before = asked().length;
    a.desk.seen(lobby, ids.at(-1)!);
    a.desk.seen(lobby, ids[0]!);
    await until('the read', () => asked().length === before + 1);
    expect((asked().at(-1)!.params as { ids: number[] }).ids).toEqual([ids[0]]);
    await until('the line', () => held(a.store, ids[0]!) !== undefined);
    expect(held(a.store, ids[0]!)).toEqual([{ emoji: UP, count: 1, mine: false }]);

    a.desk.seen(lobby, ids[0]!);
    a.tick(59_000);
    a.desk.seen(lobby, ids[0]!);
    await new Promise((r) => setTimeout(r, 20));
    expect(asked().length).toBe(before + 1);
    a.tick(2_000);
    a.desk.seen(lobby, ids[0]!);
    await until('the read again', () => asked().length === before + 2);

    await a.desk.refetchHeld([a.store.conversation(publicId(room))!, lobby]);
    expect(asked().slice(before + 2).map((r) => (r.params as { room?: number }).room ?? 0)).toEqual([room, 0, 0, 0, 0]);
    await a.seq.run(() => {});
    expect(held(a.store, roomLine!, publicId(room))).toEqual([{ emoji: UP, count: 1, mine: false }]);
  });
});
