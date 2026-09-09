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
  const { request: secret } = (await res.json()) as { request: string };
  if (!secret) throw new IdentityError('server-error', 'the server accepted the request but returned no handle');
  return secret;
}

function cancelled(): IdentityError {
  return new IdentityError('server-error', 'enrollment cancelled');
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
  for (;;) {
    if (signal?.aborted) throw cancelled();
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
      const { bundle } = (await res.json()) as { bundle: string };
      return { kind: 'bundle', bundle: base64urlToBytes(bundle) };
    }
    if (res.status === 202) continue; // still pending at the deadline
    if (res.status === 403) {
      const { denied } = (await res.json()) as { denied?: string };
      return { kind: 'denied', reason: denied ?? 'refused' };
    }
    // 410, and anything else: the request is gone, and the server will
    // not say whether it expired or was already collected.
    if (res.status === 410) return { kind: 'gone' };
    throw await errorFrom(res, 'the server would not answer this enrollment request');
  }
}
