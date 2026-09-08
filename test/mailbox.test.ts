import { describe, expect, it } from 'vitest';

import type { InboxOk } from '@hotline-ng/client';

import { Cursor, Store, type Line } from '../src/state';

const chat = (t: number, text: string, extra: Partial<Line> = {}): Line => ({
  t,
  kind: 'chat',
  text,
  ...extra,
});

const stored = (id: number, read = false): InboxOk['messages'][number] => ({
  id,
  from: { nick: 'Bob', login: 'bob' },
  text: `message ${id}`,
  at: 1_700_000_000,
  read,
});

const page = (ids: number[], counts: Partial<InboxOk> = {}): InboxOk => ({
  messages: ids.map((id) => stored(id)),
  unread: counts.unread ?? ids.length,
  total: counts.total ?? ids.length,
});

describe('mail counts', () => {
  it('start absent, which is not the same as zero', () => {
    // Absent means this server keeps no mail, and nothing about mail
    // should be drawn at all.
    expect(new Store().mail).toBeNull();
  });

  it('move both counters when a stored message arrives live', () => {
    const s = new Store();
    s.mail = { unread: 0, total: 0 };
    s.noteStoredMessage();
    // Moving only `unread` rendered "1 unread of 0 stored" until the
    // next reply corrected it.
    expect(s.mail).toEqual({ unread: 1, total: 1 });
  });

  it('ignore a stored message on a server with no mailbox', () => {
    const s = new Store();
    s.noteStoredMessage();
    expect(s.mail).toBeNull();
  });

  it('are replaced wholesale by whatever a page reports', () => {
    const s = new Store();
    s.mail = { unread: 9, total: 9 };
    s.notePage(page([3, 2, 1], { unread: 1, total: 3 }));
    expect(s.mail).toEqual({ unread: 1, total: 3 });
  });
});

describe('paging backwards', () => {
  it('has no cursor until the first page', () => {
    expect(new Store().oldestMailId).toBeUndefined();
  });

  it('tracks the oldest id seen, wherever in the page it sits', () => {
    const s = new Store();
    s.notePage(page([8, 7, 6, 5, 4]));
    expect(s.oldestMailId).toBe(4);
    s.notePage(page([3, 2, 1]));
    expect(s.oldestMailId).toBe(1);
  });

  it('never lets the cursor move back up', () => {
    // A cursor that reset itself would page the same rows for ever.
    const s = new Store();
    s.notePage(page([3, 2, 1]));
    s.notePage(page([9, 8]));
    expect(s.oldestMailId).toBe(1);
  });

  it('is exhausted by a page with no rows', () => {
    const s = new Store();
    s.notePage(page([2, 1]));
    expect(s.mailExhausted).toBe(false);
    s.notePage(page([]));
    expect(s.mailExhausted).toBe(true);
  });

  it('is NOT exhausted by a page holding only messages already seen', () => {
    // The login flush pushes the oldest unread mail as events, so a page
    // backwards can land entirely on rows already on screen while older
    // ones still sit beneath it. Stopping there would hide them for good.
    const s = new Store();
    const conv = s.openPm({ login: 'bob', nick: 'Bob' });
    s.add(conv.id, chat(1, 'flushed', { id: 3 }));
    s.add(conv.id, chat(2, 'flushed', { id: 2 }));

    s.notePage(page([3, 2]));
    expect(s.mailExhausted).toBe(false);
    expect(s.oldestMailId).toBe(2); // and the cursor still moved
  });
});

describe('deduplicating what arrives twice', () => {
  it('remembers the ids it has placed', () => {
    // The login flush and an `inbox` page carry the same rows, and which
    // arrives first is a race.
    const s = new Store();
    const c = s.openPm({ login: 'bob', nick: 'Bob' });
    expect(s.hasMail(7)).toBe(false);
    s.add(c.id, chat(1, 'hello', { id: 7 }));
    expect(s.hasMail(7)).toBe(true);
  });

  it('remembers read mail too', () => {
    const s = new Store();
    const c = s.openPm({ login: 'bob', nick: 'Bob' });
    s.add(c.id, chat(1, 'read already', { id: 7 }), false);
    expect(s.hasMail(7)).toBe(true);
  });

  it('survives two threads for one person being merged', () => {
    const s = new Store();
    const byMail = s.openPm({ login: 'bob', nick: 'Bob' });
    s.add(byMail.id, chat(1, 'stored', { id: 42 }), false);
    const byRoster = s.openPm({ uid: 9, nick: 'Bob' });
    s.add(byRoster.id, chat(2, 'live'));
    s.openPm({ uid: 9, login: 'bob', nick: 'Bob' });
    expect(s.hasMail(42)).toBe(true);
  });

  it('keeps ids for lines trimmed off the top of a transcript', () => {
    // Those messages were shown and scrolled past. A later page must not
    // re-append them under whatever is on screen now.
    const s = new Store();
    const c = s.openPm({ login: 'bob', nick: 'Bob' });
    for (let i = 1; i <= 2100; i++) s.add(c.id, chat(i, `m${i}`, { id: i }));
    expect(c.lines.length).toBeLessThanOrEqual(2000);
    expect(s.hasMail(1)).toBe(true);
  });

  it('forgets a closed conversation’s mail, so paging can restore it', () => {
    // Closing is someone saying they are done with a thread; paging mail
    // afterwards should be able to bring it back rather than silently
    // skipping every message it used to hold.
    const s = new Store();
    const c = s.openPm({ login: 'bob', nick: 'Bob' });
    s.add(c.id, chat(1, 'stored', { id: 51 }), false);
    s.closePm(c.id);
    expect(s.hasMail(51)).toBe(false);

    const again = s.openPm({ login: 'bob', nick: 'Bob' });
    s.add(again.id, chat(1, 'stored', { id: 51 }), false);
    expect(again.lines.map((l) => l.text)).toEqual(['stored']);
  });
});

describe('the read cursor', () => {
  it('will not claim a position it is already at or past', () => {
    const c = new Cursor();
    expect(c.claim(0)).toBeNull();
    expect(c.claim(5)).not.toBeNull();
    expect(c.claim(5)).toBeNull();
    expect(c.claim(3)).toBeNull();
    expect(c.value).toBe(5);
  });

  it('lets only the newest claim write an answer', () => {
    // Select one conversation, then another before the first answers.
    const c = new Cursor();
    const first = c.claim(5)!;
    const second = c.claim(9)!;
    expect(first.owns()).toBe(false);
    expect(second.owns()).toBe(true);
  });

  it('puts the cursor back when a mark fails', () => {
    // Nothing was marked, so one failure must not silently retire every
    // id below it for the rest of the session.
    const c = new Cursor();
    c.claim(5);
    const failed = c.claim(9)!;
    failed.release();
    expect(c.value).toBe(5);
    expect(c.claim(9)).not.toBeNull();
  });

  it('does not rewind past a newer claim when an older one fails', () => {
    const c = new Cursor();
    const older = c.claim(5)!;
    c.claim(9);
    older.release();
    expect(c.value).toBe(9);
  });
});
