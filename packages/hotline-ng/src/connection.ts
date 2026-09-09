/**
 * One Hotline-ng session, across however many WebSockets it takes.
 *
 * The protocol's whole point is that a session outlives its connection
 * (`docs/hotline-ng.md` §2), so this class owns the *session* and treats
 * the socket as a replaceable attachment. Drop the network and it comes
 * back with `resume`, replays what it missed and carries on with the same
 * uid; let the grace window lapse and it says so instead of pretending.
 *
 * Everything that crosses the wire, in either direction, goes through
 * `trace` first. The debug panel is not instrumentation bolted on
 * afterwards — it is this hook, and it sees exactly what the socket saw.
 */

import { wsToHttp } from './identity';
import {
  isEvent,
  isReply,
  RATE_LIMITED,
  RESYNC_REQUIRED,
  type BlocksOk,
  type BlockParams,
  type EventFrame,
  type Events,
  type HistoryOk,
  type HistoryParams,
  type InboxCounts,
  type InboxOk,
  type InboxParams,
  type ChatParams,
  type LoginOk,
  type LoginParams,
  type Media,
  type MediaLimits,
  type MsgOk,
  type MsgParams,
  type ReplyFrame,
  type ResumeOk,
  type SelfUser,
  type ServerFrame,
  type SyncOk,
  type User,
  type VideoConfig,
  type WireError,
} from './protocol';

/** Turn a refused media request into the same `WireFailure` every other
 *  call throws, so a caller has one thing to catch. The body is the ng
 *  error shape; a proxy's own error page is not, hence the fallback. */
async function mediaFailure(res: Response): Promise<WireFailure> {
  const fallback: WireError = {
    code: res.status === 404 ? 'no_such_media' : 'server_error',
    text: `The server answered ${res.status}.`,
  };
  try {
    const body = (await res.json()) as { error?: WireError };
    return new WireFailure(body.error ?? fallback);
  } catch {
    return new WireFailure(fallback);
  }
}

export type ConnState =
  | 'offline'
  | 'connecting'
  | 'online'
  /** The socket died but the session may still be alive server-side;
   *  we are inside the grace window trying to `resume` back into it. */
  | 'reconnecting';

export interface TraceEntry {
  t: number;
  dir: 'out' | 'in';
  /** `req`/`reply`/`ev` name, for filtering without re-parsing JSON. */
  kind: string;
  /** The frame as it went over the wire. */
  raw: string;
  /** Set on a reply carrying an error, so the panel can colour it. */
  error?: boolean;
}

export interface Credentials {
  url: string;
  login: string;
  password: string;
  nick: string;
  icon: number;
  /**
   * Present for an identity login — hxd-ng's `docs/hotline-ng-auth.md`
   * §6–§7 defines the transport (the token, opening the WebSocket with
   * it), and its `docs/hotline-ng-identity.md` §5, §8 what identity does
   * with it (verification, account association).
   * Deliberately just a token-minting callback rather than a device key
   * or any CBOR — this package stays free of the crypto/CBOR dependency
   * that producing a token needs; the caller (built from
   * `src/identity/`) closes over the device key and the challenge/auth
   * round trip.
   *
   * When set, `login`/`password` are ignored by the server
   * (`docs/hotline-ng-identity.md` §6.1) and should be sent empty; the
   * token, not a password, is the credential.
   */
  identity?: { getToken: () => Promise<string> };
}

/** What a resumed session is allowed to remember between page loads. The
 *  token is a bearer credential for one session and dies with it, so it
 *  lives in sessionStorage — per tab, gone when the tab is.
 *
 *  The capability facts ride along because only the *login* reply
 *  carries them: `resume` answers with `self` and a replay, and `sync`
 *  with the roster, so a client that comes back through either one has
 *  no other way to learn whether this server offers voice. They describe
 *  the session and die with it, which is exactly this record's lifetime.
 *  (Worth revisiting in the spec: a `caps` echo on the resume reply would
 *  make this unnecessary.) */
