/**
 * The `#enroll=…` fragment a QR code carries (hxd-ng's
 * `docs/identity-enrollment.md` §5.6).
 *
 * A phone camera opens this client with four fields filled in, and each
 * does a different job:
 *
 * - `enroll` and `mailbox` mean the user types nothing and cannot point
 *   their phone at the wrong server.
 * - `identity` means this browser pins the fingerprint it *expects*
 *   before it asks, rather than learning it from the answer. With a
 *   typed code, a mailbox handing back a bundle for a different identity
 *   is caught only after the fact, by comparing against what this
 *   browser was enrolled with before — which does nothing on a first
 *   enrollment. Pinning up front closes that.
 * - `pair` is folded into the request as a keyed tag, proving to the
 *   holder that this request came from whoever scanned its screen. The
 *   holder refuses one that does not verify without showing it to
 *   anyone, and the mailbox never saw the secret, so it cannot mint one.
 *
 * It is in the *fragment* and not the query deliberately: browsers do
 * not send a fragment to the server, so the pairing secret never reaches
 * an access log. This module clears it from the address bar once read,
 * for the same reason — a URL that stays in the bar gets shared,
 * bookmarked, and restored by the next session.
 */

import { IdentityError, base64urlToBytes } from '@hotline-ng/client';

/** §5.6's pairing secret: 16 bytes, base64url. */
const PAIRING_SECRET_BYTES = 16;

export interface Scanned {
  code: string;
  /** The mailbox's host, as the holder displayed it. */
  mailbox: string;
  /** The identity fingerprint to pin before asking. */
  identity: string;
  pairingSecret: Uint8Array;
}

/**
 * Parse a fragment. `null` for one that carries no `enroll` — the
 * ordinary case of a page opened by hand.
 *
 * A fragment that has `enroll` but is malformed in any other way throws
 * rather than degrading to the typed path: it means a QR code was
 * scanned and something is wrong with it, and silently dropping the
 * pinned identity and the pairing proof would quietly turn the stronger
 * ceremony into the weaker one.
 */
export function parseScanFragment(fragment: string): Scanned | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const code = params.get('enroll');
  if (!code) return null;

  const mailbox = params.get('mailbox');
  const identity = params.get('identity');
  const pair = params.get('pair');
  if (!mailbox || !identity || !pair) {
    throw new IdentityError('bad-field', 'this enrollment link is incomplete — scan the code again');
  }
  // 52 Crockford digits, the form `Fingerprint` prints.
  if (!/^[0-9a-hjkmnp-tv-z]{52}$/.test(identity)) {
    throw new IdentityError('bad-field', 'this enrollment link names a malformed identity');
  }
  let pairingSecret: Uint8Array;
  try {
    pairingSecret = base64urlToBytes(pair);
  } catch {
    throw new IdentityError('bad-field', 'this enrollment link has a malformed pairing secret');
  }
  if (pairingSecret.length !== PAIRING_SECRET_BYTES) {
    throw new IdentityError('bad-field', 'this enrollment link has a pairing secret of the wrong size');
  }
  return { code, mailbox, identity, pairingSecret };
}

/**
 * Read the fragment this page was opened with, and take it out of the
 * address bar.
 *
 * Removing it is the point of doing this once at startup rather than
 * reading `location.hash` where it is needed: the secret should not
 * survive a copied URL, a bookmark, or a reload. `replaceState` rather
 * than assigning `location.hash`, which would push a history entry and
 * leave the fragment one Back button away.
 */
export function takeScanFragment(): Scanned | null {
  if (typeof location === 'undefined') return null;
  const raw = location.hash;
  if (!raw || !raw.includes('enroll=')) return null;
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  } catch {
    // A sandboxed frame with no session history. Not a reason to refuse
    // the enrollment; the caller still gets the fields.
  }
  return parseScanFragment(raw);
}
