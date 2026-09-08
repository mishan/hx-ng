/** What the client remembers: the roster, and one transcript per
 *  conversation. No DOM in this file — the UI reads from here, never the
 *  other way round. */

import type {
  ChatStyle,
  InboxCounts,
  InboxOk,
  Sender,
  ServerInfo,
  Status,
  User,
} from '@hotline-ng/client';

export type LineKind =
  /** Public chat, or a private message inside a PM conversation. */
  | 'chat'
  /** `/me`, which the server carries as style 1. */
  | 'action'
  /** A server notice: joins and parts the server chose to announce,
   *  kick announcements, agreement text. */
  | 'notice'
  | 'broadcast'
  /** Something this client is saying about itself — connection state,
   *  errors. Never came off the wire. */
  | 'system';

export interface Line {
  t: number;
  kind: LineKind;
  from?: Sender;
  text: string;
  /** Set on lines this client generated, so the transcript can mark them
   *  as not having come from the server. */
  local?: boolean;
  /** This message waited in the store before it reached us. Worth saying:
   *  its timestamp is when it was *sent*, which may be days ago, and a
   *  reply is not as prompt as it looks. */
  queued?: boolean;
  /** The store's id, when it has one. `msg_read` marks up to it. */
  id?: number;
}

export type ConvId = string;

/**
 * How the far half of a private conversation is named on the wire.
 *
 * Two names, because the protocol has two and they have different
 * lifetimes. `uid` is a roster row and lasts as long as the session
 * behind it; `login` is an account and outlives every session it ever
 * had. A message that waited in the store arrives with `uid: 0` and a
 * login, because there was no session to point at when it was flushed —
 * so a client that keys conversations on uid alone files all of its
 * offline mail under one imaginary person and cannot answer any of it.
 *
 * Both are optional and a conversation accumulates them: clicking a
 * roster row knows only a uid (the roster carries no logins), and the
 * first `msg` from that person adds the login to the same conversation
 * rather than starting a second one.
 */
export interface Peer {
  uid?: number;
  login?: string;
}

export interface Conversation {
  id: ConvId;
  kind: 'lobby' | 'pm';
  /** Empty for the lobby. */
  peer: Peer;
  title: string;
  lines: Line[];
  unread: number;
}

export const LOBBY: ConvId = 'lobby';

/** What `msg` should carry to reach this conversation's other half, or
 *  `null` when nothing can: a guest who has left the roster has no login
 *  to fall back on, and their uid is somebody else's now or nobody's. */
export function addressOf(c: Conversation): { to_login: string } | { to: number } | null {
  // The login first. It is the durable name, and it is the only one that
  // reaches someone who is not here.
  if (c.peer.login !== undefined) return { to_login: c.peer.login };
  if (c.peer.uid !== undefined) return { to: c.peer.uid };
  return null;
}

const uidKey = (uid: number): string => `uid:${uid}`;
const loginKey = (login: string): string => `login:${login.toLowerCase()}`;
/** The last-resort key, for a sender the wire gave no name at all. */
const nickKey = (nick: string): string => `nick:${nick}`;

/**
 * A position that only moves forward, whose updates may be in flight at
 * once.
 *
 * `msg_read` is the case: selecting one conversation and then another
 * before the first answers puts two marks on the wire, and the reply
 * that lands second is not necessarily the one that went second. The
 * spec has the server answering in order, but a cursor is cheaper than
 * depending on that, and it also answers the other question — a mark
 * that *failed* marked nothing and must not be remembered as done.
 */
export class Cursor {
  private at = 0;

  get value(): number {
    return this.at;
  }

  /** Move to `to`, or `null` when that is not ahead of here. The claim
   *  knows whether it is still the newest, and can put the cursor back
   *  where it found it. */
  claim(to: number): { to: number; owns: () => boolean; release: () => void } | null {
    if (to <= this.at) return null;
    const previous = this.at;
    this.at = to;
    return {
      to,
      owns: () => this.at === to,
      release: () => {
        if (this.at === to) this.at = previous;
      },
    };
  }
}

/** How many lines a transcript keeps. Long enough that scrolling back
 *  through an evening works, short enough that a room left open
 *  overnight does not grow without bound. */
