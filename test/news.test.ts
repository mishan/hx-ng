import { describe, expect, it } from 'vitest';

import type { Events, NewsArticle, NewsConfig, NewsNode, NewsSub } from '@hotline-ng/client';

import {
  byteLength,
  canReply,
  coalesced,
  draftProblem,
  excerpt,
  Following,
  highestId,
  indexTree,
  isOwn,
  Jumps,
  nextSearchOffset,
  notifiesThread,
  notifyText,
  replySubject,
  scopeKey,
  trailTo,
} from '../src/news';

const cfg = (over: Partial<NewsConfig> = {}): NewsConfig => ({
  post: true,
  attach: false,
  max_body: 65535,
  max_subject: 255,
  max_depth: 3,
  markdown: 'off',
  body_types: ['text/plain'],
  max_refs: 32,
  search: false,
  ...over,
});

const article = (over: Partial<NewsArticle> = {}): NewsArticle => ({
  id: 1,
  category: 1,
  parent: null,
  root: 1,
  depth: 0,
  from: { nick: 'Alice', login: 'alice' },
  subject: 'Hello',
  body: 'Hi',
  mime: 'text/plain',
  at: 1,
  deleted: false,
  attachments: [],
  refs: [],
  referenced_by: 0,
  ...over,
});

const node = (id: number, parent: number | null, name: string, children?: NewsNode[]): NewsNode => ({
  id,
  parent,
  kind: children ? 'bundle' : 'category',
  name,
  count: 0,
  created_at: 1,
  ...(children ? { children } : {}),
});

describe('replying', () => {
  it('puts one Re: on a subject, never a stack of them', () => {
    expect(replySubject('Phase 4 is open')).toBe('Re: Phase 4 is open');
    expect(replySubject('Re: Phase 4 is open')).toBe('Re: Phase 4 is open');
    expect(replySubject('RE: shouting')).toBe('RE: shouting');
    expect(replySubject('  padded  ')).toBe('Re: padded');
  });

  it('is offered only where the server would take it', () => {
    expect(canReply(article(), cfg())).toBe(true);
    expect(canReply(article({ depth: 3 }), cfg())).toBe(false);
    expect(canReply(article({ depth: 3 }), cfg({ max_depth: undefined }))).toBe(true);
    expect(canReply(article({ deleted: true }), cfg())).toBe(false);
    expect(canReply(article(), cfg({ post: false }))).toBe(false);
    expect(canReply(article(), null)).toBe(false);
  });
});

describe('ownership', () => {
  it('is the login, folded, and a guest owns nothing', () => {
    expect(isOwn({ nick: 'Alice', login: 'alice' }, 'Alice')).toBe(true);
    expect(isOwn({ nick: 'Alice', login: 'alice' }, 'bob')).toBe(false);
    expect(isOwn({ nick: 'guest' }, 'guest')).toBe(false);
    expect(isOwn({ nick: 'Alice', login: 'alice' }, null)).toBe(false);
  });
});

describe('drafts', () => {
  it('are measured the way the server measures them', () => {
    expect(byteLength('é')).toBe(2);
    expect(draftProblem('  ', 'x', cfg())).toMatch(/subject/);
    expect(draftProblem('é'.repeat(128), 'x', cfg())).toMatch(/255 bytes/);
    expect(draftProblem('ok', 'x'.repeat(11), cfg({ max_body: 10 }))).toMatch(/too long/);
    // CRLF is one byte once the server has made it LF.
    expect(draftProblem('ok', 'a\r\nb\r\nc\r\nd\r\n', cfg({ max_body: 8 }))).toBeNull();
    expect(draftProblem('ok', '', cfg())).toBeNull();
  });
});

describe('listing', () => {
  it('shows one line of a body, cut at a word', () => {
    expect(excerpt('line one\n\nline two')).toBe('line one line two');
    const long = 'word '.repeat(60);
    const cut = excerpt(long, 50);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(51);
    expect(cut).not.toMatch(/wor…$/);
  });
});

