import { describe, expect, it } from 'vitest';

import type { AccountInfo, Role } from '@hotline-ng/client';

import {
  draftOf,
  editParams,
  gives,
  grantable,
  inherited,
  isOn,
  mayAdminister,
  mayGive,
  roleDraftOf,
  roleGives,
  roleParams,
  source,
  toggle,
  toggleOwn,
  unknownNames,
  type Draft,
  type Inherited,
  type Own,
  type RoleDraft,
} from '../src/accounts';

const eve: AccountInfo = {
  login: 'eve',
  name: 'Eve',
  password: true,
  access: ['read_chat', 'send_chat', 'flying'],
  raw_bits: [41],
};

describe('editParams', () => {
  it.each<[string, AccountInfo | null, Partial<Draft>, unknown]>([
    ['sends nothing when nothing changed', eve, {}, null],
    ['leaves a name it was not asked to touch as it is', { ...eve, name: ' Eve ' }, { password: 'pw' }, { login: 'eve', password: 'pw' }],
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
    const draft = { ...draftOf(original), ...change };
    expect(editParams(original, draft)).toEqual(want);
  });
});

const carol: AccountInfo = {
  login: 'carol',
  name: 'Carol',
  password: true,
  access: ['read_chat', 'send_chat', 'upload_files'],
  raw_bits: [41],
  roles: ['regulars'],
  grant: ['upload_files'],
  deny: ['send_media'],
  raw_grant: [41],
  raw_deny: [],
};

describe('editParams with roles', () => {
  const own = (o: Partial<Own>) => ({ ...draftOf(carol).own!, ...o });
  it.each<[string, AccountInfo | null, (d: Draft) => Partial<Draft>, unknown]>([
    ['sends nothing when nothing changed', carol, () => ({}), null],
    [
      'sends only the roles when only they changed',
      carol,
      () => ({ own: own({ roles: new Set(['regulars', 'moderators']) }) }),
      { login: 'carol', roles: ['regulars', 'moderators'] },
    ],
    [
      'sends all four own-key lists, never access, when one changed',
      carol,
      () => ({ own: own({ deny: new Set() }) }),
      { login: 'carol', grant: ['upload_files'], deny: [], raw_grant: [41], raw_deny: [] },
    ],
    [
      'leaves the own keys alone when only access, which it does not edit, differs',
      carol,
      (d) => ({ access: new Set([...d.access, 'delete_files']) }),
      null,
    ],
    [
      'sends roles and own keys for a new account',
      null,
      (d) => ({ login: 'dan', own: { ...d.own!, roles: new Set(['regulars']), grant: new Set(['send_media']) } }),
      { login: 'dan', roles: ['regulars'], grant: ['send_media'], deny: [], raw_grant: [], raw_deny: [] },
    ],
  ])('%s', (_, original, change, want) => {
    const base = draftOf(original, true);
    expect(editParams(original, { ...base, ...change(base) })).toEqual(want);
  });

  it('edits access, as before roles, on a server without them', () => {
    expect(draftOf(null).own).toBeNull();
    expect(draftOf(eve, true).own).toBeNull();
    expect(editParams(null, { ...draftOf(null), login: 'dan', access: new Set(['read_chat']) })).toEqual({
      login: 'dan',
      access: ['read_chat'],
    });
  });
});

