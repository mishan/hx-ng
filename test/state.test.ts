import { describe, expect, it } from 'vitest';

import type { User } from '@hotline-ng/client';

import { addressOf, LOBBY, Store, statusLabel, styleToKind, type Line } from '../src/state';

const chat = (t: number, text: string, extra: Partial<Line> = {}): Line => ({
  t,
  kind: 'chat',
  text,
  ...extra,
});

const person = (uid: number, nick: string, over: Partial<User> = {}): User => ({
  uid,
  nick,
  icon: 128,
  admin: false,
  status: 'active',
  transport: 'encrypted',
  ...over,
});

describe('addressing a conversation', () => {
  it('prefers the login, which outlives any session', () => {
    const s = new Store();
    const c = s.openPm({ uid: 9, login: 'alice', nick: 'Alice' });
    expect(addressOf(c)).toEqual({ to_login: 'alice' });
  });

  it('falls back to the uid for someone with no account', () => {
    const s = new Store();
    expect(addressOf(s.openPm({ uid: 9, nick: 'a guest' }))).toEqual({ to: 9 });
  });

  it('says there is no way to reach a guest who has left', () => {
    const s = new Store();
    s.put(person(5, 'a guest'));
    const c = s.openPm({ uid: 5, nick: 'a guest' });
    s.remove(5);
    // Honestly unaddressable beats sending `{ to: 5 }` to whoever the
    // server hands that uid to next.
    expect(addressOf(c)).toBeNull();
  });
});

describe('one conversation per person', () => {
  it('does not file every offline sender under one imaginary uid', () => {
    // A message whose sender no longer holds a session arrives with
    // `uid: 0`. Keying on that put all of them in one thread.
    const s = new Store();
    const carol = s.openPm({ uid: 0, login: 'carol', nick: 'carol' });
    const erin = s.openPm({ uid: 0, login: 'erin', nick: 'erin' });
    expect(carol.id).not.toBe(erin.id);
    expect(addressOf(carol)).toEqual({ to_login: 'carol' });
  });

  it('folds a login into the conversation a roster click opened', () => {
    // The roster carries no logins, so clicking a row knows only a uid.
    const s = new Store();
    const clicked = s.openPm({ uid: 9, nick: 'Alice' });
    s.add(clicked.id, chat(1, 'from me'));
    const messaged = s.openPm({ uid: 9, login: 'alice', nick: 'Alice' });
    expect(messaged.id).toBe(clicked.id);
    expect(addressOf(messaged)).toEqual({ to_login: 'alice' });
    expect(s.conversations.size).toBe(2); // the lobby, and one thread
  });

  it('merges a pair that started apart, oldest line first', () => {
    // Mail from alice opens one thread; she arrives and gets clicked,
    // opening a second; her next message names both.
    const s = new Store();
    const byMail = s.openPm({ uid: 0, login: 'alice', nick: 'Alice' });
    s.add(byMail.id, chat(10, 'sent while you were out'));
    const byRoster = s.openPm({ uid: 9, nick: 'Alice' });
    s.add(byRoster.id, chat(20, 'hello again'));

    const merged = s.openPm({ uid: 9, login: 'alice', nick: 'Alice' });
    expect(s.conversations.size).toBe(2);
    expect(merged.lines.map((l) => l.text)).toEqual(['sent while you were out', 'hello again']);
  });

  it('carries unread and a moved active pointer through a merge', () => {
    const s = new Store();
    const byMail = s.openPm({ login: 'alice', nick: 'Alice' });
    s.add(byMail.id, chat(10, 'one'));
    const byRoster = s.openPm({ uid: 9, nick: 'Alice' });
    s.add(byRoster.id, chat(20, 'two'));
    s.active = byRoster.id;

    const merged = s.openPm({ uid: 9, login: 'alice', nick: 'Alice' });
    expect(s.active).toBe(merged.id);
    expect(s.conversation(byRoster.id)).toBeUndefined();
  });

  it('matches logins case-insensitively', () => {
    const s = new Store();
    expect(s.openPm({ login: 'Alice', nick: 'Alice' }).id).toBe(
      s.openPm({ login: 'alice', nick: 'alice' }).id,
    );
  });
});

