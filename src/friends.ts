/** Friends as this client keeps them (hxd-ng's `docs/hotline-ng.md`
 *  §7.5): this account's roster rows by login, kept current by the
 *  family's events, and the order they are drawn in. No DOM. */

import type { Events, Friend, FriendPresence, PresenceState } from '@hotline-ng/client';

const keyOf = (login: string): string => login.toLowerCase();

export const PRESENCE_LABEL: Record<FriendPresence | PresenceState, string> = {
  online: 'Online',
  away: 'Away',
  busy: 'Busy',
  offline: 'Offline',
  invisible: 'Invisible',
};

/** Most available first, as a buddy list reads. */
const RANK: Record<FriendPresence, number> = { online: 0, away: 1, busy: 2, offline: 3 };

export interface FriendGroups {
  /** Asking this account for friendship. */
  incoming: Friend[];
  friends: Friend[];
  /** Asked by this account, not yet answered. */
  outgoing: Friend[];
  blocked: Friend[];
}

export function friendName(f: Friend): string {
  return f.alias ?? f.login;
}

export class FriendBook {
  private rows = new Map<string, Friend>();

  replace(list: Friend[]): void {
    this.rows = new Map(list.map((f) => [keyOf(f.login), f]));
  }

  clear(): void {
    this.rows.clear();
  }

  get(login: string): Friend | undefined {
    return this.rows.get(keyOf(login));
  }

  /** A friendship, the one thing typing and receipts pass on. */
  isFriend(login: string): boolean {
    return this.get(login)?.state === 'accepted';
  }

  /** A `friend` event: the row whole as it now stands, or gone. */
  apply(f: Friend): void {
    if (f.state === 'removed') this.rows.delete(keyOf(f.login));
    else this.rows.set(keyOf(f.login), f);
  }

  /** A `friend_request`, which may come before or without its row. */
  request(d: Events['friend_request']): void {
    const had = this.get(d.login);
    if (had && had.state !== 'pending_in') return;
    this.apply({
      login: d.login,
      state: 'pending_in',
      ...(d.fingerprint !== undefined ? { fingerprint: d.fingerprint } : {}),
      ...(d.note !== undefined ? { note: d.note } : {}),
    });
  }

  /** A `presence` event, which only a friend's row carries. Returns
   *  whether it changed one. */
  presence(d: Events['presence']): boolean {
    const had = this.get(d.login);
    if (had?.state !== 'accepted') return false;
    const next: Friend = { ...had, presence: d.state };
    if (d.status_text === undefined) delete next.status_text;
    else next.status_text = d.status_text;
    this.apply(next);
    return true;
  }

  groups(): FriendGroups {
    const by = (a: Friend, b: Friend) => friendName(a).localeCompare(friendName(b), undefined, { sensitivity: 'base' });
    const all = [...this.rows.values()];
    const of = (state: Friend['state']) => all.filter((f) => f.state === state).sort(by);
    return {
      incoming: of('pending_in'),
      friends: of('accepted').sort(
        (a, b) => RANK[a.presence ?? 'offline'] - RANK[b.presence ?? 'offline'] || by(a, b),
      ),
      outgoing: of('pending_out'),
      blocked: of('blocked'),
    };
  }
}

/** Read receipts owed for messages the user was shown, whose sending
 *  failed in a way worth trying again: kept apart from the messages not
 *  yet read, so a retry tells nobody of one the user never saw. */
export class OwedReceipts {
  private owed = new Map<string, { login: string; guid: string }>();

  add(login: string, guid: string): void {
    this.owed.set(`${keyOf(login)} ${guid}`, { login, guid });
  }

  /** Everything owed, which is then no longer held here. */
  take(): { login: string; guid: string }[] {
    const all = [...this.owed.values()];
    this.owed.clear();
    return all;
  }

  clear(): void {
    this.owed.clear();
  }
}
