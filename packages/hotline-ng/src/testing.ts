/**
 * `@hotline-ng/client/testing`: an in-memory Hotline-ng server, for the
 * tests of code built on `Connection`.
 *
 * It speaks the wire of hxd-ng's `docs/hotline-ng.md`, with the rooms of
 * its `docs/chat-rooms.md` §7, in this package's own types, so a fake a
 * consumer builds on it moves when the protocol the library speaks does.
 * It models what those documents promise rather than how any one server
 * keeps them: there are no privileges, rate limits or grace timer, and
 * a detached session's outbox holds everything from its detach, so a
 * resume replays unless a test says otherwise (`overflow`). A request
 * it does not serve is answered `unknown_method`, as a server without
 * that family answers it.
 *
 * No network and no DOM: `credentials()` hands a `Connection` the
 * server's `webSocket`, which opens a `SocketLike`.
 */

import type { Credentials, SocketLike } from './connection.js';
import type {
  ChatOk,
  ChatParams,
  EventFrame,
  EventName,
  Events,
  HistoryLine,
  HistoryOk,
  HistoryParams,
  InboxCounts,
  InboxOk,
  InboxParams,
  LoginOk,
  LoginParams,
  MsgOk,
  MsgParams,
  ReqFrame,
  ResumeOk,
  ResumeParams,
  Room,
  RoomJoinOk,
  RoomsOk,
  SelfUser,
  Sender,
  StoredMessage,
  SyncOk,
  User,
  WireError,
} from './protocol.js';

export interface FakeAccount {
  login: string;
  /** Empty for an account with none, which detaches only when an
   *  identity logged it in. */
  password: string;
  /** Linked to an identity, which `identityToken(login)` proves. A
   *  password-less linked account is not reachable by password (hxd-ng's
   *  `docs/hotline-ng-identity.md` §8.3). An account with a password or
   *  a link has an inbox (`docs/private-messages.md` §2). */
  identity?: boolean;
  nick?: string;
  icon?: number;
}

/** Who sent a request, once its connection holds a session. */
export interface FakeSender {
  uid: number;
  login: string | null;
}

export interface FakeRequest extends ReqFrame {
  /** `null` for a handshake, which comes before the session. */
  from: FakeSender | null;
}

/** A reply as a handler gives it. */
export type FakeReply = { ok: unknown } | { error: WireError };

/** Answers a request in place of the server, or leaves it to the
 *  server by returning `undefined`. */
export type FakeHandler = (
  params: Record<string, unknown>,
  from: FakeSender,
) => FakeReply | undefined | Promise<FakeReply | undefined>;

export interface FakeServerOptions {
  name?: string;
  subject?: string;
  accounts?: FakeAccount[];
  /** Whether a login naming no account is let in; it is by default. */
  guests?: boolean;
  rooms?: { name: string; topic?: string; position?: number }[];
  /** What the login reply's `detach` says; nothing here times it. */
  grace?: number;
  /** The families served, as the login reply's `caps` lists them: of
   *  these, `history`, `inbox`, `rooms` and `chat_guid` change what the
   *  server does. `identity` says the server has the identity
   *  endpoints, and is listed to every session however it logged in, as
   *  the spec has it; this server does not serve them, and
   *  `identityToken` stands in for them. */
  caps?: string[];
}

const CAPS = ['history', 'inbox', 'rooms', 'chat_guid', 'identity'];
const GUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_JOINED = 32;

interface Session {
  uid: number;
  user: User;
  account: FakeAccount | null;
  /** The account's login where it has an inbox. */
  mailbox: string | null;
  identity: SelfUser['identity'];
  id: string;
  token: string;
  /** A user the test plays, with no socket and no outbox. */
  scripted: boolean;
  detachable: boolean;
  seq: number;
  log: EventFrame[];
  /** The first seq held for replay: the first after its detach. */
  bufferFrom: number;
  socket: FakeSocket | null;
  broken: boolean;
  /** Has it sent a request of the rooms family (chat-rooms.md §7)? */
  aware: boolean;
  ended: boolean;
}

interface FakeRoom {
  id: number;
  name: string;
  topic: string;
  position: number;
  members: Set<number>;
  archived: boolean;
}

interface Mail extends StoredMessage {
  to: string;
  guid?: string;
  fromUid: number;
  /** Stored while its recipient had no attached session (§6.4). */
  pending: boolean;
}

