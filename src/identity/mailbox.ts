/**
 * The enrollee's side of hxd-ng's `docs/identity-enrollment.md` §5: post
 * a signed request under the code the user was shown, then wait for the
 * holder to answer.
 *
 * Everything here is delivery. The mailbox verifies nothing and is
 * trusted with nothing but availability (§9), so nothing this module
 * returns is believed on its own — `openBundle` checks the answer, and
 * the caller checks that the certificate names *this* browser's keys and
 * that the identity is the one it expected. What a hostile mailbox can
 * do is drop a request, delay one, or hand back a bundle for somebody
 * else, and the last of those is caught by the pinning in the panel
 * rather than by anything here.
 */

import { IdentityError, base64urlToBytes, bytesToBase64url } from '@hotline-ng/client';

/** §5.2's error codes, as a browser should put them to a user. The
 *  mailbox deliberately does not distinguish "no such code" from "that
 *  code was already used" — both are 404 `unknown_code`, so this cannot
 *  either, and the wording covers both without guessing. */
const POST_ERRORS: Record<string, string> = {
  unknown_code: 'That code is not open. It may have expired, or already been used — codes work once.',
  no_holder: 'Nothing is listening for this identity. Run `hlid enroll` and use the code it shows.',
  request_too_large: 'This enrollment request is too large for the server to accept.',
  bad_request: 'The server could not read this enrollment request.',
  rate_limited: 'Too many enrollment attempts from here. Wait a moment and try again.',
  too_many_sessions: 'The server is holding as many enrollments as it can. Try again shortly.',
};

export interface Mailbox {
  /** The absolute or page-relative base, e.g. `/identity/enroll`. */
  base: string;
}

/** `identity.endpoints.enroll` from discovery, or `null` when this
 *  server hosts no mailbox — which is not an error but a fact about the
 *  server, and the reason the paste box stays. */
export function mailboxFrom(httpBase: string, endpoint: string | undefined): Mailbox | null {
  return endpoint ? { base: `${httpBase}${endpoint}` } : null;
}

/** The mailbox is trusted with availability and nothing else (§9), and
 *  that includes being well-formed: a proxy in front of it can answer
 *  200 with an error page, and `res.json()` then rejects with the
 *  runtime's own `SyntaxError`, which is what the user would be shown.
 *  Every read of a body goes through here so the failure is one of ours. */
async function readJson<T>(res: Response, what: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new IdentityError('server-error', `the server's ${what} was not JSON (HTTP ${res.status})`);
  }
}

/**
 * The HTTP base for a host a QR code named (§5.6), which is where its
 * discovery document — and therefore its mailbox endpoint — is found.
 *
 * Page-relative when the scanned host is the one serving this page, which
 * is the ordinary deployment: the app and the server behind the same
 * name. That keeps the request same-origin, so it needs no CORS headers
 * and works in production through the reverse proxy that served the page,
 * and in `npm run dev` through Vite's proxy. Anything else is absolute
 * and cross-origin, and relies on the server's CORS headers.
 */
export function scannedBase(host: string): string {
  if (typeof location === 'undefined') return `https://${host}`;
  if (host === location.host || host === location.hostname) return '';
  return `${location.protocol}//${host}`;
}

async function errorFrom(res: Response, fallback: string): Promise<IdentityError> {
  let code: string | undefined;
  try {
    code = ((await res.json()) as { error?: string }).error;
  } catch {
    /* not JSON; the status is all there is */
  }
  const text = (code && POST_ERRORS[code]) ?? `${fallback} (HTTP ${res.status})`;
  return new IdentityError('server-error', text);
}

/** §5.2. `code` is what the user typed; it is sent as typed, since the
 *  server normalizes case, the display hyphen and Crockford's
 *  confusables for exactly this reason. */