describe('where a bit comes from', () => {
  const mine = { access: ['read_chat', 'read_chat_history', 'send_chat', 'upload_files', 'read_news'], raw_bits: [] };
  const from: Inherited = { bits: new Set(['read_chat', 'send_chat']), sure: true };
  const own = (grant: string[], deny: string[]): Own => ({
    roles: new Set(),
    grant: new Set(grant),
    deny: new Set(deny),
    raw_grant: [],
    raw_deny: [],
  });
  it.each<[string, Own, Inherited, string, string]>([
    ['a role', own([], []), from, 'send_chat', 'role'],
    ['roles, unsaid without a list', own([], []), { ...from, sure: false }, 'send_chat', 'inherited'],
    ['the account, granting', own(['upload_files'], []), from, 'upload_files', 'granted'],
    ['the account, granting what a role does too', own(['send_chat'], []), from, 'send_chat', 'granted'],
    ['the account, denying what a role grants', own([], ['send_chat']), from, 'send_chat', 'denied'],
    ['nowhere', own([], []), from, 'upload_files', 'off'],
    ['reading chat, for history nothing names', own([], []), from, 'read_chat_history', 'follows'],
    ['nowhere, for history once chat is denied', own([], ['read_chat']), from, 'read_chat_history', 'off'],
  ])('%s', (_, o, f, name, want) => {
    expect(source(o, name, f)).toBe(want);
  });

  it.each<[string, string[], string[], string, boolean, string[], string[]]>([
    ['grants what no role does', [], [], 'upload_files', true, ['upload_files'], []],
    ['denies what a role grants', [], [], 'send_chat', false, [], ['send_chat']],
    ['drops a denial a role then makes good', [], ['send_chat'], 'send_chat', true, [], []],
    ['drops a grant, back to off', ['upload_files'], [], 'upload_files', false, [], []],
    ['denies history that follows chat', [], [], 'read_chat_history', false, [], ['read_chat_history']],
  ])('ticking %s', (_, grant, deny, name, on, wantGrant, wantDeny) => {
    const o = own(grant, deny);
    toggleOwn(o, name, on, from, null, mine);
    expect([[...o.grant], [...o.deny]]).toEqual([wantGrant, wantDeny]);
    expect(isOn(source(o, name, from))).toBe(on);
  });

  it('takes history that follows chat with it when chat is unticked', () => {
    const o = own([], []);
    toggleOwn(o, 'read_chat', false, from, null, mine);
    expect(source(o, 'read_chat_history', from)).toBe('off');
  });

  it.each<[string, string[], string[]]>([
    ['leaves history following chat for a session that may grant it', ['read_chat', 'read_chat_history'], []],
    ['denies history a session may not grant, as ticking chat would give it', ['read_chat'], ['read_chat_history']],
  ])('ticking Read chat %s', (_, held, wantDeny) => {
    const o = own([], []);
    toggleOwn(o, 'read_chat', true, { bits: new Set(), sure: true }, null, { access: held, raw_bits: [] });
    expect([[...o.grant], [...o.deny]]).toEqual([['read_chat'], wantDeny]);
  });

  it('keeps a key the account was opened with when it is ticked back', () => {
    const o = draftOf(carol).own!;
    const f: Inherited = { bits: new Set(['upload_files']), sure: true };
    toggleOwn(o, 'upload_files', false, f, carol, mine);
    toggleOwn(o, 'upload_files', true, f, carol, mine);
    expect(editParams(carol, { ...draftOf(carol), own: o })).toBeNull();
  });

  const role = (name: string, access: string[], raw_bits: number[] = []): Role => ({
    name,
    title: name,
    position: 0,
    access,
    raw_bits,
    extra: [],
  });
  const list = [
    role('everyone', ['read_news']),
    role('regulars', ['upload_files', 'send_media']),
    role('staff', ['disconnect_users']),
  ];
  // By the account, Carol's roles give `send_chat` and not `read_news`:
  // grants changed since the list was fetched.
  it.each<[string, string[], Role[] | null, AccountInfo | null, string[], boolean]>([
    ['what the account came to with no key of its own, over a list that disagrees', ['regulars'], list, carol, ['read_chat', 'send_chat', 'send_media', 'upload_files'], true],
    ['and what a role added gives, from the list', ['regulars', 'staff'], list, carol, ['disconnect_users', 'read_chat', 'send_chat', 'send_media', 'upload_files'], true],
    ['less what only a role taken away gave, by the list', [], list, { ...carol, access: [...carol.access, 'send_media'], deny: [] }, ['read_chat', 'send_chat'], true],
    ['for a new account, everyone and its roles from the list', ['regulars'], list, null, ['read_news', 'send_media', 'upload_files'], true],
    ['without a list, the account alone', ['regulars'], null, carol, ['read_chat', 'send_chat'], false],
    ['without a list, nothing for a new account', ['regulars'], null, null, [], false],
  ])('roles give %s', (_, roles, l, account, want, sure) => {
    const o = { ...draftOf(account, true).own!, roles: new Set(roles) };
    const got = inherited(o, l, account);
    expect([[...got.bits].sort(), got.sure]).toEqual([want, sure]);
  });

  it.each<[string, Partial<AccountInfo>]>([
    ['chat from roles', {}],
    ['chat the account grants itself', { grant: ['read_chat', 'upload_files'] }],
  ])('does not count history that may be following %s, without a list', (_, change) => {
    const account = { ...carol, access: [...carol.access, 'read_chat_history'], ...change };
    const o = draftOf(account).own!;
    const f = inherited(o, null, account);
    expect(f.bits.has('read_chat_history')).toBe(false);
    toggleOwn(o, 'read_chat', false, f, account, mine);
    expect(source(o, 'read_chat_history', f)).toBe('off');
  });

  it('writes only what was ticked for a new account, without a list', () => {
    const draft = { ...draftOf(null, true), login: 'dan' };
    const f = inherited(draft.own!, null, null);
    toggleOwn(draft.own!, 'read_news', true, f, null, mine);
    expect(editParams(null, draft)).toEqual({ login: 'dan', roles: [], grant: ['read_news'], deny: [], raw_grant: [], raw_deny: [] });
  });

  it.each<[string, Role | undefined, boolean]>([
    ['a role granting only what this session holds', role('regulars', ['upload_files']), true],
    ['not one granting a bit it lacks', role('staff', ['disconnect_users']), false],
    ['not one granting a raw bit it lacks', role('odd', [], [41]), false],
    ['one it knows nothing of, for the server to judge', undefined, true],
  ])('gives %s', (_, r, want) => {
    expect(mayGive({ access: ['upload_files'], raw_bits: [] }, r)).toBe(want);
  });

  it.each<[string, (d: Draft) => void, boolean]>([
    ['gives nothing by a rename', (d) => (d.name = 'C'), false],
    ['gives nothing by taking a role and a grant away', (d) => (d.own!.roles.clear(), d.own!.grant.clear()), false],
    ['gives a role', (d) => d.own!.roles.add('staff'), true],
    ['gives a bit by granting it', (d) => d.own!.grant.add('delete_files'), true],
    ['gives a bit by lifting a denial', (d) => d.own!.deny.clear(), true],
  ])('an edit that %s', (_, change, want) => {
    const d = draftOf(carol);
    change(d);
    expect(gives(carol, d)).toBe(want);
  });
});

