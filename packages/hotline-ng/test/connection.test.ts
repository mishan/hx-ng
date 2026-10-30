import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Connection, hasSavedSession, type ConnectionHooks, type Credentials } from '../src/connection';
import { AuthError, SERVER_CHALLENGE_REFUSED } from '../src/identity';
import type { HistoryLine, InboxOk, LoginOk, Room, SelfUser, User } from '../src/protocol';
import { FakeServer as FakeHotline } from '../src/testing';

import { installFakeWire, settle, uninstallFakeWire, type FakeServer } from './fake-wire';

const CREDS: Credentials = {
  url: 'ws://test/ng',
  login: 'alice',
  password: 'hunter2',
  nick: 'Alice',
  icon: 128,
};

const user = (uid: number, nick: string): User => ({
  uid,
  nick,
  icon: 128,
  admin: false,
  status: 'active',
  transport: 'encrypted',
});

// Built out rather than widened from `user()`: `self` narrows `identity`
// to the richer shape only its owner sees, so a roster row is
// deliberately not assignable to it, and that is the right way round.
const me = (uid: number, nick: string): SelfUser => ({
  uid,
  nick,
  icon: 128,
  admin: false,
  status: 'active',
  transport: 'encrypted',
});

const loginOk = (over: Partial<LoginOk> = {}): LoginOk => ({
  session: 's_1',
  token: 'tok',
  self: me(1, 'Alice'),
  server: { name: 'Test', subject: 'hi' },
  users: [user(1, 'Alice'), user(2, 'Bob')],
  detach: { grace: 300 },
  caps: ['inbox'],
  seq: 0,
  ...over,
});

const historyLine = (id: number): HistoryLine => ({
  id,
  at: 1_700_000_000 + id,
  from: { nick: 'Bob', icon: 128 },
  text: `line ${id}`,
  style: 'normal',
});

/** A store of the caller's, as an installed app's localStorage. */
function memoryStore() {
  const kept = new Map<string, string>();
  return {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  };
}

let server: FakeServer;

beforeEach(() => {
  server = installFakeWire();
  server.on('login', () => ({ ok: loginOk() }));
});
afterEach(() => uninstallFakeWire());

/** A connection that has logged in, with whatever hooks the test wants. */
async function connect(hooks: ConnectionHooks = {}): Promise<Connection> {
  const conn = new Connection(CREDS, hooks);
  await conn.start();
  return conn;
}

describe('login', () => {
  it('sends the credentials and adopts the reply', async () => {
    const conn = await connect();
    expect(server.sent('login')[0]?.params).toMatchObject({
      login: 'alice',
      password: 'hunter2',
      nick: 'Alice',
      icon: 128,
    });
    expect(conn.state).toBe('online');
    expect(conn.self?.uid).toBe(1);
    expect(conn.caps).toEqual(['inbox']);
    expect(conn.grace).toBe(300);
  });

  it('hands the caller a roster snapshot', async () => {
    let snapshot: { users: User[] } | null = null;
    await connect({ onSnapshot: (ok) => (snapshot = ok) });
    expect(snapshot!.users.map((u) => u.nick)).toEqual(['Alice', 'Bob']);
  });

  it('does not remember a session that may not detach', async () => {
    // Without the permission a resume can only ever answer
    // `session_expired`, so storing the token invites a confusing
    // reconnect on the next page load.
    server.on('login', () => ({ ok: loginOk({ detach: null }) }));
    await connect();
    expect(sessionStorage.getItem('hxd-ng.session')).toBeNull();
  });

  it('remembers one that may', async () => {
    await connect();
    const saved = JSON.parse(sessionStorage.getItem('hxd-ng.session')!) as { session: string };
    expect(saved.session).toBe('s_1');
  });
});

describe('events', () => {
  it('accounts every seq, including events it does not understand', async () => {
    const conn = await connect();
    server.event('chat', { from: { uid: 2, nick: 'Bob' }, text: 'hi', style: 'normal' });
    // The server's placeholder for a domain event this revision has no
    // mapping for. Counting it is what keeps a later resume exact.
    server.event('unsupported', {});
    server.event('some_future_event', { whatever: true });
    await settle();
    expect(conn.seq).toBe(3);
  });

  it('dispatches to handlers and ignores the rest without throwing', async () => {
    const conn = await connect();
    const seen: string[] = [];
    conn.on('chat', (d) => seen.push(d.text));
    server.event('chat', { from: { uid: 2, nick: 'Bob' }, text: 'one', style: 'normal' });
    server.event('never_heard_of_it', {});
    server.event('chat', { from: { uid: 2, nick: 'Bob' }, text: 'two', style: 'normal' });
    await settle();
    expect(seen).toEqual(['one', 'two']);
  });

  it('delivers a purge as its batched events', async () => {
    const conn = await connect();
    const lines: number[][] = [];
    const articles: { id: number; category: number }[][] = [];
    conn.on('chat_purged', (d) => lines.push(d.ids));
    conn.on('news_purged', (d) => articles.push(d.articles));
    server.event('chat_purged', { ids: [4101, 4102, 4105] });
    server.event('news_purged', { articles: [{ id: 51, category: 3 }, { id: 52, category: 3 }] });
    await settle();
    expect(lines).toEqual([[4101, 4102, 4105]]);
    expect(articles).toEqual([[{ id: 51, category: 3 }, { id: 52, category: 3 }]]);
    expect(conn.seq).toBe(2);
  });
});

