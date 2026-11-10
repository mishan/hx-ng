/**
 * The server's own emoji on the client side (hxd-ng's
 * `docs/server-emoji.md` §8): the catalog kept from `emoji_list`, what a
 * line's references make of its text, the declaration and its block,
 * and the image route, stubbed as the avatar tests stub theirs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Connection, WireFailure, type Credentials } from '../src/connection';
import { EMOJI_REFS_MAX, EmojiCatalog, emojiRefsFor, emojiSegments } from '../src/emoji';
import type { EmojiConfig, EmojiEntry, EmojiListOk, EmojiListParams, LiveEmoji, LoginOk, SelfUser } from '../src/protocol';

import { installFakeWire, settle, uninstallFakeWire, type FakeServer } from './fake-wire';

const live = (id: number, name: string, revision = id, extra: Partial<LiveEmoji> = {}): LiveEmoji => ({
  id,
  revision,
  name,
  hash: id.toString(16).padStart(64, '0'),
  width: 32,
  height: 32,
  ...extra,
});
const removed = (id: number, name: string, revision: number): EmojiEntry => ({ id, revision, name, removed: true });

/** A list function answering each request with the next page given, and
 *  recording what was asked. */
function scripted(...pages: EmojiListOk[]): { list: (p: EmojiListParams) => Promise<EmojiListOk>; asked: EmojiListParams[] } {
  const asked: EmojiListParams[] = [];
  return {
    asked,
    list: (p) => {
      asked.push(p);
      const page = pages.shift();
      return page ? Promise.resolve(page) : Promise.reject(new Error(`nothing scripted for ${JSON.stringify(p)}`));
    },
  };
}

const names = (c: EmojiCatalog) => c.entries().map((e) => e.name);

