/**
 * `ClassicConnection` against a scripted classic server, through a fake
 * WebSocket, with the real wasm session in between — so these check the
 * module's event shapes against `src/classic/wire.ts` as well as the
 * translation into the ng shapes the views take.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClassicConnection, type ClassicHooks } from '../src/classic/connection';
import { candidates, classicAddress, route } from '../src/classic/route';
import { loadClassic } from '../src/classic/wire';

// `node:fs` behind an `any`, as tsconfig.json asks, so Node's types stay
// out of a program that also typechecks as browser code.
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as any;

const TASK = 0x0001_0000;

// --- the classic wire, written by hand ---------------------------------

type Field = [number, Uint8Array | string | number[]];

const enc = new TextEncoder();

function bytes(v: Uint8Array | string | number[]): Uint8Array {
  return typeof v === 'string' ? enc.encode(v) : v instanceof Uint8Array ? v : Uint8Array.from(v);
}

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** A transaction as a server writes one. */
function frame(type: number, trans: number, fields: Field[], flag = 0): Uint8Array {
  const body: number[] = [...u16(fields.length)];
  for (const [tag, v] of fields) {
    const b = bytes(v);
    body.push(...u16(tag), ...u16(b.length), ...b);
  }
  return Uint8Array.from([...u32(type), ...u32(trans), ...u32(flag), ...u32(body.length), ...u32(body.length), ...body]);
}

/** The transactions in what the client sent: (type, trans, fields). */
function parse(data: Uint8Array): { type: number; trans: number; fields: Map<number, Uint8Array> }[] {
  const out = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  // The magic, when it is there, is not a transaction.
  if (data.length >= 12 && new TextDecoder().decode(data.subarray(0, 8)) === 'TRTPHOTL') at = 12;
  while (at + 22 <= data.length) {
    const type = view.getUint32(at);
    const trans = view.getUint32(at + 4);
    const len = view.getUint32(at + 16);
    const count = view.getUint16(at + 20);
    const fields = new Map<number, Uint8Array>();
    let f = at + 22;
    for (let i = 0; i < count; i++) {
      const tag = view.getUint16(f);
      const n = view.getUint16(f + 2);
      fields.set(tag, data.subarray(f + 4, f + 4 + n));
      f += 4 + n;
    }
    out.push({ type, trans, fields });
    at += 20 + len;
  }
  return out;
}

function userRow(uid: number, icon: number, status: number, name: string): number[] {
  const n = enc.encode(name);
  return [...u16(uid), ...u16(icon), ...u16(status), ...u16(n.length), ...n];
}

// --- a WebSocket a test can be the other end of -------------------------

class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;
  readyState = 0;
  binaryType = 'blob';
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: Uint8Array): void {
    this.sent.push(Uint8Array.from(data));
  }

  close(): void {
    if (this.readyState >= 2) return;
    // As a browser does: closing now, closed later.
    this.readyState = 2;
    setTimeout(() => {
      this.readyState = 3;
      this.onclose?.();
    }, 0);
  }

  /** The server says something. */
  serve(...chunks: Uint8Array[]): void {
    for (const c of chunks) this.onmessage?.({ data: c.slice().buffer });
  }

  /** What the client sent since last asked. */
  take(): ReturnType<typeof parse> {
    const all = this.sent.flatMap((b) => parse(b));
    this.sent = [];
    return all;
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  await loadClassic(readFileSync(new URL('../packages/classic/pkg/hxclassic_bg.wasm', import.meta.url)));
});

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.last = null;
});

/** Every connection a test made, dropped after it so none outlives it. */
const made: ClassicConnection[] = [];

