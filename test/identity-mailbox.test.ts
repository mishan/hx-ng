import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdentityError, bytesToBase64url, hexToBytes } from '@hotline-ng/client';

import { awaitAnswer, mailboxFrom, postEnrollRequest } from '../src/identity/mailbox';
import vectors from '../packages/hotline-ng/test/identity-vectors.json';

const MAILBOX = { base: 'https://hl.example/identity/enroll' };

/** A `fetch` that replays a queue of canned responses and records what
 *  it was asked for. Not a mocking library — the same spirit as
 *  `test/fake-idb.ts`. */
function fakeFetch(replies: { status: number; body?: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mailboxFrom', () => {
  it('is null when the server advertises no mailbox', () => {
    // Not an error: it is a fact about the server, and the reason the
    // paste box stays on the panel.
    expect(mailboxFrom('https://hl.example', undefined)).toBeNull();
    expect(mailboxFrom('https://hl.example', '/identity/enroll')).toEqual({
      base: 'https://hl.example/identity/enroll',
    });
  });
});

describe('postEnrollRequest', () => {
  const request = hexToBytes(vectors.enroll_request.signed_hex);

  it('sends the request base64url with the code as typed', async () => {
    const { calls } = fakeFetch([{ status: 201, body: { request: 'sekrit', expires_in: 300 } }]);
    const secret = await postEnrollRequest(MAILBOX, request, 'k7pm-4xwe');
    expect(secret).toBe('sekrit');

    expect(calls[0]!.url).toBe('https://hl.example/identity/enroll/requests');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.request).toBe(bytesToBase64url(request));
    // As typed, lower case and hyphen and all: the server normalizes,
    // and doing it here too would mean two places to get it wrong.
    expect(body.code).toBe('k7pm-4xwe');
  });

  it('omits the code entirely for a renewal', async () => {
    const { calls } = fakeFetch([{ status: 201, body: { request: 's' } }]);
    await postEnrollRequest(MAILBOX, request, null);
    expect(JSON.parse(calls[0]!.init!.body as string)).not.toHaveProperty('code');
  });

  it('turns the wire codes into something a person can act on', async () => {
    fakeFetch([{ status: 404, body: { error: 'unknown_code' } }]);
    await expect(postEnrollRequest(MAILBOX, request, 'AAAA-AAAA')).rejects.toThrow(/expired, or already been used/);

    fakeFetch([{ status: 404, body: { error: 'no_holder' } }]);
    await expect(postEnrollRequest(MAILBOX, request, null)).rejects.toThrow(/hlid enroll/);

    // An error the client has no wording for still says the status
    // rather than nothing.
    fakeFetch([{ status: 500, body: {} }]);
    await expect(postEnrollRequest(MAILBOX, request, 'x')).rejects.toThrow(/HTTP 500/);
  });
});

describe('awaitAnswer', () => {
  it('keeps polling through 202s until the holder answers', async () => {
    // The server holds each request 30 seconds and answers 202 at the
    // deadline, so one human reading a prompt spans several polls.
    const { fn } = fakeFetch([
      { status: 202, body: { expires_in: 280 } },
      { status: 202, body: { expires_in: 250 } },
      { status: 200, body: { bundle: bytesToBase64url(Uint8Array.of(1, 2, 3)) } },
    ]);
    const answer = await awaitAnswer(MAILBOX, 'sekrit');
    expect(answer).toEqual({ kind: 'bundle', bundle: Uint8Array.of(1, 2, 3) });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('reports a denial with the reason, for the UI to show', async () => {
    fakeFetch([{ status: 403, body: { denied: 'not_mine' } }]);
    expect(await awaitAnswer(MAILBOX, 's')).toEqual({ kind: 'denied', reason: 'not_mine' });
  });

  it('reports a request that is gone without guessing why', async () => {
    // Expired and already-collected are the same 410 on purpose, so
    // this must not invent a distinction the server refused to make.
    fakeFetch([{ status: 410 }]);
    expect(await awaitAnswer(MAILBOX, 's')).toEqual({ kind: 'gone' });
  });

  it('stops when the caller aborts rather than polling on', async () => {
    const controller = new AbortController();
    controller.abort();
    fakeFetch([]);
    await expect(awaitAnswer(MAILBOX, 's', controller.signal)).rejects.toThrow(IdentityError);
  });
});