const MAX_LINES = 2000;

export class Store {
  server: ServerInfo = { name: '', subject: '' };
  self: User | null = null;
  users = new Map<number, User>();
  conversations = new Map<ConvId, Conversation>();
  active: ConvId = LOBBY;
  /** Bumped whenever a transcript is rewritten wholesale rather than
   *  appended to — today only a merge. A view that draws incrementally
   *  watches this to know its DOM has gone stale underneath it. */
  revision = 0;
  /**
   * What the server says is waiting, which is not the same thing as the
   * per-conversation `unread` counters beside it.
   *
   * Those are "you have not looked at this tab since it changed" and
   * this client owns them. This is read state in the *store*, owned by
   * the server, shared with every other client on the same account, and
   * moved only by `msg_read`. `null` means this server keeps no inbox
   * and nothing about mail should be drawn at all.
   */
  mail: InboxCounts | null = null;
  /**
   * The lowest stored id this client has pulled, and therefore where the
   * next page backwards starts. Undefined only before the first page:
   * once set it stays set and keeps moving down, because a cursor that
   * reset itself would page the same rows for ever. Exhaustion is
   * `mailExhausted`, below, and not the absence of this.
   */
  oldestMailId?: number;
  /** True once a page has come back with **no rows at all**. Not "no rows
   *  this client had yet to see": those are different, and conflating
   *  them stops paging early over mail the login flush happened to
   *  deliver first. */
  mailExhausted = false;
  /**
   * Stored message ids this client has already placed. Mail arrives
   * twice by design — the login flush pushes `msg` events for what is
   * unread while `inbox` lists the same rows — so both paths check here
   * first.
   *
   * Trimming a transcript past `MAX_LINES` deliberately leaves ids here:
   * those messages were shown and scrolled past, and a later page must
   * not re-append them under whatever is on screen now. Closing a
   * conversation does the opposite and forgets them, because closing is
   * someone saying they are done with it, and paging mail afterwards
   * should be able to bring it back.
   */
  private seenMail = new Set<number>();
  /** Every name a PM conversation answers to, mapped to its id. One
   *  conversation may sit under two keys — a uid and a login — which is
   *  what stops the same person appearing twice. */
  private pmIndex = new Map<string, ConvId>();
  /** Conversation ids are opaque and unique. Deriving one from whichever
   *  name we had first meant a *stale* id could be recomputed: a guest
   *  parts, their uid is reissued, and the next person's conversation
   *  lands on the previous one's transcript. Every lookup goes through
   *  `pmIndex` instead, so an id nothing points at is unreachable. */
  private pmSeq = 0;

  constructor() {
    this.conversations.set(LOBBY, {
      id: LOBBY,
      kind: 'lobby',
      peer: {},
      title: 'Lobby',
      lines: [],
      unread: 0,
    });
  }

  /** Roster order: admins first, then everyone else, each alphabetically
   *  and case-insensitively. Hotline servers send the list in join order;
   *  a sorted list is easier to find a name in, which is what a user list
   *  is for. */
  roster(): User[] {
    return [...this.users.values()].sort((a, b) => {
      if (a.admin !== b.admin) return a.admin ? -1 : 1;
      return a.nick.localeCompare(b.nick, undefined, { sensitivity: 'base' }) || a.uid - b.uid;
    });
  }

  user(uid: number): User | undefined {
    return this.users.get(uid);
  }

  /** The nick to show for a uid that has left: the roster no longer has
   *  it, but a transcript line that mentions it still should. */
  nickOf(uid: number, fallback = `uid ${uid}`): string {
    return this.users.get(uid)?.nick ?? fallback;
  }

  replaceRoster(users: User[]): void {
    this.users.clear();
    for (const u of users) this.users.set(u.uid, u);
  }

  put(u: User): void {
    this.users.set(u.uid, u);
  }

  remove(uid: number): User | undefined {
    const u = this.users.get(uid);
    this.users.delete(uid);
    // The roster row is gone, and with it the only thing that made this
    // uid mean anything. Uids are the legacy wire's 16-bit ids and the
    // server reuses them, so a conversation that kept this one would
    // eventually deliver to whoever inherited it. A conversation with a
    // login is unaffected — that is the name that survives — and one
    // without becomes unaddressable, which is the truth about a guest
    // who left.
    const id = this.pmIndex.get(uidKey(uid));
    if (id !== undefined) {
      this.pmIndex.delete(uidKey(uid));
      const c = this.conversations.get(id);
      if (c) c.peer.uid = undefined;
    }
    return u;
  }

