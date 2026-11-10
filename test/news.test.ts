import { describe, expect, it } from 'vitest';

import { WireFailure, type Events, type NewsArticle, type NewsConfig, type NewsNode, type NewsSub, type NewsTimelineThread } from '@hotline-ng/client';

import {
  byteLength,
  attachmentProblem,
  tooManyAttachments,
  canReply,
  canStartThread,
  coalesced,
  draftProblem,
  excerpt,
  expiredAttachments,
  expiryProblem,
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
  readSpan,
  spanHull,
  staleProblem,
  Timeline,
  timelineMissing,
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

  it('follows a feed: no new threads, and replies only where the feed takes them', () => {
    const feed = (replies: boolean) => ({ ...node(1, null, 'Releases'), feed: { name: 'mobius', replies } });
    expect(canStartThread(node(1, null, 'General'), cfg())).toBe(true);
    expect(canStartThread(feed(true), cfg())).toBe(false);
    expect(canStartThread(node(1, null, 'General'), cfg({ post: false }))).toBe(false);
    expect(canReply(article(), cfg(), feed(false).feed)).toBe(false);
    expect(canReply(article(), cfg(), feed(true).feed)).toBe(true);
    expect(canReply(article({ depth: 3 }), cfg(), feed(true).feed)).toBe(false);
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

  it('uses the server attachment capability and count', () => {
    const image = { id: 'a', type: 'image/png', width: 1, height: 1, bytes: 70 };
    expect(attachmentProblem([], cfg())).toBeNull();
    expect(attachmentProblem([image], cfg())).toMatch(/may not attach/);
    expect(attachmentProblem([image], cfg({ attach: true, max_attachments: 1 }))).toBeNull();
    expect(attachmentProblem([image, { ...image, id: 'b' }], cfg({ attach: true, max_attachments: 1 }))).toBe(
      'That post may have 1 attachment at most.',
    );
    expect(tooManyAttachments(8)).toBe('That post may have 8 attachments at most.');
  });

  it('names the staged images that have lapsed, and says what to do', () => {
    const image = { id: 'a', type: 'image/png', width: 1, height: 1, bytes: 70 };
    const draft = [
      { ...image, name: 'photo.png', expiresAt: 1000 },
      { ...image, id: 'b', expiresAt: 5000 },
      { ...image, id: 'c', expiresAt: 2000 },
    ];
    expect(expiredAttachments([], 0)).toEqual([]);
    expect(expiredAttachments(draft, 999)).toEqual([]);
    // The moment it lapses counts as lapsed.
    expect(expiredAttachments(draft, 1000)).toEqual([0]);
    expect(expiredAttachments(draft, 2500)).toEqual([0, 2]);

    expect(expiryProblem(draft, 999)).toBeNull();
    expect(expiryProblem(draft, 1000)).toBe('photo.png has expired. Remove it and attach it again.');
    // One without a file name is called by its place in the draft.
    expect(expiryProblem(draft, 2500)).toBe('photo.png, Image 3 have expired. Remove them and attach them again.');
  });

  it('turns a server refusal of staged images into something to do', () => {
    const image = { id: 'a', type: 'image/png', width: 1, height: 1, bytes: 70 };
    expect(staleProblem([{ ...image, name: 'photo.png' }])).toBe(
      'photo.png has expired on the server. Remove it and attach it again.',
    );
    expect(staleProblem([{ ...image, name: 'photo.png' }, { ...image, id: 'b' }])).toMatch(
      /photo\.png, Image 2\. Remove the images and attach them again\./,
    );
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

    // A notification for a scope the list does not cover counts from
    // then on.
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

  it('keeps a count answered for a page short of the newest, and does not claim that page again', () => {
    const f = new Following();
    f.load([sub({ unread: 3, last_seen: 400 })]);
    expect(f.claimSeen({ thread: 398 }, 410)).toBe(true);
    expect(f.unreadOf({ thread: 398 })).toBe(0);
    // One reply is newer than anything drawn.
    f.seen({ thread: 398 }, 410, 1);
    expect(f.unreadOf({ thread: 398 })).toBe(1);
    // Redrawn to show it, the same page moves no cursor: nothing is sent,
    // and the count stays.
    expect(f.claimSeen({ thread: 398 }, 410)).toBe(false);
    expect(f.unreadOf({ thread: 398 })).toBe(1);
    // Drawn as far as that reply, it is claimed.
    expect(f.claimSeen({ thread: 398 }, 415)).toBe(true);
    expect(f.unreadOf({ thread: 398 })).toBe(0);
  });

  it('knows which categories something followed lives in', () => {
    const f = new Following();
    f.load([sub(), sub({ scope: 'category', target: 12, category: 12, name: 'Announcements' })]);
    expect(f.touches(7)).toBe(true);
    expect(f.touches(12)).toBe(true);
    expect(f.touches(8)).toBe(false);
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

const row = (id: number, over: Partial<NewsTimelineThread> & { category?: number; deleted?: boolean } = {}): NewsTimelineThread => {
  const { category = 1, deleted = false, ...rest } = over;
  return {
    article: article({ id, root: id, category, deleted }),
    replies: 0,
    last_at: id,
    last_id: id,
    unread: false,
    ...rest,
  };
};

const ids = (t: Timeline): number[] => t.threads.map((r) => r.article.id);

const posted = (over: Partial<Events['news_posted']>): Events['news_posted'] => ({
  id: 40,
  category: 1,
  root: 40,
  parent: null,
  subject: 's',
  from: { nick: 'Bob' },
  at: 1,
  attachments: 0,
  ...over,
});

describe('the timeline', () => {
  it('pages older threads in below the ones it holds, never one twice', () => {
    const t = new Timeline();
    t.load({ threads: [row(30), row(20)], has_more: true });
    expect(t.older).toBe(true);
    t.addOlder({ threads: [row(20), row(10)], has_more: false });
    expect(ids(t)).toEqual([30, 20, 10]);
    expect(t.older).toBe(false);
  });

  it('pages on below a page whose every thread was left out', () => {
    const t = new Timeline();
    t.load({ threads: [row(30), row(20)], has_more: true }, () => false);
    expect(ids(t)).toEqual([]);
    expect(t.bottom).toBe(20);
    t.addOlder({ threads: [row(10)], has_more: false });
    expect(ids(t)).toEqual([10]);
    expect(t.bottom).toBe(10);
  });

  it('rereads a span by after pages up from its bottom, as many as it takes', async () => {
    // The server's: ids above `after` and below `before`, the nearest
    // `limit` of them, newest first.
    const all = [70, 60, 50, 40, 30, 20, 10].map((id) => row(id));
    const asked: { after: number; before?: number; limit: number }[] = [];
    const fetch = async (p: { after: number; before?: number; limit: number }) => {
      asked.push(p);
      const inside = all.filter((r) => r.article.id > p.after && (p.before === undefined || r.article.id < p.before));
      const page = inside.slice(-p.limit);
      return { threads: page, has_more: inside.length > p.limit };
    };
    expect((await readSpan(fetch, { after: 15 }, 2)).map((r) => r.article.id)).toEqual([30, 20, 50, 40, 70, 60]);
    expect(asked.map((p) => p.after)).toEqual([15, 30, 50]);
    asked.length = 0;
    expect((await readSpan(fetch, { after: 15, before: 45 }, 200)).map((r) => r.article.id)).toEqual([40, 30, 20]);
    expect(asked).toEqual([{ after: 15, before: 45, limit: 200 }]);
    // A server that says there is more and moves no further is not
    // asked forever.
    const stuck = async () => ({ threads: [row(20)], has_more: true });
    expect(await readSpan(stuck, { after: 20 }, 2)).toHaveLength(1);
  });

  it('takes what a reread found in place of what it held across the span', () => {
    const cases: { name: string; span: { after: number; before?: number }; rows: NewsTimelineThread[]; want: number[] }[] = [
      { name: 'new threads at the top', span: { after: 30 }, rows: [row(50), row(40)], want: [50, 40, 30, 20, 10] },
      { name: 'one thread changed', span: { after: 19, before: 21 }, rows: [row(20, { replies: 3 })], want: [30, 20, 10] },
      { name: 'one thread gone', span: { after: 19, before: 21 }, rows: [], want: [30, 10] },
      { name: 'everything, newest included', span: { after: 9 }, rows: [row(40), row(30)], want: [40, 30] },
    ];
    for (const c of cases) {
      const t = new Timeline();
      t.load({ threads: [row(30), row(20), row(10)], has_more: true });
      t.replace(c.span, c.rows);
      expect(ids(t), c.name).toEqual(c.want);
      expect(t.older, c.name).toBe(true);
    }
    const t = new Timeline();
    t.load({ threads: [row(30), row(20), row(10)], has_more: false });
    t.replace({ after: 19, before: 21 }, [row(20, { replies: 3 })]);
    expect(t.threads[1]!.replies).toBe(3);
  });

  it('sends each live event to the span of it that is held, or nowhere', () => {
    // 20's starter is a tombstone kept for a live reply, so a reply
    // deleted in its category may be the last thing keeping it listed.
    const held = () => {
      const t = new Timeline();
      t.load({ threads: [row(30), row(20, { category: 2, deleted: true }), row(10)], has_more: true });
      return t;
    };
    const follows = (c: number) => c === 1 || c === 2;
    const cases: [string, (t: Timeline) => unknown, unknown][] = [
      ['a thread started in a followed category', (t) => t.posted(posted({ id: 40 }), follows), { after: 30 }],
      ['a thread started where nothing is followed', (t) => t.posted(posted({ id: 40, category: 3 }), follows), null],
      ['a reply in a held thread', (t) => t.posted(posted({ id: 41, root: 20, parent: 20, category: 2 }), follows), { after: 19, before: 21 }],
      ['a reply in a thread not held', (t) => t.posted(posted({ id: 41, root: 5, parent: 5 }), follows), null],
      ['a held starter rewritten', (t) => t.edited({ id: 30, category: 1 }), { after: 29, before: 31 }],
      ['a reply rewritten', (t) => t.edited({ id: 31, category: 1 }), null],
      ['a held starter deleted', (t) => t.deleted({ id: 10, category: 1 }), { after: 9, before: 11 }],
      ['a reply deleted beside a tombstoned starter', (t) => t.deleted({ id: 25, category: 2 }), { after: 9 }],
      ['a reply deleted where every starter lives', (t) => t.deleted({ id: 25, category: 1 }), null],
      ['a purge of a reply and a starter', (t) => t.purged({ articles: [{ id: 33, category: 1 }, { id: 30, category: 1 }] }), { after: 29, before: 31 }],
      ['a purge of two starters', (t) => t.purged({ articles: [{ id: 30, category: 1 }, { id: 10, category: 1 }] }), { after: 9, before: 31 }],
      ['a purge of nothing held', (t) => t.purged({ articles: [{ id: 33, category: 1 }] }), null],
      ['a category or bundle deleted', (t) => t.nodeDeleted(), { after: 9 }],
      ['a new thread notified by a category', (t) => t.notified(notice({ scope: 'category', target: 4, category: 4 }), true), { after: 30 }],
      // Followed where the list does not yet say so: its older threads
      // may sit among those held.
      ['a new thread notified by a category followed elsewhere', (t) => t.notified(notice({ scope: 'category', target: 4, category: 4 }), false), { after: 9 }],
      ['a reply notified by a thread', (t) => t.notified(notice(), true), null],
      ['a reply notified by a thread followed elsewhere', (t) => t.notified(notice(), false), null],
    ];
    for (const [name, touch, want] of cases) expect(touch(held()), name).toEqual(want);
  });

  it('reloads when something arrives for a timeline holding nothing', () => {
    const t = new Timeline();
    t.load({ threads: [], has_more: false });
    expect(t.posted(posted({}), () => true)).toBe('reload');
    expect(t.notified(notice({ scope: 'category' }), true)).toBe('reload');
    expect(t.notified(notice({ scope: 'category' }), false)).toBe('reload');
    expect(t.posted(posted({ parent: 5, root: 5 }), () => true)).toBeNull();
    expect(t.deleted({ id: 5, category: 1 })).toBeNull();
    expect(t.nodeDeleted()).toBeNull();
  });

  it('rereads one span covering every event of a burst', () => {
    expect(spanHull(null, { after: 19, before: 21 })).toEqual({ after: 19, before: 21 });
    expect(spanHull({ after: 19, before: 21 }, { after: 29, before: 31 })).toEqual({ after: 19, before: 31 });
    expect(spanHull({ after: 19, before: 21 }, { after: 30 })).toEqual({ after: 19 });
    expect(spanHull({ after: 30 }, 'reload')).toBe('reload');
    expect(spanHull('reload', null)).toBe('reload');
  });

  it('claims the unbroken run shown, from its oldest starter to its newest, once', () => {
    const t = new Timeline();
    t.load({ threads: [row(50, { unread: true }), row(40), row(30, { unread: true }), row(20), row(10)], has_more: true });
    for (const id of [50, 40, 30]) t.saw(id);
    expect(t.claimSeen()).toEqual([{ from: 30, upTo: 50 }]);
    expect(t.claimSeen()).toEqual([]);
    // Nothing a run inside it could move that it did not.
    t.saw(20);
    t.saw(10);
    expect(t.claimSeen()).toEqual([{ from: 10, upTo: 50 }]);
  });

  it('claims down to the end of the timeline as from 0, and to its oldest starter short of it', () => {
    for (const older of [false, true]) {
      const t = new Timeline();
      t.load({ threads: [row(30), row(20, { unread: true }), row(10)], has_more: older });
      for (const id of [30, 20, 10]) t.saw(id);
      expect(t.claimSeen(), String(older)).toEqual([{ from: older ? 10 : 0, upTo: 30 }]);
    }
  });

  it('claims each run apart, never across a thread not shown, and none with nothing unread', () => {
    const t = new Timeline();
    t.load({
      threads: [row(60), row(50, { unread: true }), row(40, { unread: true }), row(30, { unread: true }), row(20), row(10)],
      has_more: false,
    });
    for (const id of [60, 50, 30, 20]) t.saw(id);
    expect(t.claimSeen()).toEqual([
      { from: 50, upTo: 60 },
      { from: 20, upTo: 30 },
    ]);
    const read = new Timeline();
    read.load({ threads: [row(20), row(10)], has_more: false });
    read.saw(20);
    read.saw(10);
    expect(read.claimSeen()).toEqual([]);
  });

  it('claims a run again once a thread joins it, read or not, to free what the server held back', () => {
    // The server keeps a category's cursor below an unread thread older
    // than `from`, so the top's claim may have moved nothing. Once the
    // gap is shown, the run joining them is claimed, though the thread
    // that joined them was read already.
    const t = new Timeline();
    t.load({ threads: [row(30, { unread: true }), row(20), row(10, { unread: true })], has_more: false });
    t.saw(30);
    expect(t.claimSeen()).toEqual([{ from: 30, upTo: 30 }]);
    t.saw(10);
    expect(t.claimSeen()).toEqual([{ from: 0, upTo: 10 }]);
    t.saw(20);
    expect(t.claimSeen()).toEqual([{ from: 0, upTo: 30 }]);
  });

  it('claims a run again once it grows above what was claimed', () => {
    const t = new Timeline();
    t.load({ threads: [row(30, { unread: true }), row(20, { unread: true })], has_more: true });
    t.saw(20);
    expect(t.claimSeen()).toEqual([{ from: 20, upTo: 20 }]);
    t.replace({ after: 30 }, [row(40, { unread: true })]);
    t.saw(30);
    expect(t.claimSeen()).toEqual([{ from: 20, upTo: 30 }]);
    t.saw(40);
    expect(t.claimSeen()).toEqual([{ from: 20, upTo: 40 }]);
  });

  it('claims a run again once a reread brings an unread thread inside it', () => {
    // A category followed elsewhere since: its thread was never in the run
    // the claim covered.
    const t = new Timeline();
    t.load({ threads: [row(30, { unread: true }), row(10)], has_more: false });
    t.saw(30);
    t.saw(10);
    expect(t.claimSeen()).toEqual([{ from: 0, upTo: 30 }]);
    t.replace({ after: 9 }, [row(30), row(15, { unread: true }), row(10)]);
    t.saw(15);
    expect(t.claimSeen()).toEqual([{ from: 0, upTo: 30 }]);
  });

  it('gives a failed claim back, to be claimed again', () => {
    const t = new Timeline();
    t.load({ threads: [row(20, { unread: true })], has_more: false });
    t.saw(20);
    const [run] = t.claimSeen();
    t.unclaim(run!);
    expect(t.claimSeen()).toEqual([run]);
  });

  it('keeps a thread drawn as new for the visit after it is seen', () => {
    const t = new Timeline();
    t.load({ threads: [row(20, { unread: true }), row(10)], has_more: false });
    t.saw(20);
    t.claimSeen();
    t.replace({ after: 20 }, [row(30, { unread: true }), row(25)]);
    expect([30, 25, 20, 10].map((id) => t.isNew(id))).toEqual([true, false, true, false]);
  });

  it('is hidden on a server that does not know it, and only then', () => {
    const failure = (code: string) => new WireFailure({ code, text: '' });
    expect(timelineMissing(failure('unknown_method'))).toBe(true);
    for (const e of [failure('not_available'), failure('no_mailbox'), failure('access_denied'), new Error('closed')]) {
      expect(timelineMissing(e)).toBe(false);
    }
  });

  it('counts only the unmuted categories followed toward it', () => {
    const f = new Following();
    f.load([
      sub({ unread: 4 }),
      sub({ scope: 'category', target: 7, unread: 2 }),
      sub({ scope: 'category', target: 8, category: 8, unread: 3, muted: true }),
    ]);
    expect([7, 8, 398].map((c) => f.followsCategory(c))).toEqual([true, false, false]);
    expect(f.timelineUnread()).toBe(2);
    expect(new Following().timelineUnread()).toBe(0);
  });
});
