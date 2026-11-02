import { describe, expect, it, vi } from 'vitest';

import { Connection, WireFailure, type ConnectionHooks, type SocketLike } from '../src/connection';
import { newGuid, type Events, type HistoryOk } from '../src/protocol';
import { FakeServer } from '../src/testing';

const ACCOUNTS = [
  { login: 'alice', password: 'pw', nick: 'Alice' },
  { login: 'bob', password: 'pw', nick: 'Bob' },
];

async function waitFor(what: string, ok: () => boolean): Promise<void> {
  for (const end = Date.now() + 5000; !ok(); await new Promise((r) => setTimeout(r, 5))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

async function connect(server: FakeServer, login: string, hooks: ConnectionHooks = {}): Promise<Connection> {
  const conn = new Connection(server.credentials({ login, password: 'pw' }), hooks);
  await conn.start();
  return conn;
}

/** A resume on a socket of the test's own, for the cases `Connection`
 *  never makes: a stale `last_seq`. */
async function rawResume(server: FakeServer, conn: Connection, lastSeq: number): Promise<{ error?: { code: string } }> {
  const sock: SocketLike = server.webSocket(server.url);
  const frames: { reply?: number; error?: { code: string } }[] = [];
  sock.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  await new Promise((resolve) => (sock.onopen = resolve));
  sock.send(JSON.stringify({ id: 1, req: 'resume', params: { session: conn.session, token: conn.token, last_seq: lastSeq } }));
  await waitFor('the reply', () => frames.some((f) => f.reply === 1));
  return frames.find((f) => f.reply === 1)!;
}

function heard<K extends keyof Events>(conn: Connection, ev: K): Events[K][] {
  const got: Events[K][] = [];
  conn.on(ev, (d) => got.push(d));
  return got;
}

describe('the fake server', () => {
  it('logs in with a password, and refuses a wrong one', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS, subject: 'welcome' });
    const bot = server.addUser({ nick: 'Bot' });
    const conn = await connect(server, 'alice');
    expect(conn.self).toMatchObject({ nick: 'Alice', status: 'active' });
    expect(conn.grace).toBe(300);
    expect(conn.login?.server.subject).toBe('welcome');
    expect(conn.login?.users.map((u) => u.uid)).toEqual([bot, conn.self!.uid]);

    const wrong = new Connection(server.credentials({ login: 'alice', password: 'no' }));
    await expect(wrong.start()).rejects.toMatchObject({ wire: { code: 'login_failed' } });
  });

  it('logs a guest in that may not detach, and an identity token as its linked account and no other', async () => {
    const server = new FakeServer({ accounts: [...ACCOUNTS, { login: 'carol', password: '', identity: true }] });
    const guest = new Connection(server.credentials());
    await guest.start();
    expect([guest.self?.nick, guest.grace]).toEqual(['guest', null]);

    const proved = new Connection(
      server.credentials({ identity: { getToken: async () => server.identityToken('carol') } }),
    );
    await proved.start();
    expect(proved.self?.identity).toMatchObject({ outcome: 'linked', account: 'carol' });
    expect(server.requests.at(-1)?.params).not.toHaveProperty('login');
    expect(await proved.inbox()).toMatchObject({ total: 0 });
    expect(() => server.identityToken('bob')).toThrow(/not linked/);

    // Its only credential is the identity, and an empty password is not one.
    const byPassword = new Connection(server.credentials({ login: 'carol', password: '' }));
    await expect(byPassword.start()).rejects.toMatchObject({ wire: { code: 'login_failed' } });
  });

  it('tells the roster who joins and parts', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const alice = await connect(server, 'alice');
    const joined = heard(alice, 'user_joined');
    const parted = heard(alice, 'user_parted');
    const uid = server.addUser({ nick: 'Bot' });
    const bob = await connect(server, 'bob');
    server.removeUser(uid);
    await waitFor('the part', () => parted.length === 1);
    expect(joined.map((d) => d.user.nick)).toEqual(['Bot', 'Bob']);
    expect(parted).toEqual([{ uid }]);
    expect(bob.login?.users.map((u) => u.nick)).toEqual(['Alice', 'Bot', 'Bob']);
  });

  it('relays a lobby line with its id, keeps it, and answers a repeated guid as the original', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const alice = await connect(server, 'alice');
    const bob = await connect(server, 'bob');
    const lines = heard(bob, 'chat');
    const own = heard(alice, 'chat');
    const guid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const { id } = await alice.chat({ text: 'hello', guid });
    expect(await alice.chat({ text: 'hello again', guid })).toEqual({ id });
    await waitFor('the line', () => lines.length === 1);
    expect(lines[0]).toMatchObject({ id, text: 'hello', from: { nick: 'Alice' } });
    expect(lines[0]).not.toHaveProperty('guid');
    expect(own[0]).toMatchObject({ id, guid });
    expect((await bob.history()).lines.map((l) => l.text)).toEqual(['hello']);
  });

  it('pages history both ways', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const bot = server.addUser({ nick: 'Bot' });
    const ids = ['a', 'b', 'c', 'd', 'e'].map((t) => server.say(bot, t));
    const alice = await connect(server, 'alice');
    const page = (p: HistoryOk) => [p.lines.map((l) => l.text).join(''), p.has_more];
    expect(page(await alice.history({ limit: 2 }))).toEqual(['de', true]);
    expect(page(await alice.history({ before: ids[3], limit: 2 }))).toEqual(['bc', true]);
    expect(page(await alice.history({ after: ids[2], limit: 2 }))).toEqual(['de', false]);
    await expect(alice.history({ limit: 0 })).rejects.toMatchObject({ wire: { code: 'bad_request' } });
  });

  it('joins a room, carries a line in it to its members alone, and tells them of joins and topics', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS, rooms: [{ name: 'lounge' }] });
    const alice = await connect(server, 'alice');
    const bob = await connect(server, 'bob');
    const lounge = alice.login!.rooms!.list[0]!.id;
    const bobLines = heard(bob, 'chat');
    const members = heard(alice, 'room_member_joined');
    const subjects = heard(alice, 'subject');
    const changed = heard(bob, 'room_changed');

    await expect(alice.chat({ text: 'x', room: lounge })).rejects.toMatchObject({ wire: { code: 'not_a_member' } });
    expect(await alice.roomJoin(lounge)).toMatchObject({ members: [alice.self!.uid], may_post: true });
    await bob.rooms();
    await bob.roomJoin(lounge);
    const { id } = await alice.chat({ text: 'in here', room: lounge });
    await bob.roomPart(lounge);
    await alice.roomTopic(lounge, 'quiet');
    await alice.chat({ text: 'alone now', room: lounge });
    await expect(alice.roomJoin(9999)).rejects.toMatchObject({ wire: { code: 'no_such_room' } });

    await waitFor('the topic', () => subjects.length === 1 && changed.length === 1);
    expect(members.map((d) => d.user.nick)).toEqual(['Bob']);
    expect(bobLines).toMatchObject([{ id, text: 'in here', room: lounge }]);
    expect(subjects).toEqual([{ subject: 'quiet', room: lounge }]);
    expect(changed[0]?.room).toMatchObject({ id: lounge, topic: 'quiet' });
    expect((await alice.history({ room: lounge })).lines.map((l) => l.text)).toEqual(['in here', 'alone now']);
    expect(alice.roomHistoryIds.get(lounge)).toBeGreaterThan(id!);
  });

  it('queues a message for an absent account and delivers it after the next login', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const alice = await connect(server, 'alice');
    const sent = await alice.msg({ to_login: 'bob', text: 'later' });
    expect(sent).toEqual({ queued: true, ref: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });

    const bob = new Connection(server.credentials({ login: 'bob', password: 'pw' }));
    const mail = heard(bob, 'msg');
    await bob.start();
    await waitFor('the mail', () => mail.length === 1);
    expect(mail[0]).toMatchObject({ text: 'later', queued: true, id: 1, ref: sent.ref, from: { uid: alice.self!.uid, login: 'alice' } });
    const box = await bob.inbox();
    expect(box).toMatchObject({ unread: 1, total: 1, messages: [{ id: 1, ref: sent.ref, text: 'later', read: false }] });
    expect(await bob.msgRead(box.messages[0]!.id)).toEqual({ unread: 0, total: 1 });

    // Stored though delivered at once, so it has a reference too.
    const now = await bob.msg({ to: alice.self!.uid, text: 'now' });
    expect(now).toEqual({ queued: false, ref: expect.any(String) });
    expect(now.ref).not.toBe(sent.ref);
    const bot = server.addUser({ nick: 'Bot' });
    expect(server.message(bot, { to: bob.self!.uid, text: 'beep' })).toEqual({ queued: false });
    await waitFor('the bot', () => mail.length === 2);
    expect(mail[1]).toMatchObject({ text: 'beep', from: { uid: bot, nick: 'Bot' } });
    await expect(bob.msg({ to_login: 'nobody', text: '?' })).rejects.toMatchObject({ wire: { code: 'no_such_user' } });
  });

  it('stores no plain guest\'s mail, an identity\'s with a reference, and gives an account without a password no inbox', async () => {
    const server = new FakeServer({ accounts: [...ACCOUNTS, { login: 'kiosk', password: '' }] });
    const guest = new Connection(server.credentials());
    await guest.start();
    await expect(guest.msg({ to_login: 'bob', text: 'hi' })).rejects.toMatchObject({ wire: { code: 'no_such_user' } });

    const alice = await connect(server, 'alice');
    const mail = heard(alice, 'msg');
    server.drop(alice.self!.uid);
    await waitFor('the detach', () => alice.state === 'reconnecting');
    // Through the outbox, so it arrives on resume, and is never stored.
    expect(await guest.msg({ to: alice.self!.uid, text: 'psst' })).toEqual({ queued: false });
    await waitFor('the replay', () => mail.length === 1);
    expect(mail[0]).toMatchObject({ text: 'psst', queued: false });
    expect(mail[0]).not.toHaveProperty('id');
    expect(mail[0]).not.toHaveProperty('ref');
    expect(await alice.inbox()).toMatchObject({ total: 0 });

    const kiosk = new Connection(server.credentials({ login: 'kiosk', password: '' }));
    await kiosk.start();
    expect(kiosk.grace).toBeNull();
    await expect(kiosk.inbox()).rejects.toMatchObject({ wire: { code: 'no_inbox' } });
    await kiosk.logout();
    await expect(alice.msg({ to_login: 'kiosk', text: 'hi' })).rejects.toMatchObject({ wire: { code: 'no_such_user' } });

    const proved = new Connection(server.credentials({ identity: { getToken: async () => server.identityToken() } }));
    await proved.start();
    expect(await proved.msg({ to_login: 'bob', text: 'from a key' })).toEqual({ queued: true, ref: expect.any(String) });
    const bob = new Connection(server.credentials({ login: 'bob', password: 'pw' }));
    const bobMail = heard(bob, 'msg');
    await bob.start();
    await waitFor('the queued mail', () => bobMail.length === 1);
    expect(bobMail[0]).toMatchObject({ text: 'from a key', queued: true });
    expect(bobMail[0]?.from).not.toHaveProperty('login');
    expect((await bob.inbox()).messages[0]?.from).toEqual({ nick: 'guest' });
  });

  it('numbers each mailbox by itself and refuses a cursor it never issued', async () => {
    const server = new FakeServer({ accounts: [...ACCOUNTS, { login: 'carol', password: 'pw' }] });
    const alice = await connect(server, 'alice');
    const bob = await connect(server, 'bob');
    const carol = await connect(server, 'carol');
    const bobMail = heard(bob, 'msg');
    const carolMail = heard(carol, 'msg');
    await alice.msg({ to_login: 'bob', text: 'one' });
    await alice.msg({ to_login: 'carol', text: 'two' });
    await alice.msg({ to_login: 'bob', text: 'three' });
    await waitFor('the mail', () => bobMail.length === 2 && carolMail.length === 1);
    expect(bobMail.map((m) => m.id)).toEqual([1, 2]);
    expect(carolMail.map((m) => m.id)).toEqual([1]);
    expect((await carol.inbox()).messages.map((m) => m.text)).toEqual(['two']);

    const refused = [
      () => carol.msgRead(2),
      () => carol.inbox({ before: 2 }),
      () => carol.request('msg_read', {}),
      () => carol.request('msg_read', { up_to: 0.5 }),
      () => carol.request('msg_read', { up_to: -1 }),
      () => carol.inbox({ before: -1 }),
      () => carol.request('inbox', { before: false }),
      () => carol.request('inbox', { before: '' }),
    ];
    for (const ask of refused) await expect(ask()).rejects.toMatchObject({ wire: { code: 'bad_request' } });
    expect(await carol.inbox({ before: 1 })).toMatchObject({ messages: [], unread: 1 });
    // As hxd-ng's optional u64 reads them: 0 is below every cursor, null is none.
    expect(await carol.inbox({ before: 0 })).toMatchObject({ messages: [] });
    expect(await carol.request('inbox', { before: null })).toMatchObject({ messages: [{ text: 'two' }] });
    expect(server.mail('bob').map((m) => [m.id, m.text])).toEqual([[1, 'one'], [2, 'three']]);
  });

  it('takes a retried message under its guid as the one it repeats, waiting or delivered', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const alice = await connect(server, 'alice');
    const waiting = { to_login: 'bob', text: 'once', guid: '0F8FAD5B-D9CB-469F-A165-70867728950E' };
    const first = await alice.msg(waiting);
    // Either case and without hyphens, the same guid.
    expect(await alice.msg({ ...waiting, guid: '0f8fad5bd9cb469fa16570867728950e' })).toEqual(first);
    expect(first).toMatchObject({ queued: true, ref: expect.any(String) });

    const bob = new Connection(server.credentials({ login: 'bob', password: 'pw' }));
    const mail = heard(bob, 'msg');
    await bob.start();
    // Now it is delivered, and a retry says so.
    expect(await alice.msg(waiting)).toEqual({ queued: false, ref: first.ref });
    const live = { to_login: 'bob', text: 'live', guid: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' };
    await alice.msg(live);
    await alice.msg(live);
    await waitFor('the mail', () => mail.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(mail.map((m) => m.text)).toEqual(['once', 'live']);
    expect((await bob.inbox()).total).toBe(2);
    await expect(alice.msg({ to: bob.self!.uid, text: 'x', guid: 'nope' })).rejects.toMatchObject({ wire: { code: 'bad_request' } });
    await expect(alice.chat({ text: 'x', guid: 'nope' })).rejects.toMatchObject({ wire: { code: 'bad_request' } });
  });

  it('records who sent each request, and lets a test answer some itself, in order', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS, rooms: [{ name: 'lounge' }] });
    const alice = await connect(server, 'alice');
    const lounge = alice.login!.rooms!.list[0]!.id;
    await alice.roomJoin(lounge);
    server.handle('chat', (p) => (p.room === lounge ? { error: { code: 'read_only', text: 'Read only.' } } : undefined));
    server.handle('ping', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: {} };
    });

    const order: string[] = [];
    await Promise.all([
      alice.request('ping').then(() => order.push('ping')),
      alice.chat({ text: 'lobby' }).then(() => order.push('chat')),
    ]);
    expect(order).toEqual(['ping', 'chat']);
    await expect(alice.chat({ text: 'room', room: lounge })).rejects.toMatchObject({ wire: { code: 'read_only' } });
    expect(server.requests.find((f) => f.req === 'chat')?.from).toEqual({ uid: alice.self!.uid, login: 'alice' });
    expect(server.requests.find((f) => f.req === 'login')?.from).toBeNull();
    expect(server.uidOf('alice')).toBe(alice.self!.uid);
  });

  it('plays a user with a login and an identity, whose mail says who it is from', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const fingerprint = 'F'.repeat(52);
    const bot = server.addUser({ nick: 'Bot', login: 'bot', fingerprint });
    const alice = await connect(server, 'alice');
    const mail = heard(alice, 'msg');
    expect(alice.login?.users.find((u) => u.uid === bot)?.identity).toEqual({ fingerprint, handle: null });
    server.message(bot, { to: alice.self!.uid, text: 'beep' });
    await waitFor('the mail', () => mail.length === 1);
    expect(mail[0]?.from).toMatchObject({ uid: bot, login: 'bot' });
    expect(server.uidOf('bot')).toBe(bot);
    expect(await alice.msg({ to_login: 'bot', text: 'ack' })).toEqual({ queued: false, ref: expect.any(String) });
  });

  it('serves only the families its caps say', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS, caps: ['rooms'] });
    const alice = await connect(server, 'alice');
    expect(alice.caps).toEqual(['rooms']);
    expect([alice.login?.inbox, alice.login?.history]).toEqual([undefined, undefined]);
    expect(await alice.chat({ text: 'gone', guid: 'not a guid, and not read' })).toEqual({});
    await expect(alice.inbox()).rejects.toMatchObject({ wire: { code: 'no_inbox' } });
    await expect(alice.history()).rejects.toMatchObject({ wire: { code: 'not_available' } });
    await expect(alice.msg({ to_login: 'bob', text: 'later' })).rejects.toMatchObject({ wire: { code: 'no_such_user' } });

    const defaults = await connect(new FakeServer({ accounts: ACCOUNTS }), 'alice');
    expect(defaults.caps).toContain('identity');
  });

  it('kicks a session, which ends it on the client, and ends one it removes the same way', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const ended: string[] = [];
    const alice = await connect(server, 'alice', { onEnded: (why) => ended.push(why) });
    const bob = await connect(server, 'bob', { onEnded: (why) => ended.push(why) });
    const parted = heard(bob, 'user_parted');
    server.kick(alice.self!.uid);
    await waitFor('the kick', () => ended.length === 1 && parted.length === 1);
    expect([alice.state, ended[0]]).toEqual(['offline', 'You were disconnected by an administrator.']);
    expect(parted).toEqual([{ uid: alice.self!.uid }]);

    server.removeUser(bob.self!.uid);
    await waitFor('the removal', () => ended.length === 2);
    expect(bob.state).toBe('offline');
    expect(() => server.uidOf('bob')).toThrow();
  });

  it('shows a test what it kept, and takes accounts added later', async () => {
    const server = new FakeServer({ rooms: [{ name: 'lounge' }] });
    server.addAccount({ login: 'alice', password: 'pw' });
    server.addAccount({ login: 'bob', password: 'pw' });
    const alice = await connect(server, 'alice');
    const lounge = alice.login!.rooms!.list[0]!.id;
    await alice.roomJoin(lounge);
    await alice.chat({ text: 'lobby' });
    await alice.chat({ text: 'room', room: lounge });
    await alice.msg({ to_login: 'bob', text: 'later' });
    expect(server.lines().map((l) => l.text)).toEqual(['lobby']);
    expect(server.lines(lounge).map((l) => l.text)).toEqual(['room']);
    const kept = server.mail('bob');
    expect(kept).toMatchObject([{ text: 'later', read: false, from: { login: 'alice' } }]);
    kept[0]!.read = true;
    expect(server.mail('bob')[0]?.read).toBe(false);
  });

  it('refuses the next request as told, then serves again', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const alice = await connect(server, 'alice');
    server.refuseNext('chat', 'rate_limited', { retry_after: 3 });
    const refused = await alice.chat({ text: 'too soon' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WireFailure);
    expect((refused as WireFailure).wire).toMatchObject({ code: 'rate_limited', retry_after: 3 });
    expect(await alice.chat({ text: 'now' })).toHaveProperty('id');
  });

  it('detaches a dropped session and replays what it missed on resume', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const bot = server.addUser({ nick: 'Bot' });
    const replays: number[] = [];
    const alice = await connect(server, 'alice', { onResumed: (n) => replays.push(n) });
    const watcher = await connect(server, 'bob');
    const statuses = heard(watcher, 'user_changed');
    const lines = heard(alice, 'chat');
    const uid = alice.self!.uid;

    server.drop(uid);
    await waitFor('the detach', () => statuses.length === 1);
    server.say(bot, 'while you were out');
    server.event(uid, 'notice', { text: 'and this' });
    await waitFor('the resume', () => replays.length === 1 && alice.state === 'online');

    expect(alice.self?.uid).toBe(uid);
    expect(replays).toEqual([2]);
    await waitFor('the replay', () => lines.length === 1);
    expect(lines[0]?.text).toBe('while you were out');
    await waitFor('the return', () => statuses.length === 2);
    expect(statuses.map((d) => d.user.status)).toEqual(['detached', 'active']);
  });

  it('answers a takeover resync_required only when the old connection was sent what the new one lacks', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const ended: string[] = [];
    const alice = await connect(server, 'alice', { onEnded: (why) => ended.push(why) });
    const bob = await connect(server, 'bob');
    server.event(alice.self!.uid, 'notice', { text: 'seen' });
    await waitFor('the notice', () => alice.seq === 2);

    expect((await rawResume(server, alice, 1)).error?.code).toBe('resync_required');
    expect((await rawResume(server, bob, bob.seq)).error).toBeUndefined();
    await waitFor('the takeover', () => ended.length === 1);
    expect(ended[0]).toMatch(/taken over/);
  });

  it('answers a detached session resync_required for what it was sent before its detach', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const alice = await connect(server, 'alice');
    const uid = alice.self!.uid;
    server.event(uid, 'notice', { text: 'seen' });
    await waitFor('the notice', () => alice.seq === 1);
    server.drop(uid);
    await waitFor('the detach', () => alice.state === 'reconnecting');
    server.event(uid, 'notice', { text: 'held' });
    expect((await rawResume(server, alice, 0)).error?.code).toBe('resync_required');
  });

  it('keeps connections apart where sessionStorage saves them, and resumes one reused', async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    });
    try {
      const server = new FakeServer({ accounts: ACCOUNTS });
      const alice = await connect(server, 'alice');
      const creds = server.credentials({ login: 'bob', password: 'pw' });
      const bob = new Connection(creds);
      await bob.start();
      expect([alice.self?.nick, bob.self?.nick]).toEqual(['Alice', 'Bob']);
      const reload = new Connection(creds);
      await reload.start();
      expect(reload.self?.uid).toBe(bob.self!.uid);
      expect(server.requests.filter((f) => f.req === 'resume')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ends a detached session whose grace lapsed, so the next connection logs in afresh', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const alice = await connect(server, 'alice');
    const uid = alice.self!.uid;
    alice.drop();
    await waitFor('the detach', () => alice.state === 'reconnecting');
    server.expire(uid);
    await waitFor('the login', () => alice.state === 'online' && alice.self?.uid !== uid);
    expect(server.requests.map((f) => f.req).slice(-2)).toEqual(['resume', 'login']);
  });

  it('tells a login the rooms the session it replaces was in, in place and after a reload', async () => {
    const saved = new Map<string, string>();
    const store = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
    const server = new FakeServer({ accounts: ACCOUNTS, rooms: [{ name: 'lounge' }] });
    const creds = server.credentials({ login: 'alice', password: 'pw', sessionStore: store });
    const inPlace: number[][] = [];
    const reloaded: number[][] = [];
    const alice = new Connection(creds, { onLogin: (_, was) => inPlace.push(was.rooms) });
    await alice.start();
    const lounge = alice.login!.rooms!.list[0]!.id;
    await alice.roomJoin(lounge);
    const uid = alice.self!.uid;
    const copy = new Map(saved);
    const page = { getItem: (k: string) => copy.get(k) ?? null, setItem: (k: string, v: string) => void copy.set(k, v), removeItem: (k: string) => void copy.delete(k) };

    alice.drop();
    await waitFor('the detach', () => alice.state === 'reconnecting');
    server.expire(uid);
    await waitFor('the login', () => alice.state === 'online' && alice.self?.uid !== uid);
    const reload = new Connection({ ...creds, sessionStore: page }, { onLogin: (_, was) => reloaded.push(was.rooms) });
    await reload.start();

    expect(inPlace).toEqual([[], [lounge]]);
    expect(reloaded).toEqual([[lounge]]);
    expect(server.requests.filter((f) => f.req === 'resume').length).toBeGreaterThanOrEqual(2);
  });

  it('answers a resume after an overflow resync_required, and the catch-up pages each joined room', async () => {
    const server = new FakeServer({
      accounts: ACCOUNTS,
      rooms: [{ name: 'attic', position: 1 }, { name: 'lounge' }, { name: 'den' }],
    });
    const bot = server.addUser({ nick: 'Bot' });
    const recovered: [number, string][] = [];
    const alice = await connect(server, 'alice', {
      onMissedHistory: (page, room) => recovered.push(...page.lines.map((l): [number, string] => [room, l.text])),
    });
    const list = alice.login!.rooms!.list;
    expect(list.map((r) => r.name)).toEqual(['den', 'lounge', 'attic']);
    const [den, lounge] = list.map((r) => r.id);
    await alice.roomJoin(lounge!);
    await alice.roomJoin(den!);
    server.joinRoom(bot, lounge!);
    server.say(bot, 'seen');
    server.say(bot, 'seen here', { room: lounge });
    await waitFor('the lines', () => alice.lastHistoryId > 0 && (alice.roomHistoryIds.get(lounge!) ?? 0) > 0);

    server.overflow(alice.self!.uid);
    server.say(bot, 'lost');
    server.say(bot, 'lost here', { room: lounge });
    await waitFor('the catch-up', () => recovered.length === 2);

    expect(alice.state).toBe('online');
    expect(server.requests.filter((f) => f.req === 'sync')).toHaveLength(1);
    expect(recovered).toEqual([
      [0, 'lost'],
      [lounge, 'lost here'],
    ]);
  });
});

