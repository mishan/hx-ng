/** Account administration's logic, apart from the DOM: what each access
 * name means, what this session may do, and what an edit sends
 * (hxd-ng's `docs/account-admin.md` §5).
 */

import type { AccessSet, AccountEditParams, AccountInfo, Role, RoleEditParams } from '@hotline-ng/client';

/** Every access name the editor knows, grouped as hxd-ng's
 *  `access-bits.md` groups them, with the classic editors' wording. A
 *  name the server sends that is not here is still kept and sent back;
 *  it is listed under "Other". */
export const ACCESS_GROUPS: { title: string; bits: [name: string, label: string][] }[] = [
  {
    title: 'Files',
    bits: [
      ['download_files', 'Download files'],
      ['upload_files', 'Upload files'],
      ['upload_anywhere', 'Upload anywhere'],
      ['delete_files', 'Delete files'],
      ['rename_files', 'Rename files'],
      ['move_files', 'Move files'],
      ['comment_files', 'Comment files'],
      ['create_folders', 'Create folders'],
      ['delete_folders', 'Delete folders'],
      ['rename_folders', 'Rename folders'],
      ['move_folders', 'Move folders'],
      ['comment_folders', 'Comment folders'],
      ['download_folders', 'Download folders'],
      ['upload_folders', 'Upload folders'],
      ['view_drop_boxes', 'View drop boxes'],
      ['make_aliases', 'Make aliases'],
    ],
  },
  {
    title: 'Chat and messages',
    bits: [
      ['read_chat', 'Read chat'],
      ['send_chat', 'Send chat'],
      ['read_chat_history', 'Read chat history'],
      ['create_pchats', 'Open private chats'],
      ['send_msgs', 'Send private messages'],
      ['send_media', 'Post images'],
      ['can_broadcast', 'Broadcast'],
    ],
  },
  {
    title: 'News',
    bits: [
      ['read_news', 'Read news'],
      ['post_news', 'Post news'],
      ['delete_articles', 'Delete articles'],
      ['create_categories', 'Create categories'],
      ['delete_categories', 'Delete categories'],
      ['create_news_bundles', 'Create bundles'],
      ['delete_news_bundles', 'Delete bundles'],
    ],
  },
  {
    title: 'Voice and video',
    bits: [
      ['voice_chat', 'Voice chat'],
      ['video_chat', 'Camera'],
      ['screen_share', 'Share screen'],
    ],
  },
  {
    title: 'Users',
    bits: [
      ['get_user_info', 'Get user info'],
      ['use_any_name', 'Use any name'],
      ['dont_show_agreement', 'Skip the agreement'],
      ['disconnect_users', 'Disconnect users'],
      ['cant_be_disconnected', 'Cannot be disconnected'],
      ['read_users', 'Read accounts'],
      ['create_users', 'Create accounts'],
      ['modify_users', 'Modify accounts'],
      ['delete_users', 'Delete accounts'],
    ],
  },
];

const KNOWN = new Set(ACCESS_GROUPS.flatMap((g) => g.bits.map(([name]) => name)));

/** Names an account holds that the editor has no label for. */
export function unknownNames(set: AccessSet): string[] {
  return set.access.filter((name) => !KNOWN.has(name));
}

/** What this session may do to accounts. */
export interface Powers {
  read: boolean;
  create: boolean;
  modify: boolean;
  delete: boolean;
}

export function powers(mine: AccessSet | null): Powers {
  const has = (name: string) => !!mine?.access.includes(name);
  return { read: has('read_users'), create: has('create_users'), modify: has('modify_users'), delete: has('delete_users') };
}

/** Whether to offer the editor at all. */
export function mayAdminister(mine: AccessSet | null): boolean {
  const p = powers(mine);
  return p.read || p.create;
}

/** May this session give an account `name`? The server refuses a grant
 *  of anything the granter does not hold (`outranked`), so the editor
 *  does not offer one. */