interface Saved {
  url: string;
  session: string;
  token: string;
  seq: number;
  caps: string[];
  grace: number | null;
  video: VideoConfig | null;
  historyId: number;
  media: MediaLimits | null;
}

const SAVED_KEY = 'hxd-ng.session';

/** How long the history catch-up waits after `rate_limited`, doubling
 *  with each refusal. */
const HISTORY_BACKOFF_MS = 250;
const HISTORY_BACKOFF_TRIES = 3;
/** Pages the catch-up will fetch before it stops. At the wire's largest
 *  page this covers far more scrollback than any client keeps, and it
 *  means a server that answers `has_more` forever cannot hold the loop
 *  open for the life of the session. */
const HISTORY_CATCHUP_PAGES = 20;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Does this tab hold a session for `url` that a `resume` could pick up?
 *  The client asks before showing a login form, so a reload goes
 *  straight back into the room. */
export function hasSavedSession(url: string): boolean {
  const s = readSaved();
  return !!s && s.url === url;
}

export class WireFailure extends Error {
  constructor(readonly wire: WireError) {
    super(wire.text || wire.code);
    this.name = 'WireFailure';
  }
}

type EventHandler<K extends keyof Events> = (data: Events[K]) => void;

export interface ConnectionHooks {
  onState?: (state: ConnState, detail?: string) => void;
  onTrace?: (entry: TraceEntry) => void;
  /** A full roster replacement: the login snapshot, or a `sync` after
   *  the outbox overflowed. Everything else arrives as events. */
  onSnapshot?: (ok: { self: SelfUser; users: User[]; server: SyncOk['server'] }) => void;
  onLogin?: (ok: LoginOk) => void;
  /** Resume succeeded; `replay` events are about to arrive. */
  onResumed?: (replay: number) => void;
  /**
   * The outbox overflowed, the gap has been resynced, and this is what
   * the store held across it.
   *
   * **A client that shows private messages must implement this.**
   * `hotline-ng.md` §7.1 makes it an obligation rather than a nicety:
   * any `msg` in the gap was already marked delivered, so the store is
   * the only remaining copy of it and nothing will re-send it. Without
   * this hook a `resync_required` silently eats mail.
   *
   * Newest first, and it may overlap messages already on screen — match
   * on `id` rather than appending blindly.
   */
  onMissedMail?: (ok: InboxOk) => void;
  /** Public-chat pages recovered after an unreplayable outbox gap.
   *  They may overlap live events already handled; deduplicate by id. */
  onMissedHistory?: (ok: HistoryOk) => void;
  /** The session is gone for good — kicked, logged out, banned, or the
   *  grace window lapsed. No further reconnection will be attempted. */
  onEnded?: (reason: string) => void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Set<(data: any) => void>>();
  private retry = 0;
  private resumeOnly = false;
  /** Has the app been handed a roster yet in this page load? A resume
   *  replays events but never re-sends the user list, so a client that
   *  resumed into a session it did not itself log into has to ask. */
  private gotSnapshot = false;
  private retryTimer: number | null = null;
  private closing = false;

  state: ConnState = 'offline';
  /** The last seq we have actually processed. Resume's `last_seq`. */
  seq = 0;
  session: string | null = null;
  token: string | null = null;
  self: SelfUser | null = null;
  caps: string[] = [];
  grace: number | null = null;
  login: LoginOk | null = null;
  /** The video ceilings, from the login reply or from the saved session
   *  a resume came back through. */
  video: VideoConfig | null = null;
  /** Highest durable public-chat id observed on an event or page. */
  lastHistoryId = 0;
  /** What this server takes as an image, from the same two places.
   *  `null` means it takes none: no paperclip. */
  media: MediaLimits | null = null;
  /** Round-trip time of the last explicit `ping`, in milliseconds. */
  rtt: number | null = null;

  constructor(
    private creds: Credentials,
    private hooks: ConnectionHooks = {},
  ) {}

  // --- lifecycle --------------------------------------------------------