  conversation(id: ConvId): Conversation | undefined {
    return this.conversations.get(id);
  }

  /** The conversation this person already has, under either of their
   *  names, or undefined. */
  pmWith(who: Peer): Conversation | undefined {
    const id =
      (who.login !== undefined ? this.pmIndex.get(loginKey(who.login)) : undefined) ??
      (who.uid !== undefined ? this.pmIndex.get(uidKey(who.uid)) : undefined);
    return id === undefined ? undefined : this.conversations.get(id);
  }

  /**
   * Find or create the conversation with someone, folding whatever this
   * sighting of them knows into whatever earlier ones did.
   *
   * A uid of 0 is not a uid — it is the wire saying "this message
   * outlived its sender's session" — so it is dropped here rather than
   * indexed, which is what keeps every offline sender from sharing one
   * conversation.
   */
  openPm(who: { uid?: number; login?: string; nick: string }): Conversation {
    const uid = who.uid !== undefined && who.uid > 0 ? who.uid : undefined;
    const login = who.login || undefined;
    const nameless = uid === undefined && login === undefined;

    const byLogin = login !== undefined ? this.pmWith({ login }) : undefined;
    const byUid = uid !== undefined ? this.pmWith({ uid }) : undefined;
    // Two conversations, one person. It happens in the obvious way:
    // offline mail from `alice` opens one under her account, then she
    // arrives and gets clicked in the roster — which carries no logins,
    // so that opens a second under her uid — and her next message names
    // both. Fold them rather than leaving the older one stranded with no
    // index entry pointing at it.
    if (byLogin && byUid && byLogin !== byUid) this.mergePm(byUid, byLogin);

    // A sender the wire gave no name at all — stored mail whose account
    // has gone — can only be recognised by their nick. The alias is
    // consulted *only* for another equally nameless sighting, never to
    // resolve a uid or a login: `alice` with no account and `alice` with
    // one are not known to be the same person, and assuming they are is
    // the login-recycling failure `private-messages.md` §4 exists to
    // prevent. Two threads is the safe way to be wrong here.
    const byNick = nameless
      ? this.conversations.get(this.pmIndex.get(nickKey(who.nick)) ?? '')
      : undefined;

    let c = byLogin ?? byUid ?? byNick;
    if (!c) {
      const id = `pm:${++this.pmSeq}`;
      c = { id, kind: 'pm', peer: {}, title: who.nick, lines: [], unread: 0 };
      this.conversations.set(id, c);
      if (nameless) this.pmIndex.set(nickKey(who.nick), id);
    }
    if (login !== undefined) {
      c.peer.login = login;
      this.pmIndex.set(loginKey(login), c.id);
    }
    if (uid !== undefined) {
      c.peer.uid = uid;
      this.pmIndex.set(uidKey(uid), c.id);
    }
    if (who.nick) c.title = who.nick;
    return c;
  }

  /** Pour `from` into `into`, oldest line first, and forget `from`. */
  private mergePm(from: Conversation, into: Conversation): void {
    into.lines = [...into.lines, ...from.lines].sort((a, b) => a.t - b.t);
    if (into.lines.length > MAX_LINES) into.lines.splice(0, into.lines.length - MAX_LINES);
    into.unread += from.unread;
    into.peer = { uid: into.peer.uid ?? from.peer.uid, login: into.peer.login ?? from.peer.login };
    for (const [k, v] of this.pmIndex) if (v === from.id) this.pmIndex.set(k, into.id);
    this.conversations.delete(from.id);
    if (this.active === from.id) this.active = into.id;
    this.revision++;
  }