class Refusal {
  constructor(readonly error: WireError) {}
}

const refuse = (code: string, text = code): Refusal => new Refusal({ code, text });
const now = (): number => Math.floor(Date.now() / 1000);

/** Frames go both ways on microtasks, so a client that only works when
 *  its replies are synchronous fails here as it would against a server. */
class FakeSocket implements SocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  session: Session | null = null;

  constructor(
    private readonly server: { received(sock: FakeSocket, raw: string): Promise<void>; lost(sock: FakeSocket): void },
    readonly url: string,
    /** The account an identity token chose, `null` for a guest, absent
     *  for a socket opened without one. */
    readonly identity: { login: string | null } | undefined,
    refused: boolean,
  ) {
    queueMicrotask(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      if (refused) {
        // A token the server does not take fails the upgrade itself.
        this.readyState = FakeSocket.CLOSED;
        this.onerror?.({});
        this.onclose?.({ code: 1006, reason: '' });
        return;
      }
      this.readyState = FakeSocket.OPEN;
      this.onopen?.({});
    });
  }

  /** One request at a time, so a handler that takes its time still
   *  answers in order (§5). */
  private queue: Promise<void> = Promise.resolve();

  send(raw: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('send on a socket that is not open');
    // A handler that throws fails the test as an unhandled rejection,
    // and the requests after it are still answered.
    const next = this.queue.then(() => this.server.received(this, raw));
    this.queue = next.catch(() => {});
  }

  close(): void {
    if (this.readyState >= FakeSocket.CLOSING) return;
    this.readyState = FakeSocket.CLOSED;
    queueMicrotask(() => {
      this.server.lost(this);
      this.onclose?.({ code: 1000, reason: '' });
    });
  }

  deliver(frame: unknown): void {
    const raw = JSON.stringify(frame);
    queueMicrotask(() => {
      if (this.readyState !== FakeSocket.CLOSED) this.onmessage?.({ data: raw });
    });
  }

  /** The server closes it, after whatever it has already sent. */
  shut(code: number, reason: string): void {
    if (this.readyState >= FakeSocket.CLOSING) return;
    this.readyState = FakeSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = FakeSocket.CLOSED;
      this.server.lost(this);
      this.onclose?.({ code, reason });
    });
  }
}

let servers = 0;

export class FakeServer {
  /** Unique to this server, so a session saved for one is never
   *  resumed on another. */
  readonly url = `ws://fake-${++servers}.invalid/ng`;
  private clients = 0;
  /** Every request any client sent, in the order they arrived. */
  readonly requests: FakeRequest[] = [];
  subject: string;
  private readonly name: string;
  private readonly accounts: Map<string, FakeAccount>;
  private readonly guests: boolean;
  private readonly grace: number;
  private readonly caps: Set<string>;
  private readonly sessions = new Map<number, Session>();
  private readonly rooms = new Map<number, FakeRoom>();
  private readonly kept = new Map<number, HistoryLine[]>([[0, []]]);
  private readonly stored: Mail[] = [];
  private readonly guids = new Map<string, number>();
  private readonly mailGuids = new Map<string, Mail>();
  private readonly handlers = new Map<string, FakeHandler>();
  private readonly refusals = new Map<string, WireError[]>();
  private readonly tokens = new Map<string, string | null>();
  private nextUid = 1;
  private nextRoom = 1;
  private nextLine = 0;
  private nextMail = 0;
  private serial = 0;

  constructor(opts: FakeServerOptions = {}) {
    this.name = opts.name ?? 'Fake';
    this.subject = opts.subject ?? '';
    this.accounts = new Map((opts.accounts ?? []).map((a) => [a.login, a]));
    this.guests = opts.guests ?? true;
    this.grace = opts.grace ?? 300;
    this.caps = new Set(opts.caps ?? CAPS);
    for (const r of opts.rooms ?? []) this.addRoom(r);
  }

  /** For `Credentials.webSocket`. */
  readonly webSocket = (url: string): SocketLike => {
    const token = new URL(url).searchParams.get('token');
    const known = token !== null && this.tokens.has(token);
    const identity = known ? { login: this.tokens.get(token)! } : undefined;
    if (known) this.tokens.delete(token);
    const peer = {
      received: (sock: FakeSocket, raw: string) => this.received(sock, raw),
      lost: (sock: FakeSocket) => this.lost(sock),
    };
    return new FakeSocket(peer, url, identity, token !== null && !known);
  };