  /** Connect and log in. If this tab has a live session for the same
   *  server, try to resume into it first — a page reload should not cost
   *  you your place in the room.
   *
   *  `resumeOnly` is for exactly that reload: the password was never
   *  stored, so falling back to a fresh login would send an empty one
   *  and get `login_failed` for an account that is perfectly fine. Fail
   *  the resume instead and let the caller ask for the password. */
  async start(opts: { resumeOnly?: boolean } = {}): Promise<void> {
    this.closing = false;
    const saved = readSaved();
    if (saved && saved.url === this.creds.url) {
      this.session = saved.session;
      this.token = saved.token;
      this.seq = saved.seq;
      this.caps = saved.caps ?? [];
      this.grace = saved.grace ?? null;
      this.video = saved.video ?? null;
      this.lastHistoryId = saved.historyId ?? 0;
      this.media = saved.media ?? null;
    } else if (opts.resumeOnly) {
      throw new Error('no session to resume');
    }
    this.resumeOnly = opts.resumeOnly ?? false;
    await this.attach();
  }

  /** End the session now, with no grace window. */
  async logout(): Promise<void> {
    this.closing = true;
    this.cancelRetry();
    try {
      await this.request('logout', {});
    } catch {
      /* the socket dying during logout is a successful logout */
    }
    clearSaved();
    this.ws?.close();
    this.setState('offline');
  }

  /** Drop the socket without ending the session — the manual version of
   *  closing a laptop lid, and the only way to exercise resume by hand. */
  drop(): void {
    this.ws?.close();
  }

