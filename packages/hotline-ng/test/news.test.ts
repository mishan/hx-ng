import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Connection, type Credentials } from '../src/connection';
import { referenceSpans } from '../src/news';
import type { LoginOk, NewsConfig, NewsReference, SelfUser } from '../src/protocol';

import { installFakeWire, settle, uninstallFakeWire, type FakeServer } from './fake-wire';

const ref = (id: number, over: Partial<NewsReference> = {}): NewsReference => ({
  id,
  subject: `about ${id}`,
  from: 'alice',
  at: 1_789_000_000,
  deleted: false,
  ...over,
});

const linked = (body: string, refs: NewsReference[]): string[] =>
  referenceSpans(body, refs).flatMap((s) => ('ref' in s ? [s.text] : []));

describe('finding references in a body', () => {
  it('links only the ids the server resolved', () => {
    expect(referenceSpans('see #51, and #4000 which is nothing', [ref(51)])).toEqual([
      { text: 'see ' },
      { text: '#51', ref: ref(51) },
      { text: ', and #4000 which is nothing' },
    ]);
  });

  it('gives back exactly the body it was handed', () => {
    const body = '#51 at the start, (#47) in brackets, and #51 again.\n#9';
    const spans = referenceSpans(body, [ref(51), ref(47), ref(9)]);
    expect(spans.map((s) => s.text).join('')).toBe(body);
    expect(linked(body, [ref(51), ref(47), ref(9)])).toEqual(['#51', '#47', '#51', '#9']);
  });

  it('finds them where the server does, and nowhere else', () => {
    // The server's scanner decides what is a reference; a client that
    // disagreed would link digits the server never resolved.
    for (const body of ['#51', '(#51)', 'x #51.', 'line\n#51\n', 'end: #51']) {
      expect(linked(body, [ref(51)]), body).toEqual(['#51']);
    }
    for (const body of ['&#51;', '##51', 'issue#51', '#51st', '#51_x', '#51é', '# 51', '_#51']) {
      expect(linked(body, [ref(51)]), body).toEqual([]);
    }
  });

  it('still links a reference whose target was deleted', () => {
    const gone = ref(51, { deleted: true, subject: undefined, from: undefined });
    expect(referenceSpans('see #51', [gone])).toEqual([{ text: 'see ' }, { text: '#51', ref: gone }]);
  });
});

const CREDS: Credentials = {
  url: 'ws://test/ng',
  login: 'alice',
  password: 'hunter2',
  nick: 'Alice',
  icon: 128,
};

const me: SelfUser = {
  uid: 1,
  nick: 'Alice',
  icon: 128,
  admin: false,
  status: 'active',
  transport: 'encrypted',
};

const NEWS: NewsConfig = {
  post: true,
  attach: false,
  max_body: 65535,
  max_subject: 255,
  max_depth: 32,
  markdown: 'off',
  body_types: ['text/plain'],
  max_refs: 32,
  search: false,
};

const loginOk = (over: Partial<LoginOk> = {}): LoginOk => ({
  session: 's_1',
  token: 'tok',
  self: me,
  server: { name: 'Test', subject: '' },
  users: [me],
  detach: { grace: 300 },
  caps: ['news'],
  seq: 0,
  news: NEWS,
  ...over,
});

let server: FakeServer;

beforeEach(() => {
  server = installFakeWire();
  server.on('login', () => ({ ok: loginOk() }));
});
afterEach(() => uninstallFakeWire());