describe('names that do not last', () => {
  it('gives a reissued uid a conversation of its own', () => {
    // Uids are the legacy wire's 16-bit ids and the server reuses them.
    const s = new Store();
    s.put(person(5, 'a guest'));
    const guest = s.openPm({ uid: 5, nick: 'a guest' });
    s.add(guest.id, chat(1, 'something private'));
    s.remove(5);

    const next = s.openPm({ uid: 5, nick: 'somebody else' });
    expect(next.id).not.toBe(guest.id);
    expect(next.lines).toHaveLength(0);
  });

  it('keeps a login-named thread reachable after its owner parts', () => {
    const s = new Store();
    s.put(person(9, 'Alice'));
    const c = s.openPm({ uid: 9, login: 'alice', nick: 'Alice' });
    s.remove(9);
    expect(c.peer.uid).toBeUndefined();
    expect(addressOf(c)).toEqual({ to_login: 'alice' });
  });

  it('keeps one thread for a sender the wire never named', () => {
    // Stored mail whose sender's account has since gone: no uid, no
    // login. The second message must land in the first one's thread
    // rather than building a fresh one over it.
    const s = new Store();
    const first = s.openPm({ uid: 0, nick: 'ghost' });
    s.add(first.id, chat(1, 'one'));
    const second = s.openPm({ uid: 0, nick: 'ghost' });
    expect(second.id).toBe(first.id);
    s.add(second.id, chat(2, 'two'));
    expect(s.conversation(first.id)!.lines.map((l) => l.text)).toEqual(['one', 'two']);
  });

  it('does not let a bare nick capture an account of the same name', () => {
    // `alice` with no account and `alice` with one are not known to be
    // the same person, and assuming they are is the login-recycling
    // failure private-messages.md §4 exists to prevent.
    const s = new Store();
    const nameless = s.openPm({ uid: 0, nick: 'alice' });
    const account = s.openPm({ uid: 0, login: 'alice', nick: 'alice' });
    expect(account.id).not.toBe(nameless.id);
    // ...and the nameless thread stays reachable afterwards.
    expect(s.openPm({ uid: 0, nick: 'alice' }).id).toBe(nameless.id);
  });
});

describe('closing', () => {
  it('forgets every name the conversation answered to', () => {
    const s = new Store();
    const c = s.openPm({ uid: 9, login: 'alice', nick: 'Alice' });
    s.add(c.id, chat(1, 'old thread'));
    s.active = c.id;
    s.closePm(c.id);

    expect(s.pmWith({ login: 'alice' })).toBeUndefined();
    expect(s.pmWith({ uid: 9 })).toBeUndefined();
    expect(s.active).toBe(LOBBY);
    // A reopened thread is a new one, not the old one resurrected.
    expect(s.openPm({ login: 'alice', nick: 'Alice' }).lines).toHaveLength(0);
  });

  it('refuses to close the lobby', () => {
    const s = new Store();
    s.closePm(LOBBY);
    expect(s.conversation(LOBBY)).toBeDefined();
  });
});

describe('unread counting', () => {
  it('counts lines in a conversation that is not on screen', () => {
    const s = new Store();
    const c = s.openPm({ uid: 9, nick: 'Alice' });
    s.add(c.id, chat(1, 'one'));
    s.add(c.id, chat(2, 'two'));
    expect(c.unread).toBe(2);
  });

  it('does not count what the reader is looking at', () => {
    const s = new Store();
    const c = s.openPm({ uid: 9, nick: 'Alice' });
    s.active = c.id;
    s.add(c.id, chat(1, 'one'));
    expect(c.unread).toBe(0);
  });

  it('does not raise a badge over mail the server calls read', () => {
    // Recovered mail may already have been dealt with, possibly from
    // another client on the same account.
    const s = new Store();
    const c = s.openPm({ login: 'alice', nick: 'Alice' });
    s.add(c.id, chat(1, 'already read', { id: 7 }), false);
    expect(c.unread).toBe(0);
    s.add(c.id, chat(2, 'genuinely new', { id: 8 }), true);
    expect(c.unread).toBe(1);
  });
});

describe('transcript bounds', () => {
  it('keeps a room left open overnight from growing without bound', () => {
    const s = new Store();
    const c = s.openPm({ uid: 9, nick: 'Alice' });
    for (let i = 1; i <= 2100; i++) s.add(c.id, chat(i, `m${i}`));
    expect(c.lines.length).toBeLessThanOrEqual(2000);
    expect(c.lines.at(-1)!.text).toBe('m2100');
  });
});

describe('small translations', () => {
  it('maps a chat style to a line kind', () => {
    expect(styleToKind('action')).toBe('action');
    expect(styleToKind('normal')).toBe('chat');
  });

  it('says nothing for a person who is simply here', () => {
    // Away and detached are one thing to a 1.x client and two here.
    expect(statusLabel('active')).toBe('');
    expect(statusLabel('idle')).toBe('away');
    expect(statusLabel('detached')).toBe('disconnected');
  });

  it('sorts admins first, then by name, case-insensitively', () => {
    const s = new Store();
    s.replaceRoster([
      person(3, 'zoe'),
      person(1, 'Bob', { admin: true }),
      person(2, 'alice'),
      person(4, 'Adam', { admin: true }),
    ]);
    expect(s.roster().map((u) => u.nick)).toEqual(['Adam', 'Bob', 'alice', 'zoe']);
  });
});