describe('resume', () => {
  it('resumes into a stored session on a new Connection', async () => {
    await connect();
    server.on('resume', () => ({ ok: { replay: 2, self: user(1, 'Alice') } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [], seq: 9 } }));

    let replayed = -1;
    const second = new Connection(CREDS, { onResumed: (n) => (replayed = n) });
    await second.start();
    expect(server.sent('resume')[0]?.params).toMatchObject({ session: 's_1', token: 'tok' });
    expect(replayed).toBe(2);
    expect(second.state).toBe('online');
  });

  it('logs in on a fresh socket when the session is gone', async () => {
    await connect();
    server.on('resume', () => ({ error: { code: 'session_expired', text: 'gone' } }));
    const second = new Connection(CREDS, {});
    await second.start();
    expect(server.sent('resume')).toHaveLength(1);
    expect(server.sent('login')).toHaveLength(2); // the first connect, then this one
    expect(second.state).toBe('online');
    // The server closed the one the resume was refused on.
    expect(server.sockets).toHaveLength(3);
  });

  it('catches public history up after an expired session needs a fresh login', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: ['history'] }) }));
    const first = await connect();
    server.event('chat', {
      from: { uid: 2, nick: 'Bob' },
      text: 'last seen',
      style: 'normal',
      id: 10,
      at: 1_700_000_010,
    });
    await settle();
    expect(first.lastHistoryId).toBe(10);

    server.on('resume', () => ({ error: { code: 'session_expired', text: 'gone' } }));
    server.on('history', () => ({ ok: { lines: [historyLine(11)], has_more: false } }));
    const recovered: number[] = [];
    const second = new Connection(CREDS, {
      onMissedHistory: (page) => recovered.push(...page.lines.map((line) => line.id)),
    });
    await second.start();
    await settle();

    expect(server.sent('history')[0]?.params).toEqual({ after: 10, limit: 200 });
    expect(recovered).toEqual([11]);
    expect(second.lastHistoryId).toBe(11);
  });

  it('backs off and retries a catch-up the server rate-limits', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: ['history'] }) }));
    const first = await connect();
    server.event('chat', {
      from: { uid: 2, nick: 'Bob' },
      text: 'last seen',
      style: 'normal',
      id: 10,
      at: 1_700_000_010,
    });
    await settle();
    expect(first.lastHistoryId).toBe(10);

    server.on('resume', () => ({ error: { code: 'session_expired', text: 'gone' } }));
    let asked = 0;
    server.on('history', () =>
      ++asked === 1
        ? { error: { code: 'rate_limited', text: 'slow down' } }
        : { ok: { lines: [historyLine(11)], has_more: false } },
    );

    const recovered: number[] = [];
    const second = new Connection(CREDS, {
      onMissedHistory: (page) => recovered.push(...page.lines.map((line) => line.id)),
    });
    await second.start();
    // "Slow down" is not "there is no more": the gap must still close.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(asked).toBe(2);
    expect(recovered).toEqual([11]);
  });

  it.each([
    { code: 'rate_limited', retry_after: 0 },
    { code: 'too_many_connections' },
  ])('keeps a session whose resume is refused $code, and resumes it later', async (error) => {
    const conn = await connect();
    let asked = 0;
    server.on('resume', () =>
      ++asked === 1 ? { error: { text: 'not now', ...error } } : { ok: { replay: 0, self: user(1, 'Alice') } },
    );
    conn.drop();
    // The first retry's backoff, then the refusal's own.
    await new Promise((resolve) => setTimeout(resolve, 1700));

    expect(server.sent('resume').map((f) => f.params.session)).toEqual(['s_1', 's_1']);
    expect(server.sent('login')).toHaveLength(1);
    expect(conn.state).toBe('online');
  });
  it('retries a reconnect login refused rate_limited once per refusal, and stops on logout', async () => {
    server.on('login', () => ({ ok: loginOk({ detach: null }) }));
    const conn = await connect();
    server.on('login', () => ({ error: { code: 'rate_limited', text: 'slow down', retry_after: 1 } }));
    conn.drop();
    // The backoff, a refusal, its second, and a second refusal.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(server.sent('login')).toHaveLength(3);

    await conn.logout();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(server.sent('login')).toHaveLength(3);
  });

  it('ends a resume-only connection whose resume is refused on a reconnect', async () => {
    await connect();
    server.on('resume', () => ({ ok: { replay: 0, self: user(1, 'Alice') } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [], seq: 0 } }));
    let ended: string | null = null;
    const reloaded = new Connection(CREDS, { onEnded: (r) => (ended = r) });
    await reloaded.start({ resumeOnly: true });

    server.on('resume', () => ({ error: { code: 'session_expired', text: 'gone' } }));
    reloaded.drop();
    await new Promise((resolve) => setTimeout(resolve, 700));

    // No password to log in with, so nothing is left to retry.
    expect(ended).toBe('Your session has ended. Log in again.');
    expect(reloaded.state).toBe('offline');
    expect(server.sent('login')).toHaveLength(1);
    expect(hasSavedSession(CREDS.url)).toBe(false);
  });

  it('keeps the record in a store the caller names, and only there', async () => {
    const store = memoryStore();
    await new Connection({ ...CREDS, sessionStore: store }).start();
    expect(hasSavedSession(CREDS.url, store)).toBe(true);
    expect(hasSavedSession(CREDS.url)).toBe(false);

    server.on('resume', () => ({ ok: { replay: 0, self: user(1, 'Alice') } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [], seq: 0 } }));
    const again = new Connection({ ...CREDS, sessionStore: store });
    await again.start({ resumeOnly: true });
    expect(server.sent('resume')[0]?.params).toMatchObject({ session: 's_1', token: 'tok' });

    await again.logout();
    expect(hasSavedSession(CREDS.url, store)).toBe(false);
  });

  it('leaves the record of a window that took its session over', async () => {
    const store = memoryStore();
    let ended: string | null = null;
    await new Connection({ ...CREDS, sessionStore: store }, { onEnded: (r) => (ended = r) }).start();
    const replaced = server.socket!;
    server.on('resume', () => ({ ok: { replay: 0, self: user(1, 'Alice') } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [], seq: 0 } }));
    await new Connection({ ...CREDS, sessionStore: store }).start({ resumeOnly: true });

    replaced.close('replaced');
    await settle();
    expect(ended).toBe('This session was taken over by another connection.');
    expect(hasSavedSession(CREDS.url, store)).toBe(true);
  });

  it('goes on trying nothing once start is refused', async () => {
    server.on('login', () => ({ error: { code: 'rate_limited', text: 'slow down', retry_after: 0 } }));
    await expect(new Connection(CREDS, {}).start()).rejects.toThrow('slow down');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(server.sent('login')).toHaveLength(1);
  });
});

