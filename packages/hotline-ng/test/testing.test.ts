import { describe, expect, it, vi } from 'vitest';

import { Connection, WireFailure, type ConnectionHooks, type SocketLike } from '../src/connection';
import type { Events, HistoryOk } from '../src/protocol';
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

  it('logs a guest in that may not detach, and an identity token as its account', async () => {
    const server = new FakeServer({ accounts: ACCOUNTS });
    const guest = new Connection(server.credentials());
    await guest.start();
    expect([guest.self?.nick, guest.grace]).toEqual(['guest', null]);

    const proved = new Connection(
      server.credentials({ identity: { getToken: async () => server.identityToken('bob') } }),
    );
    await proved.start();
    expect(proved.self?.identity).toMatchObject({ outcome: 'linked', account: 'bob' });
    expect(server.requests.at(-1)?.params).not.toHaveProperty('login');
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
    expect(await alice.msg({ to_login: 'bob', text: 'later' })).toEqual({ queued: true, id: 1 });

    const bob = new Connection(server.credentials({ login: 'bob', password: 'pw' }));
    const mail = heard(bob, 'msg');
    await bob.start();
    await waitFor('the mail', () => mail.length === 1);
    expect(mail[0]).toMatchObject({ text: 'later', queued: true, from: { uid: alice.self!.uid, login: 'alice' } });
    const box = await bob.inbox();
    expect(box).toMatchObject({ unread: 1, total: 1, messages: [{ text: 'later', read: false }] });
    expect(await bob.msgRead(box.messages[0]!.id)).toEqual({ unread: 0, total: 1 });

    expect(await bob.msg({ to: alice.self!.uid, text: 'now' })).toEqual({ queued: false });
    const bot = server.addUser({ nick: 'Bot' });
    expect(server.message(bot, { to: bob.self!.uid, text: 'beep' })).toEqual({ queued: false });
    await waitFor('the bot', () => mail.length === 2);
    expect(mail[1]).toMatchObject({ text: 'beep', from: { uid: bot, nick: 'Bot' } });
    await expect(bob.msg({ to_login: 'nobody', text: '?' })).rejects.toMatchObject({ wire: { code: 'no_such_user' } });
  });

  it('stores no plain guest\'s mail, an identity\'s without an id, and gives an account without a password no inbox', async () => {
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
    expect(await alice.inbox()).toMatchObject({ total: 0 });

    const kiosk = new Connection(server.credentials({ login: 'kiosk', password: '' }));
    await kiosk.start();
    expect(kiosk.grace).toBeNull();
    await expect(kiosk.inbox()).rejects.toMatchObject({ wire: { code: 'no_inbox' } });
    await kiosk.logout();
    await expect(alice.msg({ to_login: 'kiosk', text: 'hi' })).rejects.toMatchObject({ wire: { code: 'no_such_user' } });

    const proved = new Connection(server.credentials({ identity: { getToken: async () => server.identityToken() } }));
    await proved.start();
    expect(await proved.msg({ to_login: 'bob', text: 'from a key' })).toEqual({ queued: true });
    const bob = new Connection(server.credentials({ login: 'bob', password: 'pw' }));
    const bobMail = heard(bob, 'msg');
    await bob.start();
    await waitFor('the queued mail', () => bobMail.length === 1);
    expect(bobMail[0]).toMatchObject({ text: 'from a key', queued: true });
    expect(bobMail[0]?.from).not.toHaveProperty('login');
    expect((await bob.inbox()).messages[0]?.from).toEqual({ nick: 'guest' });
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