export function grantable(mine: AccessSet | null, name: string): boolean {
  return !!mine?.access.includes(name);
}

/** What the editor holds while it is open. */
export interface Draft {
  login: string;
  name: string;
  /** Typed into the password box; empty leaves the password as it is. */
  password: string;
  /** Clear the password rather than set one. */
  clearPassword: boolean;
  access: Set<string>;
  /** On a server with roles: what the editor changes in place of
   *  `access`. `null` without them. */
  own: Own | null;
}

/** An account's roles, and the keys its own record sets over them
 *  (hxd-ng's `docs/roles.md` §3). */
export interface Own {
  roles: Set<string>;
  grant: Set<string>;
  deny: Set<string>;
  /** Not shown, so sent back as they were. */
  raw_grant: number[];
  raw_deny: number[];
}

/** `roles` says the server has them, which an account it sends says
 *  for itself by carrying `grant`. */
export function draftOf(account: AccountInfo | null, roles = false): Draft {
  const own = account ? account.grant !== undefined : roles;
  return {
    login: account?.login ?? '',
    name: account?.name ?? '',
    password: '',
    clearPassword: false,
    access: new Set(account?.access ?? []),
    own: own
      ? {
          roles: new Set(account?.roles ?? []),
          grant: new Set(account?.grant ?? []),
          deny: new Set(account?.deny ?? []),
          raw_grant: account?.raw_grant ?? [],
          raw_deny: account?.raw_deny ?? [],
        }
      : null,
  };
}

const HISTORY = 'read_chat_history';

/** What an account's roles give it, as far as this client can tell:
 *  `sure` when the server's role list says so. */
export interface Inherited {
  bits: Set<string>;
  sure: boolean;
}

/**
 * What the roles in `own` give the account `original` was opened as.
 * The account is the authority on what its roles gave it then: a role's
 * grants change without telling anyone but its holders, so the list can
 * be older. The list says only what the account cannot: what roles added
 * or taken away in the draft change, and whether roles give a bit the
 * account sets itself, or chat history, which may only be following
 * chat. Without a list, the account alone, and for a new one nothing.
 */
export function inherited(own: Own, list: Role[] | null, original: AccountInfo | null): Inherited {
  const pinned = (n: string) => !!(original?.grant?.includes(n) || original?.deny?.includes(n));
  const opened = new Set((original?.access ?? []).filter((n) => !pinned(n)));
  if (!list) {
    if (original?.access.includes('read_chat')) opened.delete(HISTORY);
    return { bits: opened, sure: false };
  }
  const grants = (names: string[]) => new Set(list.filter((r) => names.includes(r.name)).flatMap((r) => r.access));
  const held = original?.roles ?? [];
  const kept = grants(['everyone', ...held.filter((r) => own.roles.has(r))]);
  const added = grants([...own.roles].filter((r) => !held.includes(r)));
  const removed = grants(held.filter((r) => !own.roles.has(r)));
  const bits = new Set<string>();
  for (const n of new Set([...opened, ...kept, ...added])) {
    const byList = !original || pinned(n) || n === HISTORY;
    if (added.has(n) || (byList ? kept.has(n) : opened.has(n) && (kept.has(n) || !removed.has(n)))) bits.add(n);
  }
  return { bits, sure: true };
}

/** Where a bit's state comes from. `inherited` is from roles by the
 *  account alone, without a list to say so; `follows` is chat history
 *  that nothing names, which goes with reading chat. */
export type Source = 'role' | 'inherited' | 'granted' | 'denied' | 'follows' | 'off';

export function source(own: Own, name: string, from: Inherited): Source {
  if (own.grant.has(name)) return 'granted';
  if (own.deny.has(name)) return 'denied';
  if (from.bits.has(name)) return from.sure ? 'role' : 'inherited';
  if (name === HISTORY && isOn(source(own, 'read_chat', from))) return 'follows';
  return 'off';
}