describe('replies on the fake server', () => {
  async function asking(server: FakeServer, login: string, heard?: Events['msg'][]): Promise<Connection> {
    const conn = new Connection(server.credentials({ login, password: 'pw', replies: true }));
    if (heard) conn.on('msg', (d) => heard.push(d));
    await conn.start();
    return conn;
  }
  const REF = 'AAAAAAAAAAAAAAAAAAAAAA';

  it('grants replies to a login that asks, with the targets it keeps, and keeps them across a reload', async () => {
    const saved = new Map<string, string>();
    const store = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
    const server = new FakeServer({ accounts: ACCOUNTS });
    const creds = server.credentials({ login: 'alice', password: 'pw', replies: true, sessionStore: store });
    const alice = new Connection(creds);
    await alice.start();
    expect(alice.hasCap('replies')).toBe(true);
    expect(alice.replies).toEqual({ targets: ['line', 'pm'] });
    const reload = new Connection(creds);
    await reload.start({ resumeOnly: true });
    expect(reload.replies).toEqual({ targets: ['line', 'pm'] });

    const bob = await connect(server, 'bob');
    expect([bob.hasCap('replies'), bob.replies, bob.login?.replies]).toEqual([false, null, undefined]);
    for (const [caps, targets] of [
      [['inbox', 'replies'], ['pm']],
      [['history', 'replies'], ['line']],
    ] as const) {
      const conn = await asking(new FakeServer({ accounts: ACCOUNTS, caps: [...caps] }), 'alice');
      expect(conn.replies?.targets).toEqual(targets);
    }
    for (const caps of [['replies'], ['history', 'inbox']]) {
      const conn = await asking(new FakeServer({ accounts: ACCOUNTS, caps }), 'alice');
      expect([conn.hasCap('replies'), conn.replies]).toEqual([false, null]);
    }
  });

  it('carries a line\'s re as sent to the sessions that asked, live and in history, and ignores one from a session that did not', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const alice = await asking(server, 'alice');
    const bob = await connect(server, 'bob');
    const aliceHeard = heard(alice, 'chat');
    const bobHeard = heard(bob, 'chat');
    const { id: asked } = await alice.chat({ text: 'lunch?' });
    const re = { line: asked! };
    await alice.chat({ text: 'me?', re });
    // Never refused for pointing at nothing.
    await alice.chat({ text: 'dangling', re: { line: asked! + 1000, room: 0 } });
    await bob.chat({ text: 'unasked', re });
    await waitFor('the lines', () => aliceHeard.length === 4 && bobHeard.length === 4);
    expect(aliceHeard.map((d) => d.re)).toEqual([undefined, re, { line: asked! + 1000 }, undefined]);
    expect(bobHeard.every((d) => d.re === undefined)).toBe(true);
    expect((await alice.history()).lines.map((l) => l.re)).toEqual([undefined, re, { line: asked! + 1000 }, undefined]);
    expect((await bob.history()).lines.every((l) => l.re === undefined)).toBe(true);
  });

  it('refuses a target across rooms or of the wrong kind, a malformed one, one not kept, and one beside a signature, before membership', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS, rooms: [{ name: 'lounge' }] });
    const alice = await asking(server, 'alice');
    const bob = await asking(server, 'bob');
    const room = alice.login!.rooms!.list[0]!.id;
    await alice.roomJoin(room);
    const { id: lobby } = await alice.chat({ text: 'in the lobby' });
    const { ref } = await alice.msg({ to: bob.self!.uid, text: 'psst' });
    for (const [what, send] of [
      ['a lobby line from a room', () => alice.chat({ text: 'x', room, re: { line: lobby! } })],
      ["a room's line from the lobby", () => alice.chat({ text: 'x', re: { line: lobby!, room } })],
      ['a message from public chat', () => alice.chat({ text: 'x', re: { pm: ref! } })],
      ['a line from a message', () => alice.msg({ to: bob.self!.uid, text: 'x', re: { line: lobby! } })],
      ['an instant message, which it does not keep', () => alice.msg({ to: bob.self!.uid, text: 'x', re: { im: { login: 'bob', guid: newGuid() } } })],
      ['a malformed target', () => alice.chat({ text: 'x', re: { line: 'one' } as never })],
      ['a reference that is no reference', () => alice.msg({ to: bob.self!.uid, text: 'x', re: { pm: 'short' } })],
      ['a signed line', () => alice.chat({ text: 'x', guid: newGuid(), signed: 'AAAA', re: { line: lobby! } })],
      ['a malformed target, to a room not joined', () => bob.chat({ text: 'x', room, re: { line: -1 } })],
    ] as const) {
      await expect(send(), what).rejects.toMatchObject({ wire: { code: 'bad_request' } });
    }
    // Any reference at all, which the server does not look up.
    await expect(alice.msg({ to: bob.self!.uid, text: 'ok', re: { pm: REF } })).resolves.toMatchObject({ queued: false });
    await expect(alice.chat({ text: 'ok', room, re: { line: 1, room } })).resolves.toMatchObject({ id: expect.any(Number) });
  });

  it('carries a message\'s re live, held for an absent recipient, and on its inbox row', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const alice = await asking(server, 'alice');
    const bob = await asking(server, 'bob');
    const got = heard(bob, 'msg');
    const re = { pm: REF };
    await alice.msg({ to: bob.self!.uid, text: 'live', re });
    await waitFor('the message', () => got.length === 1);
    expect(got[0]?.re).toEqual(re);
    await bob.logout();
    await alice.msg({ to_login: 'bob', text: 'held', re });
    const flushed: Events['msg'][] = [];
    const later = await asking(server, 'bob', flushed);
    await waitFor('the flush', () => flushed.length === 1);
    expect(flushed[0]).toMatchObject({ text: 'held', queued: true, re });
    expect((await later.inbox()).messages.map((m) => [m.text, m.re])).toEqual([
      ['held', re],
      ['live', re],
    ]);
    expect((await connect(server, 'bob').then((c) => c.inbox())).messages.every((m) => m.re === undefined)).toBe(true);
  });

  it('answers history ids ascending, leaving out a missing line and another room\'s, and the highest past what one reply holds', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS, rooms: [{ name: 'lounge' }] });
    const alice = await asking(server, 'alice');
    const room = alice.login!.rooms!.list[0]!.id;
    await alice.roomJoin(room);
    const { id: hidden } = await alice.chat({ text: 'in the room', room });
    const { id: first } = await alice.chat({ text: 'one' });
    const { id: second } = await alice.chat({ text: 'two' });
    const got = await alice.history({ ids: [second!, hidden!, first!, second! + 1000] });
    expect([got.lines.map((l) => l.id), got.has_more]).toEqual([[first, second], false]);
    expect((await alice.history({ room, ids: [hidden!, first!] })).lines.map((l) => l.id)).toEqual([hidden]);
    for (const params of [{ ids: [] }, { ids: [-1] }, { ids: Array.from({ length: 51 }, (_, i) => i + 1) }, { ids: [first!], before: second! }]) {
      await expect(alice.history(params), JSON.stringify(params)).rejects.toMatchObject({ wire: { code: 'bad_request' } });
    }
    expect((await alice.history({ ids: null as never })).lines.length).toBeGreaterThan(1);
    // Any other session is served a page, as an unknown param is ignored.
    const bob = await connect(server, 'bob');
    expect((await bob.history({ ids: [first!] })).lines.map((l) => l.id)).toEqual([first, second]);

    const said: number[] = [];
    for (let i = 0; i < 24; i++) said.push((await alice.chat({ text: 'x'.repeat(4000) })).id!);
    const part = await alice.history({ ids: said });
    const shown = part.lines.map((l) => l.id);
    expect(part.has_more).toBe(true);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).toEqual(said.slice(0, shown.length));
    const rest = await alice.history({ ids: said.slice(shown.length) });
    expect([rest.lines.length, rest.has_more]).toEqual([said.length - shown.length, false]);
  });

  it('moves no catch-up cursor for lines asked for by id', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const alice = await asking(server, 'alice');
    await alice.chat({ text: 'seen' });
    await waitFor('the line', () => alice.lastHistoryId > 0);
    const seen = alice.lastHistoryId;
    // A line this session was never sent, past the ones it was: as a
    // quote names one said while it was away.
    server.handle('history', (p) => (p.ids ? { ok: { lines: [{ ...server.lines()[0]!, id: seen + 5 }], has_more: false } } : undefined));
    await alice.history({ ids: [seen + 5] });
    expect(alice.lastHistoryId).toBe(seen);
  });
});