describe('resync recovery', () => {
  /** A server whose outbox overflowed: resume is refused, sync succeeds,
   *  and the store still holds the mail that was in the gap. */
  function overflowed(messages: InboxOk['messages']): void {
    server.on('resume', () => ({ error: { code: 'resync_required', text: 'gap' } }));
    server.on('sync', () => ({
      ok: { server: { name: 'Test', subject: 'hi' }, users: [user(1, 'Alice')], seq: 977 },
    }));
    server.on('inbox', () => ({ ok: { messages, unread: messages.length, total: messages.length } }));
  }

  const mail = (id: number): InboxOk['messages'][number] => ({
    id,
    from: { nick: 'Bob', login: 'bob' },
    text: `message ${id}`,
    at: 1_700_000_000,
    read: false,
  });

  it('syncs, then pulls the mail the gap swallowed', async () => {
    await connect();
    overflowed([mail(2), mail(1)]);

    let recovered: InboxOk | null = null;
    const second = new Connection(CREDS, { onMissedMail: (ok) => (recovered = ok) });
    await second.start();
    await settle();

    expect(second.state).toBe('online');
    expect(second.seq).toBe(977);
    // The obligation in hotline-ng.md §7.1: the events in the gap are
    // gone and were already marked delivered, so the store is the only
    // remaining copy of any `msg` among them.
    expect(recovered!.messages.map((m) => m.id)).toEqual([2, 1]);
  });

  it('asks for the largest page the wire allows', async () => {
    await connect();
    overflowed([mail(1)]);
    const second = new Connection(CREDS, { onMissedMail: () => {} });
    await second.start();
    await settle();
    // Covering a gap of unknown size is not browsing; the default page
    // would quietly cover only its first 50 messages.
    expect(server.sent('inbox')[0]?.params).toEqual({ limit: 200 });
  });

  it('pulls the mail even when caps does not mention an inbox', async () => {
    // `caps` is a hint about what to draw, not a gate on what to send.
    // As a gate it meant a server under-reporting its own extensions
    // silently lost mail instead of answering `no_inbox`.
    server.on('login', () => ({ ok: loginOk({ caps: [] }) }));
    await connect();
    overflowed([mail(1)]);
    const second = new Connection(CREDS, { onMissedMail: () => {} });
    await second.start();
    await settle();
    expect(server.sent('inbox')).toHaveLength(1);
  });

  it('survives a server that refuses the inbox', async () => {
    await connect();
    overflowed([]);
    server.on('inbox', () => ({ error: { code: 'no_inbox', text: 'no mailbox here' } }));

    let called = false;
    const second = new Connection(CREDS, { onMissedMail: () => (called = true) });
    await second.start();
    await settle();
    // The session is already recovered by this point. Turning a failed
    // mail fetch into a failed resume would cost the room to fix nothing.
    expect(second.state).toBe('online');
    expect(second.seq).toBe(977);
    expect(called).toBe(false);
  });

  it('asks for nothing when the caller does not want mail', async () => {
    await connect();
    overflowed([mail(1)]);
    const second = new Connection(CREDS, {});
    await second.start();
    await settle();
    expect(server.sent('inbox')).toHaveLength(0);
  });

  it('pages public history forward from the cursor captured before sync', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: ['history'] }) }));
    const first = await connect();
    server.event('chat', {
      from: { uid: 2, nick: 'Bob' },
      text: 'last seen',
      style: 'normal',
      id: 10,
      at: 1_700_000_010,
    });
    await settle();
    expect(first.lastHistoryId).toBe(10);

    server.on('resume', () => ({ error: { code: 'resync_required', text: 'gap' } }));
    server.on('sync', () => {
      // Live traffic may resume before sync answers. Recovery must still
      // begin at 10, not at this moving high-water mark.
      server.event('chat', {
        from: { uid: 2, nick: 'Bob' },
        text: 'live during sync',
        style: 'normal',
        id: 20,
        at: 1_700_000_020,
      });
      return {
        ok: { server: { name: 'Test', subject: 'hi' }, users: [user(1, 'Alice')], seq: 977 },
      };
    });
    server.on('history', (params) =>
      params.after === 10
        ? { ok: { lines: [historyLine(11), historyLine(12)], has_more: true } }
        : { ok: { lines: [historyLine(13)], has_more: false } },
    );

    const recovered: number[] = [];
    const second = new Connection(CREDS, {
      onMissedHistory: (page) => recovered.push(...page.lines.map((line) => line.id)),
    });
    await second.start();
    await settle();

    expect(server.sent('history').map((frame) => frame.params)).toEqual([
      { after: 10, limit: 200 },
      { after: 12, limit: 200 },
    ]);
    expect(recovered).toEqual([11, 12, 13]);
    expect(second.lastHistoryId).toBe(20);
  });
  it('pages each joined room from its own cursor, apart from the lobby', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: ['history', 'rooms'] }) }));
    const first = await connect();
    server.on('room_join', ({ room }) => ({ ok: { members: [1], topic: '', may_post: true, last_id: room === 7 ? 50 : undefined } }));
    await first.roomJoin(7);
    await first.roomJoin(8);
    await first.roomJoin(9);
    const chat = (id: number, room?: number) => ({ from: { uid: 2, nick: 'Bob' }, text: '', style: 'normal', id, at: 1, room });
    server.event('chat', chat(10));
    // A room's ids are its own: a higher one must not move the lobby's.
    server.event('chat', chat(60, 7));
    await settle();
    expect(first.lastHistoryId).toBe(10);

    server.on('resume', () => ({ error: { code: 'resync_required', text: 'gap' } }));
    server.on('sync', () => ({
      ok: {
        server: { name: 'Test', subject: 'hi' },
        users: [user(1, 'Alice')],
        seq: 977,
        // 8 was left unseen; 9 was empty when joined, so it is caught up
        // from its start; 10 was joined where this record was not kept.
        rooms: { list: [], joined: [{ id: 7, last_id: 61 }, { id: 9, last_id: 3 }, { id: 10, last_id: 5 }], max_joined: 32 },
      },
    }));
    server.on('history', ({ after }) => ({ ok: { lines: [historyLine(Number(after) + 1)], has_more: false } }));

    const recovered: [number, number][] = [];
    const second = new Connection(CREDS, {
      onMissedHistory: (page, room) => recovered.push(...page.lines.map((line): [number, number] => [room, line.id])),
    });
    await second.start();
    await settle(12);

    expect(server.sent('history').map((frame) => frame.params)).toEqual([
      { after: 10, limit: 200 },
      { after: 60, limit: 200, room: 7 },
      { after: 0, limit: 200, room: 9 },
    ]);
    expect(recovered).toEqual([[0, 11], [7, 61], [9, 1]]);
    expect(second.lastHistoryId).toBe(11);
    expect(Object.fromEntries(second.roomHistoryIds)).toEqual({ 7: 61, 9: 1, 10: 5 });
  });
});

describe('chat history', () => {
  it('sends typed paging requests and remembers the highest returned id', async () => {
    const conn = await connect();
    server.on('history', () => ({
      ok: {
        lines: [
          {
            id: 8,
            at: 1_700_000_008,
            from: { nick: 'Bob', icon: 128 },
            text: 'eight',
            style: 'normal',
          },
        ],
        has_more: true,
      },
    }));

    const page = await conn.history({ before: 12, limit: 25 });
    expect(server.sent('history')[0]?.params).toEqual({ before: 12, limit: 25 });
    expect(page.lines[0]?.id).toBe(8);
    expect(conn.lastHistoryId).toBe(8);
    expect(JSON.parse(sessionStorage.getItem('hxd-ng.session')!).historyId).toBe(8);
  });
});

describe('the message requests', () => {
  it('send the frames the wire specifies', async () => {
    const conn = await connect();
    for (const req of ['msg', 'inbox', 'msg_read', 'block', 'unblock', 'blocks']) {
      server.on(req, () => ({ ok: {} }));
    }
    await conn.msg({ to_login: 'bob', text: 'hello', guid: 'g-1' });
    await conn.msgRead(42);
    await conn.block({ login: 'bob' });
    await conn.unblock({ fingerprint: 'f'.repeat(52) });
    await conn.blocks();

    expect(server.sent('msg')[0]?.params).toEqual({ to_login: 'bob', text: 'hello', guid: 'g-1' });
    expect(server.sent('msg_read')[0]?.params).toEqual({ up_to: 42 });
    expect(server.sent('block')[0]?.params).toEqual({ login: 'bob' });
    expect(server.sent('unblock')[0]?.params).toEqual({ fingerprint: 'f'.repeat(52) });
  });

  it('reject with the server’s own error', async () => {
    const conn = await connect();
    server.on('msg', () => ({ error: { code: 'blocked', text: 'not accepting' } }));
    await expect(conn.msg({ to: 2, text: 'hi' })).rejects.toMatchObject({
      wire: { code: 'blocked' },
    });
  });

  it('report caps without gating on them', async () => {
    const conn = await connect();
    expect(conn.hasCap('inbox')).toBe(true);
    expect(conn.hasCap('voice')).toBe(false);
  });
});

