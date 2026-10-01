/**
 * A session on a classic Hotline server, reached through a relay.
 *
 * A browser cannot open TCP, so a classic server is reached through a
 * relay beside it (`hlrelay`, hxd-ng's `docs/relay.md`) or hxd-ng's own
 * `/trtp`: a WebSocket whose binary frames carry the classic protocol
 * byte for byte. The protocol itself is hx-libs' `hxsession` — GtkHx's
 * logic, compiled to wasm (`./wire`) — and this class is the rest: the
 * socket, the timer, and the translation between what the session says
 * and what this client's views expect of a `Connection`.
 *
 * That translation is the point of the class. The views were written for
 * the ng wire, so a classic server is presented in its terms: users and
 * chat as ng events, a folder as an ng listing, threaded news as ng's
 * tree of numbered nodes. What a classic server cannot do is declined
 * the way an ng server without the capability declines it, and the views
 * already know how to take that.
 */

import {
  CAP_FILES,
  CAP_NEWS,
  WireFailure,
  type ChatStyle,
  type ConnectionHooks,
  type ConnState,
  type Events,
  type FilesListOk,
  type LoginOk,
  type NewsArticle,
  type NewsConfig,
  type NewsNode,
  type NewsThread,
  type NewsThreadOk,
  type NewsThreadParams,
  type NewsThreadsOk,
  type NewsThreadsParams,
  type NewsTreeOk,
  type NewsTreeParams,
  type SelfUser,
  type Sender,
  type User,
} from '@hotline-ng/client';

import type { Session } from '../session';
import {
  ClassicConfig,
  ClassicSession,
  classicFailed,
  isRefusal,
  loadClassic,
  macDate,
  type ClassicArticle,
  type ClassicEvent,
  type ClassicReply,
  type ClassicUser,
} from './wire';

export interface ClassicCredentials {
  /** The relay's `/trtp`, as a ws: or wss: URL. */
  url: string;
  login: string;
  password: string;
  nick: string;
  icon: number;
  /** The relay's name for the server, from discovery: shown where the
   *  server names itself to nobody, as a 1.2 server does. */
  name?: string;
}

export interface ClassicHooks extends ConnectionHooks {
  /** The server's agreement. Resolve true to agree and carry on, false
   *  to leave; `signal` aborts if the session ends while it is asked.
   *  Without this hook the agreement is accepted unseen, which is what the
   *  server is told either way when it has nothing to show. */
  onAgreement?: (text: string, signal: AbortSignal) => Promise<boolean>;
}

/** What a classic server cannot do, said in this client's own words: the
 *  code is one `errorText` has no canned text for, so the text shows. */
function unavailable(what: string): WireFailure {
  return new WireFailure({ code: 'classic', text: `Not on a classic server yet: ${what}.` });
}

/** How long a request may go unanswered. A classic server ignores an
 *  opcode it does not know rather than refusing it. */
const REQUEST_MS = 20_000;

const THREAD_FETCHES = 4;

/** How long after the login a server has to send its user list, which
 *  is what the login waits on. */
const ROSTER_MS = 15_000;

/** A request the server refused, with its reason when it gave one. */
function refused(reason: string | undefined): WireFailure {
  return new WireFailure({ code: 'refused', text: reason ?? 'The server refused that.' });
}

/** A roster row as the session's own. Nothing on a classic server proves
 *  an identity, so there is none to carry over. */
function selfOf(u: User): SelfUser {
  const { identity: _identity, ...rest } = u;
  return rest;
}

/** The status bits a classic server keeps, as the ng roster has them. */
const AWAY = 1;
const ADMIN = 2;

/** Read-only news, as this client offers it on a classic server. */
const CLASSIC_NEWS: NewsConfig = {
  post: false,
  attach: false,
  max_body: 0,
  max_subject: 0,
  markdown: 'off',
  body_types: ['text/plain'],
  max_refs: 0,
  search: false,
};