describe('reactions on the fake server', () => {
  const UP = { emoji: '\u{1F44D}' };
  const HEART = { emoji: '\u2764\u{FE0F}' };
  async function asking(server: FakeServer, login: string): Promise<Connection> {
    const conn = new Connection(server.credentials({ login, password: 'pw', reactions: true, replies: true }));
    await conn.start();
    return conn;
  }

  it('grants reactions to a login that asks, with its caps, and only where lines are kept', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS, reactionCaps: { max_keys: 3, max_per_user: 2 } });
    const alice = await asking(server, 'alice');
    expect([alice.hasCap('reactions'), alice.reactions]).toEqual([true, { targets: ['line'], max_keys: 3, max_per_user: 2 }]);
    const bob = await connect(server, 'bob');
    expect([bob.hasCap('reactions'), bob.reactions]).toEqual([false, null]);
    await expect(bob.react({ line: 1 }, UP)).rejects.toMatchObject({ wire: { code: 'not_available' } });
    const unkept = await asking(new FakeServer({ accounts: ACCOUNTS, caps: ['reactions'] }), 'alice');
    expect([unkept.hasCap('reactions'), unkept.reactions]).toEqual([false, null]);
  });

  it('counts each account once, and shows each reader its own on history and in a batch to its room alone', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS, rooms: [{ name: 'lounge' }] });
    const alice = await asking(server, 'alice');
    const bob = await asking(server, 'bob');
    const room = alice.login!.rooms!.list[0]!.id;
    await alice.roomJoin(room);
    const { id } = await bob.chat({ text: 'lunch?' });
    const { id: inRoom } = await alice.chat({ text: 'here', room });
    expect(await alice.react({ line: id! }, UP)).toEqual({ count: 1 });
    expect(await alice.react({ line: id! }, UP)).toEqual({ count: 1 });
    expect(await bob.react({ line: id! }, UP)).toEqual({ count: 2 });
    expect(await bob.react({ line: id! }, HEART)).toEqual({ count: 1 });
    await alice.react({ line: inRoom!, room }, HEART);
    const aliceHeard = heard(alice, 'reactions_changed');
    const bobHeard = heard(bob, 'reactions_changed');
    server.flushReactions();
    await waitFor('the batches', () => aliceHeard.length === 2 && bobHeard.length === 1);
    const keys = [
      { key: UP, count: 2 },
      { key: HEART, count: 1 },
    ];
    expect(aliceHeard.flatMap((d) => d.changes)).toEqual(
      expect.arrayContaining([
        { target: { line: id }, action: 'summary', keys, mine: [0] },
        { target: { line: inRoom, room }, action: 'summary', keys: [{ key: HEART, count: 1 }], mine: [0] },
      ]),
    );
    expect(bobHeard[0]!.changes).toEqual([{ target: { line: id }, action: 'summary', keys, mine: [0, 1] }]);

    expect(await alice.react({ line: id! }, UP, { remove: true })).toEqual({ count: 1 });
    const line = (await alice.history({ ids: [id!] })).lines[0];
    expect([line?.reactions, line?.reactions_mine]).toEqual([[{ key: UP, count: 1 }, { key: HEART, count: 1 }], undefined]);
    expect((await bob.history()).lines.find((l) => l.id === id)?.reactions_mine).toEqual([0, 1]);
  });

  it('refuses a guest, a line out of reach, a malformed act and one past the caps', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS, rooms: [{ name: 'lounge' }], reactionCaps: { max_keys: 2, max_per_user: 1 } });
    const alice = await asking(server, 'alice');
    const bob = await asking(server, 'bob');
    const guest = new Connection(server.credentials({ reactions: true }));
    await guest.start();
    const room = alice.login!.rooms!.list[0]!.id;
    await alice.roomJoin(room);
    const { id } = await alice.chat({ text: 'one' });
    const { id: inRoom } = await alice.chat({ text: 'two', room });
    await alice.react({ line: id! }, UP);
    for (const [code, send] of [
      ['access_denied', () => guest.react({ line: id! }, UP)],
      ['no_such_target', () => bob.react({ line: inRoom!, room }, UP)],
      ['no_such_target', () => bob.react({ line: inRoom! }, UP)],
      ['no_such_target', () => bob.react({ line: 999 }, UP)],
      ['bad_request', () => bob.react({ line: id! }, { emoji: 'a b' })],
      ['too_many_reactions', () => alice.react({ line: id! }, HEART)],
    ] as const) {
      await expect(send(), `${code}`).rejects.toMatchObject({ wire: { code } });
    }
    await bob.react({ line: id! }, HEART);
    await expect(bob.react({ line: id! }, UP)).rejects.toMatchObject({ wire: { code: 'too_many_reactions' } });
    await expect(alice.react({ line: id! }, UP)).resolves.toEqual({ count: 1 });
  });
});
