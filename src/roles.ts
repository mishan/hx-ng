/** Roles as the user list draws them (hxd-ng's docs/roles.md §8). */

import type { RoleShown, User } from '@hotline-ng/client';

/** Highest position first; the sort is stable, so a tie goes to the
 *  role the server listed first. `everyone` is left out: every account
 *  holds it, so it says nothing about anyone, and its color colors
 *  nobody (roles.md §8). */
function ranked(list: RoleShown[]): RoleShown[] {
  return list.filter((r) => r.name !== 'everyone').sort((a, b) => b.position - a.position);
}

/** The highest of `u`'s roles the list knows, or with `colored`, the
 *  highest that has a color. A name the list lacks is ignored: a
 *  `user_changed` can arrive before the `roles_changed` that adds it. */
export function highestRole(u: User, list: RoleShown[], colored = false): RoleShown | undefined {
  const held = new Set(u.roles ?? []);
  return ranked(list).find((r) => held.has(r.name) && (!colored || r.color !== undefined));
}

/** The color to draw `u`'s nick in: their own if they chose one, since a
 *  role's is only a default, and otherwise their highest colored role's. */
export function nickColorOf(u: User, list: RoleShown[] | null): number | undefined {
  return u.color ?? (list ? highestRole(u, list, true)?.color : undefined);
}

export interface RosterGroup {
  /** `null` for the users who hold no role in the list. */
  role: RoleShown | null;
  users: User[];
}

/** `users`, in the order given, grouped under each one's highest role,
 *  groups in position order and the roleless last. `null` when there is
 *  nothing to group by, and the list is drawn as one. */
export function groupByRole(users: User[], list: RoleShown[] | null): RosterGroup[] | null {
  if (!list) return null;
  const groups = new Map<RoleShown | null, User[]>([...ranked(list), null].map((r) => [r, []]));
  for (const u of users) groups.get(highestRole(u, list) ?? null)!.push(u);
  if (groups.get(null)!.length === users.length) return null;
  return [...groups].filter(([, us]) => us.length > 0).map(([role, us]) => ({ role, users: us }));
}