describe('push devices', () => {
  const PUSH = { vapid: 'BEl6', types: ['webpush', 'unifiedpush'], content: 'sender' as const };

  it('adopts the login reply’s push block, and keeps it for a resume', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: ['inbox', 'push'], push: PUSH }) }));
    const conn = await connect();
    expect(conn.push).toEqual(PUSH);
    const saved = JSON.parse(sessionStorage.getItem('hxd-ng.session')!) as { push: unknown };
    expect(saved.push).toEqual(PUSH);
  });

  it('has none where the server offers none', async () => {
    const conn = await connect();
    expect(conn.push).toBeNull();
  });

  it('sends the frames the wire specifies', async () => {
    const conn = await connect();
    server.on('push_register', () => ({ ok: { devid: 'hx-0123456789' } }));
    server.on('push_unregister', () => ({ ok: {} }));
    const ok = await conn.pushRegister({
      type: 'webpush',
      endpoint: 'https://push.example/abc',
      p256dh: 'BPk',
      auth: 'c2VjcmV0',
      devid: 'hx-0123456789',
    });
    await conn.pushUnregister({ devid: 'hx-0123456789' });
    await conn.pushUnregister();

    expect(ok.devid).toBe('hx-0123456789');
    expect(server.sent('push_register')[0]?.params).toMatchObject({ endpoint: 'https://push.example/abc' });
    expect(server.sent('push_unregister').map((f) => f.params)).toEqual([{ devid: 'hx-0123456789' }, {}]);
  });
});

describe('moderation', () => {
  it('takes the moderator flag from login and keeps it across a resume that does not say', async () => {
    server.on('login', () => ({ ok: loginOk({ self: { ...me(1, 'Alice'), moderator: true }, moderation: { open: 3 } }) }));
    const first = await connect();
    expect(first.moderator).toBe(true);
    expect(first.moderation).toEqual({ open: 3 });

    // The resume reply's `self` is a roster row and carries no flag.
    server.on('resume', () => ({ ok: { replay: 0, self: user(1, 'Alice') } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [], seq: 0 } }));
    const second = new Connection(CREDS);
    await second.start();
    expect(second.moderator).toBe(true);
    expect(second.moderation).toEqual({ open: 3 });
  });

  it('is nobody’s by default', async () => {
    const conn = await connect();
    expect(conn.moderator).toBe(false);
    expect(conn.moderation).toBeNull();
  });

  it('sends the frames the wire specifies', async () => {
    const conn = await connect();
    for (const req of ['report_close', 'redact', 'revoke', 'kick']) server.on(req, () => ({ ok: {} }));
    server.on('report', () => ({ ok: { id: 7, outcome: 'open', follow_up: true } }));
    server.on('reports', () => ({ ok: { reports: [], has_more: false } }));
    server.on('purge', () => ({ ok: { lines: 2, media: 1, articles: 0 } }));
    server.on('moderation_log', () => ({ ok: { entries: [], has_more: false } }));

    expect(await conn.report({ line: 42, reason: 'slur' })).toEqual({ id: 7, outcome: 'open', follow_up: true });
    await conn.report({ user: { login: 'bob' }, reason: 'spam', evidence: 'buy now' });
    await conn.reports({ status: 'all', before: 9 });
    await conn.reportClose({ id: 7, outcome: 'duplicate', of: 6 });
    await conn.redact(42, 'slur');
    await conn.revoke('AAAA', 'gore');
    await conn.revoke('BBBB', 'mine', false);
    expect(await conn.purge({ uid: 2, since: 600, reason: 'flood' })).toEqual({ lines: 2, media: 1, articles: 0 });
    await conn.kick({ uid: 2, ban: 3600, purge: 3600, reason: 'flood' });
    await conn.moderationLog();

    expect(server.sent('report').map((f) => f.params)).toEqual([
      { line: 42, reason: 'slur' },
      { user: { login: 'bob' }, reason: 'spam', evidence: 'buy now' },
    ]);
    expect(server.sent('reports')[0]?.params).toEqual({ status: 'all', before: 9 });
    expect(server.sent('report_close')[0]?.params).toEqual({ id: 7, outcome: 'duplicate', of: 6 });
    expect(server.sent('redact')[0]?.params).toEqual({ id: 42, reason: 'slur' });
    // Unsaid is the server's default, which is to block.
    expect(server.sent('revoke').map((f) => f.params)).toEqual([
      { media: 'AAAA', reason: 'gore' },
      { media: 'BBBB', reason: 'mine', block: false },
    ]);
    expect(server.sent('purge')[0]?.params).toEqual({ uid: 2, since: 600, reason: 'flood' });
    expect(server.sent('kick')[0]?.params).toEqual({ uid: 2, ban: 3600, purge: 3600, reason: 'flood' });
    expect(server.sent('moderation_log')[0]?.params).toEqual({});
  });
});

