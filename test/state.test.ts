import { describe, expect, it } from 'vitest';

import type { User } from '@hotline-ng/client';

import {
  addressOf,
  continuesRun,
  LOBBY,
  Store,
  statusLabel,
  styleToKind,
  type Line,
} from '../src/state';

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

  it('counts the active conversation while something covers it', () => {
    // The news reader takes the chat pane's place; the conversation it
    // hid is still the active one, and nobody is reading it.
    const s = new Store();
    const c = s.openPm({ uid: 9, nick: 'Alice' });
    s.active = c.id;
    s.covered = true;
    s.add(c.id, chat(1, 'one'));
    expect(c.unread).toBe(1);
  });

  it('leaves a news notice to the News badge, even while the reader covers chat', () => {
    // A notice arriving with News open lands in the covered conversation,
    // and is about something else entirely.
    const s = new Store();
    const c = s.openPm({ uid: 9, nick: 'Carol' });
    s.active = c.id;
    s.covered = true;
    s.add(c.id, { t: 1, kind: 'notice', text: 'Bob replied to you: “Re: Hello”', article: 412 });
    expect(c.lines).toHaveLength(1);
    expect(c.unread).toBe(0);
    // Nor anywhere else: off screen, it is still not chat.
    const lobby = s.conversation(LOBBY)!;
    s.add(LOBBY, { t: 2, kind: 'notice', text: 'Bob posted in “Hello”', article: 413 });
    expect(lobby.unread).toBe(0);
    // A line that is chat counts as it always did.
    s.add(c.id, chat(3, 'are you there?'));
    expect(c.unread).toBe(1);
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

describe('public chat history', () => {
  it('deduplicates overlap with live chat and keeps id order at one timestamp', () => {
    const s = new Store();
    s.add(LOBBY, chat(2_000, 'live', { id: 3, from: { uid: 9, nick: 'Alice' } }));
    const added = s.mergeHistory(
      [
        chat(1_000, 'one', { id: 1, from: { nick: 'Alice', icon: 128 } }),
        chat(2_000, 'two', { id: 2, from: { nick: 'Alice', icon: 128 } }),
        chat(2_000, 'live', { id: 3, from: { nick: 'Alice', icon: 128 } }),
      ],
      true,
      'older',
    );

    expect(added).toBe(2);
    expect(s.conversation(LOBBY)!.lines.map((line) => line.id)).toEqual([1, 2, 3]);
    expect(s.oldestHistoryId).toBe(1);
    expect(s.newestHistoryId).toBe(3);
    expect(s.historyExhausted).toBe(false);
  });

  it('keeps the page it just fetched when the transcript is already full', () => {
    const s = new Store();
    for (let i = 1; i <= 2000; i++) s.add(LOBBY, chat(10_000 + i, `live ${i}`, { id: 1000 + i }));
    const added = s.mergeHistory(
      Array.from({ length: 200 }, (_, n) => chat(1_000 + n, `old ${n}`, { id: 1 + n })),
      true,
      'older',
    );

    expect(added).toBe(200);
    const lines = s.conversation(LOBBY)!.lines;
    expect(lines).toHaveLength(2000);
    expect(lines[0]!.id).toBe(1);
    expect(s.oldestHistoryId).toBe(1);
    // The newest lines made room instead, and their ids went with them,
    // so a catch-up can bring them back rather than filtering them out.
    expect(s.hasHistory(3000)).toBe(false);
    expect(s.newestHistoryId).toBe(2800);
  });

  it('keeps chat ids separate from private-mail ids and records exhaustion', () => {
    const s = new Store();
    s.mergeHistory([chat(1, 'history', { id: 7 })], false, 'older');
    expect(s.hasHistory(7)).toBe(true);
    expect(s.hasMail(7)).toBe(false);
    expect(s.historyExhausted).toBe(true);

    const pm = s.openPm({ login: 'alice', nick: 'Alice' });
    s.add(pm.id, chat(2, 'mail', { id: 7 }));
    expect(s.hasMail(7)).toBe(true);
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

describe('collapsing a run of lines', () => {
  const from = (uid: number, nick: string, login?: string) => ({ uid, nick, login });
  const at = (t: number, sender: ReturnType<typeof from>, extra: Partial<Line> = {}): Line => ({
    t,
    kind: 'chat',
    text: 'x',
    from: sender,
    ...extra,
  });

  it('collapses consecutive lines from one person', () => {
    const a = at(0, from(9, 'Alice', 'alice'));
    const b = at(1000, from(9, 'Alice', 'alice'));
    expect(continuesRun(a, b)).toBe(true);
  });

  it('breaks the run after a long silence', () => {
    const a = at(0, from(9, 'Alice', 'alice'));
    const b = at(6 * 60 * 1000, from(9, 'Alice', 'alice'));
    expect(continuesRun(a, b)).toBe(false);
  });

  it('does not hide one queued sender under another with the same nick', () => {
    // Mail that waited arrives with `uid: 0`, so uid and nick alone are
    // not a person: two senders sharing a nick would collapse into one
    // block and the second one's name would simply not appear.
    const a = at(0, from(0, 'dave', 'dave@one'), { queued: true });
    const b = at(1000, from(0, 'dave', 'dave@two'), { queued: true });
    expect(continuesRun(a, b)).toBe(false);
  });

  it('separates a stored line from a live one', () => {
    const a = at(0, from(0, 'Alice', 'alice'), { queued: true });
    const b = at(1000, from(9, 'Alice', 'alice'));
    expect(continuesRun(a, b)).toBe(false);
  });

  it('separates your own half of a conversation from theirs', () => {
    const a = at(0, from(1, 'Me'), { local: true });
    const b = at(1000, from(1, 'Me'));
    expect(continuesRun(a, b)).toBe(false);
  });

  it('never continues into or out of a non-chat line', () => {
    const notice: Line = { t: 0, kind: 'notice', text: 'someone joined' };
    const chatLine = at(1000, from(9, 'Alice', 'alice'));
    expect(continuesRun(notice, chatLine)).toBe(false);
    expect(continuesRun(chatLine, notice)).toBe(false);
    expect(continuesRun(undefined, chatLine)).toBe(false);
  });
});