type Waiter = {
  resolve: (e: ClassicReply) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** A news node: a bundle or category by its path — each name's bytes as
 *  the server listed it — or the server's 1.2 flat news, which has none. */
type Node = { kind: 'bundle' | 'category'; path: Uint8Array[] } | { kind: 'flat' };

/** A path of names' bytes as a map key. */
function pathKey(path: Uint8Array[]): string {
  return path.map((p) => Array.from(p, (b) => b.toString(16).padStart(2, '0')).join('')).join('/');
}

/** How long the root's threaded listing may lag the flat file before the
 *  root is shown without it. */
const LISTING_GRACE_MS = 3000;

/** An article, by where it lives on the server. */
interface Post {
  node: number;
  postid: number;
  parent: number | null;
  root: number;
  depth: number;
  subject: string;
  poster: string;
  at: number;
}

export class ClassicConnection implements Session {
  readonly classic = true;
  state: ConnState = 'offline';
  // Nothing here resumes: a classic session ends with its socket.
  session: string | null = null;
  token: string | null = null;
  seq = 0;
  grace: number | null = null;
  self: SelfUser | null = null;
  caps: string[] = [];
  rtt: number | null = null;
  // Extensions a classic server reaches this client without.
  video: Session['video'] = null;
  media: Session['media'] = null;
  push: Session['push'] = null;
  moderator = false;
  moderation: Session['moderation'] = null;
  banner: Session['banner'] = null;
  avatars: Session['avatars'] = null;
  news: NewsConfig | null = null;

  private ws: WebSocket | null = null;
  private s: ClassicSession | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Map<string, Set<(data: unknown) => void>>();
  private waiting = new Map<number, Waiter>();
  private roster = new Map<number, User>();
  private selfUid: number | null = null;
  private serverName = '';
  private online = false;
  private ending = false;
  private starting: { resolve: () => void; reject: (e: Error) => void } | null = null;
  /** Running between the session saying it is ready and the user list
   *  that completes the login. */
  private rosterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Aborted when the session ends, withdrawing an agreement still asked. */
  private asking = new AbortController();

  // Threaded news, numbered the way the ng views expect.
  private nodes = new Map<number, Node>();
  private nodeIds = new Map<string, number>();
  private posts = new Map<number, Post>();
  private postIds = new Map<string, number>();
  private nextId = 1;
  /** The flat news file, once read: it is all one article. */
  private flatText: string | null = null;
  /** Whether the server answers threaded news at its root; `false` once
   *  it has ignored or refused it, so the root stops waiting on it. */
  private threaded: boolean | null = null;
  /** Folders' paths by the names shown, to the bytes that name them: a
   *  view addresses a folder by a slash-separated path of shown names. */
  private folders = new Map<string, Uint8Array[]>([['', []]]);
  /** An agreement is being shown; another is not shown on top of it. */
  private agreementOpen = false;
  /** Refusals said while logging in, told once logged in. */
  private early: string[] = [];

  constructor(
    private creds: ClassicCredentials,
    private hooks: ClassicHooks = {},
  ) {
    // An ng server names a nameless login after its account; a classic
    // one shows an empty name, so give it the one GtkHx would.
    this.creds = { ...creds, nick: creds.nick.trim() || creds.login.trim() || 'guest' };
  }

  // --- lifecycle --------------------------------------------------------

  async start(_opts: { resumeOnly?: boolean } = {}): Promise<void> {
    this.ending = false;
    this.asking = new AbortController();
    this.setState('connecting');
    let s: ClassicSession;
    let ws: WebSocket;
    try {
      await loadClassic();
      // Dropped while the module loaded: there is nothing to start.
      if (this.ending) throw new Error('Disconnected.');
      s = new ClassicSession(
        new ClassicConfig(this.creds.login, this.creds.password, this.creds.nick, this.creds.icon),
        performance.now(),
      );
      this.s = s;
      ws = new WebSocket(this.creds.url);
    } catch (e) {
      this.s?.free();
      this.s = null;
      this.setState('offline');
      throw e;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    // The login deadline runs from now, not from the socket opening. Only
    // the timer: a pump now would take the magic before it can be sent.
    this.arm(s);
    const started = new Promise<void>((resolve, reject) => (this.starting = { resolve, reject }));
    ws.onopen = () => this.pump();
    ws.onmessage = (m) => {
      if (this.s !== s || !(m.data instanceof ArrayBuffer)) return;
      this.guard(() => s.feed(new Uint8Array(m.data), performance.now()));
      this.pump();
    };
    ws.onclose = () => {
      if (this.s !== s) return;
      this.guard(() => s.disconnected());
      this.pump();
    };
    ws.onerror = () => {
      // A close always follows, and says it.
    };
    return started;
  }

  async logout(): Promise<void> {
    this.drop();
  }

  drop(): void {
    this.ending = true;
    this.ws?.close();
  }

  /**
   * Call into the module, and end the session if it fails. With
   * `panic = "abort"` a panic is a trap, after which the module is not to
   * be trusted with this session again — better a closed connection that
   * says so than one that shows online with nothing moving. A refusal —
   * too long, not logged in — is an answer, not a fault, and is thrown on
   * to the caller.
   */
  private guard<T>(f: () => T): T | undefined {
    try {
      return f();
    } catch (e) {
      if (isRefusal(e)) throw e;
      classicFailed();
      this.closed(`The classic session failed: ${e instanceof Error ? e.message : String(e)}`, false);
      return undefined;
    }
  }

  /** Move what the session wants sent, take what it has to say, and set
   *  the timer for when it next needs the clock. */
  private pump(): void {
    const s = this.s;
    if (!s) return;
    for (;;) {
      const out = this.guard(() => s.takeOutgoing());
      if (this.s !== s || out === undefined) return;
      if (out.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(out);
      const e = this.guard(() => s.pollEvent()) as ClassicEvent | undefined;
      if (this.s !== s) return;
      if (!e) break;
      this.trace(e);
      // Not guarded: a view's handler failing is the view's bug, not a
      // reason to end the session.
      this.onEvent(e);
      if (this.s !== s) return;
    }
    this.arm(s);
  }

  private arm(s: ClassicSession): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const due = this.guard(() => s.nextDeadline());
    if (this.s !== s || due === undefined) return;
    this.timer = setTimeout(
      () => {
        if (this.s !== s) return;
        this.guard(() => s.tick(performance.now()));
        this.pump();
      },
      Math.max(0, due - performance.now()),
    );
  }

  private trace(e: ClassicEvent): void {
    this.hooks.onTrace?.({ t: Date.now(), dir: 'in', kind: `classic:${e.type}`, raw: JSON.stringify(e) });
  }

  private setState(s: ConnState, detail?: string): void {
    this.state = s;
    this.hooks.onState?.(s, detail);
  }

  // --- what the session says --------------------------------------------

  private onEvent(e: ClassicEvent): void {
    switch (e.type) {
      case 'logged_in':
        this.serverName = e.name ?? this.creds.name ?? '';
        this.selfUid = e.uid ?? null;
        return;
      case 'agreement':
        void this.agreement(e.text);
        return;
      case 'ready':
        // The session asked for the user list; its answer is the login.
        // A server that refuses it, or never sends it, still logged us in.
        this.rosterTimer = setTimeout(() => this.loggedIn('The server did not send its user list.'), ROSTER_MS);
        return;
      case 'user_list':
        for (const u of e.users) this.roster.set(u.uid, this.user(u, this.roster.get(u.uid)));
        if (!this.online) this.loggedIn();
        // A list after the login went ahead without one: the views are
        // handed the whole roster again.
        else this.snapshot();
        return;
      case 'self_info':
        this.selfUid = e.uid;
        return;
      case 'user_changed': {
        // A change in a private chat; the public roster is all there is.
        if (e.cid !== 0) return;
        const before = this.roster.get(e.user.uid);
        const user = this.user(e.user, before);
        this.roster.set(user.uid, user);
        if (user.uid === this.selfUid) this.self = selfOf(user);
        if (this.online) this.emit(before ? 'user_changed' : 'user_joined', { user });
        return;
      }
      case 'user_left':
        if (e.cid !== 0) return;
        this.roster.delete(e.uid);
        if (this.online) this.emit('user_parted', { uid: e.uid });
        return;
      case 'chat':
        // A private chat's; this client is in the public one only.
        if (e.cid !== 0) return;
        return this.chatLines(e.uid, e.text);
      case 'message':
        this.emit('msg', {
          from: { uid: e.uid, nick: e.from || this.roster.get(e.uid)?.nick || `uid ${e.uid}` },
          text: e.text,
          at: Math.floor(Date.now() / 1000),
          queued: false,
        });
        return;
      case 'broadcast':
        this.emit('broadcast', { from: { uid: 0, nick: this.serverName || 'Server' }, text: e.text });
        return;
      case 'disconnecting':
        this.emit('notice', { text: e.text });
        return;
      case 'news_posted':
        // The flat file is stale; the next read fetches it again.
        this.flatText = null;
        return;
      case 'failed': {
        const w = this.waiting.get(e.trans);
        if (w) {
          this.waiting.delete(e.trans);
          clearTimeout(w.timer);
          w.reject(refused(e.reason));
        } else if (!this.online && e.trans === this.guard(() => this.s?.rosterTrans())) {
          // The post-login user list, refused: logged in all the same.
          this.loggedIn(e.reason ?? 'The server would not send its user list.');
        } else if (!this.online) {
          // Something else sent while logging in — the agree, the name —
          // refused before there is a session to say so in.
          if (e.reason) this.early.push(e.reason);
        } else {
          // Chat and messages are not answered when they work, so a
          // refusal of one is the only word about it, reason or none.
          this.emit('notice', { text: e.reason ?? 'The server refused something this client sent.' });
        }
        return;
      }
      case 'closed':
        return this.closed(e.reason, e.refused);
      case 'unhandled':
        return;
      default: {
        const w = this.waiting.get(e.trans);
        if (!w) return;
        this.waiting.delete(e.trans);
        clearTimeout(w.timer);
        w.resolve(e);
      }
    }
  }

  private async agreement(text: string): Promise<void> {
    // A server that sends its agreement twice gets one dialog.
    if (this.agreementOpen) return;
    this.agreementOpen = true;
    const s = this.s;
    let agreed: boolean;
    try {
      agreed = this.hooks.onAgreement ? await this.hooks.onAgreement(text, this.asking.signal) : true;
    } catch {
      // A view that could not ask has not been agreed with.
      agreed = false;
    } finally {
      this.agreementOpen = false;
    }
    if (!this.s || this.s !== s || this.ending) return;
    if (!agreed) {
      this.closed('You did not accept the agreement.', true);
      this.drop();
      return;
    }
    try {
      this.guard(() => s.agree());
    } catch {
      // Already answered: nothing more to say.
    }
    this.pump();
  }

  /** The login is complete: tell the views, with a note when it came
   *  without a user list. */
  private loggedIn(note?: string): void {
    if (this.online || !this.s) return;
    if (this.rosterTimer !== null) clearTimeout(this.rosterTimer);
    this.rosterTimer = null;
    const users = [...this.roster.values()];
    const me = (this.selfUid !== null && this.roster.get(this.selfUid)) || this.byNick(users) || null;
    this.selfUid = me?.uid ?? this.selfUid;
    const self = me ? selfOf(me) : this.placeholderSelf();
    this.self = self;
    this.caps = [CAP_FILES, CAP_NEWS];
    this.news = CLASSIC_NEWS;
    this.online = true;
    const server = { name: this.serverName, subject: '' };
    const ok: LoginOk = {
      session: '',
      token: '',
      self,
      server,
      users,
      detach: null,
      caps: this.caps,
      seq: 0,
      news: CLASSIC_NEWS,
    };
    this.setState('online');
    this.hooks.onLogin?.(ok);
    this.hooks.onSnapshot?.({ self, users, server });
    this.starting?.resolve();
    this.starting = null;
    for (const text of this.early.splice(0)) this.emit('notice', { text });
    if (note) this.emit('notice', { text: note });
  }

  /** The roster again, for a list that came after the login: who we are
   *  is worked out afresh, since a login without a list could not. */
  private snapshot(): void {
    const users = [...this.roster.values()];
    if (!this.selfUid || !this.roster.has(this.selfUid)) {
      this.selfUid = this.byNick(users)?.uid ?? this.selfUid;
    }
    const me = this.selfUid !== null ? this.roster.get(this.selfUid) : undefined;
    if (me) this.self = selfOf(me);
    this.hooks.onSnapshot?.({ self: this.self ?? this.placeholderSelf(), users, server: { name: this.serverName, subject: '' } });
  }

  /** Who we are, when the server has not said our uid: one of the users
   *  with our name, and our icon if any of them has it. Of several — two
   *  guests are common on a classic server — the newest, since servers
   *  number users as they arrive and we have only just. */
  private byNick(users: User[]): User | undefined {
    const named = users.filter((u) => u.nick === this.creds.nick);
    const iconed = named.filter((u) => u.icon === this.creds.icon);
    const pool = iconed.length ? iconed : named;
    return pool.reduce<User | undefined>((a, u) => (!a || u.uid > a.uid ? u : a), undefined);
  }

  private placeholderSelf(): SelfUser {
    return {
      uid: this.selfUid ?? 0,
      nick: this.creds.nick,
      icon: this.creds.icon,
      admin: false,
      status: 'active',
      transport: 'cleartext',
    };
  }

  private closed(reason: string, wasRefused: boolean): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.rosterTimer !== null) clearTimeout(this.rosterTimer);
    this.rosterTimer = null;
    this.asking.abort();
    this.early = [];
    const s = this.s;
    this.s = null;
    // After a trap the module's own state is not to be trusted; freeing
    // it is best effort.
    try {
      s?.free();
    } catch {
      /* already poisoned */
    }
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
    this.waiting.clear();
    this.setState('offline', reason);
    if (this.starting) {
      const start = this.starting;
      this.starting = null;
      start.reject(wasRefused ? new WireFailure({ code: 'classic', text: reason }) : new Error(reason));
      return;
    }
    if (this.online) {
      this.online = false;
      this.hooks.onEnded?.(this.ending ? 'Disconnected.' : reason);
    }
  }

  /** A classic user as the ng roster draws one. A change that leaves the
   *  status out keeps the one already known. */
  private user(u: ClassicUser, before?: User): User {
    const bits = u.status ?? (before ? (before.status === 'idle' ? AWAY : 0) | (before.admin ? ADMIN : 0) : 0);
    return {
      uid: u.uid,
      nick: u.name,
      icon: u.icon,
      admin: (bits & ADMIN) !== 0,
      status: bits & AWAY ? 'idle' : 'active',
      // Nothing on the classic wire says otherwise, and the hop from the
      // relay to the server is plain TCP.
      transport: 'cleartext',
    };
  }

  /**
   * Public chat. A classic server formats each line itself — the sender's
   * name right-aligned before two spaces, or ` *** name text` for an emote
   * — and one transaction may carry several lines, each formatted. Many
   * servers say nothing else about who sent it, so the name is read back
   * out of each line and matched against the roster. A line with no name
   * on it carries on from the line before.
   *
   * The emote form comes first, since its text may hold anything. A
   * server's own notices take that form too, so an emote is attributed
   * only when the server said who sent it, and is otherwise shown as it
   * came, as a notice. One notice does come with a uid: mhxd's and
   * hxd-ng's ` *** alice was kicked for chat spamming` names the spammer,
   * and is drawn as alice's emote — which reads the same.
   *
   * Only the first line decides who is speaking, or that the server is.
   * A server that passes a user's own line breaks through unprefixed
   * would otherwise let them write ` *** Server: …` or `bob:  …` on a
   * line of their own and be shown as the server or as bob; later lines
   * that look like either carry on as the first speaker's words, and only
   * the first speaker's name is taken off them.
   */
  private chatLines(uid: number, text: string): void {
    const at = Math.floor(Date.now() / 1000);
    let last: Sender | null = null;
    let first = true;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (!first) {
        const speaker: Sender = last ?? this.sender(uid, '');
        const said = /^\s*(?:\[\d{1,2}:\d{2}\]\s+)?(.+?):\s\s([\s\S]*)$/.exec(line);
        const shown = said?.[1]!.trim() ?? '';
        // mhxd cuts a name to thirteen characters in the line it formats.
        const own = said && (shown === speaker.nick || (shown.length >= 13 && speaker.nick.startsWith(shown)));
        if (last || uid) {
          last = speaker;
          this.emit('chat', { from: speaker, text: own ? said[2]! : line.trim(), style: 'normal', at });
        } else {
          this.emit('notice', { text: line.trim() });
        }
        continue;
      }
      first = false;
      const emote = /^\s?\*\*\*\s([\s\S]*)$/.exec(line);
      if (emote) {
        const rest = emote[1]!;
        const who = uid ? this.roster.get(uid) : undefined;
        if (who && rest.startsWith(`${who.nick} `)) {
          last = { uid, nick: who.nick };
          this.emit('chat', { from: last, text: rest.slice(who.nick.length + 1), style: 'action', at });
        } else {
          last = null;
          this.emit('notice', { text: line.trim() });
        }
        continue;
      }
      // hxd-ng replays history to a client without the capability with
      // the time before the name: `[12:34] alice:  hi`.
      const said = /^\s*(?:\[\d{1,2}:\d{2}\]\s+)?(.+?):\s\s([\s\S]*)$/.exec(line);
      if (said) {
        last = this.sender(uid, said[1]!.trim());
        const style: ChatStyle = 'normal';
        this.emit('chat', { from: last, text: said[2]!, style, at });
      } else if (last) {
        this.emit('chat', { from: last, text: line.trim(), style: 'normal', at });
      } else {
        this.emit('notice', { text: line.trim() });
      }
    }
  }

  private sender(uid: number, shown: string): Sender {
    const byUid = uid ? this.roster.get(uid) : undefined;
    if (byUid) return { uid, nick: byUid.nick };
    // mhxd cuts a name to thirteen characters in the line it formats.
    for (const u of this.roster.values()) {
      if (u.nick === shown || (shown.length >= 13 && u.nick.startsWith(shown))) return { uid: u.uid, nick: u.nick };
    }
    return { uid: 0, nick: shown };
  }

  // --- events -----------------------------------------------------------

  on<K extends keyof Events>(ev: K, handler: (data: Events[K]) => void): void {
    let set = this.handlers.get(ev);
    if (!set) this.handlers.set(ev, (set = new Set()));
    set.add(handler as (data: unknown) => void);
  }

  private emit<K extends keyof Events>(ev: K, data: Events[K]): void {
    for (const h of this.handlers.get(ev) ?? []) h(data);
  }

  hasCap(name: string): boolean {
    return this.caps.includes(name);
  }

  // --- requests ---------------------------------------------------------

  /** Send through the session and wait for the event that answers it. */
  private ask<T extends ClassicReply['type']>(
    type: T,
    send: (s: ClassicSession) => number,
  ): Promise<Extract<ClassicReply, { type: T }>> {
    const s = this.s;
    if (!s || !this.online) return Promise.reject(new WireFailure({ code: 'not_logged_in', text: '' }));
    let trans: number | undefined;
    try {
      trans = this.guard(() => send(s));
    } catch (e) {
      return Promise.reject(new WireFailure({ code: 'classic', text: (e as Error).message }));
    }
    if (trans === undefined) return Promise.reject(new Error('The classic session failed.'));
    const answer = new Promise<ClassicReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting.get(trans)?.timer !== timer) return;
        this.waiting.delete(trans);
        reject(new WireFailure({ code: 'classic', text: 'The server did not answer.' }));
      }, REQUEST_MS);
      this.waiting.set(trans, { resolve, reject, timer });
    });
    this.pump();
    return answer.then((e) => {
      if (e.type !== type) throw new Error(`expected ${type}, got ${e.type}`);
      return e as Extract<ClassicReply, { type: T }>;
    });
  }

  /** Send through the session when nothing will answer. */
  private tell(send: (s: ClassicSession) => unknown): void {
    const s = this.s;
    if (!s || !this.online) throw new WireFailure({ code: 'not_logged_in', text: '' });
    try {
      this.guard(() => send(s));
    } catch (e) {
      // Refused before it was sent: too long, say.
      throw new WireFailure({ code: 'classic', text: (e as Error).message });
    }
    this.pump();
  }

  async request<T = unknown>(req: string, params: unknown = {}): Promise<T> {
    const p = params as { text?: string; style?: string; nick?: string; icon?: number };
    if (req === 'chat' && typeof p.text === 'string') {
      this.tell((s) => s.chat(p.text!, p.style === 'action'));
      return {} as T;
    }
    if (req === 'nick') {
      const me = this.self;
      const nick = p.nick ?? me?.nick ?? this.creds.nick;
      const icon = p.icon ?? me?.icon ?? this.creds.icon;
      // byNick finds us by it.
      this.creds = { ...this.creds, nick, icon };
      this.tell((s) => s.setNick(nick, icon));
      return {} as T;
    }
    throw unavailable(`the “${req}” request`);
  }

  async ping(): Promise<number> {
    // The session keeps the connection alive itself, and a classic ping
    // goes unanswered on older servers: there is no round trip to time.
    return 0;
  }

  async chat(params: { text: string; media?: string }): Promise<Record<string, never>> {
    if (params.media) throw unavailable('sending images');
    this.tell((s) => s.chat(params.text, false));
    return {};
  }

  async msg(params: Parameters<Session['msg']>[0]): Promise<{ queued: boolean }> {
    const to = 'to' in params ? params.to : undefined;
    if (to === undefined) throw unavailable('writing to someone who is not here');
    if (params.media) throw unavailable('sending images');
    // A classic server answers a message only when it refuses one, and
    // that refusal arrives as a notice.
    this.tell((s) => s.message(to, params.text));
    return { queued: false };
  }

  // --- files ------------------------------------------------------------

  /** A folder by the shown path the view has, named to the server by the
   *  bytes its listing gave each name. A name holding a `/` cannot be
   *  told apart from two in this path; such a folder does not open. */
  async filesList(path = ''): Promise<FilesListOk> {
    const parts = path.split('/').filter(Boolean);
    const shown = parts.join('/');
    const bytes =
      this.folders.get(shown) ??
      // Never listed here: a path typed, not followed. The names are
      // encoded as the session sends text.
      parts.map((p) => this.s?.encode(p) ?? new Uint8Array());
    const e = await this.ask('file_list', (s) => s.fileList(bytes));
    for (const f of e.files) {
      if (f.folder) this.folders.set(shown ? `${shown}/${f.name}` : f.name, [...bytes, f.name_bytes]);
    }
    return {
      path: shown,
      entries: e.files.map((f) => ({
        name: f.name,
        kind: f.folder ? 'folder' : 'file',
        size: String(f.size),
        media_type: null,
        modified: null,
      })),
    };
  }

  async fileInfo(): Promise<never> {
    throw unavailable('file details');
  }

  async prepareFileDownload(): Promise<never> {
    throw unavailable('downloading');
  }

  fileDownloadUrl(): string {
    throw unavailable('downloading');
  }

  async fetchFile(): Promise<never> {
    throw unavailable('downloading');
  }

  // --- news -------------------------------------------------------------

  private nodeId(node: Node): number {
    const key = node.kind === 'flat' ? 'flat' : `n:${pathKey(node.path)}`;
    let id = this.nodeIds.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.nodeIds.set(key, id);
    }
    this.nodes.set(id, node);
    return id;
  }

  private postId(node: number, postid: number): number {
    const key = `${node}:${postid}`;
    let id = this.postIds.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.postIds.set(key, id);
    }
    return id;
  }

  private node(id: number): Node {
    const n = this.nodes.get(id);
    if (!n) throw new WireFailure({ code: 'no_such_node', text: '' });
    return n;
  }

  /**
   * A bundle's contents. At the root, a server's 1.2 flat news joins its
   * threaded news as one more category — servers keep either, or both,
   * or neither.
   */
  async newsTree(params: NewsTreeParams = {}): Promise<NewsTreeOk> {
    const parent = params.parent ?? null;
    const at = parent === null ? null : this.node(parent);
    if (at && at.kind !== 'bundle') throw new WireFailure({ code: 'not_a_category', text: '' });
    const path = at?.path ?? [];
    const root = parent === null;
    // At the root the two kinds are asked for at once, and an old server
    // that ignores the threaded request does not hold up its flat news for
    // longer than a moment: the root is shown without it, and not asked
    // for again in this session.
    const listing =
      root && this.threaded === false
        ? Promise.reject(new Error('no threaded news'))
        : this.ask('news_listing', (s) => s.newsListing(path));
    const flat = root ? this.flat() : Promise.reject(new Error('not the root'));
    listing.catch(() => {
      if (root) this.threaded = false;
    });
    listing.then(
      () => {
        if (root) this.threaded = true;
      },
      () => {},
    );
    const [flatDone] = await Promise.allSettled([flat]);
    let grace: ReturnType<typeof setTimeout> | undefined;
    const graced =
      root && flatDone.status === 'fulfilled' && this.threaded === null
        ? Promise.race([
            listing,
            new Promise<never>((_, reject) => {
              grace = setTimeout(() => {
                // Not asked again unless it answers after all, which
                // marks it answered; an answer already in stands.
                if (this.threaded === null) this.threaded = false;
                reject(new Error('threaded news is slow'));
              }, LISTING_GRACE_MS);
            }),
          ])
        : listing;
    const [listingDone] = await Promise.allSettled([graced]);
    clearTimeout(grace);
    const nodes: NewsNode[] = [];
    if (listingDone.status === 'fulfilled') {
      for (const item of listingDone.value.items) {
        const kind = item.bundle ? 'bundle' : 'category';
        nodes.push({
          id: this.nodeId({ kind, path: [...path, item.name_bytes] }),
          parent,
          kind,
          name: item.name,
          // Not said by a classic listing; the views leave it out.
          count: 0,
          created_at: 0,
        });
      }
    }
    if (flatDone.status === 'fulfilled') {
      nodes.push({ id: this.nodeId({ kind: 'flat' }), parent: null, kind: 'category', name: 'News', count: 1, created_at: 0 });
    }
    if (!nodes.length && listingDone.status === 'rejected') throw listingDone.reason;
    return { nodes };
  }

  private async flat(): Promise<string> {
    if (this.flatText === null) {
      const e = await this.ask('news_file', (s) => s.newsFile());
      this.flatText = e.text;
    }
    return this.flatText;
  }

  /** A category's articles, as the server lists them: threads are read
   *  back out of the parent each article names. */
  private async category(id: number): Promise<number[]> {
    const node = this.node(id);
    if (node.kind === 'flat') {
      const post = this.postId(id, 0);
      this.posts.set(post, { node: id, postid: 0, parent: null, root: post, depth: 0, subject: 'News', poster: this.serverName, at: 0 });
      return [post];
    }
    if (node.kind !== 'category') throw new WireFailure({ code: 'not_a_category', text: '' });
    const e = await this.ask('news_category', (s) => s.newsCategory(node.path));
    const byPostid = new Map<number, ClassicArticle>(e.articles.map((a) => [a.id, a]));
    const ids: number[] = [];
    for (const a of e.articles) {
      // Walk up to the thread's starter for its root and the depth here.
      let depth = 0;
      let top = a;
      const seen = new Set<number>();
      while (top.parent && byPostid.has(top.parent) && !seen.has(top.id)) {
        seen.add(top.id);
        top = byPostid.get(top.parent)!;
        depth++;
      }
      const post = this.postId(id, a.id);
      this.posts.set(post, {
        node: id,
        postid: a.id,
        parent: a.parent && byPostid.has(a.parent) ? this.postId(id, a.parent) : null,
        root: this.postId(id, top.id),
        depth,
        subject: a.subject,
        poster: a.poster,
        at: macDate(a.year, a.seconds),
      });
      ids.push(post);
    }
    return ids;
  }

  private article(id: number, body: string): NewsArticle {
    const p = this.posts.get(id);
    if (!p) throw new WireFailure({ code: 'no_such_article', text: '' });
    return {
      id,
      category: p.node,
      parent: p.parent,
      root: p.root,
      depth: p.depth,
      from: { nick: p.poster },
      subject: p.subject,
      body,
      mime: 'text/plain',
      at: p.at,
      deleted: false,
      attachments: [],
      refs: [],
      referenced_by: 0,
    };
  }

  private async body(id: number): Promise<string> {
    const p = this.posts.get(id);
    if (!p) throw new WireFailure({ code: 'no_such_article', text: '' });
    const node = this.node(p.node);
    if (node.kind === 'flat') return this.flat();
    if (node.kind !== 'category') throw new WireFailure({ code: 'no_such_article', text: '' });
    const e = await this.ask('news_article', (s) => s.newsArticle(node.path, p.postid));
    return e.text;
  }

  /** Every thread at once, newest activity first: a classic listing has
   *  no pages. */
  async newsThreads(params: NewsThreadsParams): Promise<NewsThreadsOk> {
    if (params.before !== undefined || params.after !== undefined) return { threads: [], has_more: false };
    const ids = await this.category(params.category);
    const threads = new Map<number, NewsThread>();
    for (const id of ids) {
      const p = this.posts.get(id)!;
      let t = threads.get(p.root);
      if (!t) {
        t = { article: this.article(p.root, ''), replies: 0, last_at: 0, last_id: p.root };
        threads.set(p.root, t);
      }
      if (id !== p.root) t.replies++;
      if (p.at >= t.last_at) {
        t.last_at = p.at;
        t.last_id = id;
      }
    }
    return { threads: [...threads.values()].sort((a, b) => b.last_at - a.last_at), has_more: false };
  }

  /** A thread in reading order, bodies and all. */
  async newsThread(params: NewsThreadParams): Promise<NewsThreadOk> {
    if (params.after !== undefined) return { articles: [], has_more: false, snapshot: 0 };
    const root = this.posts.get(params.root);
    if (!root) throw new WireFailure({ code: 'no_such_article', text: '' });
    const ids = await this.category(root.node);
    const children = new Map<number | null, number[]>();
    for (const id of ids) {
      const p = this.posts.get(id)!;
      if (p.root !== params.root || id === params.root) continue;
      const list = children.get(p.parent) ?? [];
      list.push(id);
      children.set(p.parent, list);
    }
    const order: number[] = [];
    const walk = (id: number): void => {
      order.push(id);
      for (const c of children.get(id) ?? []) walk(c);
    };
    walk(params.root);
    // A few at a time: a server with a flood limit takes a burst for an
    // attack.
    const bodies: string[] = new Array<string>(order.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < order.length) {
        const i = next++;
        bodies[i] = await this.body(order[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(THREAD_FETCHES, order.length) }, worker));
    return { articles: order.map((id, i) => this.article(id, bodies[i]!)), has_more: false, snapshot: 0 };
  }

  async newsArticle(id: number): Promise<NewsArticle> {
    return this.article(id, await this.body(id));
  }

  // --- what a classic server does not do --------------------------------

  async newsPost(): Promise<never> {
    throw unavailable('posting news');
  }
  async newsDelete(): Promise<never> {
    throw unavailable('deleting news');
  }
  async newsRefs(): Promise<never> {
    throw unavailable('article references');
  }
  async newsNodeCreate(): Promise<never> {
    throw unavailable('making news folders');
  }
  async newsNodeRename(): Promise<never> {
    throw unavailable('renaming news folders');
  }
  async newsNodeDelete(): Promise<never> {
    throw unavailable('deleting news folders');
  }
  async newsSearch(): Promise<never> {
    throw unavailable('searching news');
  }
  async newsSubscribe(): Promise<never> {
    throw unavailable('following news');
  }
  async newsUnsubscribe(): Promise<never> {
    throw unavailable('following news');
  }
  async newsMute(): Promise<never> {
    throw unavailable('following news');
  }
  async newsSubs(): Promise<never> {
    throw unavailable('following news');
  }
  async newsSeen(): Promise<never> {
    throw unavailable('following news');
  }
  async uploadNewsAttachment(): Promise<never> {
    throw unavailable('news images');
  }
  async fetchNewsAttachment(): Promise<never> {
    throw unavailable('news images');
  }
  async msgRead(): Promise<never> {
    throw unavailable('the mailbox');
  }
  async inbox(): Promise<never> {
    throw unavailable('the mailbox');
  }
  async history(): Promise<never> {
    throw unavailable('chat history');
  }
  async block(): Promise<never> {
    throw unavailable('blocking');
  }
  async unblock(): Promise<never> {
    throw unavailable('blocking');
  }
  async blocks(): Promise<never> {
    throw unavailable('blocking');
  }
  async kick(): Promise<never> {
    throw unavailable('moderation');
  }
  async report(): Promise<never> {
    throw unavailable('reports');
  }
  async reports(): Promise<never> {
    throw unavailable('reports');
  }
  async reportClose(): Promise<never> {
    throw unavailable('reports');
  }
  async redact(): Promise<never> {
    throw unavailable('moderation');
  }
  async revoke(): Promise<never> {
    throw unavailable('moderation');
  }
  async purge(): Promise<never> {
    throw unavailable('moderation');
  }
  async moderationLog(): Promise<never> {
    throw unavailable('moderation');
  }
  async uploadMedia(): Promise<never> {
    throw unavailable('sending images');
  }
  async fetchMedia(): Promise<never> {
    throw unavailable('images');
  }
  async fetchBanner(): Promise<never> {
    throw unavailable('the banner');
  }
  async uploadAvatar(): Promise<never> {
    throw unavailable('pictures');
  }
  async clearAvatar(): Promise<never> {
    throw unavailable('pictures');
  }
  async fetchAvatar(): Promise<never> {
    throw unavailable('pictures');
  }
  async pushRegister(): Promise<never> {
    throw unavailable('notifications');
  }
  async pushUnregister(): Promise<never> {
    throw unavailable('notifications');
  }
}