describe('the emoji catalog', () => {
  it('reads everything from nothing, paging after the last id with no revision, and keeps the first page\'s revision', async () => {
    const s = scripted(
      { revision: 7, emoji: [live(1, 'party'), live(2, 'zebra')], has_more: true },
      { revision: 8, emoji: [removed(3, 'old', 6), live(4, 'apple')] },
    );
    const c = new EmojiCatalog(s.list);
    expect(c.revision).toBeNull();
    expect(await c.refresh()).toBe(true);
    expect(s.asked).toEqual([{}, { after: 2 }]);
    expect(c.revision).toBe(7);
    expect(names(c)).toEqual(['apple', 'party', 'zebra']);
    expect([c.live(3), c.get(3), c.named('old')]).toEqual([undefined, removed(3, 'old', 6), undefined]);
    expect(c.named('party')).toEqual(live(1, 'party'));
  });

  it('merges a delta from the revision held: an add, a rename and a removal', async () => {
    const s = scripted(
      { revision: 2, emoji: [live(1, 'party'), live(2, 'cat')] },
      { revision: 5, emoji: [live(1, 'fiesta', 3), removed(2, 'cat', 4), live(3, 'dog', 5)], delta: true },
    );
    const c = new EmojiCatalog(s.list);
    await c.refresh();
    expect(await c.refresh()).toBe(true);
    expect(s.asked[1]).toEqual({ revision: 2 });
    expect(c.revision).toBe(5);
    expect(names(c)).toEqual(['dog', 'fiesta']);
    expect([c.named('party'), c.named('cat'), c.live(2), c.get(2)?.name]).toEqual([undefined, undefined, undefined, 'cat']);
  });

  it('answers that nothing changed for an empty delta, holding what it held', async () => {
    const s = scripted({ revision: 2, emoji: [live(1, 'party')] }, { revision: 2, delta: true });
    const c = new EmojiCatalog(s.list);
    await c.refresh();
    expect(await c.refresh()).toBe(false);
    expect([c.revision, names(c)]).toEqual([2, ['party']]);
  });

  it('pages a delta with the revision it asked from, and keeps the first page\'s revision', async () => {
    const s = scripted(
      { revision: 1, emoji: [live(1, 'a1')] },
      { revision: 4, emoji: [live(2, 'b2')], delta: true, has_more: true },
      { revision: 6, emoji: [live(5, 'c5')], delta: true },
    );
    const c = new EmojiCatalog(s.list);
    await c.refresh();
    await c.refresh();
    expect(s.asked.slice(1)).toEqual([{ revision: 1 }, { revision: 1, after: 2 }]);
    expect([c.revision, names(c)]).toEqual([4, ['a1', 'b2', 'c5']]);
  });

  it('replaces what it holds when a revision it holds is answered whole, as past one the server forgot', async () => {
    const s = scripted({ revision: 3, emoji: [live(1, 'gone'), live(2, 'kept')] }, { revision: 9, emoji: [live(2, 'kept', 2)] });
    const c = new EmojiCatalog(s.list);
    await c.refresh();
    expect(await c.refresh()).toBe(true);
    expect([c.revision, names(c), c.get(1)]).toEqual([9, ['kept'], undefined]);
  });

  it('runs a refresh asked for while one pages once more after it, shared by every such call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const asked: EmojiListParams[] = [];
    const answers = [
      { revision: 1, emoji: [live(1, 'a1')] },
      { revision: 2, emoji: [live(2, 'b2', 2)], delta: true as const },
    ];
    const c = new EmojiCatalog(async (p) => {
      asked.push(p);
      if (asked.length === 1) await gate;
      return answers.shift()!;
    });
    const first = c.refresh();
    const second = c.refresh();
    const third = c.refresh();
    expect(second).toBe(third);
    release();
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(asked).toEqual([{}, { revision: 1 }]);
    expect(names(c)).toEqual(['a1', 'b2']);
  });

  it('keeps what it held through a refusal, and the next refresh asks from there', async () => {
    const answers: (EmojiListOk | Error)[] = [
      { revision: 1, emoji: [live(1, 'a1')] },
      { revision: 3, emoji: [live(2, 'b2')], delta: true, has_more: true },
      new Error('rate_limited'),
      { revision: 3, emoji: [live(2, 'b2')], delta: true },
    ];
    const asked: EmojiListParams[] = [];
    const c = new EmojiCatalog((p) => {
      asked.push(p);
      const a = answers.shift()!;
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    });
    await c.refresh();
    await expect(c.refresh()).rejects.toThrow('rate_limited');
    expect([c.revision, names(c)]).toEqual([1, ['a1']]);
    await c.refresh();
    expect(asked.at(-1)).toEqual({ revision: 1 });
    expect([c.revision, names(c)]).toEqual([3, ['a1', 'b2']]);
  });

  it('runs a refresh queued behind one that is refused, and both callers are answered', async () => {
    const answers: (EmojiListOk | Error)[] = [new Error('rate_limited'), { revision: 2, emoji: [live(1, 'a1')] }];
    const c = new EmojiCatalog(async () => {
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return a;
    });
    const first = c.refresh();
    const queued = c.refresh();
    await expect(first).rejects.toThrow('rate_limited');
    expect(await queued).toBe(true);
    expect([c.revision, names(c)]).toEqual([2, ['a1']]);
  });

  it('starts again from nothing, paging, when a later page of a delta comes back whole', async () => {
    const s = scripted(
      { revision: 3, emoji: [live(1, 'forgotten'), live(2, 'b')] },
      { revision: 5, emoji: [live(2, 'b2', 4)], delta: true, has_more: true },
      { revision: 6, emoji: [live(9, 'z9', 6)] },
      { revision: 6, emoji: [live(2, 'b2', 4)], has_more: true },
      { revision: 7, emoji: [live(9, 'z9', 6)] },
    );
    const c = new EmojiCatalog(s.list);
    await c.refresh();
    expect(await c.refresh()).toBe(true);
    expect(s.asked.slice(1)).toEqual([{ revision: 3 }, { revision: 3, after: 2 }, {}, { after: 2 }]);
    expect([c.revision, names(c), c.get(1)]).toEqual([6, ['b2', 'z9'], undefined]);
  });

  it('pages a whole answer to a revision it holds as a listing from nothing, which stays whole', async () => {
    const s = scripted(
      { revision: 9, emoji: [live(1, 'a1')] },
      { revision: 3, emoji: [live(1, 'a1')], has_more: true },
      { revision: 3, emoji: [live(4, 'd4')] },
    );
    const c = new EmojiCatalog(s.list);
    await c.refresh();
    await c.refresh();
    expect(s.asked.slice(1)).toEqual([{ revision: 9 }, { after: 1 }]);
    expect([c.revision, names(c)]).toEqual([3, ['a1', 'd4']]);
  });

  it('finds a name freed by a removal under the entry that took it', async () => {
    const c = new EmojiCatalog(scripted({ revision: 2, emoji: [removed(1, 'party', 1), live(2, 'party', 2)] }).list);
    await c.refresh();
    expect(c.named('party')?.id).toBe(2);
  });
});