  /** Credentials for a `Connection` to this server: a guest's unless
   *  `over` names an account. Each call's `url` is its own, so two
   *  connections never share a saved session; reusing one is a reload. */
  credentials(over: Partial<Credentials> = {}): Credentials {
    const url = `${this.url}?c=${++this.clients}`;
    return { url, login: '', password: '', nick: '', icon: 128, webSocket: this.webSocket, ...over };
  }

  /** A single-use token for `Credentials.identity.getToken`: a socket
   *  opened with it logs in as `login`, an account linked to an
   *  identity, or as an identity's guest without one. A socket opened
   *  with any other token is refused. `@hotline-ng/client/node`'s
   *  `identityToken` talks to endpoints this server does not have. */
  identityToken(login?: string): string {
    if (login !== undefined && !this.accounts.get(login)?.identity) throw new Error(`${login} is not linked to an identity`);
    const token = `id${++this.serial}`;
    this.tokens.set(token, login ?? null);
    return token;
  }

  // --- what a test does to the server -----------------------------------

  /** Answer the next `req` with this error. A refused handshake closes
   *  its connection, as every one but `resync_required` does; for that
   *  one, `overflow`. */
  refuseNext(req: string, code: string, extra: Partial<WireError> = {}): void {
    if (code === 'resync_required') throw new Error('a resume answered resync_required attaches: use overflow()');
    const queue = this.refusals.get(req) ?? [];
    queue.push({ code, text: code, ...extra });
    this.refusals.set(req, queue);
  }

  /** Answer `req`, after the handshake, with `fn` before the server
   *  does; the latest for a name wins. */
  handle(req: string, fn: FakeHandler): void {
    this.handlers.set(req, fn);
  }

  /** The newest session logged in as `login`. */
  uidOf(login: string): number {
    const s = this.everyone().filter((x) => x.account?.login === login).at(-1);
    if (!s) throw new Error(`nobody is logged in as ${login}`);
    return s.uid;
  }

  /** Push an event to one session, taking its next seq. */
  event<K extends EventName>(uid: number, ev: K, data: Events[K]): void {
    this.emit(this.live(uid), ev, data);
  }

  /** A user the test plays joins the roster: with a `login`, as an
   *  account's with an inbox, and with a `fingerprint`, as one that
   *  proved an identity. */
  addUser(user: { nick: string; icon?: number; login?: string; fingerprint?: string }): number {
    const uid = this.nextUid++;
    const account = user.login ? (this.accounts.get(user.login) ?? { login: user.login, password: '' }) : null;
    const s: Session = {
      ...this.blank(uid, account),
      user: { uid, nick: user.nick, icon: user.icon ?? 128, admin: false, status: 'active', transport: 'encrypted' },
      scripted: true,
    };
    if (account && this.caps.has('inbox')) s.mailbox = account.login;
    if (user.fingerprint) this.prove(s, user.fingerprint);
    this.join(s);
    return uid;
  }

  /** A user the test plays leaves the server. Any other session is
   *  kicked, the one way a server ends a session that is not ending its
   *  own. */
  removeUser(uid: number): void {
    const s = this.live(uid);
    if (s.scripted) this.end(s);
    else this.kick(uid);
  }

  /** Kick a session: `kicked`, then the connection closed with reason
   *  `kicked` (hotline-ng.md §5); a detached one just ends (§2). */
  kick(uid: number): void {
    const s = this.live(uid);
    this.emit(s, 'kicked', {});
    this.end(s, 'kicked');
  }

  /** Add an account, or replace the one with its login. */
  addAccount(account: FakeAccount): void {
    this.accounts.set(account.login, account);
  }

  /** The public lines kept in `room`, the lobby by default, oldest first. */
  lines(room = 0): HistoryLine[] {
    const lines = this.kept.get(room);
    if (!lines) throw new Error(`no room ${room}`);
    return structuredClone(lines);
  }

  /** The messages stored for `login`, oldest first. */
  mail(login: string): StoredMessage[] {
    return this.stored.filter((m) => m.to === login).map(({ id, from, text, at, read }) => structuredClone({ id, from, text, at, read }));
  }