describe('accounts', () => {
  const ADMIN = { access: ['read_users', 'modify_users'], raw_bits: [] };

  it('keeps what the account may do current, and saved for a resume', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: ['accounts'], accounts: ADMIN }) }));
    const conn = await connect();
    expect(conn.accounts).toEqual(ADMIN);

    let heard: unknown = null;
    conn.on('account_changed', () => (heard = conn.accounts));
    const demoted = { access: ['read_users'], raw_bits: [41] };
    server.event('account_changed', demoted);
    await settle();
    expect(heard).toEqual(demoted);
    const saved = JSON.parse(sessionStorage.getItem('hxd-ng.session')!) as { accounts: unknown };
    expect(saved.accounts).toEqual(demoted);
  });

  it.each([
    { files: { writable: true, may: ['delete_files'], previews: ['text'] }, now: ['create_folders', 'comment_files'] },
    { files: { writable: false, may: [], previews: ['text'] }, now: [] },
  ] as const)('keeps what the file area lets it change current: $files.writable', async ({ files, now }) => {
    server.on('login', () => ({
      ok: loginOk({ caps: ['files'], files: { ...files, may: [...files.may], previews: [...files.previews] } }),
    }));
    const conn = await connect();
    server.event('account_changed', { access: ['read_chat', 'create_folders', 'comment_files'], raw_bits: [] });
    await settle();
    expect(conn.files).toEqual({ writable: files.writable, may: now, previews: ['text'] });
  });

  it('takes what a resync says, for a change the gap swallowed', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: ['accounts'], accounts: ADMIN }) }));
    await connect();
    const demoted = { access: [], raw_bits: [] };
    server.on('resume', () => ({ error: { code: 'resync_required', text: 'gap' } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [], seq: 977, accounts: demoted } }));
    const resumed = new Connection(CREDS);
    await resumed.start();
    await settle();
    expect(resumed.accounts).toEqual(demoted);
    // And saved with the seq it is good for, so a reload does not bring
    // back what the gap swallowed.
    const saved = JSON.parse(sessionStorage.getItem('hxd-ng.session')!) as { accounts: unknown; seq: number };
    expect(saved).toMatchObject({ accounts: demoted, seq: 977 });
  });

  it('has none where the server administers none', async () => {
    const conn = await connect();
    expect(conn.accounts).toBeNull();
  });

  it('sends the frames the wire specifies', async () => {
    const conn = await connect();
    const account = { login: 'eve', name: 'Eve', password: true, access: [], raw_bits: [] };
    server.on('account_list', () => ({ ok: { accounts: [{ login: 'eve', name: 'Eve' }] } }));
    for (const req of ['account_get', 'account_create', 'account_update']) server.on(req, () => ({ ok: { account } }));
    server.on('account_delete', () => ({ ok: {} }));

    expect(await conn.accountList()).toEqual({ accounts: [{ login: 'eve', name: 'Eve' }] });
    expect(await conn.accountGet('eve')).toEqual({ account });
    await conn.accountCreate({ login: 'eve', password: 'pw', access: ['read_chat'] });
    await conn.accountUpdate({ login: 'eve', name: 'Eve', access: [], raw_bits: [41] });
    await conn.accountDelete('eve');

    expect(server.sent('account_list')[0]?.params).toEqual({});
    expect(server.sent('account_get')[0]?.params).toEqual({ login: 'eve' });
    expect(server.sent('account_create')[0]?.params).toEqual({ login: 'eve', password: 'pw', access: ['read_chat'] });
    expect(server.sent('account_update')[0]?.params).toEqual({ login: 'eve', name: 'Eve', access: [], raw_bits: [41] });
    expect(server.sent('account_delete')[0]?.params).toEqual({ login: 'eve' });
  });
});

describe('roles', () => {
  const STAFF = { name: 'staff', title: 'Staff', position: 10 };
  const EDITORS = { name: 'editors', title: 'Editors', position: 20, color: 0x112233 };

  it('keeps the roles current, and saved for a resume', async () => {
    server.on('login', () => ({
      ok: loginOk({ caps: ['accounts', 'roles'], roles: { list: [STAFF], manage_roles: true } }),
    }));
    const conn = await connect();
    expect(conn.roles).toEqual({ list: [STAFF], manage_roles: true });

    let heard: unknown = null;
    conn.on('roles_changed', () => (heard = conn.roles));
    server.event('roles_changed', { list: [EDITORS, STAFF] });
    await settle();
    expect(heard).toEqual({ list: [EDITORS, STAFF], manage_roles: true });
    // manage_roles rides on account_changed, said only while held.
    server.event('account_changed', { access: [], raw_bits: [] });
    await settle();
    expect(conn.roles).toEqual({ list: [EDITORS, STAFF] });
    const saved = JSON.parse(sessionStorage.getItem('hxd-ng.session')!) as { roles: unknown };
    expect(saved.roles).toEqual({ list: [EDITORS, STAFF] });
  });

  it('asks again for a roster refused rate_limited', async () => {
    let snapshot: { users: User[]; stale?: true } | null = null;
    await connect({ onSnapshot: (ok) => (snapshot = ok) });
    let asked = 0;
    server.on('sync', () =>
      ++asked === 1
        ? { error: { code: 'rate_limited', text: 'slow down', retry_after: 0 } }
        : { ok: { server: { name: 'Test', subject: 'hi' }, users: [user(2, 'Bob')], seq: 1 } },
    );
    server.event('roster_stale', {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.sent('sync')).toHaveLength(2);
    expect(snapshot).toMatchObject({ users: [user(2, 'Bob')], stale: true });
  });

  it('asks at the resume for a roster a dropped socket cut short', async () => {
    let snapshot: { users: User[]; stale?: true } | null = null;
    const conn = await connect({ onSnapshot: (ok) => (snapshot = ok) });
    server.on('sync', () => new Promise(() => {}));
    server.event('roster_stale', {});
    await settle();
    server.on('resume', () => ({ ok: { replay: 0, self: me(1, 'Alice') } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [user(2, 'Bob')], seq: 1 } }));
    conn.drop();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(server.sent('sync')).toHaveLength(2);
    expect(snapshot).toMatchObject({ users: [user(2, 'Bob')], stale: true });
  });

  it('answers roster_stale with a sync, and hands its roster on', async () => {
    let snapshot: { users: User[] } | null = null;
    const conn = await connect({ onSnapshot: (ok) => (snapshot = ok) });
    const promoted = { ...user(2, 'Bob'), admin: true, roles: ['staff'] };
    server.on('sync', () => ({
      ok: { server: { name: 'Test', subject: 'hi' }, users: [user(1, 'Alice'), promoted], seq: 1, roles: { list: [STAFF] } },
    }));
    server.event('roster_stale', {});
    await settle();
    expect(server.sent('sync')).toHaveLength(1);
    expect(snapshot!.users).toEqual([user(1, 'Alice'), promoted]);
    expect(conn.roles).toEqual({ list: [STAFF] });
  });

  it.each([
    { call: (c: Connection) => c.roleList(), req: 'role_list', params: {} },
    { call: (c: Connection) => c.roleGet('staff'), req: 'role_get', params: { name: 'staff' } },
    {
      call: (c: Connection) => c.roleCreate({ name: 'helpers', color: 0x112233, access: ['read_users'] }),
      req: 'role_create',
      params: { name: 'helpers', color: 0x112233, access: ['read_users'] },
    },
    {
      call: (c: Connection) => c.roleUpdate({ name: 'helpers', color: null }),
      req: 'role_update',
      params: { name: 'helpers', color: null },
    },
    { call: (c: Connection) => c.roleDelete('helpers'), req: 'role_delete', params: { name: 'helpers' } },
    {
      call: (c: Connection) => c.accountUpdate({ login: 'eve', roles: ['staff'], grant: ['send_chat'], deny: [] }),
      req: 'account_update',
      params: { login: 'eve', roles: ['staff'], grant: ['send_chat'], deny: [] },
    },
  ])('$req sends the frame the wire specifies', async ({ call, req, params }) => {
    const conn = await connect();
    server.on(req, () => ({ ok: {} }));
    await call(conn);
    expect(server.sent(req).map((f) => f.params)).toEqual([params]);
  });
});