afterEach(() => {
  for (const c of made.splice(0)) c.drop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A connection, remembered for dropping when the test ends. */
function connection(creds = CREDS, hooks: ClassicHooks = {}): ClassicConnection {
  const c = new ClassicConnection(creds, hooks);
  made.push(c);
  return c;
}

const CREDS = { url: 'ws://relay/trtp', login: '', password: '', nick: 'me', icon: 7 };

/** A connection logged in to a 1.5 server with no agreement to show,
 *  and the socket it holds. */
async function online(hooks: ClassicHooks = {}): Promise<{ conn: ClassicConnection; ws: FakeSocket }> {
  const conn = connection(CREDS, hooks);
  const started = conn.start();
  await tick();
  await tick();
  const ws = FakeSocket.last!;
  ws.serve(enc.encode('TRTP\0\0\0\0'));
  const login = ws.take();
  expect(login.map((t) => t.type)).toEqual([107]);
  ws.serve(
    frame(TASK, 1, [
      [0xa0, u16(190)],
      [0xa2, 'Scripted'],
      [0x67, u16(2)],
    ]),
    frame(0x6d, 0, [[0x9a, [1]]]),
  );
  const after = ws.take();
  expect(after.map((t) => t.type)).toEqual([121, 300]);
  ws.serve(
    frame(TASK, after[1]!.trans, [
      [0x12c, userRow(1, 3, 2, 'alice')],
      [0x12c, userRow(2, 7, 0, 'me')],
    ]),
  );
  await started;
  return { conn, ws };
}

describe('ClassicConnection', () => {
  it('logs in, and hands the views an ng login and roster', async () => {
    const onLogin = vi.fn();
    const onSnapshot = vi.fn();
    const { conn } = await online({ onLogin, onSnapshot });
    expect(conn.state).toBe('online');
    expect(conn.self).toMatchObject({ uid: 2, nick: 'me', icon: 7 });
    const ok = onLogin.mock.calls[0]![0];
    expect(ok.server.name).toBe('Scripted');
    expect(ok.users).toEqual([
      { uid: 1, nick: 'alice', icon: 3, admin: true, status: 'active', transport: 'cleartext' },
      { uid: 2, nick: 'me', icon: 7, admin: false, status: 'active', transport: 'cleartext' },
    ]);
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(conn.hasCap('files')).toBe(true);
    expect(conn.news?.post).toBe(false);
  });

  it('logs in to a 1.2 server as the newest user with our name', async () => {
    const conn = connection({ ...CREDS, nick: 'guest' });
    const started = conn.start();
    await tick();
    await tick();
    const ws = FakeSocket.last!;
    ws.serve(enc.encode('TRTP\0\0\0\0'));
    ws.take();
    // No version, no uid: a 1.2 server. The name goes in a user change.
    ws.serve(frame(TASK, 1, []));
    const after = ws.take();
    expect(after.map((t) => t.type)).toEqual([304, 300]);
    ws.serve(
      frame(TASK, after[1]!.trans, [
        [0x12c, userRow(1, 7, 0, 'guest')],
        [0x12c, userRow(4, 3, 0, 'guest')],
        [0x12c, userRow(9, 7, 0, 'guest')],
      ]),
    );
    await started;
    expect(conn.self?.uid).toBe(9);

    await conn.request('nick', { nick: 'later' });
    expect(ws.take().map((t) => t.type)).toEqual([304]);
  });

  it('gives up on a relay that never opens its socket', async () => {
    class Silent extends FakeSocket {
      constructor(url: string) {
        super(url);
        this.readyState = 0;
      }
    }
    // Never opens: the microtask FakeSocket queues is disarmed.
    Object.defineProperty(Silent.prototype, 'onopen', { set() {}, get: () => null });
    vi.stubGlobal('WebSocket', Silent);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const conn = connection();
    const started = conn.start();
    started.catch(() => {});
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(started).rejects.toThrow();
    expect(conn.state).toBe('offline');
  });

  it('takes an agreement it could not ask about as declined', async () => {
    const conn = connection(CREDS, { onAgreement: () => Promise.reject(new Error('no dialog')) });
    const started = conn.start();
    await tick();
    await tick();
    const ws = FakeSocket.last!;
    ws.serve(enc.encode('TRTP\0\0\0\0'));
    ws.take();
    ws.serve(frame(TASK, 1, [[0xa0, u16(190)]]), frame(0x6d, 0, [[0x65, 'Be nice.']]));
    await expect(started).rejects.toThrow('You did not accept the agreement.');
  });

  it('shows the agreement, and sends nothing until it is answered', async () => {
    let answer!: (yes: boolean) => void;
    const onAgreement = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const conn = connection(CREDS, { onAgreement });
    const started = conn.start();
    await tick();
    await tick();
    const ws = FakeSocket.last!;
    ws.serve(enc.encode('TRTP\0\0\0\0'));
    ws.take();
    ws.serve(frame(TASK, 1, [[0xa0, u16(190)]]), frame(0x6d, 0, [[0x65, 'Be nice.\rReally.']]));
    expect(onAgreement).toHaveBeenCalledWith('Be nice.\nReally.', expect.any(AbortSignal));
    expect(ws.take()).toEqual([]);

    answer(false);
    await expect(started).rejects.toThrow('You did not accept the agreement.');
    expect(conn.state).toBe('offline');
  });

  it('lets only the first line of a chat say who is speaking', async () => {
    const { conn, ws } = await online();
    const chat = vi.fn();
    const notice = vi.fn();
    conn.on('chat', chat);
    conn.on('notice', notice);
    // A server that passes a user's own line breaks through: alice
    // writes a server notice, and a line in bob's name, of her own.
    ws.serve(
      frame(0x6a, 0, [
        [0x65, '\r        alice:  hi\r *** Server: going down\r          me:  give alice your password\r        alice:  bye'],
        [0x67, u16(1)],
      ]),
    );
    expect(notice).not.toHaveBeenCalled();
    expect(chat.mock.calls.map(([c]) => [c.from.uid, c.text])).toEqual([
      [1, 'hi'],
      [1, '*** Server: going down'],
      [1, 'me:  give alice your password'],
      [1, 'bye'],
    ]);
  });

  it('reads who said a line out of the line, as a classic server formats it', async () => {
    const { conn, ws } = await online();
    const chat = vi.fn();
    const notice = vi.fn();
    conn.on('chat', chat);
    conn.on('notice', notice);
    ws.serve(
      frame(0x6a, 0, [[0x65, '\r        alice:  hello, café']]),
      // An emote the server says alice sent, with a colon and two spaces
      // in it.
      frame(0x6a, 0, [
        [0x65, '\r *** alice says: look:  here'],
        [0x67, u16(1)],
      ]),
      frame(0x6a, 0, [[0x65, '\rThe server is going down at noon.']]),
      // An emote as Janus sends one, naming nobody as its sender: shown
      // as it came, since a server's own notices take this shape too.
      frame(0x6a, 0, [[0x65, '\r *** alice waves']]),
      // mhxd's and hxd-ng's spam kick, which names the spammer: drawn as
      // their emote, which reads the same.
      frame(0x6a, 0, [
        [0x65, '\r *** alice was kicked for chat spamming'],
        [0x67, u16(1)],
      ]),
      // A two-line emote, each line formatted as mhxd formats it.
      frame(0x6a, 0, [
        [0x65, '\r *** alice waves\r *** alice and bows'],
        [0x67, u16(1)],
      ]),
    );
    expect(chat.mock.calls.map((c) => [c[0].from, c[0].text, c[0].style])).toEqual([
      [{ uid: 1, nick: 'alice' }, 'hello, café', 'normal'],
      [{ uid: 1, nick: 'alice' }, 'says: look:  here', 'action'],
      [{ uid: 1, nick: 'alice' }, 'was kicked for chat spamming', 'action'],
      [{ uid: 1, nick: 'alice' }, 'waves', 'action'],
      [{ uid: 1, nick: 'alice' }, 'and bows', 'action'],
    ]);
    expect(notice.mock.calls.map((c) => c[0].text)).toEqual(['The server is going down at noon.', '*** alice waves']);
  });

  it('reads several lines in one transaction, each with its own name', async () => {
    const { conn, ws } = await online();
    const chat = vi.fn();
    conn.on('chat', chat);
    ws.serve(
      // What mhxd and hxd-ng send for a multi-line message: every line
      // formatted, all in one transaction.
      frame(0x6a, 0, [[0x65, '\r        alice:  one\r        alice:  two']]),
      // hxd-ng's history replay to a client without the capability.
      frame(0x6a, 0, [[0x65, '\r[12:34] alice:  earlier']]),
      // A line with no name carries on from the line before.
      frame(0x6a, 0, [[0x65, '\r        alice:  first\rand more']]),
    );
    expect(chat.mock.calls.map((c) => [c[0].from.nick, c[0].text])).toEqual([
      ['alice', 'one'],
      ['alice', 'two'],
      ['alice', 'earlier'],
      ['alice', 'first'],
      ['alice', 'and more'],
    ]);
  });

  it('reports a refusal and carries on', async () => {
    const { conn, ws } = await online();
    // Too long for a field: refused before it is sent, and the session
    // lives on.
    await expect(conn.chat({ text: 'x'.repeat(70_000) })).rejects.toThrow('too long');
    expect(conn.state).toBe('online');
    await conn.chat({ text: 'short' });
    expect(ws.take().map((t) => t.type)).toEqual([105]);
  });

  it('takes a multi-word name off the front of an emote', async () => {
    const { conn, ws } = await online();
    ws.serve(
      frame(0x12d, 0, [
        [0x67, u16(9)],
        [0x66, 'Mary Ann'],
      ]),
    );
    const chat = vi.fn();
    conn.on('chat', chat);
    ws.serve(
      frame(0x6a, 0, [
        [0x65, '\r *** Mary Ann waves'],
        [0x67, u16(9)],
      ]),
    );
    expect(chat.mock.calls[0]![0]).toMatchObject({ from: { uid: 9, nick: 'Mary Ann' }, text: 'waves', style: 'action' });
  });

  it('turns users coming, changing and going into roster events', async () => {
    const { conn, ws } = await online();
    const seen: string[] = [];
    conn.on('user_joined', (d) => seen.push(`joined ${d.user.nick}`));
    conn.on('user_changed', (d) => seen.push(`changed ${d.user.nick} ${d.user.status}`));
    conn.on('user_parted', (d) => seen.push(`parted ${d.uid}`));
    ws.serve(
      frame(0x12d, 0, [
        [0x67, u16(5)],
        [0x68, u16(1)],
        [0x66, 'bob'],
      ]),
      frame(0x12d, 0, [
        [0x67, u16(5)],
        [0x68, u16(1)],
        [0x66, 'bob'],
        [0x70, u16(1)],
      ]),
      frame(0x12e, 0, [[0x67, u16(5)]]),
    );
    expect(seen).toEqual(['joined bob', 'changed bob idle', 'parted 5']);
  });

  it('sends private messages and hears them', async () => {
    const { conn, ws } = await online();
    const msg = vi.fn();
    conn.on('msg', msg);
    await conn.msg({ to: 1, text: 'psst\nok' });
    const sent = ws.take();
    expect(sent[0]!.type).toBe(108);
    expect(new TextDecoder().decode(sent[0]!.fields.get(0x65))).toBe('psst\rok');
    ws.serve(
      frame(0x68, 0, [
        [0x67, u16(1)],
        [0x66, 'alice'],
        [0x65, 'hi back'],
      ]),
    );
    expect(msg.mock.calls[0]![0]).toMatchObject({ from: { uid: 1, nick: 'alice' }, text: 'hi back', queued: false });
    // Somebody who is not here cannot be written to on a classic server.
    await expect(conn.msg({ to_login: 'carol', text: 'hi' })).rejects.toThrow('Not on a classic server yet');
  });

  it('lists a folder as an ng listing', async () => {
    const { conn, ws } = await online();
    const listing = conn.filesList('Uploads/new');
    const req = ws.take()[0]!;
    expect(req.type).toBe(200);
    const entry = (type: string, size: number, name: string): number[] => [
      ...enc.encode(type),
      ...enc.encode('ttxt'),
      ...u32(size),
      0,
      0,
      0,
      0,
      0,
      0,
      ...u16(name.length),
      ...enc.encode(name),
    ];
    ws.serve(
      frame(TASK, req.trans, [
        [0xc8, entry('fldr', 2, 'Docs')],
        [0xc8, entry('TEXT', 1234, 'read me')],
      ]),
    );
    expect(await listing).toEqual({
      path: 'Uploads/new',
      entries: [
        { name: 'Docs', kind: 'folder', size: '2', media_type: null, modified: null },
        { name: 'read me', kind: 'file', size: '1234', media_type: null, modified: null },
      ],
    });
    // A refusal arrives as the request's failure, with the server's words.
    const refused = conn.filesList('');
    const again = ws.take()[0]!;
    ws.serve(frame(TASK, again.trans, [[0x64, 'You cannot browse files.']], 1));
    await expect(refused).rejects.toThrow('You cannot browse files.');
  });

  it('presents threaded and flat news as one tree of numbered nodes', async () => {
    const { conn, ws } = await online();
    const tree = conn.newsTree();
    await tick();
    // Both at once: the root's bundles and categories, and the flat file.
    const [dir, flat] = ws.take();
    expect([dir!.type, flat!.type]).toEqual([370, 101]);
    // A category's item: its type, a count, a GUID and two serials, then
    // its name.
    const item = (name: string): number[] => [
      ...u16(3),
      ...u16(0),
      ...new Array<number>(16).fill(0),
      ...u32(0),
      ...u32(0),
      name.length,
      ...enc.encode(name),
    ];
    ws.serve(frame(TASK, dir!.trans, [[0x143, item('General')]]));
    ws.serve(frame(TASK, flat!.trans, [[0x65, 'Welcome.\rBe nice.']]));
    const { nodes } = await tree;
    expect(nodes.map((n) => [n.name, n.kind])).toEqual([
      ['General', 'category'],
      ['News', 'category'],
    ]);

    // The flat news reads as one article.
    const flatThreads = await conn.newsThreads({ category: nodes[1]!.id });
    expect(flatThreads.threads).toHaveLength(1);
    const article = await conn.newsArticle(flatThreads.threads[0]!.article.id);
    expect(article.body).toBe('Welcome.\nBe nice.');

    // A post to it reaches a view showing it, and the next read asks
    // again.
    const posted = vi.fn();
    conn.on('news_posted', posted);
    ws.serve(frame(102, 0, [[0x65, 'Hello.']]));
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ category: nodes[1]!.id, root: article.id }));
    const reread = conn.newsArticle(article.id);
    const ask = ws.take()[0]!;
    expect(ask.type).toBe(101);
    ws.serve(frame(TASK, ask.trans, [[0x65, 'Hello.\rWelcome.']]));
    expect((await reread).body).toBe('Hello.\nWelcome.');
  });

  it('ends the session when the socket goes', async () => {
    const onEnded = vi.fn();
    const { conn, ws } = await online({ onEnded });
    ws.close();
    await tick();
    expect(conn.state).toBe('offline');
    expect(onEnded).toHaveBeenCalledWith('The connection closed.');
  });
});

