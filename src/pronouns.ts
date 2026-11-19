/** Pronouns: what the settings field says before the server is asked,
 * and what it says after (hxd-ng's `docs/hotline-ng.md` §7.3).
 *
 * The check here is the server's own rule, for feedback as the field is
 * typed in; the server's answer is the one that counts.
 */

import { errorText, PRONOUNS_MAX_CHARS, pronounsValid, WireFailure } from '@hotline-ng/client';

/** Offered as quick picks into a free-text field, never as the only
 *  choices. */
export const PRONOUN_SUGGESTIONS = ['she/her', 'he/him', 'they/them'] as const;

/** Why the server would refuse `value`, in words, or null if it would
 *  take it. Empty is no problem: it clears them. */
export function pronounsProblem(value: string): string | null {
  if (value === '' || pronounsValid(value)) return null;
  if ([...value].length > PRONOUNS_MAX_CHARS) return `At most ${PRONOUNS_MAX_CHARS} characters.`;
  if (value.trim() === '') return 'Type something other than spaces, or leave it empty for none.';
  if (value.trim() !== value) return 'No space at either end.';
  if (value.includes('  ')) return 'No two spaces in a row.';
  return 'No line breaks, tabs, or invisible characters.';
}

/** A refused `pronouns` request, in plain words. */
export function pronounsRefusal(e: unknown): string {
  if (!(e instanceof WireFailure)) return 'Your pronouns could not be saved. Check the connection and try again.';
  switch (e.wire.code) {
    case 'rate_limited': {
      const s = e.wire.retry_after;
      return s === undefined
        ? 'You changed your pronouns a moment ago. Wait a little and try again.'
        : `You changed your pronouns a moment ago. Try again in ${s} ${s === 1 ? 'second' : 'seconds'}.`;
    }
    case 'access_denied':
      return 'This account may not set pronouns here. A guest login keeps none.';
    case 'not_available':
      return 'This server does not show pronouns.';
    case 'bad_request':
      return `The server would not take those: 1 to ${PRONOUNS_MAX_CHARS} characters, with no line breaks, invisible characters, doubled spaces, or space at either end.`;
    default:
      return errorText(e.wire);
  }
}
