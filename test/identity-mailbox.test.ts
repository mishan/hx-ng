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
  vi.useRealTimers();
});

/** A `fetch` that answers the same thing forever, and counts. */
function fetchAlways(reply: { status: number; body?: unknown }) {
  let calls = 0;
  vi.stubGlobal('fetch', async () => {
    calls += 1;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  });
  return () => calls;
}

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
    // Fake timers because a 202 now costs the poll gap, which an
    // honest long poll would have spent holding the request open.
    vi.useFakeTimers();
    const polling = awaitAnswer(MAILBOX, 'sekrit');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await polling).toEqual({ kind: 'bundle', bundle: Uint8Array.of(1, 2, 3) });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up on a mailbox that answers 202 for ever, without spinning', async () => {
    // §9: the mailbox is trusted with availability and nothing else, and
    // a proxy that does not understand a long poll answers 202 at once.
    // Unbounded, this loop pinned a core and flooded the network until
    // the tab was closed — and `tryAutoRenewal` runs it with no signal
    // to abort.
    vi.useFakeTimers();
    const calls = fetchAlways({ status: 202, body: {} });
    const polling = awaitAnswer(MAILBOX, 's');
    const settled = expect(polling).rejects.toThrow(/never answered/);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await settled;
    // One poll per second at most, rather than as fast as the event
    // loop will turn.
    expect(calls()).toBeLessThanOrEqual(11 * 60);
  });

  it('does not surface a raw SyntaxError when the answer is not JSON', async () => {
    // A proxy in front of the mailbox can answer 200 with an error
    // page. `res.json()` then rejects with the runtime's own
    // SyntaxError, which is what the user was shown.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    }) as unknown as Response);
    const err = await awaitAnswer(MAILBOX, 's').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect((err as Error).message).toMatch(/was not JSON/);
  });

  it('does not accept a 200 with no bundle in it', async () => {
    fakeFetch([{ status: 200, body: { expires_in: 30 } }]);
    const err = await awaitAnswer(MAILBOX, 's').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect((err as Error).message).toMatch(/no bundle/);
  });

  it('falls back to a plain refusal when 403 carries no reason', async () => {
    fakeFetch([{ status: 403, body: {} }]);
    expect(await awaitAnswer(MAILBOX, 's')).toEqual({ kind: 'denied', reason: 'refused' });
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

  it('reports an abort mid-flight the same way as one between polls', async () => {
    // The long poll is up to thirty seconds, so aborting *during* a
    // fetch is the ordinary case, not the edge one. It rejects with the
    // runtime's own AbortError, and a caller showing this to somebody
    // should not get two different shapes for one cancellation.
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort();
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        throw e;
      }),
    );
    const err = await awaitAnswer(MAILBOX, 's', controller.signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect((err as Error).message).toMatch(/cancelled/);
  });
});