describe('ClassicConnection, when the server does not cooperate', () => {
  it('shows one agreement for a server that sends it twice', async () => {
    let answer!: (yes: boolean) => void;
    const onAgreement = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const conn = connection(CREDS, { onAgreement });
    const started = conn.start();
    await tick();
    await tick();
    const ws = FakeSocket.last!;
    ws.serve(enc.encode('TRTP\0\0\0\0'));
    ws.take();
    const rules = frame(0x6d, 0, [[0x65, 'Rules.']]);
    ws.serve(frame(TASK, 1, [[0xa0, u16(190)]]), rules, rules);
    expect(onAgreement).toHaveBeenCalledOnce();
    answer(true);
    await tick();
    const sent = ws.take();
    expect(sent.map((t) => t.type)).toEqual([121, 300]);
    ws.serve(frame(TASK, sent[1]!.trans, [[0x12c, userRow(2, 7, 0, 'me')]]));
    await started;
    expect(conn.state).toBe('online');
  });

  it('logs in on a refused user list, and shows the list that comes after', async () => {
    const onSnapshot = vi.fn();
    const conn = connection(CREDS, { onSnapshot });
    const notice = vi.fn();
    conn.on('notice', notice);
    const started = conn.start();
    await tick();
    await tick();
    const ws = FakeSocket.last!;
    ws.serve(enc.encode('TRTP\0\0\0\0'));
    ws.take();
    ws.serve(frame(TASK, 1, [[0xa0, u16(190)]]), frame(0x6d, 0, [[0x9a, [1]]]));
    const [agree, list] = ws.take();
    // The agree refused first: not the list, so the login waits on.
    ws.serve(frame(TASK, agree!.trans, [[0x64, 'Not like that.']], 1));
    await tick();
    expect(conn.state).toBe('connecting');
    // Then the list refused: logged in without one.
    ws.serve(frame(TASK, list!.trans, [[0x64, 'No list for you.']], 1));
    await started;
    expect(onSnapshot.mock.calls[0]![0].users).toEqual([]);
    expect(notice.mock.calls.map((c) => c[0].text)).toEqual(['Not like that.', 'No list for you.']);
  });

  it('logs in without a list that never comes, and draws it when it does', async () => {
    const onSnapshot = vi.fn();
    const conn = connection(CREDS, { onSnapshot });
    const notice = vi.fn();
    conn.on('notice', notice);
    const started = conn.start();
    await tick();
    await tick();
    const ws = FakeSocket.last!;
    ws.serve(enc.encode('TRTP\0\0\0\0'));
    ws.take();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    ws.serve(frame(TASK, 1, [[0xa0, u16(190)]]), frame(0x6d, 0, [[0x9a, [1]]]));
    const list = ws.take().find((t) => t.type === 300)!;
    vi.advanceTimersByTime(15_000);
    await started;
    expect(onSnapshot.mock.calls[0]![0].users).toEqual([]);
    expect(notice).toHaveBeenCalledWith({ text: 'The server did not send its user list.' });
    // Late, but here: the views get the roster, and we are found in it.
    ws.serve(frame(TASK, list.trans, [[0x12c, userRow(2, 7, 0, 'me')], [0x12c, userRow(3, 1, 0, 'bo')]]));
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(onSnapshot.mock.calls[1]![0].users.map((u: { nick: string }) => u.nick)).toEqual(['me', 'bo']);
    expect(conn.self?.uid).toBe(2);
  });

  it('shows the root news without a threaded listing the server ignores', async () => {
    const { conn, ws } = await online();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let done = false;
    const tree = conn.newsTree().then((t) => ((done = true), t));
    const [, flat] = ws.take();
    ws.serve(frame(TASK, flat!.trans, [[0x65, 'Welcome.']]));
    // The threaded listing never answers; the root waits a moment, not
    // the whole request timeout.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await tree).nodes.map((n) => n.name)).toEqual(['News']);
    // And is not asked again this session; the flat file is held.
    const again = await conn.newsTree();
    expect(ws.take()).toEqual([]);
    expect(again.nodes.map((n) => n.name)).toEqual(['News']);
  });

  it('shows the root news without a flat file the server ignores', async () => {
    const { conn, ws } = await online();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let done = false;
    const tree = conn.newsTree().then((t) => ((done = true), t));
    const [dir] = ws.take();
    ws.serve(frame(TASK, dir!.trans, []));
    // A threaded-only server that ignores the flat request: a moment, not
    // the whole request timeout.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await tree).nodes).toEqual([]);
  });

  it('keeps threaded news that answers after the flat file, within the grace', async () => {
    const { conn, ws } = await online();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const tree = conn.newsTree();
    const [dir, flat] = ws.take();
    ws.serve(frame(TASK, flat!.trans, [[0x65, 'Welcome.']]));
    await vi.advanceTimersByTimeAsync(1_000);
    ws.serve(frame(TASK, dir!.trans, []));
    await tree;
    // Past the grace: the next visit still asks for the listing.
    await vi.advanceTimersByTimeAsync(5_000);
    void conn.newsTree();
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.take().map((t) => t.type)).toEqual([370]);
  });

  it('asks no faster than mhxd lets a client, and the user’s own lines count', async () => {
    const { conn, ws } = await online();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // A file listing is three points to mhxd; the budget is sixty in five
    // seconds, so twenty go at once and the rest wait their turn.
    const asked = Array.from({ length: 30 }, () => conn.filesList(''));
    for (const a of asked) a.catch(() => {});
    expect(ws.take()).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ws.take()).toHaveLength(4);
    // A chat line goes at once, and what it spends the next request waits
    // for.
    await conn.chat({ text: 'hi' });
    expect(ws.take().map((t) => t.type)).toEqual([105]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ws.take()).toHaveLength(3);
  });

  it('opens a folder by the bytes the server named it with', async () => {
    const { conn, ws } = await online();
    const root = conn.filesList('');
    const req = ws.take()[0]!;
    // A name that is not valid UTF-8 — Mac Roman "café" — shown decoded.
    const name = [...enc.encode('caf'), 0x8e];
    const entry = [...enc.encode('fldr'), 0, 0, 0, 0, ...u32(1), 0, 0, 0, 0, 0, 0, ...u16(name.length), ...name];
    ws.serve(frame(TASK, req.trans, [[0xc8, entry]]));
    const { entries } = await root;
    expect(entries[0]!.name).toBe('café');
    conn.filesList(entries[0]!.name).catch(() => {});
    const dir = ws.take()[0]!.fields.get(0xca)!;
    expect(Array.from(dir)).toEqual([0, 1, 0, 0, 4, ...name]);
  });

  it('logs in without a user list the server refuses', async () => {
    const onLogin = vi.fn();
    const conn = connection(CREDS, { onLogin });
    const notice = vi.fn();
    conn.on('notice', notice);
    const started = conn.start();
    await tick();
    await tick();
    const ws = FakeSocket.last!;
    ws.serve(enc.encode('TRTP\0\0\0\0'));
    ws.take();
    ws.serve(frame(TASK, 1, [[0xa0, u16(190)]]), frame(0x6d, 0, [[0x9a, [1]]]));
    const list = ws.take().find((t) => t.type === 300)!;
    ws.serve(frame(TASK, list.trans, [[0x64, 'You may not see who is here.']], 1));
    await started;
    expect(conn.state).toBe('online');
    expect(onLogin.mock.calls[0]![0].users).toEqual([]);
    expect(notice).toHaveBeenCalledWith({ text: 'You may not see who is here.' });
  });

  it('gives up on a request nobody answers', async () => {
    const { conn, ws } = await online();
    vi.useFakeTimers();
    try {
      const listing = conn.filesList('');
      const caught = listing.catch((e: Error) => e);
      expect(ws.take()[0]!.type).toBe(200);
      vi.advanceTimersByTime(20_000);
      expect(String(await caught)).toContain('The server did not answer.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('withdraws the agreement when the server hangs up while it is shown', async () => {
    let signal!: AbortSignal;
    const onAgreement = vi.fn((_text: string, s: AbortSignal) => {
      signal = s;
      return new Promise<boolean>(() => {});
    });
    const conn = connection(CREDS, { onAgreement });
    const started = conn.start().catch((e: Error) => e);
    await tick();
    await tick();
    const ws = FakeSocket.last!;
    ws.serve(enc.encode('TRTP\0\0\0\0'));
    ws.serve(frame(TASK, 1, [[0xa0, u16(190)]]), frame(0x6d, 0, [[0x65, 'Rules.']]));
    expect(signal.aborted).toBe(false);
    ws.close();
    await tick();
    expect(signal.aborted).toBe(true);
    expect(String(await started)).toContain('The connection closed.');
  });

  it('starts nothing when dropped while the module loads', async () => {
    const conn = connection(CREDS);
    const started = conn.start();
    conn.drop();
    await expect(started).rejects.toThrow('Disconnected.');
    expect(FakeSocket.last).toBeNull();
  });

  it('names a nameless login as GtkHx would', async () => {
    const conn = connection({ ...CREDS, nick: '  ' });
    void conn.start().catch(() => {});
    await tick();
    await tick();
    const ws = FakeSocket.last!;
    ws.serve(enc.encode('TRTP\0\0\0\0'));
    ws.take();
    ws.serve(frame(TASK, 1, [[0xa0, u16(190)]]), frame(0x6d, 0, [[0x9a, [1]]]));
    const agree = ws.take().find((t) => t.type === 121)!;
    expect(new TextDecoder().decode(agree.fields.get(0x66))).toBe('guest');
    conn.drop();
  });

  it('keeps private chats out of the public roster', async () => {
    const { conn, ws } = await online();
    const joined = vi.fn();
    conn.on('user_joined', joined);
    ws.serve(
      frame(0x75, 0, [
        [0x67, u16(5)],
        [0x66, 'bob'],
        [0x72, u32(7)],
      ]),
    );
    expect(joined).not.toHaveBeenCalled();
  });
});