describe('rooms', () => {
  const LOUNGE: Room = { id: 2754100983, name: 'lounge', topic: 'anything goes', position: 0, members: 4, may_post: false, signed: true };

  it.each([
    { call: (c: Connection) => c.rooms(), req: 'rooms', params: {} },
    { call: (c: Connection) => c.roomJoin(LOUNGE.id), req: 'room_join', params: { room: LOUNGE.id } },
    { call: (c: Connection) => c.roomPart(LOUNGE.id), req: 'room_part', params: { room: LOUNGE.id } },
    { call: (c: Connection) => c.roomTopic(0, 'hi'), req: 'room_topic', params: { room: 0, topic: 'hi' } },
    {
      call: (c: Connection) => c.roomCreate({ name: 'staff', post: ['@moderators'], signed: true }),
      req: 'room_create',
      params: { name: 'staff', post: ['@moderators'], signed: true },
    },
    {
      call: (c: Connection) => c.roomEdit({ room: LOUNGE.id, read: [], max_days: null }),
      req: 'room_edit',
      params: { room: LOUNGE.id, read: [], max_days: null },
    },
    { call: (c: Connection) => c.roomArchive(LOUNGE.id), req: 'room_archive', params: { room: LOUNGE.id } },
    { call: (c: Connection) => c.roomUnarchive(LOUNGE.id), req: 'room_unarchive', params: { room: LOUNGE.id } },
  ])('$req sends the frame the wire specifies', async ({ call, req, params }) => {
    const conn = await connect();
    server.on(req, () => ({ ok: {} }));
    await call(conn);
    expect(server.sent(req).map((f) => f.params)).toEqual([params]);
  });

  it('keeps manage_rooms across a resume whose self does not say, and takes it and moderator from account_changed', async () => {
    server.on('login', () => ({ ok: loginOk({ self: { ...me(1, 'Alice'), manage_rooms: true } }) }));
    await connect();
    server.on('resume', () => ({ ok: { replay: 0, self: me(1, 'Alice') } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [], seq: 0 } }));
    const resumed = new Connection(CREDS);
    await resumed.start();
    expect(resumed.manageRooms).toBe(true);
    // The powers that are not bits ride on account_changed, each said
    // only while held.
    server.event('account_changed', { access: [], raw_bits: [], moderator: true });
    await settle();
    expect([resumed.manageRooms, resumed.moderator]).toEqual([false, true]);
  });

  it('answers a join with what the server said, and refuses with its error', async () => {
    const conn = await connect();
    const joined = { members: [1, 2], topic: 'anything goes', topic_by: 'bob', may_post: false, signed: true };
    server.on('room_join', ({ room }) =>
      room === LOUNGE.id ? { ok: joined } : { error: { code: 'no_such_room', text: 'No such room.' } },
    );
    expect(await conn.roomJoin(LOUNGE.id)).toEqual(joined);
    await expect(conn.roomJoin(7)).rejects.toMatchObject({ wire: { code: 'no_such_room' } });
  });

  it('forgets a room’s cursor when this session is parted from it, and not when someone else is', async () => {
    const fake = new FakeHotline({ accounts: [{ login: 'alice', password: 'pw' }], rooms: [{ name: 'den' }, { name: 'lounge' }] });
    const bob = fake.addUser({ nick: 'Bob' });
    const conn = new Connection(fake.credentials({ login: 'alice', password: 'pw' }));
    await conn.start();
    const [den, lounge] = conn.login!.rooms!.list.map((r) => r.id) as [number, number];
    for (const room of [den, lounge]) {
      fake.joinRoom(bob, room);
      await conn.roomJoin(room);
    }
    fake.say(bob, 'hi', { room: lounge });
    fake.partRoom(bob, lounge);
    fake.archiveRoom(den);
    await settle();
    expect(Object.fromEntries(conn.roomHistoryIds)).toEqual({ [lounge]: 1 });
  });
});

describe('identity login', () => {
  const identityCreds = (getToken: () => Promise<string>): Credentials => ({
    ...CREDS,
    identity: { getToken },
  });

  it('mints a token before opening a socket, and sends no login/password', async () => {
    let calls = 0;
    server.on('login', (params) => {
      expect(params.login).toBeUndefined();
      expect(params.password).toBeUndefined();
      return { ok: loginOk() };
    });
    const conn = new Connection(
      identityCreds(async () => {
        calls++;
        return 'tok-1';
      }),
      {},
    );
    await conn.start();
    expect(calls).toBe(1);
    expect(conn.state).toBe('online');
    // No wasted tokenless socket: with nothing to resume, the very first
    // socket already carries the token.
    expect(server.sockets).toHaveLength(1);
    expect(server.sockets[0]?.url).toContain('?token=tok-1');
  });

  it('closes a failed resume and opens a fresh tokened socket, rather than logging in on the old one', async () => {
    let calls = 0;
    const getToken = async () => {
      calls++;
      return `tok-${calls}`;
    };
    server.on('login', () => ({ ok: loginOk() }));
    const first = new Connection(identityCreds(getToken), {});
    await first.start();
    expect(calls).toBe(1);

    server.on('resume', () => ({ error: { code: 'session_expired', text: 'gone' } }));
    const second = new Connection(identityCreds(getToken), {});
    await second.start();

    expect(calls).toBe(2); // a fresh token for the fresh socket
    expect(second.state).toBe('online');
    // first's socket, second's failed-resume socket, second's tokened socket
    expect(server.sockets).toHaveLength(3);
    expect(server.sockets[2]?.url).toContain('?token=tok-2');
    expect(server.sent('resume')).toHaveLength(1);
    expect(server.sent('login')).toHaveLength(2);
  });

  it.each([
    ['answered wrong_host', new AuthError('wrong_host', 'not here', 421)],
    ['whose challenge was not vouched for', new AuthError(SERVER_CHALLENGE_REFUSED, 'not vouched')],
  ])('ends a reconnect %s instead of proving it again', async (_, refusal) => {
    let calls = 0;
    server.on('login', () => ({ ok: loginOk({ detach: null }) }));
    const conn = new Connection(
      identityCreds(async () => {
        if (++calls > 1) throw refusal;
        return 'tok-1';
      }),
      {},
    );
    await conn.start();
    conn.drop();
    // The first backoff, and past where a second try would have been.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(calls).toBe(2);
    expect(conn.state).toBe('offline');
  });
});

