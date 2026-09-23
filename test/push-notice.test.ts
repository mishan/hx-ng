import { describe, expect, it } from 'vitest';

import { isPushOpenMessage, noticeFor, openFor, openParam, parseOpenParam } from '../src/push/notice';

describe('noticeFor', () => {
  it('says what a message says, when the server sent it', () => {
    const n = noticeFor({ kind: 'message', id: '1', unread: 1, from: 'alice', from_nick: 'Alice', text: 'hi there' });
    expect(n).toEqual({ title: 'Alice', body: 'hi there', tag: 'msg:alice' });
  });

  it('says who, and nothing they said, under `sender`', () => {
    const n = noticeFor({ kind: 'message', id: '1', unread: 3, from: 'alice', from_nick: 'Alice' });
    expect(n.title).toBe('Alice');
    expect(n.body).toBe('Sent you a private message (3 unread).');
  });

  it('names nobody under `generic`', () => {
    const n = noticeFor({ kind: 'message', id: '1', unread: 1 });
    expect(n.title).toBe('Private message');
    expect(n.body).not.toMatch(/alice/i);
  });

  it('describes news by its reason, and collapses by scope', () => {
    const base = { kind: 'news', article: 412, root: 398, category: 3, scope: 'thread', target: 398, unread: 1 } as const;
    expect(noticeFor({ ...base, reason: 'reply', from_nick: 'Alice', subject: 'Hello' }).body).toBe(
      'Alice replied to you in “Hello”.',
    );
    expect(noticeFor({ ...base, reason: 'subscription', from_nick: 'Bo', subject: 'Hi', excerpt: 'well…' }).body).toBe(
      'Bo posted in “Hi”: well…',
    );
    expect(noticeFor({ ...base, reason: 'reference' }).body).toBe('Someone cited your article.');
    expect(noticeFor({ ...base, reason: 'reply' }).tag).toBe('news:thread:398');
  });

  it('still says something about a push it cannot read', () => {
    expect(noticeFor(null).body).toBeTruthy();
  });
});

describe('opening a notice', () => {
  it('opens the conversation, or the article', () => {
    expect(openFor({ kind: 'message', id: '1', unread: 1, from: 'alice', from_nick: 'Alice' })).toEqual({
      msg: 'alice',
      nick: 'Alice',
    });
    expect(openFor({ kind: 'message', id: '1', unread: 1 })).toEqual({});
    expect(
      openFor({ kind: 'news', reason: 'reply', article: 7, root: 7, category: 1, scope: 'thread', target: 7, unread: 1 }),
    ).toEqual({ article: 7 });
  });

  it('round-trips through `?open=`, and ignores anything else there', () => {
    expect(parseOpenParam(openParam({ msg: 'alice' }))).toEqual({ msg: 'alice' });
    expect(parseOpenParam(openParam({ article: 7 }))).toEqual({ article: 7 });
    expect(openParam({})).toBeNull();
    expect(parseOpenParam('article:nope')).toEqual({});
    expect(parseOpenParam('msg:')).toEqual({});
    expect(parseOpenParam(null)).toEqual({});
  });
});

describe('isPushOpenMessage', () => {
  const ok = { type: 'hx-push-open', server: 'wss://x', account: 'ann', open: { msg: 'bob' }, act: false };

  it('takes what the worker sends', () => {
    expect(isPushOpenMessage(ok)).toBe(true);
    expect(isPushOpenMessage({ ...ok, account: '' })).toBe(true);
  });

  it('refuses one that does not say whose it is, or whether to act', () => {
    const { account: _account, ...noAccount } = ok;
    const { act: _act, ...noAct } = ok;
    expect(isPushOpenMessage(noAccount)).toBe(false);
    expect(isPushOpenMessage(noAct)).toBe(false);
    expect(isPushOpenMessage({ ...ok, open: null })).toBe(false);
    expect(isPushOpenMessage(null)).toBe(false);
  });
});
