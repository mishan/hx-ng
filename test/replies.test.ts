import { describe, expect, it } from 'vitest';

import { WireFailure, type HistoryLine, type HistoryOk } from '@hotline-ng/client';

import { excerpt, QuoteFetcher, resolveQuote, startReply } from '../src/replies';
import { LOBBY, Store, type Line } from '../src/state';

const ALL = ['line', 'pm', 'im'] as const;

const line = (extra: Partial<Line>): Line => ({ t: 0, kind: 'chat', text: 'hello', ...extra });
const kept = (id: number, extra: Partial<HistoryLine> = {}): HistoryLine => ({
  id,
  at: 0,
  from: { nick: 'Bob', icon: 128 },
  text: `line ${id}`,
  style: 'normal',
  ...extra,
});

function rooms() {
  const store = new Store();
  const lobby = store.conversation(LOBBY)!;
  const pm = store.openPm({ login: 'bob', nick: 'Bob' });
  const room = store.putRoom({ id: 8, name: 'lounge', topic: '', position: 0, members: 1, may_post: true });
  return { store, lobby, pm, room };
}

describe('starting a reply', () => {
  it('names a line, a message and an instant message as the server keeps them, and nothing it does not', () => {
    const { lobby, pm, room } = rooms();
    const bob = { nick: 'Bob', login: 'bob' };
    for (const [what, conv, l, targets, re] of [
      ['a lobby line', lobby, line({ id: 7, from: bob }), ALL, { line: 7 }],
      ['a room line, with its room', room, line({ id: 7, from: bob }), ALL, { line: 7, room: 8 }],
      ['a lobby line without history', lobby, line({ id: 7, from: bob }), ['pm'], null],
      ['a line never kept', lobby, line({ from: bob }), ALL, null],
      ['a redacted line', lobby, line({ id: 7, kind: 'deleted', deleted: true }), ALL, null],
      ['a notice', lobby, line({ id: 7, kind: 'notice' }), ALL, null],
      ['a stored message', pm, line({ ref: 'R', from: bob }), ALL, { pm: 'R' }],
      ['an instant message', pm, line({ ref: 'R', guid: 'G', from: bob }), ALL, { im: { login: 'bob', guid: 'G' } }],
      ['an instant message, with no im kept', pm, line({ ref: 'R', guid: 'G', from: bob }), ['pm'], { pm: 'R' }],
      ['one of ours, by reference', pm, line({ ref: 'R', guid: 'G', local: true }), ALL, { pm: 'R' }],
      ['one never stored', pm, line({ from: bob }), ALL, null],
      ['a hidden sealed one', pm, line({ ref: 'R', hidden: true }), ALL, null],
    ] as const) {
      expect(startReply(l, conv, targets)?.re ?? null, what).toEqual(re);
    }
  });

  it('says whom and what, on one line and cut short', () => {
    const { lobby } = rooms();
    const long = `first\n\n${'word '.repeat(60)}`;
    const r = startReply(line({ id: 1, text: long, from: { nick: 'Bob' } }), lobby, ALL)!;
    expect(r.nick).toBe('Bob');
    expect(r.excerpt).not.toContain('\n');
    expect([...r.excerpt]).toHaveLength(120);
    expect(r.excerpt.endsWith('…')).toBe(true);
    expect(startReply(line({ id: 2, text: '', media: { width: 1, height: 1, type: 'image/png' } as never, local: true }), lobby, ALL)).toMatchObject({
      nick: 'yourself',
      excerpt: 'an image',
    });
    expect(excerpt('**bold** <b>x</b>')).toBe('**bold** <b>x</b>');
  });
});