  /** A line of public chat from `uid`, which must be in `room` if one
   *  is named. Returns its id. */
  say(uid: number, text: string, opts: { room?: number; style?: 'normal' | 'action' } = {}): number {
    const s = this.live(uid);
    const room = opts.room ?? 0;
    if (room && !this.room(room).members.has(uid)) throw new Error(`${uid} is not in room ${room}`);
    return this.relay(s, room, text, opts.style ?? 'normal');
  }

  /** A private message from `uid`, as `msg` would send it. */
  message(uid: number, params: MsgParams): MsgOk {
    return this.sendMsg(this.live(uid), params);
  }

  addRoom(room: { name: string; topic?: string; position?: number }): number {
    const r: FakeRoom = {
      id: this.nextRoom++,
      name: room.name,
      topic: room.topic ?? '',
      position: room.position ?? 0,
      members: new Set(),
      archived: false,
    };
    this.rooms.set(r.id, r);
    this.kept.set(r.id, []);
    for (const s of this.aware()) this.emit(s, 'room_added', { room: this.view(r) });
    return r.id;
  }

  /** A user the test plays joins a room. */
  joinRoom(uid: number, room: number): void {
    this.enter(this.live(uid), this.room(room));
  }

  /** A user the test plays leaves a room. */
  partRoom(uid: number, room: number): void {
    this.leave(this.live(uid), this.room(room));
  }

  /** Part every member, telling each why and nobody else, then hide
   *  the room. */
  archiveRoom(id: number): void {
    const r = this.room(id);
    for (const uid of r.members) this.emit(this.live(uid), 'room_member_parted', { room: id, uid, reason: 'archived' });
    r.members.clear();
    r.archived = true;
    for (const s of this.aware()) this.emit(s, 'room_removed', { room: id });
  }

  /** Lose `uid`'s connection, as a dead network would. */
  drop(uid: number): void {
    this.live(uid).socket?.shut(1006, '');
  }

  /** What a server does to a client too far behind: drop it, and answer
   *  its next resume `resync_required`, since the gap cannot be replayed. */
  overflow(uid: number): void {
    const s = this.live(uid);
    s.broken = true;
    s.socket?.shut(1006, '');
  }

  /** End a detached session, as its grace window lapsing would. */
  expire(uid: number): void {
    const s = this.live(uid);
    if (s.socket) throw new Error(`${uid} is attached`);
    this.end(s);
  }

  // --- the wire ---------------------------------------------------------

  private async received(sock: FakeSocket, raw: string): Promise<void> {
    if (sock.readyState !== FakeSocket.OPEN) return;
    const frame = JSON.parse(raw) as ReqFrame;
    const s = sock.session;
    this.requests.push({ ...frame, from: s && this.sender(s) });
    const { id, req } = frame;
    const params = (frame.params ?? {}) as Record<string, any>;
    const handshake = req === 'login' || req === 'resume';
    const answer = (reply: FakeReply): void => sock.deliver({ reply: id, ...reply });
    const refused = this.refusals.get(req)?.shift();
    if (refused) {
      answer({ error: refused });
      if (handshake && !s) sock.shut(1000, '');
      return;
    }
    try {
      if (!s) {
        if (req === 'login') return this.login(sock, params as LoginParams, answer);
        if (req === 'resume') return this.resume(sock, params as ResumeParams, answer);
        answer({ error: { code: 'not_logged_in', text: 'Log in first.' } });
        return sock.shut(1000, '');
      }
      if (handshake) throw refuse('bad_request', 'Already logged in.');
      const custom = await this.handlers.get(req)?.(params, this.sender(s));
      if (custom) return answer(custom);
      if (req === 'logout') {
        answer({ ok: {} });
        return this.end(s, 'logout');
      }
      if (req === 'sync') {
        answer({ ok: this.sync(s) });
        return this.flushMail(s);
      }
      answer({ ok: this.dispatch(s, req, params) });
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      answer({ error: e.error });
      if (handshake && !s) sock.shut(1000, '');
    }
  }

  private lost(sock: FakeSocket): void {
    const s = sock.session;
    if (!s || s.socket !== sock || s.ended) return;
    s.socket = null;
    if (!s.detachable) return this.end(s);
    s.bufferFrom = s.seq + 1;
    this.restatus(s, 'detached');
  }

