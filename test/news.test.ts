import { describe, expect, it } from 'vitest';

import type { NewsArticle, NewsConfig, NewsNode } from '@hotline-ng/client';

import { byteLength, canReply, draftProblem, excerpt, indexTree, isOwn, replySubject, trailTo } from '../src/news';

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