describe('signs', () => {
  it.each([
    ['echoed', 'default', 'default'],
    ['not echoed', 'able', undefined],
  ] as const)('says it at an identity login and on every resume, and signs only while %s', async (_, signs, echo) => {
    server.on('login', () => ({ ok: loginOk(echo ? { signs: echo } : {}) }));
    // Nothing for a resume to say, as when the saved session proved no
    // device: the login says what its token's device does.
    const conn = new Connection({ ...CREDS, identity: { getToken: async () => 'tok', signs: () => signs } }, {});
    await conn.start();
    expect(server.sent('login')[0]?.params.signs).toBe(signs);
    expect(conn.signing).toBe(echo ?? null);

    // A change is said on the next resume, and its echo is what counts.
    conn.signs = 'able';
    server.on('resume', (params) => ({ ok: { replay: 0, self: me(1, 'Alice'), ...(echo ? { signs: params.signs } : {}) } }));
    conn.drop();
    // The first retry's backoff.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(server.sent('resume')[0]?.params.signs).toBe('able');
    expect(conn.signing).toBe(echo ? 'able' : null);
  });

  it.each([
    ['taken', { ok: {} }, 'default'],
    ['refused', { error: { code: 'bad_request', text: 'no' } }, 'able'],
  ] as const)('says a change at once, and again on every later resume once it is %s', async (_, answer, signing) => {
    server.on('login', () => ({ ok: loginOk({ signs: 'able' }) }));
    const conn = new Connection({ ...CREDS, identity: { getToken: async () => 'tok', signs: () => 'able' } }, {});
    await conn.start();
    server.on('signs', () => answer);
    await conn.setSigns('default').catch(() => {});
    expect(server.sent('signs')[0]?.params).toEqual({ signs: 'default' });
    expect(conn.signing).toBe(signing);

    server.on('resume', (params) => ({ ok: { replay: 0, self: me(1, 'Alice'), signs: params.signs } }));
    conn.drop();
    // The first retry's backoff.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(server.sent('resume')[0]?.params.signs).toBe('default');
  });

  it.each([
    ['a change and back while the first is asked', ['default', 'able'], ['default', 'able']],
    ['a change, back and again', ['default', 'able', 'default'], ['default']],
    ['what the server has already', ['able'], []],
  ] as const)('asks one change at a time, and then only the latest: %s', async (_, flips, asked) => {
    server.on('login', () => ({ ok: loginOk({ signs: 'able' }) }));
    const conn = new Connection({ ...CREDS, identity: { getToken: async () => 'tok', signs: () => 'able' } }, {});
    await conn.start();
    server.on('signs', () => ({ ok: {} }));
    await Promise.all(flips.map((signs) => conn.setSigns(signs)));
    expect(server.sent('signs').map((f) => f.params.signs)).toEqual(asked);
    expect(conn.signing).toBe(flips.at(-1));
  });

  it.each([
    ['echoed', 'able', 'default'],
    ['not echoed', undefined, null],
  ] as const)('holds to a resume\'s signs answered resync_required, where the login was %s', async (_, echo, signing) => {
    server.on('login', () => ({ ok: loginOk(echo ? { signs: echo } : {}) }));
    const conn = new Connection({ ...CREDS, identity: { getToken: async () => 'tok', signs: () => 'able' } }, {});
    await conn.start();
    conn.signs = 'default';
    server.on('resume', () => ({ error: { code: 'resync_required', text: 'gap' } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [me(1, 'Alice')], seq: 9 } }));
    conn.drop();
    // The first retry's backoff.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(server.sent('resume')[0]?.params.signs).toBe('default');
    expect(conn.signing).toBe(signing);
  });

  it('says the identity login\'s own, not what a resume would have, after the resume fails', async () => {
    await connect();
    server.on('resume', () => ({ error: { code: 'session_expired', text: 'gone' } }));
    const conn = new Connection({ ...CREDS, signs: 'able', identity: { getToken: async () => 'tok', signs: () => 'default' } }, {});
    await conn.start();
    expect(server.sent('resume')[0]?.params.signs).toBe('able');
    expect(server.sent('login')[1]?.params.signs).toBe('default');
    expect(conn.signs).toBe('default');
  });

  it.each([
    ['with no certificate to sign with', {}],
    ['logging in with a password, which proves no device', { signs: 'default' as const, sealed: true }],
  ])('says nothing of signing or sealing at a login %s', async (_, over) => {
    const conn = new Connection({ ...CREDS, ...over }, {});
    await conn.start();
    expect(server.sent('login')[0]?.params).not.toHaveProperty('signs');
    expect(server.sent('login')[0]?.params).not.toHaveProperty('sealed');
    expect(conn.signing).toBeNull();
    expect(conn.sealing).toBe(false);
  });
});

describe('sealed', () => {
  it.each([
    ['echoed', true],
    ['not echoed', false],
  ] as const)('says it at an identity login and on every resume, and seals only while %s', async (_, echo) => {
    server.on('login', () => ({ ok: loginOk(echo ? { sealed: true } : {}) }));
    const conn = new Connection({ ...CREDS, identity: { getToken: async () => 'tok', sealed: () => true } }, {});
    await conn.start();
    expect(server.sent('login')[0]?.params.sealed).toBe(true);
    expect(conn.sealing).toBe(echo);

    server.on('resume', (params) => ({ ok: { replay: 0, self: me(1, 'Alice'), ...(echo ? { sealed: params.sealed } : {}) } }));
    conn.drop();
    // The first retry's backoff.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(server.sent('resume')[0]?.params.sealed).toBe(true);
    expect(conn.sealing).toBe(echo);
  });
});