  private dispatch(s: Session, req: string, p: Record<string, any>): unknown {
    // What makes a session rooms-aware, before the request is acted on
    // (chat-rooms.md §7): the lobby's `room_topic` alone does not.
    if ((req.startsWith('room') && req !== 'room_topic') || Number(p.room)) {
      if (!this.caps.has('rooms')) throw refuse('not_available', 'This server has no rooms.');
      s.aware = true;
    }
    if (req === 'history' && !this.caps.has('history')) throw refuse('not_available', 'This server keeps no history.');
    switch (req) {
      case 'ping':
        return {};
      case 'chat':
        return this.chat(s, p as ChatParams);
      case 'history':
        return this.history(p as HistoryParams);
      case 'msg':
        return this.sendMsg(s, p as MsgParams);
      case 'inbox':
        return this.inbox(s, p as InboxParams);
      case 'msg_read':
        if (!s.mailbox) throw refuse('no_inbox', 'This account has no inbox.');
        for (const m of this.mailOf(s)) if (m.id <= Number(p.up_to)) m.read = true;
        return this.counts(s);
      case 'rooms':
        return { list: this.visible().map((r) => this.view(r)) } satisfies RoomsOk;
      case 'room_join':
        return this.roomJoin(s, Number(p.room ?? 0));
      case 'room_part':
        this.leave(s, this.member(s, Number(p.room ?? 0)));
        return {};
      case 'room_topic':
        return this.roomTopic(Number(p.room ?? 0), String(p.topic ?? ''));
      default:
        throw refuse('unknown_method', `No ${req} here.`);
    }
  }

  private login(sock: FakeSocket, p: LoginParams, answer: (r: { ok: LoginOk }) => void): void {
    const proved = sock.identity;
    let account: FakeAccount | null = null;
    if (proved) {
      account = proved.login === null ? null : (this.accounts.get(proved.login) ?? null);
    } else if (p.login) {
      account = this.accounts.get(p.login) ?? null;
      // A linked account's only credential is its identity (§8.3).
      const linkedOnly = !!account && !account.password && !!account.identity;
      if (!account || linkedOnly || account.password !== (p.password ?? '')) {
        throw refuse('login_failed', 'Wrong login or password.');
      }
    } else if (!this.guests) {
      throw refuse('login_failed', 'Wrong login or password.');
    }
    const uid = this.nextUid++;
    const s = this.blank(uid, account);
    const nick = Array.from(p.nick || account?.nick || account?.login || 'guest').slice(0, 31).join('');
    s.user = { uid, nick, icon: p.icon ?? account?.icon ?? 128, admin: false, status: 'active', transport: 'encrypted' };
    if (proved) this.prove(s, String(uid).padStart(52, '0'));
    s.detachable = !!proved || !!account?.password;
    s.socket = sock;
    sock.session = s;
    this.join(s);
    answer({
      ok: {
        session: s.id,
        token: s.token,
        self: this.self(s),
        server: { name: this.name, subject: this.subject },
        users: this.roster(),
        detach: s.detachable ? { grace: this.grace } : null,
        caps: [...this.caps],
        seq: 0,
        ...(this.caps.has('history') ? { history: { max_lines: 10_000, max_days: 30 } } : {}),
        ...(this.caps.has('inbox') ? { inbox: this.counts(s) } : {}),
        ...(this.caps.has('rooms')
          ? {
              rooms: {
                lobby: { id: 0 as const, name: 'lobby', ...this.lastId(0) },
                list: this.visible().map((r) => this.view(r)),
                max_joined: MAX_JOINED,
              },
            }
          : {}),
      },
    });
    this.flushMail(s);
  }

  private resume(sock: FakeSocket, p: ResumeParams, answer: (r: { ok: ResumeOk } | { error: WireError }) => void): void {
    const s = [...this.sessions.values()].find((x) => x.id === p.session);
    if (!s || s.token !== p.token) throw refuse('session_expired', 'That session has ended.');
    // Last device wins (§2).
    const old = s.socket;
    s.socket = sock;
    sock.session = s;
    old?.shut(1008, 'replaced');
    if (s.user.status === 'detached') this.restatus(s, 'active');
    const last = p.last_seq ?? 0;
    // What went to a connection is not held again, and a detached
    // session holds only what came after its detach (§6.2).
    if (s.broken || last > s.seq || (old ? last < s.seq : last + 1 < s.bufferFrom)) {
      s.broken = false;
      return answer({ error: { code: 'resync_required', text: 'Some events cannot be replayed.' } });
    }
    const replay = s.log.filter((f) => f.seq > last);
    answer({ ok: { replay: replay.length, self: this.self(s) } });
    for (const f of replay) sock.deliver(f);
    this.flushMail(s);
  }