describe('resolving a quote', () => {
  it('finds a line held or fetched, waits for one not yet fetched, and shows none redacted, missing or in a room', () => {
    const { store, lobby } = rooms();
    store.add(LOBBY, line({ id: 3, text: 'held', from: { nick: 'Ann' } }));
    store.add(LOBBY, line({ id: 4, kind: 'deleted', deleted: true }));
    const fetched = new Map<number, HistoryLine | null>([
      [1, kept(1)],
      [2, null],
      [5, kept(5, { deleted: true })],
    ]);
    const o = { fetched, me: 'me' };
    expect(resolveQuote({ line: 3 }, lobby, o)).toMatchObject({ state: 'found', nick: 'Ann', excerpt: 'held', line: { id: 3 } });
    expect(resolveQuote({ line: 1 }, lobby, o)).toEqual({ state: 'found', nick: 'Bob', excerpt: 'line 1' });
    expect(resolveQuote({ line: 9 }, lobby, o)).toEqual({ state: 'pending', id: 9, room: 0 });
    for (const re of [{ line: 2 }, { line: 4 }, { line: 5 }, { line: 3, room: 8 }, { pm: 'R' }]) {
      expect(resolveQuote(re, lobby, o), JSON.stringify(re)).toEqual({ state: 'missing' });
    }
  });

  it("finds a room's line in that room alone", () => {
    const { store, lobby, room } = rooms();
    store.add(room.id, line({ id: 3, text: 'in the room', from: { nick: 'Ann' } }));
    store.add(LOBBY, line({ id: 4, text: 'in the lobby', from: { nick: 'Ann' } }));
    const o = { fetched: new Map([[1, kept(1)]]), me: 'me' };
    expect(resolveQuote({ line: 3, room: 8 }, room, o)).toMatchObject({ state: 'found', excerpt: 'in the room' });
    expect(resolveQuote({ line: 1, room: 8 }, room, o)).toMatchObject({ state: 'found', excerpt: 'line 1' });
    expect(resolveQuote({ line: 9, room: 8 }, room, o)).toEqual({ state: 'pending', id: 9, room: 8 });
    for (const [re, conv] of [
      [{ line: 4 }, room],
      [{ line: 3 }, room],
      [{ line: 3, room: 8 }, lobby],
      [{ line: 3, room: 9 }, room],
    ] as const) {
      expect(resolveQuote(re, conv, o), JSON.stringify(re)).toEqual({ state: 'missing' });
    }
  });

  it("finds a message in its own conversation alone, an instant message by its sender's login and guid, and none whose text is hidden", () => {
    const { store, pm } = rooms();
    const other = store.openPm({ login: 'carol', nick: 'Carol' });
    store.add(pm.id, line({ ref: 'R1', text: 'from bob', from: { nick: 'Bob', login: 'bob' } }));
    store.add(pm.id, line({ guid: 'G1', text: 'im from bob', from: { nick: 'Bob', login: 'Bob' } }));
    store.add(pm.id, line({ guid: 'G2', ref: 'R2', text: 'mine', local: true, from: { nick: 'Me' } }));
    store.add(pm.id, line({ ref: 'R4', text: 'unchecked', hidden: true, from: { nick: 'Bob', login: 'bob' } }));
    store.add(other.id, line({ ref: 'R3', text: 'carol', from: { nick: 'Carol', login: 'carol' } }));
    const o = { fetched: new Map(), me: 'ME' };
    expect(resolveQuote({ pm: 'R1' }, pm, o)).toMatchObject({ state: 'found', nick: 'Bob', excerpt: 'from bob' });
    expect(resolveQuote({ pm: 'R2' }, pm, o)).toMatchObject({ state: 'found', nick: 'you', excerpt: 'mine' });
    expect(resolveQuote({ im: { login: 'bob', guid: 'G1' } }, pm, o)).toMatchObject({ excerpt: 'im from bob' });
    expect(resolveQuote({ im: { login: 'me', guid: 'G2' } }, pm, o)).toMatchObject({ excerpt: 'mine' });
    for (const re of [{ pm: 'R3' }, { pm: 'R4' }, { im: { login: 'carol', guid: 'G1' } }, { im: { login: 'bob', guid: 'G2' } }, { line: 1 }]) {
      expect(resolveQuote(re, pm, o), JSON.stringify(re)).toEqual({ state: 'missing' });
    }
  });
});