export async function postEnrollRequest(
  mailbox: Mailbox,
  request: Uint8Array,
  code: string | null,
): Promise<string> {
  const body: Record<string, string> = { request: bytesToBase64url(request) };
  if (code !== null) body.code = code;
  const res = await fetch(`${mailbox.base}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res, 'the server refused this enrollment request');
  const { request: secret } = await readJson<{ request?: unknown }>(res, 'answer');
  if (typeof secret !== 'string' || !secret) {
    throw new IdentityError('server-error', 'the server accepted the request but returned no handle');
  }
  return secret;
}

function cancelled(): IdentityError {
  return new IdentityError('server-error', 'enrollment cancelled');
}

/**
 * How long `awaitAnswer` will keep asking before it gives up.
 *
 * A well-behaved mailbox ends this itself: the request lives five
 * minutes and the session ten, after which the answer is 410. But the
 * mailbox is exactly the party this module does not trust, and a
 * hostile one — or an ordinary proxy that does not understand a long
 * poll — can answer 202 forever. Ten minutes is the longest anything in
 * this flow legitimately takes, so past it there is nothing left to
 * wait for.
 */
const POLL_DEADLINE_MS = 10 * 60_000;

/**
 * The floor between two polls.
 *
 * §5.5's long poll is meant to hold for up to thirty seconds, so an
 * honest 202 costs one request per half-minute. A proxy that answers it
 * immediately turns the loop below into a spin that pins a core and
 * floods the network until the deadline; this makes that case merely
 * wasteful. It costs an honest server nothing, because an honest 202
 * has already taken far longer than this.
 */
const POLL_GAP_MS = 1_000;

/** `setTimeout` that settles early, and rejects, if `signal` aborts —
 *  so giving up during the gap is as prompt as giving up during a
 *  fetch. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type Answer =
  | { kind: 'bundle'; bundle: Uint8Array }
  | { kind: 'denied'; reason: string }
  | { kind: 'gone' };

/**
 * §5.5, long-polled. The server holds each request up to 30 seconds and
 * answers 202 at the deadline, so this loops rather than waiting once —
 * one call can span the whole time a human spends reading a prompt.
 *
 * `signal` is how the panel stops it: a user who closes the panel or
 * gives up should not leave a fetch loop running for ten minutes.
 */
export async function awaitAnswer(mailbox: Mailbox, secret: string, signal?: AbortSignal): Promise<Answer> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  for (;;) {
    if (signal?.aborted) throw cancelled();
    if (Date.now() >= deadline) {
      throw new IdentityError(
        'server-error',
        'the server never answered this enrollment request. Try again, or ask the holder for a new code.',
      );
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${mailbox.base}/requests/${encodeURIComponent(secret)}`, { signal });
    } catch (e) {
      // A poll aborted mid-flight rejects with the runtime's own
      // `AbortError`, which is a different type and a different message
      // from the one the caller gets when it aborts between polls.
      // Callers show these to people; one cancellation should not have
      // two shapes.
      if (signal?.aborted) throw cancelled();
      throw e;
    }
    if (res.status === 200) {
      const { bundle } = await readJson<{ bundle?: unknown }>(res, 'answer');
      if (typeof bundle !== 'string' || !bundle) {
        throw new IdentityError('server-error', 'the server answered this enrollment with no bundle');
      }
      return { kind: 'bundle', bundle: base64urlToBytes(bundle) };
    }
    if (res.status === 202) {
      // Still pending at the deadline. Only sleep for what is left of
      // the gap: an honest long poll has already spent it.
      const left = POLL_GAP_MS - (Date.now() - started);
      if (left > 0) await pause(left, signal);
      continue;
    }
    if (res.status === 403) {
      const { denied } = await readJson<{ denied?: unknown }>(res, 'refusal');
      return { kind: 'denied', reason: typeof denied === 'string' && denied ? denied : 'refused' };
    }
    // 410, and anything else: the request is gone, and the server will
    // not say whether it expired or was already collected.
    if (res.status === 410) return { kind: 'gone' };
    throw await errorFrom(res, 'the server would not answer this enrollment request');
  }
}
