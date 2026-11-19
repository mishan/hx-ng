import { describe, expect, it } from 'vitest';

import { WireFailure } from '@hotline-ng/client';

import { pronounsProblem, pronounsRefusal } from '../src/pronouns';

describe('what the pronouns field says before asking', () => {
  it.each<[string, string, RegExp | null]>([
    ['nothing for a value the server takes', 'she/her', null],
    ['nothing for empty, which clears them', '', null],
    ['the length for one too long', 'x'.repeat(33), /at most 32 characters/i],
    ['to type something for all space', '  ', /other than spaces/],
    ['no space at the ends for one ending in a space', 'she/her ', /either end/],
    ['no doubled spaces for one with two in a row', 'she  her', /two spaces in a row/],
    ['what is hidden for one with a zero-width space', 'she\u200b/her', /invisible/],
  ])('says %s', (_, value, want) => {
    const said = pronounsProblem(value);
    if (want === null) expect(said).toBeNull();
    else expect(said).toMatch(want);
  });
});

describe("the server's refusal, in words", () => {
  const refused = (code: string, retry_after?: number) =>
    new WireFailure(retry_after === undefined ? { code, text: 'x' } : { code, text: 'x', retry_after });

  it.each<[string, unknown, RegExp]>([
    ['how long to wait', refused('rate_limited', 7), /try again in 7 seconds/i],
    ['one second as one', refused('rate_limited', 1), /try again in 1 second\./i],
    ['to wait, when it says no time', refused('rate_limited'), /wait a little/i],
    ['why an account may not', refused('access_denied'), /may not set pronouns/],
    ['that the server shows none', refused('not_available'), /does not show pronouns/],
    ['the rule, for a value it would not take', refused('bad_request'), /1 to 32 characters/],
    ['to check the connection, for a failure off the wire', new Error('closed'), /check the connection/i],
  ])('says %s', (_, e, want) => {
    expect(pronounsRefusal(e)).toMatch(want);
  });
});