describe('classicAddress', () => {
  it('reads hotline:// links and bare host:port as classic', () => {
    expect(classicAddress('hotline://hl.example.org')).toEqual({ host: 'hl.example.org', port: 5500 });
    expect(classicAddress('hotline://hl.example.org:6000/Files/a.txt')).toEqual({ host: 'hl.example.org', port: 6000 });
    expect(classicAddress('10.0.0.5:5510')).toEqual({ host: '10.0.0.5', port: 5510 });
    // IPv6 keeps its brackets, as a URL's host has them.
    expect(classicAddress('hotline://[::1]:5500')).toEqual({ host: '[::1]', port: 5500 });
    expect(classicAddress('wss://hl.example.org:5700/ng')).toBeNull();
    expect(classicAddress('ws://localhost:5700')).toBeNull();
  });

  it('keeps a port that is a web scheme default, and drops a login', () => {
    expect(classicAddress('hl.example:80')).toEqual({ host: 'hl.example', port: 80 });
    expect(classicAddress('hotline://hl.example:443')).toEqual({ host: 'hl.example', port: 443 });
    expect(classicAddress('hotline://me:pw@hl.example:5600/')).toEqual({ host: 'hl.example', port: 5600 });
    expect(classicAddress('hotline://[2001:db8::1]')).toEqual({ host: '[2001:db8::1]', port: 5500 });
    expect(classicAddress('hl.example:70000')).toBeNull();
    expect(classicAddress('hl.example:0')).toBeNull();
  });
});