  private sync(s: Session): SyncOk {
    return {
      server: { name: this.name, subject: this.subject },
      users: this.roster(),
      seq: s.seq,
      ...(this.caps.has('rooms')
        ? {
            rooms: {
              list: this.visible().map((r) => this.view(r)),
              joined: this.visible()
                .filter((r) => r.members.has(s.uid))
                .map((r) => ({ id: r.id, ...this.lastId(r.id) })),
              max_joined: MAX_JOINED,
            },
          }
        : {}),
    };
  }

  private chat(s: Session, p: ChatParams): ChatOk {
    if (typeof p.text !== 'string') throw refuse('bad_request', 'No text.');
    const room = p.room ?? 0;
    if (room) this.member(s, room);
    const guid = this.caps.has('chat_guid') ? this.guid(p.guid) : undefined;
    // A guid is its account's where one person is behind it, else the
    // identity's, else the session's (§7.3).
    const key = guid && `${this.durable(s) ?? `s:${s.id}`}|${room}|${guid}`;
    const prior = key ? this.guids.get(key) : undefined;
    if (prior !== undefined) return this.lineId(prior);
    const id = this.relay(s, room, p.text, p.style ?? 'normal', guid && p.guid);
    if (key) this.guids.set(key, id);
    return this.lineId(id);
  }

  private relay(s: Session, room: number, text: string, style: 'normal' | 'action', guid?: string): number {
    const id = ++this.nextLine;
    const at = now();
    // Without `history` nothing is kept, and a line has no id.
    if (this.caps.has('history')) this.kept.get(room)!.push({ id, at, from: { nick: s.user.nick, icon: s.user.icon }, text, style });
    const data: Events['chat'] = {
      from: { uid: s.uid, nick: s.user.nick },
      text,
      style,
      at,
      ...this.lineId(id),
      ...(room ? { room } : {}),
    };
    const hearers = room ? [...this.room(room).members].map((uid) => this.live(uid)) : this.everyone();
    for (const h of hearers) this.emit(h, 'chat', h === s && guid ? { ...data, guid } : data);
    return id;
  }

  private history(p: HistoryParams): HistoryOk {
    const room = p.room ?? 0;
    if (room) this.room(room);
    const limit = p.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw refuse('bad_request', 'limit is 1 to 200.');
    const after = p.after ?? 0;
    const before = p.before ?? 0;
    const rows = this.kept.get(room)!.filter((l) => l.id > after && (!before || l.id < before));
    // Forward from `after` when there is one, else back from the newest.
    const lines = after ? rows.slice(0, limit) : rows.slice(-limit);
    return { lines, has_more: rows.length > limit };
  }

  private sendMsg(s: Session, p: MsgParams): MsgOk {
    if ((p.to === undefined) === (p.to_login === undefined)) throw refuse('bad_request', 'Name exactly one of to and to_login.');
    if (!p.text) throw refuse('bad_request', 'No text.');
    const guid = this.guid(p.guid);
    let targets: Session[];
    let box: string | null;
    if (p.to !== undefined) {
      const target = this.sessions.get(p.to);
      if (!target) throw refuse('no_such_user', 'No such user.');
      targets = [target];
      box = target.mailbox;
    } else {
      targets = this.everyone().filter((x) => x.account?.login === p.to_login);
      const account = this.accounts.get(p.to_login!) ?? targets[0]?.account;
      if (!account) throw refuse('no_such_user', 'No such user.');
      box = targets.find((x) => x.mailbox)?.mailbox ?? (this.hasInbox(account) ? account.login : null);
    }
    const at = now();
    const from: Sender = { uid: s.uid, nick: s.user.nick, ...(s.mailbox ? { login: s.mailbox } : {}) };
    const sender = this.durable(s);
    // Stored only for an inbox, from an account with one or an identity
    // (private-messages.md §7): a plain guest's goes through the outbox,
    // and to nobody when there is no session to hold it.
    if (!box || !sender) {
      if (!targets.length) throw refuse('no_such_user', 'No such user.');
      for (const x of targets) this.emit(x, 'msg', { from, text: p.text, at, queued: false });
      return { queued: false };
    }
    const attached = targets.filter((x) => x.socket || x.scripted);
    // A repeat is the message it repeats, answered as it stands now: one
    // that waited reaches a recipient who has since come back (§7.1).
    const key = guid && `${sender}|${box}|${guid}`;
    const prior = key ? this.mailGuids.get(key) : undefined;
    if (prior) {
      if (prior.pending && attached.length) {
        prior.pending = false;
        for (const x of attached) this.emit(x, 'msg', this.waited(prior));
      }
      return this.msgOk(s, prior);
    }
    const m: Mail = {
      id: ++this.nextMail,
      from: { nick: from.nick, ...(s.mailbox ? { login: s.mailbox } : {}) },
      text: p.text,
      at,
      read: false,
      to: box,
      fromUid: s.uid,
      pending: !attached.length,
    };
    this.stored.push(m);
    if (key) this.mailGuids.set(key, m);
    for (const x of attached) this.emit(x, 'msg', { from, text: m.text, at, queued: false, id: m.id });
    return this.msgOk(s, m);
  }