describe('a line\'s references', () => {
  const held = { live: (id: number) => (id === 1 ? live(1, 'party') : id === 2 ? live(2, 'cat') : undefined) };

  it.each([
    ['no references', 'a :party: b', undefined, ['a :party: b']],
    ['a bound name', 'a :party: b', [{ name: 'party', id: 1 }], ['a ', { name: 'party', id: 1 }, ' b']],
    ['a name no reference binds', ':cat: and :party:', [{ name: 'party', id: 1 }], [':cat: and ', { name: 'party', id: 1 }]],
    ['a reference to an id no longer live', ':gone:', [{ name: 'gone', id: 3 }], [':gone:']],
    ['the id\'s picture under the name the sender used', ':fiesta:', [{ name: 'fiesta', id: 1 }], [{ name: 'fiesta', id: 1 }]],
    ['a colon closing an unbound name opening the next', 'x:no:party:', [{ name: 'party', id: 1 }], ['x:no', { name: 'party', id: 1 }]],
    ['names side by side and repeated', ':party::cat::party:', [{ name: 'party', id: 1 }, { name: 'cat', id: 2 }], [
      { name: 'party', id: 1 },
      { name: 'cat', id: 2 },
      { name: 'party', id: 1 },
    ]],
    ['the first reference for a name', ':party:', [{ name: 'party', id: 2 }, { name: 'party', id: 1 }], [{ name: 'party', id: 2 }]],
    ['what no name can be', ':Party: :p: :a-b: :' + 'x'.repeat(33) + ':', [{ name: 'Party', id: 1 }, { name: 'p', id: 1 }, { name: 'a-b', id: 1 }, { name: 'x'.repeat(33), id: 1 }], [
      ':Party: :p: :a-b: :' + 'x'.repeat(33) + ':',
    ]],
    ['an unclosed name', 'say :party', [{ name: 'party', id: 1 }], ['say :party']],
    ['nothing at all', '', [{ name: 'party', id: 1 }], []],
  ] as const)('split by %s', (_, text, refs, want) => {
    expect(emojiSegments(text, refs, held)).toEqual(want);
  });

  it('are sent for each name the catalog has live now, in the order first said, each once', () => {
    const named = (n: string) => ({ party: live(1, 'party'), cat: live(2, 'cat') })[n];
    expect(emojiRefsFor(':cat: hi :nope: :party: :cat:', { named })).toEqual([
      { name: 'cat', id: 2 },
      { name: 'party', id: 1 },
    ]);
    expect(emojiRefsFor('no emoji: here', { named })).toEqual([]);
  });

  it('are sent no more than a server keeps', () => {
    const many = Array.from({ length: EMOJI_REFS_MAX + 3 }, (_, i) => `e${i}`);
    const refs = emojiRefsFor(many.map((n) => `:${n}:`).join(' '), { named: (n) => live(Number(n.slice(1)) + 1, n) });
    expect(refs).toHaveLength(EMOJI_REFS_MAX);
    expect(refs.at(-1)).toEqual({ name: `e${EMOJI_REFS_MAX - 1}`, id: EMOJI_REFS_MAX });
  });
});

const CREDS: Credentials = { url: 'ws://test/ng', login: 'alice', password: 'pw', nick: 'Alice', icon: 128, emoji: true };
const BLOCK: EmojiConfig = { revision: 12, max_count: 200, max_bytes: 16384, max_dimension: 128, manage: false };
const me = (): SelfUser => ({ uid: 1, nick: 'Alice', icon: 128, admin: false, status: 'active', transport: 'encrypted' });
const loginOk = (over: Partial<LoginOk> = {}): LoginOk => ({
  session: 's_1',
  token: 'tok',
  self: me(),
  server: { name: 'Test', subject: '' },
  users: [],
  detach: { grace: 300 },
  caps: ['emoji'],
  seq: 0,
  emoji: BLOCK,
  ...over,
});