  /** Open `url` and wire it up as `this.ws`. Every fresh connection goes
   *  through here, whether it turns out to carry a resume, a classic
   *  login, or (see `openTokenedSocket`) an identity login. */
  private async openSocket(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const fail = () => {
        // Nothing is attached to a socket that never opened, and leaving
        // it in `this.ws` would let the next `request()` believe it had
        // one.
        if (this.ws === ws) this.ws = null;
        reject(new Error(`Could not reach ${url}`));
      };
      ws.onopen = () => resolve();
      ws.onerror = fail;
      ws.onclose = fail;
    });

    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onerror = null;
    ws.onclose = (e) => this.onClose(e);
    return ws;
  }

  /** Mint a fresh transport token and open a socket carrying it
   *  (hxd-ng's `docs/hotline-ng-auth.md` §7.1's `?token=`). The token is
   *  single-use and 60 seconds, so this is only ever called immediately
   *  before the socket it's for. */
  private async openTokenedSocket(): Promise<WebSocket> {
    const token = await this.creds.identity!.getToken();
    const sep = this.creds.url.includes('?') ? '&' : '?';
    return this.openSocket(`${this.creds.url}${sep}token=${encodeURIComponent(token)}`);
  }

  private async attach(): Promise<void> {
    this.setState(this.session ? 'reconnecting' : 'connecting');

    if (this.session && this.token) {
      const ws = await this.openSocket(this.creds.url);
      const ok = await this.tryResume();
      if (ok) return;
      if (this.resumeOnly) {
        this.closing = true;
        ws.close();
        throw new Error('session expired');
      }
      if (this.creds.identity) {
        // The transport token has to exist *before* the socket that
        // redeems it opens — it's presented in the upgrade URL itself
        // (hxd-ng's `docs/hotline-ng-auth.md` §7.1), not on a frame sent
        // after — so a resume that failed cannot fall through to
        // `doLogin()` on this same, tokenless socket the way a classic
        // login would. Close it and start over with one that carries a
        // token.
        ws.onclose = null;
        ws.onmessage = null;
        ws.close();
        await this.openTokenedSocket();
      }
      // else: today's behaviour — `doLogin()` runs on this same socket.
    } else if (this.creds.identity) {
      await this.openTokenedSocket();
    } else {
      await this.openSocket(this.creds.url);
    }

    await this.doLogin();
  }

  private async doLogin(): Promise<void> {
    const historyAfter = this.lastHistoryId;
    const params: LoginParams = { icon: this.creds.icon };
    // An identity socket ignores `login`/`password` — the token already
    // said who this is (hxd-ng's `docs/hotline-ng-identity.md` §6.1) —
    // and sending them would only invite the question of why a password
    // is being typed at all for this path.
    if (!this.creds.identity) {
      params.login = this.creds.login;
      params.password = this.creds.password;
    }
    if (this.creds.nick) params.nick = this.creds.nick;

    const ok = await this.request<LoginOk>('login', params);
    this.session = ok.session;
    this.token = ok.token;
    this.self = ok.self;
    this.caps = ok.caps ?? [];
    this.grace = ok.detach ? ok.detach.grace : null;
    this.seq = ok.seq ?? 0;
    this.login = ok;
    this.video = ok.video ?? null;
    this.media = ok.media ?? null;
    // Only a session that may detach is worth remembering: without the
    // permission a resume can only ever answer session_expired, and
    // storing a token we know is useless just invites a confusing
    // reconnect on the next page load.
    if (ok.detach) this.persist();
    this.gotSnapshot = true;
    this.retry = 0;
    this.setState('online');
    this.hooks.onLogin?.(ok);
    this.hooks.onSnapshot?.({ self: ok.self, users: ok.users, server: ok.server });
    // Not awaited: the session is up and the room is drawable, and a
    // catch-up that is paging — or backing off a rate limit — would
    // otherwise hold the connect screen open behind it. Failures are
    // traced and swallowed inside.
    void this.pullMissedHistory(historyAfter);
  }

  /** Returns true when the session was recovered (with or without a
   *  resync), false when it is gone and a fresh login is needed. */
  private async tryResume(): Promise<boolean> {
    try {
      const ok = await this.request<ResumeOk>('resume', {
        session: this.session,
        token: this.token,
        last_seq: this.seq,
      });
      this.self = ok.self;
      this.retry = 0;
      this.setState('online');
      this.hooks.onResumed?.(ok.replay);
      // A resume into a session this page load never logged into — the
      // reload case — has a `self` and a replay but no user list. `sync`
      // is the spec's answer for exactly that, and asking for it costs
      // one round trip against re-typing a password.
      if (!this.gotSnapshot) await this.snapshot();
      return true;
    } catch (e) {
      if (!(e instanceof WireFailure)) throw e;
      if (e.wire.code !== RESYNC_REQUIRED) {
        // session_expired and friends: the session is gone, but the
        // socket is fine — log in on it rather than opening another.
        this.session = null;
        this.token = null;
        this.seq = 0;
        clearSaved();
        return false;
      }
      const historyAfter = this.lastHistoryId;
      // The session lives; only the replay is unrecoverable. Take a
      // fresh snapshot and continue from the seq it reports.
      //
      // `sync`'s seq says where to *continue* from, not which frames
      // already in hand to throw away: the session went live again the
      // moment the resync_required reply landed, so traffic addressed to
      // it in the window before this one carries lower seqs and has
      // already been handed to `onEvent`. Assigning here is safe because
      // that assignment only ever moves the number forward.
      const ok = await this.snapshot();
      this.seq = ok.seq;
      this.retry = 0;
      this.setState('online');
      await this.pullMissedMail();
      void this.pullMissedHistory(historyAfter);
      return true;
    }
  }

  /**
   * The other half of recovering from `resync_required`, and the half
   * that is easy to forget: `sync` restores the roster, but the `msg`
   * events in the gap are simply gone — the server marked them
   * delivered and will not send them again. The store is the only
   * remaining copy, so a resync that does not read it loses mail.
   *
   * Failure here is reported and swallowed. The session is already
   * recovered at this point; turning a mail-fetch problem into a failed
   * resume would cost the user their place in the room to fix nothing.
   */
  private async pullMissedMail(): Promise<void> {
    if (!this.hooks.onMissedMail) return;
    try {
      // Not gated on `caps`. Everywhere else in this file `caps` is a
      // hint about what to *draw*, and making it a gate here would mean
      // a server that under-reports its own extensions silently loses
      // mail rather than answering `no_inbox` — which is a refusal this
      // already handles, and a cheaper thing to be wrong about than a
      // missing message.
      //
      // The largest page the wire allows, because this one is not
      // browsing: it is covering a gap whose size nobody knows. A gap
      // holding more than this needs the caller to page back with
      // `inbox({ before })`, and there is no way to know that from
      // here — the client's position is a seq and the mailbox is
      // numbered in message ids, which do not convert.
      this.hooks.onMissedMail(await this.inbox({ limit: 200 }));
    } catch (e) {
      this.trace('in', 'missed-mail-failed', String(e instanceof Error ? e.message : e), true);
    }
  }

  /** Recover durable public chat after an outbox gap. The cursor is
   *  captured when `resync_required` arrives: live chat can continue
   *  while `sync` and these pages are in flight, and using the moving
   *  highest id would skip the missing range. */
  private async pullMissedHistory(after: number): Promise<void> {
    if (!this.hooks.onMissedHistory || after === 0) return;
    let cursor = after;
    let refusals = 0;
    for (let fetched = 0; fetched < HISTORY_CATCHUP_PAGES; ) {
      let page: HistoryOk;
      try {
        page = await this.history({ after: cursor, limit: 200 });
      } catch (e) {
        // `rate_limited` is the server pacing this loop, not the end of
        // the log — the spec says back off and ask again, and taking it
        // for an answer would leave a gap in the transcript that nothing
        // ever fills. Every other refusal is an answer.
        if (e instanceof WireFailure && e.wire.code === RATE_LIMITED && refusals < HISTORY_BACKOFF_TRIES) {
          await sleep(HISTORY_BACKOFF_MS * 2 ** refusals++);
          continue;
        }
        this.trace('in', 'missed-history-failed', String(e instanceof Error ? e.message : e), true);
        return;
      }
      refusals = 0;
      fetched++;
      this.hooks.onMissedHistory(page);
      const next = page.lines.at(-1)?.id;
      if (!page.has_more || next === undefined || next <= cursor) return;
      cursor = next;
    }
    this.trace('in', 'missed-history-stopped', `gap still open at ${cursor}`, true);
  }

  /** `sync`: the roster and server info, without disturbing the session. */
  private async snapshot(): Promise<SyncOk> {
    const ok = await this.request<SyncOk>('sync', {});
    this.gotSnapshot = true;
    if (this.self) this.hooks.onSnapshot?.({ self: this.self, users: ok.users, server: ok.server });
    return ok;
  }

  private onClose(e: CloseEvent): void {
    for (const p of this.pending.values()) p.reject(new Error('connection closed'));
    this.pending.clear();
    this.ws = null;
    if (this.closing) return;

    // The server names the two closes that mean "do not come back".
    // `replaced` is another device taking the session over — last device
    // wins is the mobile-friendly answer, and this one lost.
    const reason = e.reason || '';
    if (reason === 'replaced') return this.end('This session was taken over by another connection.');
    if (reason === 'kicked') return this.end('You were disconnected by an administrator.');
    if (reason === 'logout') return this.end('Logged out.');

    if (this.grace === null && this.session) {
      // This account cannot detach, so the session died with the socket.
      // Reconnecting means logging in fresh, which is fine — but do not
      // pretend the old session is recoverable.
      this.session = null;
      this.token = null;
      this.seq = 0;
      clearSaved();
    }
    this.scheduleRetry();
  }

  private end(reason: string): void {
    this.closing = true;
    this.cancelRetry();
    clearSaved();
    this.session = null;
    this.token = null;
    this.setState('offline', reason);
    this.hooks.onEnded?.(reason);
  }

  /** Exponential backoff, capped well inside a five-minute grace window
   *  so a flaky network never sleeps through its own chance to resume. */
  private scheduleRetry(): void {
    const delay = Math.min(500 * 2 ** this.retry, 15000);
    this.retry++;
    this.setState('reconnecting', `retrying in ${(delay / 1000).toFixed(1)}s`);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.attach().catch((e) => {
        if (e instanceof WireFailure) return this.end(e.wire.text || e.wire.code);
        this.scheduleRetry();
      });
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // --- frames -----------------------------------------------------------

  request<T = unknown>(req: string, params: unknown = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected'));
    }
    const id = ++this.nextId;
    const raw = JSON.stringify({ id, req, params });
    this.trace('out', req, raw);
    ws.send(raw);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  /** Does the server list this extension in the login reply's `caps`?
   *  A hint for deciding what to draw, not a gate on what to send. */
  hasCap(name: string): boolean {
    return this.caps.includes(name);
  }

  // --- public chat history (docs/chat-history.md §7) -------------------

  /** Durable public chat, always ascending by id. `before` pages toward
   *  older rows; `after` catches up toward newer ones. */
  async history(params: HistoryParams = {}): Promise<HistoryOk> {
    const page = await this.request<HistoryOk>('history', params);
    let advanced = false;
    for (const line of page.lines) advanced = this.noteHistoryId(line.id) || advanced;
    if (advanced) this.persist();
    return page;
  }

  // --- private messages (docs/hotline-ng.md §7.1) -----------------------

  /** Send one. Pass a `guid` — a UUID of the client's own choosing — and
   *  a retry after a dropped socket is the same message rather than a
   *  second one. The answer describes the message as it stands *now*, so
   *  a retry saying `queued: false` where the original said `true` is the
   *  message being delivered, not an error. */
  msg(params: MsgParams): Promise<MsgOk> {
    return this.request<MsgOk>('msg', params);
  }

  /** Stored mail, newest first, paging backwards with `before`. */
  inbox(params: InboxParams = {}): Promise<InboxOk> {
    return this.request<InboxOk>('inbox', params);
  }

  /** Mark everything of yours up to `id` read. A cursor rather than a
   *  list, because that is how a reader moves through a conversation. */
  msgRead(upTo: number): Promise<InboxCounts> {
    return this.request<InboxCounts>('msg_read', { up_to: upTo });
  }

  // --- inline media (docs/inline-media.md §8) ---------------------------

  /**
   * Send a public chat line, optionally with an image this session has
   * already uploaded. `text` may be empty when there is one.
   */
  chat(params: ChatParams): Promise<Record<string, never>> {
    return this.request('chat', params);
  }

  /**
   * Upload an image and get its handle back.
   *
   * The bytes go over HTTP rather than through the socket: a 200 KB
   * image base64'd into a JSON frame would be a third larger, would
   * queue behind every event in the stream, and could not be uploaded at
   * all by a client that had detached. The credential is this session's
   * own, which is why the upload works while detached and stops working
   * the moment the session does.
   *
   * The returned handle is good for one `chat` or `msg`, from this
   * session, for as long as the server keeps it.
   */
  async uploadMedia(image: Blob): Promise<Media> {
    const res = await fetch(`${this.httpBase()}/media`, {
      method: 'POST',
      headers: { Authorization: this.bearer(), 'Content-Type': image.type },
      body: image,
    });
    if (!res.ok) throw await mediaFailure(res);
    const body = (await res.json()) as { media: Media };
    return body.media;
  }

  /**
   * Fetch an image's canonical bytes.
   *
   * Every failure is a 404 — no such handle, expired, revoked, or one
   * this session was never shown — because a status that told them
   * apart would be a way to ask whether a handle exists. A client's only
   * useful response is the placeholder it was already drawing.
   */
  async fetchMedia(id: string): Promise<Blob> {
    const res = await fetch(`${this.httpBase()}/media/${encodeURIComponent(id)}`, {
      headers: { Authorization: this.bearer() },
    });
    if (!res.ok) throw await mediaFailure(res);
    return res.blob();
  }

  /** The session's credential for the media routes: the public session
   *  id and the secret token, joined by a dot. */
  private bearer(): string {
    if (!this.session || !this.token) throw new Error('not logged in');
    return `Bearer ${this.session}.${this.token}`;
  }

  /** Where the HTTP routes are. Same origin as the socket — `wsToHttp`
   *  answers with an empty string when that is the page's own origin,
   *  which makes the fetch relative and keeps it out of CORS. */
  private httpBase(): string {
    return wsToHttp(this.creds.url);
  }

  block(who: BlockParams): Promise<Record<string, never>> {
    return this.request('block', who);
  }

  unblock(who: BlockParams): Promise<Record<string, never>> {
    return this.request('unblock', who);
  }

  blocks(): Promise<BlocksOk> {
    return this.request<BlocksOk>('blocks', {});
  }

  async ping(): Promise<number> {
    const t0 = performance.now();
    await this.request('ping', {});
    this.rtt = Math.round(performance.now() - t0);
    return this.rtt;
  }

  private onMessage(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      this.trace('in', 'unparseable', raw, true);
      return;
    }
    if (isReply(frame)) return this.onReply(frame, raw);
    if (isEvent(frame)) return this.onEvent(frame, raw);
    this.trace('in', 'unknown', raw, true);
  }

  private onReply(frame: ReplyFrame, raw: string): void {
    this.trace('in', `reply:${frame.error ? frame.error.code : 'ok'}`, raw, !!frame.error);
    const p = this.pending.get(frame.reply);
    if (!p) return;
    this.pending.delete(frame.reply);
    if (frame.error) p.reject(new WireFailure(frame.error));
    else p.resolve(frame.ok ?? {});
  }

  private onEvent(frame: EventFrame, raw: string): void {
    this.trace('in', `ev:${frame.ev}`, raw);
    // Seq accounting comes first and applies to *every* event, including
    // the ones this client does not understand. The server promises the
    // stream is gapless; honouring that promise is what makes a later
    // resume able to pick up exactly where we left off.
    this.seq = frame.seq;
    if (frame.ev === 'chat') {
      const id = (frame.data as { id?: unknown } | null)?.id;
      if (typeof id === 'number') this.noteHistoryId(id);
    }
    this.persist();
    const set = this.handlers.get(frame.ev);
    if (!set) return; // unknown `ev` values are ignored, per spec
    for (const h of set) h(frame.data);
  }

  on<K extends keyof Events>(ev: K, handler: EventHandler<K>): void {
    let set = this.handlers.get(ev);
    if (!set) this.handlers.set(ev, (set = new Set()));
    set.add(handler as (data: any) => void);
  }

  /** Keep the tab's resume record current. A session that cannot detach
   *  is never worth storing — a resume for it can only answer
   *  `session_expired`. */
  private persist(): void {
    if (!this.session || !this.token || this.grace === null) return;
    saveSession({
      url: this.creds.url,
      session: this.session,
      token: this.token,
      seq: this.seq,
      caps: this.caps,
      grace: this.grace,
      video: this.video,
      historyId: this.lastHistoryId,
      media: this.media,
    });
  }

  private noteHistoryId(id: number): boolean {
    if (Number.isSafeInteger(id) && id > this.lastHistoryId) {
      this.lastHistoryId = id;
      return true;
    }
    return false;
  }

  private trace(dir: 'out' | 'in', kind: string, raw: string, error = false): void {
    this.hooks.onTrace?.({ t: Date.now(), dir, kind, raw, error });
  }

  private setState(state: ConnState, detail?: string): void {
    this.state = state;
    this.hooks.onState?.(state, detail);
  }
}

// --- session storage ----------------------------------------------------

function readSaved(): Saved | null {
  try {
    const raw = sessionStorage.getItem(SAVED_KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function saveSession(s: Saved): void {
  try {
    sessionStorage.setItem(SAVED_KEY, JSON.stringify(s));
  } catch {
    /* private browsing, storage disabled — resume across reloads is a
       convenience, never a correctness requirement */
  }
}

function clearSaved(): void {
  try {
    sessionStorage.removeItem(SAVED_KEY);
  } catch {
    /* as above */
  }
}