describe('fetching quoted lines', () => {
  /** A fetcher whose wait runs when the test says, over a server that
   *  answers at most `fits` lines a reply and has `have`. */
  function fetcher(have: Set<number>, fits = 50) {
    const asked: number[][] = [];
    let waiting: (() => void) | null = null;
    let drawn = 0;
    const f = new QuoteFetcher(
      async (ids) => {
        asked.push(ids);
        const lines = ids.filter((id) => have.has(id)).map((id) => kept(id));
        return { lines: lines.slice(0, fits), has_more: lines.length > fits } satisfies HistoryOk;
      },
      () => drawn++,
      (run) => (waiting = run),
    );
    const settle = async () => {
      const run = waiting;
      waiting = null;
      run?.();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { f, asked, settle, drawn: () => drawn };
  }

  it('gathers what comes on screen together into requests of at most fifty, asked once', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => 60 - i);
    const { f, asked, settle, drawn } = fetcher(new Set(ids.filter((id) => id % 2)));
    for (const id of ids) f.want(id);
    f.want(3);
    await settle();
    expect(asked.map((a) => a.length)).toEqual([50, 10]);
    expect(asked[0]).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect([f.lines.get(3)?.id, f.lines.get(4)]).toEqual([3, null]);
    expect(drawn()).toBe(2);
    f.want(3);
    f.want(4);
    await settle();
    expect(asked).toHaveLength(2);
  });

  it('asks again for the ids past a full reply, and not for those it left out as missing', async () => {
    const { f, asked, settle } = fetcher(new Set([1, 3, 5, 7]), 2);
    for (const id of [1, 2, 3, 4, 5, 6, 7]) f.want(id);
    await settle();
    expect(asked).toEqual([
      [1, 2, 3, 4, 5, 6, 7],
      [4, 5, 6, 7],
    ]);
    expect([...f.lines].sort(([a], [b]) => a - b).map(([id, l]) => [id, l?.id ?? null])).toEqual([
      [1, 1],
      [2, null],
      [3, 3],
      [4, null],
      [5, 5],
      [6, null],
      [7, 7],
    ]);
  });

  /** A fetcher answering from `answer`, whose waits run when the test
   *  says and are kept with how long each asked. */
  function stepped(answer: (ids: number[]) => Promise<HistoryOk>) {
    const asked: number[][] = [];
    const waits: { run: () => void; ms: number }[] = [];
    const f = new QuoteFetcher(
      (ids) => {
        asked.push(ids);
        return answer(ids);
      },
      () => {},
      (run, ms) => void waits.push({ run, ms }),
    );
    const step = async () => {
      waits.shift()?.run();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { f, asked, waits, step };
  }

  it('marks what a standing refusal was for unavailable, and asks no more', async () => {
    for (const code of ['access_denied', 'not_available', 'bad_request', 'no_such_room']) {
      const { f, asked, waits, step } = stepped(async () => {
        throw new WireFailure({ code, text: code });
      });
      f.want(1);
      await step();
      expect([f.lines.get(1), waits.length], code).toEqual([null, 0]);
      f.want(1);
      expect(asked, code).toEqual([[1]]);
    }
  });

  it('keeps what a rate limit or a lost socket refused, and asks again after its wait or a growing one', async () => {
    let fail: Error | null = new WireFailure({ code: 'rate_limited', text: 'slow', retry_after: 7 });
    const { f, asked, waits, step } = stepped(async (ids) => {
      if (fail) throw fail;
      return { lines: ids.map((id) => kept(id)), has_more: false };
    });
    f.want(1);
    await step();
    expect(waits.map((w) => w.ms)).toEqual([7000]);
    fail = new Error('not connected');
    await step();
    expect(waits.map((w) => w.ms)).toEqual([2000]);
    await step();
    expect(waits.map((w) => w.ms)).toEqual([4000]);
    expect(f.lines.has(1)).toBe(false);
    fail = null;
    await step();
    expect(f.lines.get(1)?.id).toBe(1);
    expect(asked).toEqual([[1], [1], [1], [1]]);
  });

  it('shows nothing for a line redacted while it was being fetched', async () => {
    let answer: (ok: HistoryOk) => void = () => {};
    const { f, step } = stepped(() => new Promise((r) => (answer = r)));
    f.want(1);
    await step();
    f.redacted(1);
    answer({ lines: [kept(1)], has_more: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.lines.get(1)).toBeNull();
  });
});