describe('the emoji capability', () => {
  let server: FakeServer;
  let calls: { url: string; init: RequestInit }[];
  const stubFetch = (answer: () => Response) => {
    calls = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return Promise.resolve(answer());
    });
  };
  const connect = async (creds: Credentials = CREDS) => {
    const conn = new Connection(creds, {});
    await conn.start();
    return conn;
  };

  beforeEach(() => {
    server = installFakeWire();
    server.on('login', () => ({ ok: loginOk() }));
  });
  afterEach(() => {
    uninstallFakeWire();
    vi.unstubAllGlobals();
  });

  it('is declared at login only when asked, and its block kept across a reload', async () => {
    const conn = await connect();
    expect(server.sent('login')[0]!.params.emoji).toBe(true);
    expect(conn.emoji).toEqual(BLOCK);
    server.on('resume', () => ({ ok: { replay: 0, self: me() } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: '' }, users: [me()], seq: 0 } }));
    const again = new Connection(CREDS, {});
    await again.start({ resumeOnly: true });
    await settle();
    expect(again.emoji).toEqual(BLOCK);

    uninstallFakeWire();
    server = installFakeWire();
    server.on('login', () => ({ ok: loginOk({ caps: [], emoji: undefined }) }));
    const plain = await connect({ ...CREDS, emoji: false, url: 'ws://other/ng' });
    expect(server.sent('login')[0]!.params).not.toHaveProperty('emoji');
    expect(plain.emoji).toBeNull();
  });

  it('lists the catalog with the params given', async () => {
    server.on('emoji_list', () => ({ ok: { revision: 12, delta: true } }));
    const conn = await connect();
    expect(await conn.emojiList({ revision: 3, after: 9 })).toEqual({ revision: 12, delta: true });
    expect(await conn.emojiList()).toEqual({ revision: 12, delta: true });
    expect(server.sent('emoji_list').map((f) => f.params)).toEqual([{ revision: 3, after: 9 }, {}]);
  });

  it('fetches an image by its hash in lowercase, with the credential', async () => {
    stubFetch(() => new Response(new Blob([new Uint8Array([71, 73, 70])]), { status: 200 }));
    const conn = await connect();
    const blob = await conn.fetchEmoji('AB'.repeat(32));
    expect(blob.size).toBe(3);
    expect(calls[0]!.url).toBe(`http://test/emoji/${'ab'.repeat(32)}`);
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer s_1.tok' });
  });

  it.each([
    ['the server\'s refusal', () => new Response(JSON.stringify({ error: { code: 'no_such_emoji', text: 'gone' } }), { status: 404 }), 'no_such_emoji'],
    ['a bare 404', () => new Response('not found', { status: 404 }), 'no_such_emoji'],
    ['the HTTP throttle', () => new Response(JSON.stringify({ error: 'rate_limited', text: 'slow', retry_after: 2 }), { status: 429 }), 'rate_limited'],
  ])('reads %s as a WireFailure', async (_, answer, code) => {
    stubFetch(answer);
    const conn = await connect();
    const failed = conn.fetchEmoji('ab'.repeat(32));
    await expect(failed).rejects.toBeInstanceOf(WireFailure);
    await expect(failed).rejects.toMatchObject({ wire: { code } });
  });

  it('sends a server emoji as a reaction key by its id alone', async () => {
    server.on('react', () => ({ ok: { count: 1 } }));
    server.on('reactions', () => ({ ok: { reactions: [] } }));
    const conn = await connect();
    await conn.react({ line: 4 }, { custom: 7 });
    await conn.react({ line: 4 }, { emoji: '❤︎️' }, { remove: true });
    await conn.reactionsGet([{ line: 4 }], { custom: 7 });
    expect(server.sent('react').map((f) => f.params.key)).toEqual([{ custom: 7 }, { emoji: '❤️' }]);
    expect(server.sent('reactions')[0]!.params.key).toEqual({ custom: 7 });
  });
});
