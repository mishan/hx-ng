import { describe, expect, it } from 'vitest';

import type { AccountInfo } from '@hotline-ng/client';

import { draftOf, editParams, grantable, mayAdminister, toggle, unknownNames, type Draft } from '../src/accounts';

const eve: AccountInfo = {
  login: 'eve',
  name: 'Eve',
  password: true,
  access: ['read_chat', 'send_chat', 'flying'],
  raw_bits: [41],
};

const edited = (change: Partial<Draft>): Draft => ({ ...draftOf(eve), ...change });

describe('editParams', () => {
  it.each<[string, AccountInfo | null, Partial<Draft>, unknown]>([
    ['sends nothing when nothing changed', eve, {}, null],
    ['sends only the name when only it changed', eve, { name: 'Evelyn' }, { login: 'eve', name: 'Evelyn' }],
    ['keeps the name a blank box leaves', eve, { name: '  ' }, null],
    ['sends a typed password', eve, { password: 'pw' }, { login: 'eve', password: 'pw' }],
    ['clears the password as an empty one', eve, { clearPassword: true }, { login: 'eve', password: '' }],
    [
      'sends the whole bitmap, with the bits it cannot show, when access changed',
      eve,
      { access: new Set(['read_chat', 'flying']) },
      { login: 'eve', access: ['read_chat', 'flying'], raw_bits: [41] },
    ],
    [
      'sends everything for a new account, its login canonical',
      null,
      { login: ' Bob ', name: 'Bob', password: 'pw', access: new Set(['read_chat']) },
      { login: 'bob', name: 'Bob', password: 'pw', access: ['read_chat'] },
    ],
  ])('%s', (_, original, change, want) => {
    const draft = original ? edited(change) : { ...draftOf(null), ...change };
    expect(editParams(original, draft)).toEqual(want);
  });
});

describe('toggle', () => {
  it.each<[string, string[], string, boolean, string[]]>([
    ['moves history with chat when it follows, off', ['read_chat', 'read_chat_history'], 'read_chat', false, []],
    ['moves history with chat when it follows, on', [], 'read_chat', true, ['read_chat', 'read_chat_history']],
    ['leaves history set apart from chat alone', ['read_chat'], 'read_chat', false, []],
    ['moves nothing else', ['read_chat', 'read_chat_history'], 'send_chat', true, ['read_chat', 'read_chat_history', 'send_chat']],
    ['separates history when it is the one toggled', ['read_chat', 'read_chat_history'], 'read_chat_history', false, ['read_chat']],
  ])('%s', (_, had, name, on, want) => {
    const draft = { ...draftOf(null), access: new Set(had) };
    toggle(draft, name, on);
    expect([...draft.access].sort()).toEqual([...want].sort());
  });
});

describe('what this session may do', () => {
  it('offers the editor to whoever may read or make accounts, and grants only what it holds', () => {
    const editor = { access: ['read_users', 'modify_users', 'read_chat'], raw_bits: [] };
    expect(mayAdminister(editor)).toBe(true);
    expect(mayAdminister({ access: ['read_chat'], raw_bits: [] })).toBe(false);
    expect(mayAdminister(null)).toBe(false);
    expect(grantable(editor, 'read_chat')).toBe(true);
    expect(grantable(editor, 'disconnect_users')).toBe(false);
  });

  it('keeps names it has no label for', () => {
    expect(unknownNames(eve)).toEqual(['flying']);
  });
});