describe('candidates', () => {
  const bases = (host: string, port: number) => candidates({ host, port }).map((c) => c.base);

  it('never names the classic port or its transfer port', () => {
    for (const port of [80, 81, 442, 443, 5500, 65400]) {
      for (const base of bases('hl.example', port)) {
        const u = new URL(base);
        const p = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
        expect(p).not.toBe(port);
        expect(p).not.toBe(port + 1);
      }
    }
    // Nothing beside a port with no room above it.
    expect(bases('hl.example', 65400)).toEqual(['https://hl.example']);
    expect(bases('hl.example', 443)).toEqual(['https://hl.example:643']);
  });

  it('marks the web port as one that may front another server', () => {
    expect(candidates({ host: 'hl.example', port: 5500 })).toEqual([
      { base: 'https://hl.example:5700', shared: false },
      { base: 'https://hl.example', shared: true },
    ]);
  });
});

describe('route', () => {
  /** A fetch that answers discovery for the hosts given and hangs for the
   *  rest, as a firewall that drops rather than refuses does. */
  function serving(docs: Record<string, object>): void {
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => {
      const origin = new URL(url).origin;
      const doc = docs[origin];
      if (doc) return Promise.resolve(new Response(JSON.stringify(doc)));
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timed out'))));
    });
  }

  it('takes the relay at the classic port plus 200 without waiting on the rest', async () => {
    serving({ 'https://hl.example:5700': { v: 1, name: 'Example', ng: { trtp: '/trtp' } } });
    const t0 = Date.now();
    expect(await route('hotline://hl.example:5500')).toEqual({
      wire: 'classic',
      url: 'wss://hl.example:5700/trtp',
      name: 'Example',
      shared: false,
    });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('follows no relay socket away from its document, and no redirect', async () => {
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      inits.push(init);
      const doc = { ng: { trtp: 'wss://hl.example:5500/trtp' } };
      return new URL(url).origin === 'https://hl.example:5700'
        ? Promise.resolve(new Response(JSON.stringify(doc)))
        : Promise.reject(new Error('refused'));
    });
    await expect(route('hotline://hl.example:5500')).rejects.toThrow('no relay');
    expect(inits.every((i) => i?.redirect === 'error')).toBe(true);
  });

  it('names a socket elsewhere only off the classic port, and keeps where it was found', async () => {
    // Every other origin refuses at once.
    const only = (docs: Record<string, object>) =>
      vi.stubGlobal('fetch', (url: string) => {
        const doc = docs[new URL(url).origin];
        return doc ? Promise.resolve(new Response(JSON.stringify(doc))) : Promise.reject(new Error('refused'));
      });
    only({ 'https://hl.example:5700': { v: 1, ng: { trtp: 'wss://relay.example/trtp' } } });
    expect(await route('hotline://hl.example:5500')).toMatchObject({ wire: 'classic', url: 'wss://relay.example/trtp' });
    // An ng server on the host's web port may be another server.
    only({ 'https://hl.example': { ng: { ws: '/ng' } } });
    expect(await route('hotline://hl.example:5500')).toEqual({
      wire: 'ng',
      url: 'wss://hl.example/ng',
      name: '',
      shared: true,
    });
    // A socket beside the classic port is an HTTP request Janus bans for.
    only({ 'https://hl.example:5700': { ng: { ws: 'wss://hl.example:5501/ng' } } });
    await expect(route('hotline://hl.example:5500')).rejects.toThrow('no relay');
  });

  it('hears the next candidate past a document naming a socket no URL can be', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      const origin = new URL(url).origin;
      const doc =
        origin === 'https://hl.example:5700' ? { ng: { trtp: 'http://[' } } : { ng: { trtp: '/trtp' } };
      return Promise.resolve(new Response(JSON.stringify(doc)));
    });
    expect(await route('hotline://hl.example:5500')).toMatchObject({ url: 'wss://hl.example/trtp', shared: true });
  });

  it('reads past a document that is not one', async () => {
    // Literal null beside the server, and a name that is no string on
    // the web port.
    vi.stubGlobal(
      'fetch',
      (url: string) =>
        new URL(url).origin === 'https://hl.example:5700'
          ? Promise.resolve(new Response('null'))
          : Promise.resolve(new Response(JSON.stringify({ name: 7, ng: { trtp: '/trtp' } }))),
    );
    expect(await route('hotline://hl.example:5500')).toEqual({
      wire: 'classic',
      url: 'wss://hl.example/trtp',
      name: '',
      shared: true,
    });
  });

  it('never sends HTTP to the classic port itself', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      asked.push(new URL(url).origin);
      return Promise.reject(new Error('refused'));
    });
    await expect(route('hotline://hl.example:5500')).rejects.toThrow('no relay');
    // A Hotline server takes an HTTP request on its port for a hostile
    // client, and Janus bans the address for a day.
    expect(asked).not.toContain('https://hl.example:5500');
    expect(asked).not.toContain('http://hl.example:5500');
  });
});
