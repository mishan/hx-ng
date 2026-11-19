/**
 * Pronouns on the client side (hxd-ng's `docs/hotline-ng.md` §7.3): the
 * value rule the server holds a set to, and the request that sets one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Connection, WireFailure, type Credentials } from '../src/connection';
import { pronounsValid } from '../src/pronouns';
import { CAP_PRONOUNS, type LoginOk } from '../src/protocol';

import { installFakeWire, uninstallFakeWire, type FakeServer } from './fake-wire';

const CREDS: Credentials = { url: 'ws://test/ng', login: 'alice', password: 'hunter2', nick: 'Alice', icon: 128 };

const loginOk = (): LoginOk => ({
  session: 's_1',
  token: 'tok',
  self: { uid: 1, nick: 'Alice', icon: 128, admin: false, status: 'active', transport: 'encrypted' },
  server: { name: 'Test', subject: '' },
  users: [],
  detach: { grace: 300 },
  caps: [CAP_PRONOUNS],
  seq: 0,
});

let server: FakeServer;

beforeEach(() => {
  server = installFakeWire();
  server.on('login', () => ({ ok: loginOk() }));
});

afterEach(() => uninstallFakeWire());

async function connect(): Promise<Connection> {
  const conn = new Connection(CREDS, {});
  await conn.start();
  return conn;
}

describe('a pronouns value', () => {
  it.each<[string, string, boolean]>([
    ['a plain one', 'she/her', true],
    ['one with single spaces', 'they / them', true],
    ['one in another script', '\u0647\u0648/\u0647\u064a', true],
    ['the longest', 'x'.repeat(32), true],
    ['one counted by character, not UTF-16 unit', '\u{1f308}'.repeat(32), true],
    ['one a character too long', 'x'.repeat(33), false],
    ['an empty one', '', false],
    ['all space', '   ', false],
    ['one with a space before', ' she/her', false],
    ['one with a space after', 'she/her ', false],
    ['one with two spaces in a row', 'she  her', false],
    ['one with a line break', 'she\nher', false],
    ['one with a tab', 'she\ther', false],
    ['one with a zero-width space', 'she\u200b/her', false],
    ['one with a bidi override', '\u202eshe/her', false],
    ['one with a no-break space', 'she\u00a0her', false],
    ['one with a lone surrogate', 'she/her\ud800', false],
  ])('is %s', (_, value, valid) => {
    expect(pronounsValid(value)).toBe(valid);
  });
});

describe('setPronouns', () => {
  it.each<[string, string | null]>([
    ['sets a value', 'she/her'],
    ['clears with null', null],
  ])('%s', async (_, value) => {
    server.on('pronouns', () => ({ ok: {} }));
    const conn = await connect();
    await expect(conn.setPronouns(value)).resolves.toEqual({});
    expect(server.sent('pronouns').map((f) => f.params)).toEqual([{ pronouns: value }]);
  });

  it('hands a refusal back with how long to wait', async () => {
    server.on('pronouns', () => ({ error: { code: 'rate_limited', text: 'Slow down.', retry_after: 7 } }));
    const conn = await connect();
    const failed = conn.setPronouns('she/her');
    await expect(failed).rejects.toBeInstanceOf(WireFailure);
    await expect(failed).rejects.toMatchObject({ wire: { code: 'rate_limited', retry_after: 7 } });
  });
});
