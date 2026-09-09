import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Connection, type ConnectionHooks, type Credentials } from '../src/connection';
import type { HistoryLine, InboxOk, LoginOk, SelfUser, User } from '../src/protocol';

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

  it('logs in on the same socket when the session is gone', async () => {
    await connect();
    server.on('resume', () => ({ error: { code: 'session_expired', text: 'gone' } }));
    const second = new Connection(CREDS, {});
    await second.start();
    expect(server.sent('resume')).toHaveLength(1);
    expect(server.sent('login')).toHaveLength(2); // the first connect, then this one
    expect(second.state).toBe('online');
    expect(server.sockets).toHaveLength(2); // no third socket was opened to do it
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
});