export const isOn = (s: Source): boolean => s !== 'denied' && s !== 'off';

/** Tick or untick `name` as the account's own key, setting one only
 *  where its roles do not already say the same, as the server keeps
 *  them. A key the account was opened with, ticked back to what it
 *  said, stays: whoever set it may have meant it to outlast a role.
 *  History that would follow chat on is denied where this session may
 *  not grant it, as `toggle` leaves it behind, or the save is refused. */
export function toggleOwn(
  own: Own,
  name: string,
  on: boolean,
  from: Inherited,
  original: AccountInfo | null,
  mine: AccessSet | null,
): void {
  own.grant.delete(name);
  own.deny.delete(name);
  if (on && original?.grant?.includes(name)) own.grant.add(name);
  else if (!on && original?.deny?.includes(name)) own.deny.add(name);
  else if (isOn(source(own, name, from)) !== on) (on ? own.grant : own.deny).add(name);
  if (name === 'read_chat' && on && source(own, HISTORY, from) === 'follows' && !grantable(mine, HISTORY)) {
    own.deny.add(HISTORY);
  }
}

/** Whether an edit gives the account anything. A refusal as `outranked`
 *  of one that does may be the edit's, and says nothing of the account. */
export function gives(original: AccountInfo, draft: Draft): boolean {
  const own = draft.own;
  if (!own) return [...draft.access].some((n) => !original.access.includes(n));
  return (
    [...own.roles].some((r) => !original.roles?.includes(r)) ||
    [...own.grant].some((n) => !original.grant?.includes(n)) ||
    (original.deny ?? []).some((n) => !own.deny.has(n))
  );
}

/** May this session give a role? Not one granting a bit it does not
 *  hold, which the server refuses as `outranked`; a role it knows
 *  nothing of is the server's to judge. */
export function mayGive(mine: AccessSet | null, role: Role | undefined): boolean {
  if (!role) return true;
  return role.access.every((n) => grantable(mine, n)) && role.raw_bits.every((b) => !!mine?.raw_bits.includes(b));
}

/**
 * Tick or untick `name` in `draft`. Chat history that goes with reading
 * chat goes on going with it: the server keeps an account's history
 * following its chat until something separates the two, so unticking
 * "Read chat" alone would otherwise leave history on, and ticking it
 * alone would write history off for good. Not where this session may not
 * grant history: giving it along would only have the save refused.
 */
export function toggle(draft: Draft, name: string, on: boolean, mine: AccessSet | null): void {
  const follows = draft.access.has('read_chat_history') === draft.access.has('read_chat');
  const set = (n: string) => (on ? draft.access.add(n) : draft.access.delete(n));
  set(name);
  if (name === 'read_chat' && follows && grantable(mine, 'read_chat_history')) set('read_chat_history');
}

const sameSet = <T>(a: Set<T>, b: T[]) => a.size === b.length && b.every((n) => a.has(n));

/** The four own-key lists: the server reads one left out as empty, so
 *  all four go. */
const ownKeys = (own: Own) => ({
  grant: [...own.grant],
  deny: [...own.deny],
  raw_grant: own.raw_grant,
  raw_deny: own.raw_deny,
});

/**
 * What to send for `draft`: everything for a new account, and only what
 * changed for an existing one, so an edit to a name does not rewrite
 * the bitmap. `raw_bits` travel with `access`, as the account had them —
 * the editor cannot show them, and the wire reads their absence as none.
 * On a server with roles, the account's own keys go in place of
 * `access`, and `roles` only when they changed. `null` when nothing
 * changed.
 */