  /** The id is for a sender with an inbox to find it in (§7.1). */
  private msgOk(s: Session, m: Mail): MsgOk {
    return m.pending ? { queued: true, ...(s.mailbox ? { id: m.id } : {}) } : { queued: false };
  }

  private waited(m: Mail): Events['msg'] {
    const sender = this.sessions.get(m.fromUid);
    return {
      from: { uid: sender ? sender.uid : 0, nick: m.from.nick, ...(m.from.login ? { login: m.from.login } : {}) },
      text: m.text,
      at: m.at,
      queued: true,
      id: m.id,
    };
  }

  private flushMail(s: Session): void {
    for (const m of this.mailOf(s)) {
      if (!m.pending) continue;
      m.pending = false;
      this.emit(s, 'msg', this.waited(m));
    }
  }

  private inbox(s: Session, p: InboxParams): InboxOk {
    if (!s.mailbox) throw refuse('no_inbox', 'This account has no inbox.');
    const limit = p.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw refuse('bad_request', 'limit is 1 to 200.');
    const messages = this.mailOf(s)
      .filter((m) => !p.before || m.id < p.before)
      .reverse()
      .slice(0, limit)
      .map(({ id, from, text, at, read }): StoredMessage => ({ id, from, text, at, read }));
    return { messages, ...this.counts(s) };
  }

  private roomJoin(s: Session, id: number): RoomJoinOk {
    if (!id) throw refuse('bad_request', 'The lobby is not joined.');
    const r = this.room(id);
    if (!r.members.has(s.uid)) {
      if (this.visible().filter((x) => x.members.has(s.uid)).length >= MAX_JOINED) {
        throw refuse('too_many_rooms', 'In as many rooms as allowed.');
      }
      this.enter(s, r);
    }
    return { members: [...r.members], topic: r.topic, ...this.lastId(id), may_post: true };
  }

  private roomTopic(id: number, topic: string): Record<string, never> {
    if (!id) {
      this.subject = topic;
      for (const x of this.everyone()) this.emit(x, 'subject', { subject: topic });
      return {};
    }
    const r = this.room(id);
    r.topic = topic;
    for (const x of this.everyone()) {
      if (r.members.has(x.uid)) this.emit(x, 'subject', { subject: topic, room: id });
      else if (x.aware) this.emit(x, 'room_changed', { room: this.view(r) });
    }
    return {};
  }

  // --- the state --------------------------------------------------------

  private blank(uid: number, account: FakeAccount | null): Session {
    const serial = ++this.serial;
    return {
      uid,
      user: { uid, nick: '', icon: 0, admin: false, status: 'active', transport: 'encrypted' },
      account,
      mailbox: account && this.hasInbox(account) ? account.login : null,
      identity: undefined,
      id: `s_${serial}`,
      token: `t_${serial}`,
      scripted: false,
      detachable: false,
      seq: 0,
      log: [],
      bufferFrom: 1,
      socket: null,
      broken: false,
      aware: false,
      ended: false,
    };
  }

  private hasInbox(account: FakeAccount): boolean {
    return this.caps.has('inbox') && (!!account.password || !!account.identity);
  }

  private prove(s: Session, fingerprint: string): void {
    s.user.identity = { fingerprint, handle: null };
    s.identity = {
      fingerprint,
      handle: null,
      age: 0,
      outcome: s.account ? 'linked' : 'guest',
      account: s.account?.login ?? null,
    };
  }

