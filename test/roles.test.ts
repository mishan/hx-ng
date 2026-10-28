import { describe, expect, it } from 'vitest';

import type { RoleShown, User } from '@hotline-ng/client';

import { groupByRole, highestRole, nickColorOf } from '../src/roles';

const person = (uid: number, nick: string, over: Partial<User> = {}): User => ({
  uid,
  nick,
  icon: 128,
  admin: false,
  status: 'active',
  transport: 'encrypted',
  ...over,
});

const mods: RoleShown = { name: 'mods', title: 'Moderators', position: 20, color: 0x2e8b57 };
const regulars: RoleShown = { name: 'regulars', title: 'Regulars', position: 10 };
const helpers: RoleShown = { name: 'helpers', title: 'Helpers', position: 10, color: 0x4169e1 };
const friends: RoleShown = { name: 'friends', title: 'Friends', position: 5, color: 0xdaa520 };
// Listed lowest first, so position rather than the list's order decides.
const list = [friends, regulars, helpers, mods];

describe("a user's highest role", () => {
  it.each<[string, string[] | undefined, boolean, RoleShown | undefined]>([
    ['is the highest position held', ['friends', 'mods'], false, mods],
    ['goes on a tie to the role listed first', ['helpers', 'regulars'], false, regulars],
    ['skips an uncolored role when a color is wanted', ['regulars', 'helpers'], true, helpers],
    ['ignores a name the list does not have', ['ghosts', 'friends'], false, friends],
    ['is none for a user holding no role', undefined, false, undefined],
    ['is none when every role held is uncolored and a color is wanted', ['regulars'], true, undefined],
  ])('%s', (_, roles, colored, want) => {
    expect(highestRole(person(1, 'a', roles ? { roles } : {}), list, colored)).toBe(want);
  });
});

describe("a nick's color", () => {
  it.each<[string, Partial<User>, RoleShown[] | null, number | undefined]>([
    ["is the user's own over any role's", { color: 0xff0000, roles: ['mods'] }, list, 0xff0000],
    ["is the highest colored role's for one who chose none", { roles: ['regulars', 'friends'] }, list, 0xdaa520],
    ['is none with no colored role', { roles: ['regulars'] }, list, undefined],
    ["is the user's own on a server with no roles", { color: 0x00ff00 }, null, 0x00ff00],
    ['is none on a server with no roles for one who chose none', {}, null, undefined],
    [
      "is never everyone's, which every account holds",
      { roles: ['everyone'] },
      [...list, { name: 'everyone', title: 'everyone', position: 99, color: 0x123456 }],
      undefined,
    ],
  ])('%s', (_, over, roles, want) => {
    expect(nickColorOf(person(1, 'a', over), roles)).toBe(want);
  });
});

describe('the user list grouped by role', () => {
  const ann = person(1, 'ann', { roles: ['mods', 'friends'] });
  const bob = person(2, 'bob');
  const cat = person(3, 'cat', { roles: ['friends'] });
  const dan = person(4, 'dan', { roles: ['mods'] });

  it('groups under each highest role in position order, the roleless last, keeping the order given', () => {
    expect(groupByRole([ann, bob, cat, dan], list)).toEqual([
      { role: mods, users: [ann, dan] },
      { role: friends, users: [cat] },
      { role: null, users: [bob] },
    ]);
  });

  it.each<[string, User[], RoleShown[] | null]>([
    ['on a server with no roles', [ann, bob], null],
    ['when nobody holds a role', [bob, person(5, 'eve', { roles: ['ghosts'] })], list],
    ['with nobody here', [], list],
  ])('is not drawn %s', (_, users, roles) => {
    expect(groupByRole(users, roles)).toBeNull();
  });
});