describe('the news requests', () => {
  it('keep what the login reply said about news, across a resume too', async () => {
    const conn = new Connection(CREDS);
    await conn.start();
    expect(conn.news).toEqual(NEWS);
    expect(conn.hasCap('news')).toBe(true);

    // A resume answers with `self` and a replay and nothing about
    // capabilities, so a client coming back through one has only what
    // it saved to go on.
    server.on('resume', () => ({ ok: { replay: 0, self: me } }));
    server.on('sync', () => ({ ok: { server: { name: 'Test', subject: '' }, users: [me], seq: 0 } }));
    const again = new Connection(CREDS);
    await again.start();
    await settle();
    expect(server.sent('resume')).toHaveLength(1);
    expect(again.news).toEqual(NEWS);
  });

  it('say nothing about news on a server that has none', async () => {
    server.on('login', () => ({ ok: loginOk({ caps: [], news: undefined }) }));
    const conn = new Connection(CREDS);
    await conn.start();
    expect(conn.news).toBeNull();
  });

  it('send the frames the wire specifies', async () => {
    const conn = new Connection(CREDS);
    await conn.start();
    const article = {
      id: 7,
      category: 2,
      parent: null,
      root: 7,
      depth: 0,
      from: { nick: 'alice', login: 'alice' },
      subject: 's',
      body: 'b',
      mime: 'text/plain',
      at: 1,
      deleted: false,
      attachments: [],
      refs: [],
      referenced_by: 0,
    };
    server.on('news_tree', () => ({ ok: { nodes: [] } }));
    server.on('news_threads', () => ({ ok: { threads: [], has_more: false } }));
    server.on('news_thread', () => ({ ok: { articles: [article], has_more: false } }));
    server.on('news_article', () => ({ ok: { article } }));
    server.on('news_post', () => ({ ok: { id: 8 } }));
    server.on('news_delete', () => ({ ok: {} }));
    server.on('news_refs', () => ({ ok: { referenced_by: [] } }));
    server.on('news_node_create', () => ({
      ok: { node: { id: 3, parent: null, kind: 'category', name: 'General', count: 0, created_at: 1 } },
    }));
    server.on('news_node_rename', () => ({ ok: {} }));
    server.on('news_node_delete', () => ({ ok: { articles: 4 } }));

    await conn.newsTree({ depth: 2 });
    await conn.newsThreads({ category: 2, before: 9, limit: 10 });
    await conn.newsThread({ root: 7, after: 7 });
    expect(await conn.newsArticle(7)).toEqual(article);
    expect(await conn.newsPost({ category: 2, parent: 7, subject: 'Re: s', body: 'hi' })).toEqual({ id: 8 });
    await conn.newsDelete(7);
    await conn.newsDelete(7, 'off topic');
    await conn.newsRefs(7);
    await conn.newsRefs(7, 5);
    await conn.newsNodeCreate({ kind: 'category', name: 'General' });
    await conn.newsNodeRename(3, 'Chatter');
    expect(await conn.newsNodeDelete(3)).toEqual({ articles: 4 });

    expect(server.sent('news_tree')[0]?.params).toEqual({ depth: 2 });
    expect(server.sent('news_threads')[0]?.params).toEqual({ category: 2, before: 9, limit: 10 });
    expect(server.sent('news_thread')[0]?.params).toEqual({ root: 7, after: 7 });
    expect(server.sent('news_article')[0]?.params).toEqual({ id: 7 });
    expect(server.sent('news_post')[0]?.params).toEqual({ category: 2, parent: 7, subject: 'Re: s', body: 'hi' });
    expect(server.sent('news_delete').map((f) => f.params)).toEqual([{ id: 7 }, { id: 7, reason: 'off topic' }]);
    expect(server.sent('news_refs').map((f) => f.params)).toEqual([{ id: 7 }, { id: 7, limit: 5 }]);
    expect(server.sent('news_node_create')[0]?.params).toEqual({ kind: 'category', name: 'General' });
    expect(server.sent('news_node_rename')[0]?.params).toEqual({ id: 3, name: 'Chatter' });
    expect(server.sent('news_node_delete')[0]?.params).toEqual({ id: 3 });
  });

  it('reject with the server’s own error', async () => {
    const conn = new Connection(CREDS);
    await conn.start();
    server.on('news_post', () => ({ error: { code: 'too_deep', text: 'nested too deep' } }));
    await expect(conn.newsPost({ category: 1, parent: 2, subject: 's', body: 'b' })).rejects.toMatchObject({
      wire: { code: 'too_deep' },
    });
  });

  it('hand news events to their handlers like any other', async () => {
    const conn = new Connection(CREDS);
    const seen: number[] = [];
    conn.on('news_posted', (d) => seen.push(d.id));
    await conn.start();
    server.event('news_posted', {
      id: 12,
      category: 2,
      root: 12,
      parent: null,
      subject: 'Hello',
      from: { nick: 'bob' },
      at: 1,
      attachments: 0,
    });
    await settle();
    expect(seen).toEqual([12]);
    expect(conn.seq).toBe(1);
  });
});