  closePm(id: ConvId): void {
    if (id === LOBBY) return;
    // Every alias, whatever kind it is — reading them back off `peer`
    // would miss the nick one, which is deliberately not stored there.
    for (const [k, v] of [...this.pmIndex]) if (v === id) this.pmIndex.delete(k);
    // Forget its mail too, so a later page can bring the thread back
    // rather than silently skipping every message it used to hold.
    for (const l of this.conversations.get(id)?.lines ?? []) {
      if (l.id !== undefined) this.seenMail.delete(l.id);
    }
    this.conversations.delete(id);
    if (this.active === id) this.active = LOBBY;
  }

  /** Is this stored message already on screen? */
  hasMail(id: number): boolean {
    return this.seenMail.has(id);
  }

  /**
   * Record what a page of `inbox` said about the mailbox.
   *
   * Exhaustion is a page with **no rows**, never a page with no rows we
   * had yet to see. Those are different: the login flush pushes the
   * oldest unread mail as events, so a page backwards can land entirely
   * on messages already on screen while older ones still sit beneath it,
   * and stopping there would hide them for good.
   */
  notePage(page: InboxOk): void {
    for (const m of page.messages) {
      if (this.oldestMailId === undefined || m.id < this.oldestMailId) this.oldestMailId = m.id;
    }
    if (page.messages.length === 0) this.mailExhausted = true;
    this.mail = { unread: page.unread, total: page.total };
  }

  /** A stored message arrived on the wire rather than out of a page.
   *  Both counters move: an `id` means the server kept it, and moving
   *  only `unread` renders "1 unread of 0 stored". */
  noteStoredMessage(): void {
    if (!this.mail) return;
    this.mail = { unread: this.mail.unread + 1, total: this.mail.total + 1 };
  }

  /**
   * `fresh` is whether this line should bump the conversation's unread
   * count, and it is not the same question as whether the conversation
   * is on screen.
   *
   * A message pulled back out of the store may already have been read —
   * on this account, from some other client — and the server says so in
   * `read`. Counting it would put a badge on a conversation for mail its
   * owner has already dealt with, which is exactly the thing a badge is
   * supposed to be trustworthy about.
   */
  add(id: ConvId, line: Line, fresh = true): Conversation | undefined {
    const c = this.conversations.get(id);
    if (!c) return undefined;
    if (line.id !== undefined) this.seenMail.add(line.id);
    c.lines.push(line);
    if (c.lines.length > MAX_LINES) c.lines.splice(0, c.lines.length - MAX_LINES);
    if (fresh && id !== this.active) c.unread++;
    return c;
  }

  system(text: string, id: ConvId = this.active): Conversation | undefined {
    return this.add(id, { t: Date.now(), kind: 'system', text, local: true });
  }
}

/** How long a silence ends a run. Long enough that a back-and-forth
 *  stays one block, short enough that tomorrow morning does not. */
const RUN_GAP_MS = 5 * 60 * 1000;

/**
 * Do these two lines belong to one labelled block?
 *
 * The modern convention: a run from one person collapses under a single
 * name, which costs nothing and reads better than the same name eleven
 * times. What counts as "one person" has to be every name the line
 * carries, not just the visible one — a queued message arrives with
 * `uid: 0` because its sender had no session when it was flushed, so uid
 * and nick alone would let two senders who happen to share a nick hide
 * under one heading, and the second one's name would simply not appear.
 *
 * Whether the message waited is part of it too: a stored line and a live
 * one are different enough that running them together misreads the
 * timestamps.
 */
export function continuesRun(prev: Line | undefined, line: Line): boolean {
  if (prev?.kind !== 'chat' || line.kind !== 'chat') return false;
  return (
    prev.from?.uid === line.from?.uid &&
    prev.from?.nick === line.from?.nick &&
    prev.from?.login === line.from?.login &&
    !!prev.local === !!line.local &&
    !!prev.queued === !!line.queued &&
    line.t - prev.t < RUN_GAP_MS
  );
}


export function styleToKind(style: ChatStyle): LineKind {
  return style === 'action' ? 'action' : 'chat';
}

/** Away and detached are one thing to a 1.x client and two things here.
 *  The distinction is worth showing: "away" is a person who stepped out,
 *  "detached" is a phone whose network dropped and whose session is
 *  counting down its grace window. */
export function statusLabel(s: Status): string {
  switch (s) {
    case 'active':
      return '';
    case 'idle':
      return 'away';
    case 'detached':
      return 'disconnected';
  }
}