describe('the tree', () => {
  const tree = [
    node(1, null, 'Projects', [node(2, 1, 'Servers', [node(3, 2, 'hxd-ng')])]),
    node(4, null, 'Announcements'),
  ];

  it('finds the way down to any node it was shown', () => {
    const index = indexTree(tree);
    expect(trailTo(3, index)?.map((n) => n.name)).toEqual(['Projects', 'Servers', 'hxd-ng']);
    expect(trailTo(4, index)?.map((n) => n.name)).toEqual(['Announcements']);
    expect(trailTo(99, index)).toBeNull();
  });

  it('gives up on a node whose parents it cannot reach, or that loop', () => {
    const orphan = indexTree([node(5, 42, 'Orphan')]);
    expect(trailTo(5, orphan)).toBeNull();
    const loop = new Map<number, NewsNode>([
      [6, node(6, 7, 'a')],
      [7, node(7, 6, 'b')],
    ]);
    expect(trailTo(6, loop)).toBeNull();
  });
});

describe('jumping to an article', () => {
  /** A view as far as a jump can see it: a screen replaced by every
   *  navigation and reset, and a generation bumped by every refresh. */
  const view = () => {
    const v = { screen: {}, generation: 0, landed: [] as number[] };
    const jumps = new Jumps(() => v.screen);
    // One jump: ask, wait for the answer, and land if still current.
    const jump = (id: number) => {
      const current = jumps.begin();
      let answer!: () => void;
      const done = new Promise<void>((resolve) => (answer = resolve)).then(() => {
        if (current()) v.landed.push(id);
      });
      return { answer: () => (answer(), done) };
    };
    return { v, jump };
  };

  it('lands two jumps in a row on the second, whichever answer comes back first', async () => {
    const { v, jump } = view();
    const first = jump(1);
    const second = jump(2);
    await second.answer();
    await first.answer();
    expect(v.landed).toEqual([2]);

    const { v: w, jump: again } = view();
    const a = again(1);
    const b = again(2);
    await a.answer();
    await b.answer();
    expect(w.landed).toEqual([2]);
  });

  it('is not eaten by a refresh of the screen in between', async () => {
    const { v, jump } = view();
    const j = jump(7);
    v.generation++;
    await j.answer();
    expect(v.landed).toEqual([7]);
  });

  it('is dropped once the reader has gone somewhere else, or the session is reset', async () => {
    const { v, jump } = view();
    const moved = jump(7);
    v.screen = {};
    await moved.answer();
    expect(v.landed).toEqual([]);
    // One begun from the new screen still lands.
    const fresh = jump(8);
    await fresh.answer();
    expect(v.landed).toEqual([8]);
  });
});

describe('paging a search', () => {
  it('moves on by what the server handed out, even when none of it was new', () => {
    expect(nextSearchOffset(0, 20, 137)).toBe(20);
    // A page that was all hits already shown still moves the offset;
    // asking from the same place again would get the same page forever.
    expect(nextSearchOffset(20, 20, 137)).toBe(40);
  });

  it('stops at the total, at an empty page, and at the deepest a search reaches', () => {
    expect(nextSearchOffset(120, 17, 137)).toBeNull();
    expect(nextSearchOffset(40, 0, 137)).toBeNull();
    expect(nextSearchOffset(480, 20, 500, 500)).toBeNull();
    expect(nextSearchOffset(20, 20, 9000, 500)).toBe(40);
  });
});

const sub = (over: Partial<NewsSub> = {}): NewsSub => ({
  scope: 'thread',
  target: 398,
  category: 7,
  subject: 'The derivative and the u16',
  auto: false,
  muted: false,
  unread: 0,
  last_seen: 400,
  ...over,
});

const notice = (over: Partial<Events['news_notify']> = {}): Events['news_notify'] => ({
  reason: 'subscription',
  scope: 'thread',
  target: 398,
  article: 412,
  root: 398,
  category: 7,
  subject: 'Re: The derivative and the u16',
  excerpt: 'The part size is a u16, so the full-size PNG…',
  from: { nick: 'Bob', login: 'bob' },
  at: 1_789_000_000,
  unread: 3,
  ...over,
});