  /** Who a durable message or line is held under: the inbox, else the
   *  identity, else nobody (private-messages.md §7). */
  private durable(s: Session): string | null {
    if (s.mailbox) return `a:${s.mailbox}`;
    return s.identity ? `i:${s.identity.fingerprint}` : null;
  }

  /** A guid as the wire allows it, any case and hyphens or none (§7.1). */
  private guid(guid: string | undefined): string | undefined {
    if (guid === undefined) return undefined;
    if (!GUID.test(guid)) throw refuse('bad_request', 'A guid is a UUID.');
    return guid.replaceAll('-', '').toLowerCase();
  }

  private lineId(id: number): { id?: number } {
    return this.caps.has('history') ? { id } : {};
  }

  private sender(s: Session): FakeSender {
    return { uid: s.uid, login: s.account?.login ?? null };
  }

  private join(s: Session): void {
    for (const x of this.everyone()) this.emit(x, 'user_joined', { user: s.user });
    this.sessions.set(s.uid, s);
  }

  /** Leaving the server says so once, as `user_parted`, and parts no
   *  room on its own (chat-rooms.md §7.3). */
  private end(s: Session, close?: 'logout' | 'kicked'): void {
    // Whatever is attached goes with it, after what it has been sent.
    s.socket?.shut(1000, close ?? '');
    s.ended = true;
    this.sessions.delete(s.uid);
    for (const r of this.rooms.values()) r.members.delete(s.uid);
    for (const x of this.everyone()) this.emit(x, 'user_parted', { uid: s.uid });
  }

  private restatus(s: Session, status: User['status']): void {
    s.user = { ...s.user, status };
    for (const x of this.everyone()) if (x !== s) this.emit(x, 'user_changed', { user: s.user });
  }

  private enter(s: Session, r: FakeRoom): void {
    for (const m of r.members) this.emit(this.live(m), 'room_member_joined', { room: r.id, user: s.user });
    r.members.add(s.uid);
  }

  private leave(s: Session, r: FakeRoom): void {
    r.members.delete(s.uid);
    for (const m of r.members) this.emit(this.live(m), 'room_member_parted', { room: r.id, uid: s.uid });
  }

  private emit<K extends EventName>(s: Session, ev: K, data: Events[K]): void {
    if (s.scripted || s.ended) return;
    const frame: EventFrame = { seq: ++s.seq, ev, data };
    s.log.push(frame);
    s.socket?.deliver(frame);
  }

  private live(uid: number): Session {
    const s = this.sessions.get(uid);
    if (!s) throw new Error(`no session ${uid}`);
    return s;
  }

  private everyone(): Session[] {
    return [...this.sessions.values()];
  }

  private aware(): Session[] {
    return this.everyone().filter((s) => s.aware);
  }

  private roster(): User[] {
    return this.everyone().map((s) => s.user);
  }

  private self(s: Session): SelfUser {
    // Only a session that proved an identity has one on its row.
    return s.identity ? { ...s.user, identity: s.identity } : (s.user as SelfUser);
  }

  /** A room this session may see; any other is `no_such_room` (§5). */
  private room(id: number): FakeRoom {
    const r = this.rooms.get(id);
    if (!r || r.archived) throw refuse('no_such_room', 'No such room.');
    return r;
  }

  private member(s: Session, id: number): FakeRoom {
    if (!id) throw refuse('bad_request', 'The lobby is not joined.');
    const r = this.room(id);
    if (!r.members.has(s.uid)) throw refuse('not_a_member', 'Not in that room.');
    return r;
  }

  private visible(): FakeRoom[] {
    // By position then name, by code point (chat-rooms.md §7.1).
    return [...this.rooms.values()]
      .filter((r) => !r.archived)
      .sort((a, b) => a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  private view(r: FakeRoom): Room {
    return { id: r.id, name: r.name, topic: r.topic, position: r.position, members: r.members.size, ...this.lastId(r.id), may_post: true };
  }

  private lastId(room: number): { last_id?: number } {
    const last = this.kept.get(room)!.at(-1)?.id;
    return last === undefined ? {} : { last_id: last };
  }

  private mailOf(s: Session): Mail[] {
    return s.mailbox ? this.stored.filter((m) => m.to === s.mailbox) : [];
  }

  private counts(s: Session): InboxCounts {
    const mine = this.mailOf(s);
    return { unread: mine.filter((m) => !m.read).length, total: mine.length };
  }
}
