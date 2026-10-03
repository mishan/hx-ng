/** Account administration's logic, apart from the DOM: what each access
 * name means, what this session may do, and what an edit sends
 * (hxd-ng's `docs/account-admin.md` §5).
 */

import type { AccessSet, AccountEditParams, AccountInfo } from '@hotline-ng/client';

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
}

export function draftOf(account: AccountInfo | null): Draft {
  return {
    login: account?.login ?? '',
    name: account?.name ?? '',
    password: '',
    clearPassword: false,
    access: new Set(account?.access ?? []),
  };
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

const sameSet = (a: Set<string>, b: string[]) => a.size === b.length && b.every((n) => a.has(n));

/**
 * What to send for `draft`: everything for a new account, and only what
 * changed for an existing one, so an edit to a name does not rewrite
 * the bitmap. `raw_bits` travel with `access`, as the account had them —
 * the editor cannot show them, and the wire reads their absence as none.
 * `null` when nothing changed.
 */
export function editParams(original: AccountInfo | null, draft: Draft): AccountEditParams | null {
  const login = draft.login.trim().toLowerCase();
  const name = draft.name.trim();
  const out: AccountEditParams = { login: original?.login ?? login };
  const access = [...draft.access];
  if (!original) {
    if (name) out.name = name;
    if (draft.password) out.password = draft.password;
    out.access = access;
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
  if (!sameSet(draft.access, original.access)) {
    out.access = access;
    out.raw_bits = original.raw_bits;
    changed = true;
  }
  return changed ? out : null;
}