describe('following', () => {
  it('names a scope the way the server keys it', () => {
    expect(scopeKey({ thread: 398 })).toBe('thread:398');
    expect(scopeKey({ category: 7 })).toBe('category:7');
  });

  it('acknowledges the highest id on screen, wherever it sits', () => {
    expect(highestId([{ id: 398 }, { id: 412 }, { id: 405 }])).toBe(412);
    expect(highestId([])).toBeNull();
  });

  it('takes the count a notification carries for a scope it follows', () => {
    const f = new Following();
    f.load([sub(), sub({ scope: 'category', target: 7, name: 'General', unread: 1 })]);
    expect(f.total()).toBe(1);
    expect(f.notify(notice())).toBe(true);
    expect(f.unreadOf({ thread: 398 })).toBe(3);
    expect(f.unreadIn(7)).toBe(4);
    expect(f.total()).toBe(4);
  });

  it('keeps a muted scope out of every badge', () => {
    const f = new Following();
    f.load([sub({ muted: true, unread: 5 })]);
    expect(f.unreadOf({ thread: 398 })).toBe(0);
    expect(f.unreadIn(7)).toBe(0);
    expect(f.total()).toBe(0);
  });

  it('stands on the login total until the list arrives', () => {
    const f = new Following();
    expect(f.total(2)).toBe(2);
    f.load([]);
    expect(f.total(2)).toBe(0);
  });

  it('counts a reply in a thread it does not follow, until the list covers it or it is seen', () => {
    const f = new Following();
    f.load([]);
    // No cursor, so the server says 1 each time; two replies are two.
    expect(f.notify(notice({ reason: 'reply', unread: 1 }))).toBe(false);
    f.notify(notice({ reason: 'reply', article: 413, unread: 1 }));
    expect(f.unreadOf({ thread: 398 })).toBe(2);
    expect(f.total()).toBe(2);

    // A list that turns out to hold the thread after all has the
    // server's count for it, which already includes these.
    const covered = new Following();
    covered.load([]);
    covered.notify(notice({ unread: 1 }));
    covered.load([sub({ unread: 1 })]);
    expect(covered.total()).toBe(1);

    // Drawn short of the newest reply it was told about, it stays.
    expect(f.claimSeen({ thread: 398 }, 412)).toBe(false);
    expect(f.total()).toBe(2);
    // Drawn as far as that reply, it goes. The list is in and holds no
    // row for the thread, so there is no cursor to move and nothing is
    // sent.
    expect(f.claimSeen({ thread: 398 }, 413)).toBe(false);
    expect(f.total()).toBe(0);
    expect(f.unreadOf({ thread: 398 })).toBe(0);
  });

  it('asks the server about a loose count while the list is not in, once per page drawn', () => {
    const f = new Following();
    f.notify(notice({ reason: 'reply', article: 413, unread: 1 }));
    // The server may hold a row this has not heard of yet: ask.
    expect(f.claimSeen({ thread: 398 }, 405)).toBe(true);
    // A redraw before the answer does not ask again, nor does less.
    expect(f.claimSeen({ thread: 398 }, 405)).toBe(false);
    expect(f.claimSeen({ thread: 398 }, 400)).toBe(false);
    // Still short of the reply, so still counted when the list lands.
    f.load([]);
    expect(f.unreadOf({ thread: 398 })).toBe(1);

    const g = new Following();
    g.notify(notice({ reason: 'reply', article: 413, unread: 1 }));
    expect(g.claimSeen({ thread: 398 }, 413)).toBe(true);
    expect(g.claimSeen({ thread: 398 }, 413)).toBe(false);
    g.load([]);
    expect(g.total()).toBe(0);
  });

  it('does not add a notification to the login total before the list arrives', () => {
    // The login's count already includes the followed thread this
    // notification is for.
    const f = new Following();
    f.notify(notice({ unread: 3 }));
    expect(f.total(3)).toBe(3);
    f.load([sub({ unread: 3 })]);
    expect(f.total(3)).toBe(3);

    // One the list does not cover counts from then on.
    const g = new Following();
    g.notify(notice({ reason: 'reply', target: 9, root: 9, unread: 1 }));
    expect(g.total(2)).toBe(2);
    g.load([sub({ unread: 2 })]);
    expect(g.total(2)).toBe(3);
  });

  it('asks the server only when seeing something moves it, and clears the count at once', () => {
    const f = new Following();
    f.load([sub({ unread: 2, last_seen: 400 })]);
    expect(f.claimSeen({ thread: 398 }, 412)).toBe(true);
    expect(f.unreadOf({ thread: 398 })).toBe(0);
    // A redraw of the same page before the answer does not ask again.
    expect(f.claimSeen({ thread: 398 }, 412)).toBe(false);
    expect(f.claimSeen({ thread: 398 }, 399)).toBe(false);
    // Nothing followed, nothing counted: nothing to say.
    expect(f.claimSeen({ thread: 1 }, 5)).toBe(false);
  });

  it('takes the answer to the newest acknowledgment, not an older one arriving late', () => {
    const f = new Following();
    f.load([sub({ unread: 4 })]);
    f.claimSeen({ thread: 398 }, 410);
    f.claimSeen({ thread: 398 }, 412);
    f.seen({ thread: 398 }, 410, 2);
    expect(f.unreadOf({ thread: 398 })).toBe(0);
    f.seen({ thread: 398 }, 412, 1);
    expect(f.unreadOf({ thread: 398 })).toBe(1);
    expect(f.get({ thread: 398 })?.last_seen).toBe(412);
  });

  it('forgets everything with the session', () => {
    const f = new Following();
    f.load([sub({ unread: 1 })]);
    f.notify(notice({ target: 9, root: 9, unread: 1 }));
    f.clear();
    expect(f.loaded).toBe(false);
    expect(f.list()).toEqual([]);
    expect(f.total()).toBe(0);
  });

  it('counts only a thread-scoped notification as the thread on screen', () => {
    expect(notifiesThread(notice(), 398)).toBe(true);
    expect(notifiesThread(notice(), 399)).toBe(false);
    expect(notifiesThread(notice(), null)).toBe(false);
    // A new thread in a followed category counts against the category,
    // which drawing the thread does not acknowledge.
    expect(notifiesThread(notice({ scope: 'category', target: 7, article: 398 }), 398)).toBe(false);
  });

  it('coalesces a burst of refreshes into one in flight and one after it', async () => {
    const started: (() => void)[] = [];
    const refresh = coalesced(() => new Promise<void>((resolve) => started.push(resolve)));
    const settled: number[] = [];
    const first = refresh().then(() => settled.push(1));
    const rest = [refresh(), refresh(), refresh()].map((p, i) => p.then(() => settled.push(i + 2)));
    expect(started.length).toBe(1);

    started[0]!();
    await first;
    // Everything asked while the first was out waits for a fetch begun
    // after it, and shares that one.
    await Promise.resolve();
    expect(started.length).toBe(2);
    expect(settled).toEqual([1]);
    started[1]!();
    await Promise.all(rest);
    expect(settled).toEqual([1, 2, 3, 4]);
    expect(started.length).toBe(2);

    // Idle again, the next call starts at once.
    void refresh();
    expect(started.length).toBe(3);
    started[2]!();
  });

  it('announces a notification by why it is yours', () => {
    expect(notifyText(notice({ reason: 'reply' }))).toMatch(/^Bob replied to you: “Re: The derivative and the u16” — The part size/);
    expect(notifyText(notice({ reason: 'reference', excerpt: '' }))).toBe('Bob cited your article in “Re: The derivative and the u16”');
    expect(notifyText(notice({ scope: 'category', target: 7, subject: 'New', excerpt: '' }))).toBe('Bob started “New”');
    expect(notifyText(notice({ from: { nick: '' }, excerpt: '' }))).toMatch(/^Someone posted in/);
  });
});