describe('roleParams', () => {
  const staff: Role = {
    name: 'staff',
    title: 'Staff',
    color: 0x2e8b57,
    position: 20,
    mentionable: true,
    access: ['disconnect_users'],
    raw_bits: [41],
    extra: ['moderate'],
  };
  it.each<[string, Role | null, Partial<RoleDraft>, unknown]>([
    ['sends nothing when nothing changed', staff, {}, null],
    ['clears the color as null', staff, { color: null }, { name: 'staff', color: null }],
    [
      'sends what changed and nothing else',
      staff,
      { position: 5, mentionable: false, extra: new Set() },
      { name: 'staff', position: 5, mentionable: false, extra: [] },
    ],
    [
      'sends the grants, with the bits it cannot show, when they changed',
      staff,
      { access: new Set(['disconnect_users', 'get_user_info']) },
      { name: 'staff', access: ['disconnect_users', 'get_user_info'], raw_bits: [41] },
    ],
    [
      'sends a new role with its name canonical and no defaults spelled out',
      null,
      { name: ' Mods ', access: new Set(['get_user_info']) },
      { name: 'mods', access: ['get_user_info'], extra: [] },
    ],
    [
      'sends what a new role was given',
      null,
      { name: 'mods', title: 'Mods', color: 0, position: 3, mentionable: true },
      { name: 'mods', title: 'Mods', color: 0, position: 3, mentionable: true, access: [], extra: [] },
    ],
  ])('%s', (_, original, change, want) => {
    expect(roleParams(original, { ...roleDraftOf(original), ...change })).toEqual(want);
  });

  it.each<[string, Partial<RoleDraft>, boolean]>([
    ['gives nothing by a new title or a grant taken away', { title: 'Crew', access: new Set() }, false],
    ['gives a bit', { access: new Set(['disconnect_users', 'get_user_info']) }, true],
    ['gives an extra key', { extra: new Set(['moderate', 'can_spam']) }, true],
  ])('an edit that %s', (_, change, want) => {
    expect(roleGives(staff, { ...roleDraftOf(staff), ...change })).toBe(want);
  });
});

describe('toggle', () => {
  const all = ['read_chat', 'read_chat_history', 'send_chat'];
  it.each<[string, string[], string, boolean, string[], string[]]>([
    ['moves history with chat when it follows, off', ['read_chat', 'read_chat_history'], 'read_chat', false, all, []],
    ['moves history with chat when it follows, on', [], 'read_chat', true, all, ['read_chat', 'read_chat_history']],
    ['leaves history set apart from chat alone', ['read_chat'], 'read_chat', false, all, []],
    ['moves nothing else', ['read_chat', 'read_chat_history'], 'send_chat', true, all, ['read_chat', 'read_chat_history', 'send_chat']],
    ['separates history when it is the one toggled', ['read_chat', 'read_chat_history'], 'read_chat_history', false, all, ['read_chat']],
    ['moves no history this session may not grant', [], 'read_chat', true, ['read_chat'], ['read_chat']],
  ])('%s', (_, had, name, on, mine, want) => {
    const draft = { ...draftOf(null), access: new Set(had) };
    toggle(draft, name, on, { access: mine, raw_bits: [] });
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