export function editParams(original: AccountInfo | null, draft: Draft): AccountEditParams | null {
  const login = draft.login.trim().toLowerCase();
  const name = draft.name.trim();
  const out: AccountEditParams = { login: original?.login ?? login };
  const access = [...draft.access];
  if (!original) {
    if (name) out.name = name;
    if (draft.password) out.password = draft.password;
    if (draft.own) Object.assign(out, { roles: [...draft.own.roles] }, ownKeys(draft.own));
    else out.access = access;
    return out;
  }
  let changed = false;
  // Compared as typed: a name is normalized only once someone edits it.
  if (name && draft.name !== original.name) {
    out.name = name;
    changed = true;
  }
  if (draft.clearPassword && original.password) {
    out.password = '';
    changed = true;
  } else if (draft.password) {
    out.password = draft.password;
    changed = true;
  }
  if (draft.own) {
    if (!sameSet(draft.own.roles, original.roles ?? [])) {
      out.roles = [...draft.own.roles];
      changed = true;
    }
    if (!sameSet(draft.own.grant, original.grant ?? []) || !sameSet(draft.own.deny, original.deny ?? [])) {
      Object.assign(out, ownKeys(draft.own));
      changed = true;
    }
  } else if (!sameSet(draft.access, original.access)) {
    out.access = access;
    out.raw_bits = original.raw_bits;
    changed = true;
  }
  return changed ? out : null;
}

/** The `[extra]` keys a role may grant (hxd-ng's `docs/roles.md` §5):
 *  never one that says an account is one person. */
export const ROLE_EXTRAS: [name: string, label: string][] = [
  ['set_subject', 'Set the subject'],
  ['file_list', 'List files'],
  ['file_getinfo', 'Get file info'],
  ['attach_news', 'Attach images to news'],
  ['moderate', 'Moderate'],
  ['can_spam', 'Exempt from flood limits'],
  ['manage_roles', 'Manage roles'],
  ['manage_rooms', 'Manage rooms'],
];

/** What the role editor holds while it is open. */
export interface RoleDraft {
  name: string;
  title: string;
  color: number | null;
  position: number;
  mentionable: boolean;
  access: Set<string>;
  extra: Set<string>;
}

export function roleDraftOf(role: Role | null): RoleDraft {
  return {
    name: role?.name ?? '',
    title: role?.title ?? '',
    color: role?.color ?? null,
    position: role?.position ?? 0,
    mentionable: !!role?.mentionable,
    access: new Set(role?.access ?? []),
    extra: new Set(role?.extra ?? []),
  };
}

/** `0xRRGGBB` as a color input writes it. */
export const colorHex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

/** What to send for `draft`, as `editParams` does for an account: only
 *  what changed, and the `raw_bits` the editor cannot show with
 *  `access`. A blank title is a new role's name, and leaves an existing
 *  one's as it was. `null` when nothing changed. */
export function roleParams(original: Role | null, draft: RoleDraft): RoleEditParams | null {
  const title = draft.title.trim();
  if (!original) {
    const out: RoleEditParams = { name: draft.name.trim().toLowerCase() };
    if (title) out.title = title;
    if (draft.color !== null) out.color = draft.color;
    if (draft.position) out.position = draft.position;
    if (draft.mentionable) out.mentionable = true;
    out.access = [...draft.access];
    out.extra = [...draft.extra];
    return out;
  }
  const out: RoleEditParams = { name: original.name };
  if (title && title !== original.title) out.title = title;
  if (draft.color !== (original.color ?? null)) out.color = draft.color;
  if (draft.position !== original.position) out.position = draft.position;
  if (draft.mentionable !== !!original.mentionable) out.mentionable = draft.mentionable;
  if (!sameSet(draft.access, original.access)) {
    out.access = [...draft.access];
    out.raw_bits = original.raw_bits;
  }
  if (!sameSet(draft.extra, original.extra)) out.extra = [...draft.extra];
  return Object.keys(out).length > 1 ? out : null;
}

/** As `gives`, for a role. */
export function roleGives(original: Role, draft: RoleDraft): boolean {
  return [...draft.access].some((n) => !original.access.includes(n)) || [...draft.extra].some((n) => !original.extra.includes(n));
}
