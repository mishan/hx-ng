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
  ReactionDesk,
  refetchLines,
  summaryOf,
  whyNotAdd,
} from '../src/reactions';
import { LOBBY, mergePage, publicId, Sequencer, Store, type ConvId, type Line, type Reaction } from '../src/state';

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