describe('instant messaging', () => {
  const MESSAGING = { takes_part: true, max_roster: 500, max_message_bytes: 4096, request_messages: 5 };
  const BOB = { login: 'bob', state: 'accepted' as const, presence: 'online' as const };

  it.each([
    ['asked for', true, true],
    ['not asked for', false, undefined],
  ] as const)('says messaging at login only when %s, and never on a resume', async (_, messaging, said) => {
    server.on('login', () => ({ ok: loginOk({ caps: ['messaging'], messaging: MESSAGING }) }));
    const conn = new Connection({ ...CREDS, messaging }, {});
    await conn.start();
    expect(server.sent('login')[0]?.params.messaging).toBe(said);
    expect(conn.messaging).toEqual(MESSAGING);

    server.on('resume', () => ({ ok: { replay: 0, self: me(1, 'Alice') } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [], seq: 0 } }));
    const resumed = new Connection({ ...CREDS, messaging }, {});
    await resumed.start();
    expect(server.sent('resume')[0]?.params).not.toHaveProperty('messaging');
    expect(resumed.messaging).toEqual(MESSAGING);
  });

  it.each([
    { name: 'a login that said it and takes part', messaging: true, takesPart: true, hook: true, asked: 1 },
    { name: 'a login that did not say it', messaging: false, takesPart: true, hook: true, asked: 0 },
    { name: 'an account that takes no part', messaging: true, takesPart: false, hook: true, asked: 0 },
    { name: 'a caller with no hook', messaging: true, takesPart: true, hook: false, asked: 0 },
  ])('asks for friends after $name: $asked', async ({ messaging, takesPart, hook, asked }) => {
    server.on('login', () => ({
      ok: loginOk({ caps: ['messaging'], messaging: { ...MESSAGING, takes_part: takesPart } }),
    }));
    server.on('friends', () => ({ ok: { friends: [BOB] } }));
    const heard: unknown[] = [];
    const conn = new Connection({ ...CREDS, messaging }, hook ? { onFriends: (ok) => heard.push(ok.friends) } : {});
    await conn.start();
    await settle();
    expect(server.sent('friends')).toHaveLength(asked);
    expect(heard).toEqual(asked ? [[BOB]] : []);
  });

  it.each([
    ['a resume', () => server.on('resume', () => ({ ok: { replay: 0, self: me(1, 'Alice') } }))],
    ['a resync', () => server.on('resume', () => ({ error: { code: 'resync_required', text: 'gap' } }))],
  ] as const)('asks for friends again after %s', async (_, answer) => {
    server.on('login', () => ({ ok: loginOk({ caps: ['messaging'], messaging: MESSAGING }) }));
    server.on('friends', () => ({ ok: { friends: [] } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [], seq: 5 } }));
    const hooks = { onFriends: () => {} };
    await new Connection({ ...CREDS, messaging: true }, hooks).start();
    await settle();
    answer();
    await new Connection({ ...CREDS, messaging: true }, hooks).start();
    await settle();
    expect(server.sent('friends')).toHaveLength(2);
  });

  it('makes a session that did not say it one that does at its first family request, asks for friends then, and keeps that for a resume', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: ['messaging'], messaging: MESSAGING }) }));
    server.on('friends', () => ({ ok: { friends: [] } }));
    server.on('presence', () => ({ ok: {} }));
    const hooks = { onFriends: () => {} };
    const conn = new Connection(CREDS, hooks);
    await conn.start();
    await conn.setPresence({ state: 'away' });
    await conn.setPresence({ state: 'busy' });
    await settle();
    expect(server.sent('friends')).toHaveLength(1);

    server.on('resume', () => ({ ok: { replay: 0, self: me(1, 'Alice') } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [], seq: 0 } }));
    await new Connection(CREDS, hooks).start();
    await settle();
    expect(server.sent('friends')).toHaveLength(2);
  });

  it('asks for friends again after rate_limited, and takes the block sync restates', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: ['messaging'], messaging: MESSAGING }) }));
    let asked = 0;
    server.on('friends', () =>
      ++asked === 1 ? { error: { code: 'rate_limited', text: 'slow down', retry_after: 0 } } : { ok: { friends: [BOB] } },
    );
    const heard: unknown[] = [];
    await new Connection({ ...CREDS, messaging: true }, { onFriends: (ok) => heard.push(ok.friends) }).start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard).toEqual([[BOB]]);

    const away = { ...MESSAGING, state: 'away' as const, takes_requests: true };
    server.on('resume', () => ({ error: { code: 'resync_required', text: 'gap' } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: 'hi' }, users: [], seq: 5, messaging: away } }));
    const resumed = new Connection({ ...CREDS, messaging: true }, {});
    await resumed.start();
    expect(resumed.messaging).toEqual(away);
  });

  it('reads every page of requests, one entry per sender', async () => {
    const msg = (id: number) => ({ id, text: `hi ${id}`, at: 1_700_000_000 + id, guid: `g-${id}` });
    const pages = [
      { requests: [{ login: 'eve', messages: [msg(1)] }], approvals: [{ login: 'dan' }], dropped: 2, takes_requests: true, cursor: 'c1' },
      { requests: [{ login: 'eve', messages: [msg(2)] }, { login: 'mal', messages: [msg(3)] }], approvals: [], dropped: 1, takes_requests: false },
    ];
    server.on('requests', (params) => ({ ok: pages[params.cursor === 'c1' ? 1 : 0] }));
    const conn = await connect();
    expect(await conn.requests()).toEqual({
      requests: [
        { login: 'eve', messages: [msg(1), msg(2)] },
        { login: 'mal', messages: [msg(3)] },
      ],
      approvals: [{ login: 'dan' }],
      dropped: 3,
      takes_requests: false,
    });
    expect(server.sent('requests').map((f) => f.params)).toEqual([{}, { cursor: 'c1' }]);
  });

  it('stops paging requests a server never ends, and keeps the cursor', async () => {
    let n = 0;
    server.on('requests', () => ({ ok: { requests: [], approvals: [], dropped: 0, takes_requests: true, cursor: `c${++n}` } }));
    const conn = await connect();
    expect((await conn.requests()).cursor).toBe('c20');
  });

  it('stops at a cursor handed back again, without merging a page twice', async () => {
    const msg = (id: number) => ({ id, text: `hi ${id}`, at: 1_700_000_000 + id, guid: `g-${id}` });
    server.on('requests', (params) => ({
      ok: {
        requests: [{ login: 'eve', messages: [msg(params.cursor ? 2 : 1)] }],
        approvals: [],
        dropped: 0,
        takes_requests: true,
        cursor: 'stuck',
      },
    }));
    const conn = await connect();
    const all = await conn.requests();
    expect(all.requests).toEqual([{ login: 'eve', messages: [msg(1), msg(2)] }]);
    expect(all).not.toHaveProperty('cursor');
    expect(server.sent('requests')).toHaveLength(2);
  });

  it.each([
    { call: (c: Connection) => c.friends(), req: 'friends', params: {} },
    { call: (c: Connection) => c.friendAdd('bob'), req: 'friend_add', params: { login: 'bob' } },
    { call: (c: Connection) => c.friendAdd('bob', 'it is Alice'), req: 'friend_add', params: { login: 'bob', note: 'it is Alice' } },
    { call: (c: Connection) => c.friendRespond('bob', false), req: 'friend_respond', params: { login: 'bob', accept: false } },
    { call: (c: Connection) => c.friendRemove('bob'), req: 'friend_remove', params: { login: 'bob' } },
    { call: (c: Connection) => c.friendAlias('bob', null), req: 'friend_alias', params: { login: 'bob', alias: null } },
    {
      call: (c: Connection) => c.setPresence({ state: 'away', status_text: null, takes_requests: true }),
      req: 'presence',
      params: { state: 'away', status_text: null, takes_requests: true },
    },
    { call: (c: Connection) => c.findUser('bob'), req: 'find_user', params: { login: 'bob' } },
    { call: (c: Connection) => c.userProfile('bob'), req: 'user_profile', params: { login: 'bob' } },
    { call: (c: Connection) => c.receipt('bob', 'g-1'), req: 'receipt', params: { login: 'bob', guid: 'g-1' } },
    { call: (c: Connection) => c.receipt('bob', 'g-1', true), req: 'receipt', params: { login: 'bob', guid: 'g-1', read: true } },
    { call: (c: Connection) => c.typing('bob', true), req: 'typing', params: { login: 'bob', typing: true } },
    { call: (c: Connection) => c.requestAnswer('eve', 'end'), req: 'request_answer', params: { login: 'eve', action: 'end' } },
    { call: (c: Connection) => c.requestsClear({ since: 1_700_000_000 }), req: 'requests_clear', params: { since: 1_700_000_000 } },
  ])('$req sends the frame the wire specifies: $params', async ({ call, req, params }) => {
    const conn = await connect();
    server.on(req, () => ({ ok: {} }));
    await call(conn);
    expect(server.sent(req).map((f) => f.params)).toEqual([params]);
  });
});
