/**
 * Pronouns (hxd-ng's `docs/hotline-ng.md` §7.3): the rule a value is held
 * to, the server's, so a client can say what is wrong before it asks.
 * The server's answer is still the one that counts.
 */

import { hasDeceptiveChar } from './names.js';

/** The longest value, in characters (Unicode scalar values). */
export const PRONOUNS_MAX_CHARS = 32;

/** Whether the server would take `value` as someone's pronouns: 1 to
 *  `PRONOUNS_MAX_CHARS` characters held to a display name's rules (no
 *  space at either end, not all space, nothing invisible or a control),
 *  and never two spaces in a row, which a classic client's Get User Info
 *  could wrap into what looks like a line of its own. A lone surrogate
 *  is refused too: it is no JSON a server reads, and one that cannot
 *  read a request closes the connection over it. A value that fails
 *  is refused, never cut: a cut pronoun set misstates its user. */
export function pronounsValid(value: string): boolean {
  return (
    [...value].length <= PRONOUNS_MAX_CHARS &&
    value.trim() !== '' &&
    value.trim() === value &&
    !hasDeceptiveChar(value) &&
    !/\p{Cs}/u.test(value) &&
    !value.includes('  ')
  );
}
