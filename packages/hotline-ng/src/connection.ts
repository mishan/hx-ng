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

import { AuthError, SERVER_CHALLENGE_REFUSED, WRONG_HOST, wsToHttp } from './identity.js';
import {
  decimalU64,
  parseDecimalU64,
  type FileDownloadOk,
  type FileFetchOptions,
  type FilePreviewOk,
  type FileUploadOk,
  type FileInfo,
  FILES_ACTS,
  resumeDigest,
  type FilesConfig,
  type FilesListOk,
} from './files.js';
import {
  isEvent,
  isReply,
  ERROR_TEXT,
  errorText,
  FLOODING,
  RATE_LIMITED,
  RESYNC_REQUIRED,
  TOO_MANY_CONNECTIONS,
  type AccessSet,
  type AccountEditParams,
  type AccountListOk,
  type AccountOk,
  type BlocksOk,
  type BlockParams,
  type EventFrame,
  type Events,
  type FriendsOk,
  type FriendStateOk,
  type MessagingConfig,
  type MessagingUserOk,
  type PresenceParams,
  type RequestAction,
  type RequestsClearOk,
  type RequestsClearParams,
  type RequestsOk,
  mergeRequests,
  type HistoryOk,
  type HistoryParams,
  type InboxCounts,
  type InboxOk,
  type InboxParams,
  type ChatOk,
  type ChatParams,
  type KickParams,
  type LoginOk,
  type LoginParams,
  type Signs,
  type SignsParams,
  type Media,
  type MediaLimits,
  type MsgOk,
  type ModerationCounts,
  type ModerationLogOk,
  type ModerationLogParams,
  type MsgParams,
  type SealedMsgParams,
  type DeviceCertOk,
  type NewsArticle,
  type StagedNewsAttachment,
  type NewsConfig,
  type NewsNodeCreateParams,
  type NewsNodeDeleteOk,
  type NewsNodeOk,
  type NewsPostOk,
  type NewsPostParams,
  type NewsRefsOk,
  type NewsScope,
  type NewsSearchOk,
  type NewsSearchParams,
  type NewsSeenOk,
  type NewsSubscribeOk,
  type NewsSubsOk,
  type NewsThreadOk,
  type NewsThreadParams,
  type NewsThreadsOk,
  type NewsThreadsParams,
  type NewsTreeOk,
  type NewsTreeParams,
  type PushConfig,
  type PushRegisterOk,
  type PushRegisterParams,
  type PushUnregisterParams,
  type PurgeOk,
  type PurgeParams,
  type ReplyFrame,
  type ReportCloseParams,
  type ReportOk,
  type ReportParams,
  type ReportsOk,
  type ReportsParams,
  type ResumeOk,
  type RoleEditParams,
  type RoleGetOk,
  type RoleListOk,
  type RoleOk,
  type RolesConfig,
  type RoomCreateParams,
  type RoomEditParams,
  type RoomJoinOk,
  type RoomOk,
  type RoomsOk,
  type SelfAccess,
  type SelfUser,
  type ServerFrame,
  type SyncOk,
  type SyncRooms,
  type BannerInfo,
  bannerIsHeld,
  type Avatar,
  type AvatarLimits,
  type User,
  type VideoConfig,
  type WireCode,
  type WireError,
} from './protocol.js';

/** Turn a refused HTTP request into the same `WireFailure` every other
 *  call throws, so a caller has one thing to catch. The body is the ng
 *  error shape, or the HTTP throttle's flat `{ error: code, text,
 *  retry_after }`. A proxy's own error page is neither, so its status
 *  stands in, read the way the server's own would be: a 429 or a 5xx
 *  is worth a retry, a 413 or another 4xx is not. */
async function httpFailure(res: Response, notFound: WireCode, tooLarge: WireCode): Promise<WireFailure> {
  const body = (await res.json().catch(() => null)) as {
    error?: WireError | string;
    text?: string;
    retry_after?: number;
  } | null;
  const text = `The server answered ${res.status}.`;
  if (typeof body?.error === 'string') {
    const { error: code, text: given = text, retry_after } = body;
    return new WireFailure(retry_after === undefined ? { code, text: given } : { code, text: given, retry_after });
  }
  if (body?.error) return new WireFailure(body.error);
  const s = res.status;
  const code = s === 429 ? 'rate_limited' : s === 404 ? notFound : s === 413 ? tooLarge : s >= 500 ? 'server_error' : 'bad_request';
  const failure: WireError = { code, text };
  const after = Number(res.headers.get('Retry-After') ?? NaN);
  if (code === 'rate_limited' && Number.isInteger(after) && after >= 0) failure.retry_after = after;
  return new WireFailure(failure);
}

const mediaFailure = (res: Response) => httpFailure(res, 'no_such_media', 'media_too_large');

/** A news attachment's file name as `X-Attachment-Name` carries it: well
 *  formed, at most 255 code points, then percent-encoded UTF-8. */
function attachmentName(name: string): string {
  const whole = name.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  return encodeURIComponent(Array.from(whole).slice(0, 255).join(''));
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
  identity?: {
    getToken: () => Promise<string>;
    /** What a login with this token says of signing, for a device whose
     *  certificate allows messages; asked as each login goes out. */
    signs?: () => Signs | undefined;
    /** Whether a login with this token says `sealed`, for a device that
     *  can open sealed messages; asked as each login goes out. */
    sealed?: () => boolean;
  };
  /** What a resume says of signing, for a session that proved a device
   *  whose certificate allows messages; absent, it says nothing and
   *  signs nothing. `Connection.signs` starts here, and a login sets it
   *  to what `identity.signs` gives. */
  signs?: Signs;
  /** Whether a resume says `sealed`, as `signs` above. */
  sealed?: boolean;
  /** Say `messaging` at login: this client speaks the friend family
   *  (§7.5), so a friend's instant messages reach it as `im` events
   *  rather than `msg`, each for the caller to acknowledge with
   *  `receipt`. A resume keeps what the login said. Without it, the
   *  first of the family's requests makes the session one that does. */
  messaging?: boolean;
  /** Opens each socket in place of the global `WebSocket`: for a
   *  runtime without one, or a test's fake server
   *  (`@hotline-ng/client/testing`). */
  webSocket?: (url: string) => SocketLike;
  /** Where the resume record is kept, in place of `sessionStorage`:
   *  for a page whose sessionStorage dies before its session should, as
   *  an installed app's does when the OS kills its window. */
  sessionStore?: SessionStore;
}

/** The parts of a `Storage` that keep the resume record, which is what
 *  `Credentials.sessionStore` takes. `localStorage` is one. */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A handler compared bivariantly, as a method's parameters are, so a
 *  socket whose handlers take richer events still fits. */
type Handler<E> = { bivarianceHack(ev: E): void }['bivarianceHack'];

/** The parts of a `WebSocket` that `Connection` uses, which is what a
 *  `Credentials.webSocket` factory returns. A browser's `WebSocket` is
 *  one, and so is a socket from Node's `ws`. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onerror: Handler<unknown> | null;
  onclose: Handler<{ code: number; reason: string }> | null;
}

/** What a resumed session is allowed to remember between page loads. The
 *  token is a bearer credential for one session and dies with it, so it
 *  lives in sessionStorage — per tab, gone when the tab is — unless the
 *  caller names a `sessionStore` that lasts longer.
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
  roomHistoryIds?: [number, number][];
  media: MediaLimits | null;
  news: NewsConfig | null;
  push?: PushConfig | null;
  moderator?: boolean;
  manageRooms?: boolean;
  moderation?: ModerationCounts | null;
  banner?: BannerInfo | null;
  avatars?: AvatarLimits | null;
  accounts?: AccessSet | null;
  roles?: RolesConfig | null;
  files?: FilesConfig | null;
  messaging?: MessagingConfig | null;
  /** The session speaks the friend family: its login said so, or it
   *  has sent one of the family's requests. */
  speaks?: boolean;
  /** The connection that wrote it. A store shared by windows may hold
   *  one that took the session over and wrote since, and a connection
   *  clears only a record it wrote or read. */
  writer?: string;
  /** The account the session is on, as the login named it or an
   *  identity landed on it, so a store shared by one person's accounts
   *  resumes only the one asked for. */
  login?: string;
}

const SAVED_KEY = 'hxd-ng.session';

/** A resume-only connection's session is gone, and with no password to
 *  log in again with, so is the connection. */
class SessionGone extends Error {}

/** `WebSocket.OPEN`, without needing a global `WebSocket` to read it from. */
const OPEN = 1;

/** How long the history catch-up waits after `rate_limited`, doubling
 *  with each refusal. */
const HISTORY_BACKOFF_MS = 250;
const HISTORY_BACKOFF_TRIES = 3;
/** Pages the catch-up will fetch before it stops. At the wire's largest
 *  page this covers far more scrollback than any client keeps, and it
 *  means a server that answers `has_more` forever cannot hold the loop
 *  open for the life of the session. */
const HISTORY_CATCHUP_PAGES = 20;
/** Pages of `requests` read in one call, for the same reason. */
const REQUESTS_PAGES = 20;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Is a session for `url` saved, in `store` or else sessionStorage,
 *  that a `resume` could pick up? With `login`, only one on that
 *  account. The client asks before showing a login form, so a reload
 *  goes straight back into the room. */
export function hasSavedSession(url: string, store?: SessionStore, login?: string): boolean {
  return savedFor(parseSaved(readRaw(store)), url, login);
}

function savedFor(s: Saved | null, url: string, login?: string): s is Saved {
  // Logins are case-insensitive on the server, so `Alice` resumes `alice`.
  return !!s && s.url === url && (!login || s.login?.toLowerCase() === login.toLowerCase());
}

/** How many tries in a row may go astray before an upload gives up: with
 *  the doubling waits between them, a minute without the server. */
const UPLOAD_RETRIES = 5;
/** The most this client sends in one piece. */
const UPLOAD_PIECE = 1n << 20n;

export interface FileUploadOptions {
  comment?: string;
  signal?: AbortSignal;
  /** How much of the file the server holds, as it grows. */
  onProgress?: (sent: bigint) => void;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

const uploadFailure = (res: Response) => httpFailure(res, 'not_found', 'too_large');

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
   *  the outbox overflowed. Everything else arrives as events. `stale`
   *  marks one taken because the server said `roster_stale`: only the
   *  roster is new, and nothing in between was lost. A `sync`
   *  also restates the rooms, and which of them this session is in; the
   *  login's are in `onLogin`'s reply. */
  onSnapshot?: (ok: {
    self: SelfUser;
    users: User[];
    server: SyncOk['server'];
    rooms?: SyncRooms;
    stale?: true;
  }) => void;
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
  /** Public-chat pages recovered after an unreplayable outbox gap,
   *  with the room they are from, 0 for the lobby. They may overlap
   *  live events already handled; deduplicate by id within a room. */
  onMissedHistory?: (ok: HistoryOk, room: number) => void;
  /** This account's friends, asked after each login, resume and resync
   *  of a session that said `messaging` and takes part. Asking is what
   *  hands over the instant messages that waited, and those not yet
   *  acknowledged, as `im` events; without this hook nothing is asked. */
  onFriends?: (ok: FriendsOk) => void;
  /** The session is gone for good — kicked, logged out, banned, or the
   *  grace window lapsed. No further reconnection will be attempted. */
  onEnded?: (reason: string) => void;
}

export class Connection {
  private ws: SocketLike | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Set<(data: any) => void>>();
  private retry = 0;
  private resumeOnly = false;
  /** Has the app been handed a roster yet in this page load? A resume
   *  replays events but never re-sends the user list, so a client that
   *  resumed into a session it did not itself log into has to ask. */
  private gotSnapshot = false;
  /** Did the server say `roster_stale` since the last `sync`? */
  private rosterStale = false;
  /** `ReturnType<typeof setTimeout>` rather than `number`: a browser
   *  hands one back and Node the other, and nothing here cares which. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private readonly writer = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  /** The resume record as this connection last wrote or read it. */
  private savedRaw: string | null = null;
  /** A handshake under way, whose caller retries if it fails: a close
   *  meanwhile is part of that failure, not a second one. */
  private attaching = false;
  /** Answered `flooding`: the `kicked` close that follows is for that. */
  private flooded = false;

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
  /** The same per joined room, since one room's ids say nothing about
   *  another's. Seeded by `roomJoin`, so a room joined before any line
   *  is said in it is caught up from its start. */
  roomHistoryIds = new Map<number, number>();
  /** What this server takes as an image, from the same two places.
   *  `null` means it takes none: no paperclip. */
  media: MediaLimits | null = null;
  /** What this session may do with the server's news, from the same two
   *  places. `null` means the server has none: no News view at all. */
  news: NewsConfig | null = null;
  /** How this server sends notifications, from the same two places.
   *  `null` means it sends none, or this session has no mailbox to be
   *  notified about: offer nothing. */
  push: PushConfig | null = null;
  /** May this session moderate? From the login reply's `self`, and
   *  kept here because the resume reply's `self` does not say. */
  moderator = false;
  /** May this session create, edit and archive rooms? From the login
   *  reply's `self` and `account_changed`, and kept for a resume, whose
   *  `self` does not say. */
  manageRooms = false;
  /** Open reports as the login reply counted them, for a moderator on
   *  a server that keeps reports; `null` otherwise. A starting point:
   *  `report` and `report_closed` move it from there, and nothing here
   *  does — a caller that keeps it current has it saved with the session
   *  on the next event, so a reload starts from the count it left. */
  moderation: ModerationCounts | null = null;
  /** The server's banner, from the login reply or the saved session.
   *  `null` means it shows none. */
  banner: BannerInfo | null = null;
  /** What this server takes as an avatar, from the login reply or the
   *  saved session. `null` means it has no avatars: draw icons only. */
  avatars: AvatarLimits | null = null;
  /** What this session's account may do, from the login reply, kept
   *  current by `account_changed` and saved with the session. `null`
   *  means the server administers no accounts: offer no editor. */
  accounts: AccessSet | null = null;
  /** The roles a user list is drawn with, from the login reply, kept
   *  current by `roles_changed`, `account_changed` and `sync`, and saved
   *  with the session. `null` means the server has no roles. */
  roles: RolesConfig | null = null;
  /** What this session may change in the file area, from the login reply
   *  or the saved session. `null` means no file area. */
  files: FilesConfig | null = null;
  /** The friend family's bounds and whether this account takes part,
   *  from the login reply or the saved session. `null` means the server
   *  has no such family. */
  messaging: MessagingConfig | null = null;
  /** This session speaks the friend family, so is sent its events. */
  private speaks = false;
  /** Round-trip time of the last explicit `ping`, in milliseconds. */
  rtt: number | null = null;
  /** The `signs` the next resume says; `setSigns` changes it and tells
   *  the roster at once (hxd-ng's `docs/e2e-messages.md` §4.6). */
  signs: Signs | null;
  /** The server's echo of `signs` on the latest login or resume, or a
   *  `setSigns` it took: `null` means it will not carry this session's
   *  signed lines, so none may be sent. */
  signing: Signs | null = null;
  private signsTold: Promise<void> | null = null;
  /** Whether the next login or resume says `sealed` (hxd-ng's
   *  `docs/e2e-messages.md` §4.1). */
  sealed: boolean;
  /** The server's echo of `sealed` on the latest login or resume: false
   *  means nothing sealed goes to or from this session. */
  sealing = false;

  constructor(
    private creds: Credentials,
    private hooks: ConnectionHooks = {},
  ) {
    this.signs = creds.signs ?? null;
    this.sealed = creds.sealed ?? false;
  }

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
    this.flooded = false;
    const raw = readRaw(this.creds.sessionStore);
    const saved = parseSaved(raw);
    // A login named is the account asked for, and another's session is
    // not resumed in its place.
    if (savedFor(saved, this.creds.url, this.creds.login)) {
      this.savedRaw = raw;
      this.session = saved.session;
      this.token = saved.token;
      this.seq = saved.seq;
      this.caps = saved.caps ?? [];
      this.grace = saved.grace ?? null;
      this.video = saved.video ?? null;
      this.lastHistoryId = saved.historyId ?? 0;
      this.roomHistoryIds = new Map(saved.roomHistoryIds ?? []);
      this.media = saved.media ?? null;
      this.news = saved.news ?? null;
      this.push = saved.push ?? null;
      this.moderator = saved.moderator ?? false;
      this.manageRooms = saved.manageRooms ?? false;
      this.moderation = saved.moderation ?? null;
      this.banner = saved.banner ?? null;
      this.avatars = saved.avatars ?? null;
      this.accounts = saved.accounts ?? null;
      this.roles = saved.roles ?? null;
      this.files = saved.files ?? null;
      this.messaging = saved.messaging ?? null;
      this.speaks = saved.speaks ?? false;
    } else if (opts.resumeOnly) {
      throw new Error('no session to resume');
    }
    this.resumeOnly = opts.resumeOnly ?? false;
    try {
      await this.attach();
    } catch (e) {
      // The caller has the refusal and will not keep this connection, so
      // nothing here may go on trying.
      this.closing = true;
      this.cancelRetry();
      throw e;
    }
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
    this.forget();
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
  private async openSocket(url: string): Promise<SocketLike> {
    const ws: SocketLike = this.creds.webSocket?.(url) ?? new WebSocket(url);
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
  private async openTokenedSocket(): Promise<SocketLike> {
    const token = await this.creds.identity!.getToken();
    const sep = this.creds.url.includes('?') ? '&' : '?';
    return this.openSocket(`${this.creds.url}${sep}token=${encodeURIComponent(token)}`);
  }

  private async attach(): Promise<void> {
    this.attaching = true;
    try {
      await this.handshake();
    } catch (e) {
      // Every refused handshake but `resync_required` closes the
      // connection (§6.2). Let it go here, so its close is not taken for
      // a dropped connection and retried behind the caller's back.
      if (this.ws) this.discard(this.ws);
      throw e;
    } finally {
      this.attaching = false;
    }
  }

  private async handshake(): Promise<void> {
    this.setState(this.session ? 'reconnecting' : 'connecting');

    if (this.session && this.token) {
      const ws = await this.openSocket(this.creds.url);
      if (await this.tryResume()) return;
      // `attach` lets the socket go.
      if (this.resumeOnly) throw new SessionGone('Your session has ended. Log in again.');
      // The server closes a connection whose resume it refused (§6.2),
      // and an identity login needs a socket opened with a token anyway.
      this.discard(ws);
    }
    if (this.creds.identity) await this.openTokenedSocket();
    else await this.openSocket(this.creds.url);

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
    // A login proves a device only by an identity token, and then the
    // one the token is for, whatever a session resumed before proved.
    this.signs = this.creds.identity?.signs?.() ?? null;
    if (this.signs) params.signs = this.signs;
    this.sealed = this.creds.identity?.sealed?.() ?? false;
    if (this.sealed) params.sealed = true;
    this.speaks = this.creds.messaging === true;
    if (this.speaks) params.messaging = true;

    const ok = await this.request<LoginOk>('login', params);
    this.signing = ok.signs ?? null;
    this.sealing = ok.sealed === true;
    this.session = ok.session;
    this.token = ok.token;
    this.self = ok.self;
    this.caps = ok.caps ?? [];
    this.grace = ok.detach ? ok.detach.grace : null;
    this.seq = ok.seq ?? 0;
    this.login = ok;
    this.video = ok.video ?? null;
    this.media = ok.media ?? null;
    this.news = ok.news ?? null;
    this.push = ok.push ?? null;
    this.moderator = ok.self.moderator === true;
    this.manageRooms = ok.self.manage_rooms === true;
    // A fresh session is in no room.
    this.roomHistoryIds.clear();
    this.moderation = ok.moderation ?? null;
    this.banner = ok.banner ?? null;
    this.avatars = ok.avatars ?? null;
    this.accounts = ok.accounts ?? null;
    this.roles = ok.roles ?? null;
    this.files = ok.files ?? null;
    this.messaging = ok.messaging ?? null;
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
    void this.pullFriends();
  }

  /** Returns true when the session was recovered (with or without a
   *  resync), false when it is gone and a fresh login is needed. */
  private async tryResume(): Promise<boolean> {
    try {
      const ok = await this.request<ResumeOk>('resume', {
        session: this.session,
        token: this.token,
        last_seq: this.seq,
        ...(this.signs ? { signs: this.signs } : {}),
        ...(this.sealed ? { sealed: true } : {}),
      });
      this.self = ok.self;
      this.signing = ok.signs ?? null;
      this.sealing = ok.sealed === true;
      this.retry = 0;
      this.setState('online');
      this.hooks.onResumed?.(ok.replay);
      // A resume into a session this page load never logged into — the
      // reload case — has a `self` and a replay but no user list. `sync`
      // is the spec's answer for exactly that, and asking for it costs
      // one round trip against re-typing a password.
      // Nor is a `roster_stale` whose `sync` the drop cut short replayed.
      if (!this.gotSnapshot || this.rosterStale) {
        await this.snapshot(this.gotSnapshot);
        this.persist();
      }
      void this.pullFriends();
      return true;
    } catch (e) {
      if (!(e instanceof WireFailure)) throw e;
      // The session is left as it was (§6.2): keep it, and resume later
      // on a fresh socket rather than logging in over it.
      if (e.wire.code === RATE_LIMITED || e.wire.code === TOO_MANY_CONNECTIONS) throw e;
      if (e.wire.code !== RESYNC_REQUIRED) {
        // session_expired and friends: the session is gone, and a fresh
        // login is what is left.
        this.session = null;
        this.token = null;
        this.seq = 0;
        this.forget();
        return false;
      }
      // The resume's `signs` and `sealed` hold all the same, as far as
      // the session's device allows, which an echo before said.
      this.signing = this.signing && this.signs;
      this.sealing &&= this.sealed;
      const historyAfter = this.lastHistoryId;
      const roomsAfter = new Map(this.roomHistoryIds);
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
      // What the snapshot restated, kept with the seq it is good for.
      this.persist();
      this.retry = 0;
      this.setState('online');
      await this.pullMissedMail();
      void this.pullFriends();
      void this.pullMissedRooms(historyAfter, roomsAfter, ok.rooms?.joined ?? []);
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

  /** The `friends` §7.5 asks for after each handshake, and after the
   *  request that made this a session that speaks the family. Asked
   *  again after `rate_limited`, which is pacing and not an answer;
   *  any other failure is traced and swallowed, as `pullMissedMail`'s
   *  is. */
  private async pullFriends(): Promise<void> {
    if (!this.hooks.onFriends || !this.speaks || !this.messaging?.takes_part) return;
    for (let refusals = 0; ; ) {
      try {
        return this.hooks.onFriends(await this.request<FriendsOk>('friends', {}));
      } catch (e) {
        if (e instanceof WireFailure && e.wire.code === RATE_LIMITED && refusals < HISTORY_BACKOFF_TRIES) {
          const after = e.wire.retry_after;
          await sleep(after !== undefined ? after * 1000 : HISTORY_BACKOFF_MS * 2 ** refusals);
          refusals++;
          continue;
        }
        this.trace('in', 'friends-failed', String(e instanceof Error ? e.message : e), true);
        return;
      }
    }
  }

  /** One of the family's requests. The first from a session that did
   *  not say `messaging` makes it one that speaks the family, which then
   *  asks for its friends as a login would have. */
  private async family<T>(req: string, params: unknown): Promise<T> {
    const first = !this.speaks;
    this.speaks = true;
    if (first) this.persist();
    const ok = await this.request<T>(req, params);
    if (first && req !== 'friends') void this.pullFriends();
    return ok;
  }

  /** Recover durable public chat after an outbox gap. The cursor is
   *  captured when `resync_required` arrives: live chat can continue
   *  while `sync` and these pages are in flight, and using the moving
   *  highest id would skip the missing range. */
  private async pullMissedHistory(after: number, room = 0): Promise<void> {
    if (!this.hooks.onMissedHistory || (after === 0 && room === 0)) return;
    let cursor = after;
    let refusals = 0;
    for (let fetched = 0; fetched < HISTORY_CATCHUP_PAGES; ) {
      let page: HistoryOk;
      try {
        page = await this.history({ after: cursor, limit: 200, ...(room ? { room } : {}) });
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
      this.hooks.onMissedHistory(page, room);
      const next = page.lines.at(-1)?.id;
      if (!page.has_more || next === undefined || next <= cursor) return;
      cursor = next;
    }
    this.trace('in', 'missed-history-stopped', `gap still open at ${cursor}`, true);
  }

  /** The lobby, then each joined room `sync` says is past the cursor
   *  this session had for it. A room with no cursor was joined where
   *  this record was not kept, and is the caller's to page; `snapshot`
   *  has given it one from here on. */
  private async pullMissedRooms(
    lobby: number,
    cursors: Map<number, number>,
    joined: { id: number; last_id?: number }[],
  ): Promise<void> {
    await this.pullMissedHistory(lobby);
    for (const { id, last_id } of joined) {
      const after = cursors.get(id);
      if (after !== undefined && last_id !== undefined && last_id > after) await this.pullMissedHistory(after, id);
    }
  }

  /** `sync`: the roster and server info, without disturbing the session. */
  private async snapshot(stale = false): Promise<SyncOk> {
    const ok = await this.request<SyncOk>('sync', {});
    this.gotSnapshot = true;
    this.rosterStale = false;
    if (ok.accounts) this.adoptAccess(ok.accounts);
    if (ok.roles) this.roles = ok.roles;
    if (ok.messaging) this.messaging = ok.messaging;
    if (ok.rooms) {
      // The server's word on which rooms this session is in. A room new
      // to the record starts at its newest line: what came before is the
      // caller's to page, and later gaps are covered.
      const joined = new Map(ok.rooms.joined.map((r) => [r.id, r.last_id ?? 0]));
      for (const id of this.roomHistoryIds.keys()) if (!joined.has(id)) this.roomHistoryIds.delete(id);
      for (const [id, last] of joined) if (!this.roomHistoryIds.has(id)) this.roomHistoryIds.set(id, last);
    }
    if (this.self) {
      this.hooks.onSnapshot?.({
        self: this.self,
        users: ok.users,
        server: ok.server,
        rooms: ok.rooms,
        ...(stale ? { stale: true as const } : {}),
      });
    }
    return ok;
  }

  /** Answer `roster_stale`. The server sent it in place of the rows, so
   *  nothing else will correct them: a sync refused `rate_limited` is
   *  tried again, and one a dropped socket cut short is the resume's. */
  private async refreshRoster(): Promise<void> {
    for (let refusals = 0; this.rosterStale && this.state === 'online'; ) {
      try {
        await this.snapshot(true);
        this.persist();
        return;
      } catch (e) {
        this.trace('in', 'roster-refresh-failed', String(e instanceof Error ? e.message : e), true);
        if (!(e instanceof WireFailure) || e.wire.code !== RATE_LIMITED) return;
        const after = e.wire.retry_after;
        await sleep(after !== undefined ? after * 1000 : HISTORY_BACKOFF_MS * 2 ** refusals++);
      }
    }
  }

  /** What this session's account may do now. The `files` block's `may`
   *  is some of the same bits, and the server judges each change by them
   *  as they are now, not as they were at login. */
  private adoptAccess(set: SelfAccess): void {
    this.accounts = set;
    this.manageRooms = set.manage_rooms === true;
    this.moderator = set.moderator === true;
    if (this.roles) {
      this.roles = { list: this.roles.list, ...(set.manage_roles ? { manage_roles: true } : {}) };
    }
    if (this.files?.writable) {
      this.files = { ...this.files, may: FILES_ACTS.filter((act) => set.access.includes(act)) };
    }
  }

  private onClose(e: { reason: string }): void {
    for (const p of this.pending.values()) p.reject(new Error('connection closed'));
    this.pending.clear();
    this.ws = null;
    if (this.closing || this.attaching) return;

    // The server names the two closes that mean "do not come back".
    // `replaced` is another device taking the session over — last device
    // wins is the mobile-friendly answer, and this one lost.
    const reason = e.reason || '';
    if (reason === 'replaced') return this.end('This session was taken over by another connection.');
    if (reason === 'kicked')
      return this.end(this.flooded ? ERROR_TEXT[FLOODING]! : 'You were disconnected by an administrator.');
    if (reason === 'logout') return this.end('Logged out.');

    if (this.grace === null && this.session) {
      // This account cannot detach, so the session died with the socket.
      // Reconnecting means logging in fresh, which is fine — but do not
      // pretend the old session is recoverable.
      this.session = null;
      this.token = null;
      this.seq = 0;
      this.forget();
    }
    this.scheduleRetry();
  }

  private end(reason: string): void {
    this.closing = true;
    this.cancelRetry();
    this.forget();
    this.session = null;
    this.token = null;
    this.setState('offline', reason);
    this.hooks.onEnded?.(reason);
  }

  /** Exponential backoff, capped well inside a five-minute grace window
   *  so a flaky network never sleeps through its own chance to resume. */
  private scheduleRetry(retryAfter?: number): void {
    this.cancelRetry();
    const delay = retryAfter !== undefined ? retryAfter * 1000 : Math.min(500 * 2 ** this.retry, 15000);
    this.retry++;
    this.setState('reconnecting', `retrying in ${(delay / 1000).toFixed(1)}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.attach().catch((e) => {
        if (this.closing) return;
        if (e instanceof SessionGone) return this.end(e.message);
        // Not the server a proof would be for, however often it is asked.
        if (
          e instanceof AuthError &&
          (e.status === 421 || e.code === WRONG_HOST || e.code === SERVER_CHALLENGE_REFUSED)
        ) {
          return this.end(e.message);
        }
        if (!(e instanceof WireFailure)) return this.scheduleRetry();
        // Pacing is never fatal, and a session refused a resume for its
        // account's other connections lives on until its grace lapses.
        const { code, retry_after } = e.wire;
        if (code === RATE_LIMITED || (code === TOO_MANY_CONNECTIONS && this.session)) {
          return this.scheduleRetry(retry_after);
        }
        this.end(errorText(e.wire));
      });
    }, delay);
  }

  /** Close a socket without its close counting as a dropped connection. */
  private discard(ws: SocketLike): void {
    ws.onclose = null;
    ws.onmessage = null;
    ws.close();
    if (this.ws === ws) this.ws = null;
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
    if (!ws || ws.readyState !== OPEN) {
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
    for (const line of page.lines) advanced = this.noteHistoryId(line.id, params.room) || advanced;
    if (advanced) this.persist();
    return page;
  }

  // --- private messages (docs/hotline-ng.md §7.1) -----------------------

  /** Send one. Pass a `guid` — a UUID of the client's own choosing — and
   *  a retry after a dropped socket is the same message rather than a
   *  second one. The answer describes the message as it stands *now*, so
   *  a retry saying `queued: false` where the original said `true` is the
   *  message being delivered, not an error. */
  msg(params: MsgParams | SealedMsgParams): Promise<MsgOk> {
    return this.request<MsgOk>('msg', params);
  }

  /** The certificate `uid`'s session proves now, to seal a message to
   *  once it is checked (`sealMsgRequest` checks it). Only a session
   *  that is itself `sealing` may ask, and the server rations it. */
  deviceCert(uid: number): Promise<DeviceCertOk> {
    return this.request<DeviceCertOk>('device_cert', { uid });
  }

  /** Say whether this session's user signs every lobby line
   *  (`default`) or only where asked (`able`), as a login does (hxd-ng's
   *  `docs/e2e-messages.md` §4.6). Every later resume says it again,
   *  told to the server now or not. One request at a time, and then only
   *  the latest choice if the server has not got it: each costs as much
   *  as a rename, so a user flipping it must not get the session kicked. */
  setSigns(signs: Signs): Promise<void> {
    this.signs = signs;
    this.signsTold ??= (async () => {
      try {
        while (this.signs && this.signs !== this.signing) {
          const want: Signs = this.signs;
          await this.request('signs', { signs: want } satisfies SignsParams);
          this.signing = want;
        }
      } finally {
        this.signsTold = null;
      }
    })();
    return this.signsTold;
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
  chat(params: ChatParams): Promise<ChatOk> {
    return this.request<ChatOk>('chat', params);
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
   * The returned handle may be named on a `chat` or a `msg` from this
   * session, for as long as the server keeps it. Each send captures its
   * own audience, so naming it twice shows it to two sets of people
   * rather than being refused.
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

  // --- the server banner (hxd-ng's docs/banner.md §3) -------------------

  /**
   * Fetch the banner the server holds. Only for one it holds
   * (`bannerIsHeld`): a banner somewhere else is the page's to load, and
   * this session's bearer is not to go with it.
   *
   * As often as it is asked: the server answers `no-cache` with an ETag,
   * so the browser's cache turns a repeat into a revalidation.
   */
  async fetchBanner(): Promise<Blob> {
    if (!this.banner || !bannerIsHeld(this.banner)) throw new Error('no banner on this server');
    const res = await fetch(`${this.httpBase()}${this.banner.url}`, {
      headers: { Authorization: this.bearer() },
    });
    if (!res.ok) throw await mediaFailure(res);
    return res.blob();
  }

  // --- avatars (hxd-ng's docs/avatars.md §4) ----------------------------

  /**
   * Set this session's avatar — its owner's, for an account or a proven
   * identity, so every session of theirs shows it. The server re-encodes
   * and fits it, and announces it as a `user_changed`, this session's own
   * included; the returned reference is the same one that event carries.
   *
   * One attempt per the server's interval, refused or not: a second
   * inside it is `rate_limited`.
   */
  async uploadAvatar(image: Blob): Promise<Avatar> {
    const res = await fetch(`${this.httpBase()}/avatar`, {
      method: 'PUT',
      headers: { Authorization: this.bearer(), 'Content-Type': image.type },
      body: image,
    });
    if (!res.ok) throw await mediaFailure(res);
    const body = (await res.json()) as { avatar: Avatar };
    return body.avatar;
  }

  /** Clear this session's avatar. Clearing none succeeds and announces
   *  nothing; it shares `uploadAvatar`'s allowance. */
  clearAvatar(): Promise<Record<string, never>> {
    return this.request('avatar_clear', {});
  }

  /** Fetch an avatar's canonical bytes. Any session may fetch anyone's;
   *  the id is the content, so a caller may keep the result for good. */
  async fetchAvatar(id: string): Promise<Blob> {
    const res = await fetch(`${this.httpBase()}/avatars/${encodeURIComponent(id)}`, {
      headers: { Authorization: this.bearer() },
    });
    if (!res.ok) throw await mediaFailure(res);
    return res.blob();
  }

  // --- Files (docs/hotline-ng.md §7.2) --------------------------------

  async filesList(path = ''): Promise<FilesListOk> {
    const listing = await this.request<FilesListOk>('files_list', path ? { path } : {});
    for (const entry of listing.entries) parseDecimalU64(entry.size);
    return listing;
  }

  async fileInfo(path: string): Promise<FileInfo> {
    const info = await this.request<FileInfo>('files_info', { path });
    parseDecimalU64(info.size);
    return info;
  }

  async filesMkdir(path: string): Promise<void> {
    await this.request('files_mkdir', { path });
  }

  /** A folder goes with everything in it. */
  async filesDelete(path: string): Promise<void> {
    await this.request('files_delete', { path });
  }

  /** Rename, move, or both: `to` is the entry's whole new path. */
  async filesMove(path: string, to: string): Promise<void> {
    await this.request('files_move', { path, to });
  }

  /** `''` clears it. */
  async filesComment(path: string, comment: string): Promise<void> {
    await this.request('files_comment', { path, comment });
  }

  async prepareFileDownload(path: string): Promise<FileDownloadOk> {
    const prepared = await this.request<FileDownloadOk>('files_download', { path });
    parseDecimalU64(prepared.size);
    return prepared;
  }

  /** `files_upload`: reserves an upload of `size` bytes to `path`. */
  async prepareFileUpload(
    path: string,
    size: bigint,
    options: { comment?: string; fresh?: boolean } = {},
  ): Promise<FileUploadOk> {
    const prepared = await this.request<FileUploadOk>('files_upload', {
      path,
      size: decimalU64(size),
      ...(options.comment ? { comment: options.comment } : {}),
      ...(options.fresh ? { fresh: true } : {}),
    });
    parseDecimalU64(prepared.offset);
    parseDecimalU64(prepared.piece);
    return prepared;
  }

  /**
   * Upload `file` to `path` in pieces, carrying on from what the server
   * already holds of it when that is the start of this file, and from
   * wherever the server says when a piece goes astray. Resolves with the
   * path it was published at, which a drop box may have renamed.
   */
  async uploadFile(path: string, file: Blob, options: FileUploadOptions = {}): Promise<string> {
    const size = BigInt(file.size);
    let failures = 0;
    // Each pass asks for the upload afresh: after the first, because the
    // token went with its session or the partial moved under it.
    for (;;) {
      options.signal?.throwIfAborted();
      let prepared: FileUploadOk;
      try {
        prepared = await this.prepareFileUpload(path, size, { comment: options.comment });
      } catch (error) {
        // Asked between a session's socket closing and its resume: the
        // upload waits for it, as a piece waits for a dropped connection.
        if (!(error instanceof Error) || error.message !== 'not connected') throw error;
        if (++failures > UPLOAD_RETRIES) throw error;
        await delay(1000 * 2 ** failures, options.signal);
        continue;
      }
      let offset = parseDecimalU64(prepared.offset);
      let echo = prepared.digest;
      if (echo !== undefined && (await resumeDigest(file, offset)) !== echo) {
        prepared = await this.prepareFileUpload(path, size, { comment: options.comment, fresh: true });
        offset = 0n;
        echo = undefined;
      }
      // Smaller than the server allows, where it allows that, so progress
      // moves and a dropped connection costs little. A blind upload's one
      // piece is the whole file.
      const allowed = parseDecimalU64(prepared.piece);
      const piece = allowed === size || allowed < UPLOAD_PIECE ? allowed : UPLOAD_PIECE;
      options.onProgress?.(offset);
      for (;;) {
        options.signal?.throwIfAborted();
        const end = offset + piece < size ? offset + piece : size;
        const headers: Record<string, string> = {};
        if (size > 0n) headers['Content-Range'] = `bytes ${offset}-${end - 1n}/${size}`;
        if (echo !== undefined) headers['Upload-Digest'] = echo;
        let response: Response;
        try {
          response = await fetch(this.fileUploadUrl(prepared), {
            method: 'PUT',
            headers,
            body: file.slice(Number(offset), Number(end)),
            signal: options.signal,
          });
        } catch (error) {
          // A dropped connection costs the piece, not the upload.
          if (options.signal?.aborted || ++failures > UPLOAD_RETRIES) throw error;
          await delay(1000 * 2 ** failures, options.signal);
          continue;
        }
        const told = response.headers.get('Upload-Offset');
        if (response.status === 201) {
          return ((await response.json()) as { path: string }).path;
        }
        if (response.status === 204 || (response.status === 409 && told !== null)) {
          if (told === null) throw new Error('The server did not say where the upload stands.');
          offset = parseDecimalU64(told);
          if (response.status === 204) {
            echo = undefined;
            failures = 0;
            options.onProgress?.(offset);
          } else if (++failures > UPLOAD_RETRIES) {
            throw new Error('The server and this upload disagree on where it stands.');
          }
          continue;
        }
        if (response.status === 404 && ++failures <= UPLOAD_RETRIES) break;
        if (response.status === 503 && ++failures <= UPLOAD_RETRIES) {
          const wait = Number(response.headers.get('Retry-After') ?? '1');
          await delay(1000 * (Number.isFinite(wait) ? wait : 1), options.signal);
          continue;
        }
        throw await uploadFailure(response);
      }
    }
  }

  /** `unsupported` for a file the server makes no preview of. */
  async prepareFilePreview(path: string): Promise<FilePreviewOk> {
    const prepared = await this.request<FilePreviewOk>('files_preview', { path });
    parseDecimalU64(prepared.size);
    return prepared;
  }

  /** The preview's bytes, which are small and made by the server; a kind
   *  this library does not know may be neither, and is refused. */
  async fetchFilePreview(prepared: FilePreviewOk, signal?: AbortSignal): Promise<Blob> {
    if (prepared.kind !== 'image' && prepared.kind !== 'text') {
      throw new Error(`a ${String(prepared.kind)} preview is not fetched whole`);
    }
    const response = await fetch(this.fileDownloadUrl(prepared), { signal });
    if (response.ok) return response.blob();
    await response.body?.cancel().catch(() => undefined);
    throw new WireFailure({
      code: 'not_found',
      text: 'This preview has expired or is no longer authorized.',
    });
  }

  private fileUploadUrl(prepared: FileUploadOk): string {
    if (!/^\/files\/upload\/[A-Za-z0-9_-]+$/.test(prepared.url)) {
      throw new Error('invalid file upload URL');
    }
    return `${this.httpBase()}${prepared.url}`;
  }

  /** Resolve a prepared same-server path without exposing the origin. */
  fileDownloadUrl(prepared: FileDownloadOk | FilePreviewOk): string {
    if (!/^\/files\/[A-Za-z0-9_-]+$/.test(prepared.url)) {
      throw new Error('invalid file download URL');
    }
    return `${this.httpBase()}${prepared.url}`;
  }

  /**
   * Fetch once, optionally from an exact bigint offset. Tokens are reusable
   * for a caller-directed resume, but this method never silently retries an
   * expired or session-bound URL.
   */
  async fetchFile(prepared: FileDownloadOk, options: FileFetchOptions = {}): Promise<Response> {
    const size = parseDecimalU64(prepared.size);
    const headers: Record<string, string> = {};
    if (options.offset !== undefined) {
      if (options.offset >= size) throw new RangeError('file offset is beyond the end');
      headers.Range = `bytes=${decimalU64(options.offset)}-`;
    }
    const response = await fetch(this.fileDownloadUrl(prepared), {
      headers,
      signal: options.signal,
    });
    const expectedStatus = options.offset === undefined ? 200 : 206;
    if (response.status === expectedStatus) return response;
    // Nobody will read a refused body, and a 200 to a ranged request is
    // the whole file, still streaming. Let it go now, not when the
    // response happens to be collected.
    await response.body?.cancel().catch(() => undefined);
    switch (response.status) {
      // Unknown, expired and unauthorized tokens are one answer.
      case 404:
        throw new WireFailure({
          code: 'not_found',
          text: 'This download has expired or is no longer authorized.',
        });
      case 416:
        throw new WireFailure({
          code: 'range_invalid',
          text: 'The server refused that resume offset.',
        });
      // Only a ranged request gets here with a 200: the server ignored
      // `Range`, as it does for a file it cannot read from an offset.
      case 200:
        throw new WireFailure({
          code: 'range_unsupported',
          text: 'This file cannot be resumed; download it from the start.',
        });
      default:
        throw new WireFailure({
          code: 'server_error',
          text: `The server answered ${response.status}.`,
        });
    }
  }

  /**
   * Canonicalize and stage an image for a later news post.
   *
   * `name` is for display and search. It travels in `X-Attachment-Name`
   * as UTF-8, percent-encoded as `encodeURIComponent` does it, and the
   * server decodes it (hxd-ng's `docs/news.md` §9.4): a header value past
   * ASCII is bytes a proxy may mangle, and a file name often is. It is
   * cut to 255 characters first — code points, so a surrogate pair is
   * never split — and a lone surrogate, which has no UTF-8, becomes
   * U+FFFD rather than an exception.
   */
  async uploadNewsAttachment(image: Blob, name?: string): Promise<StagedNewsAttachment> {
    const headers: Record<string, string> = { Authorization: this.bearer() };
    // A blob with no type says nothing, and the server sniffs the bytes
    // whatever it is told.
    if (image.type) headers['Content-Type'] = image.type;
    if (name) headers['X-Attachment-Name'] = attachmentName(name);
    const res = await fetch(`${this.httpBase()}/news/blob`, {
      method: 'POST',
      headers,
      body: image,
    });
    if (!res.ok) throw await mediaFailure(res);
    const body = (await res.json()) as { blob: StagedNewsAttachment };
    return body.blob;
  }

  /** Fetch a durable news image this account may read. */
  async fetchNewsAttachment(id: string): Promise<Blob> {
    const res = await fetch(`${this.httpBase()}/news/blob/${encodeURIComponent(id)}`, {
      headers: { Authorization: this.bearer() },
    });
    if (!res.ok) throw await mediaFailure(res);
    return res.blob();
  }

  /** The session's credential for authenticated media and news routes: the public session
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

  // --- rooms (hxd-ng's docs/chat-rooms.md §7) ---------------------------
  //
  // A session hears no `room_*` event until it sends one of these, or a
  // `chat` or `history` naming a room: that is what tells the server it
  // knows rooms exist. `roomTopic` of the lobby alone does not. So a
  // client that wants the login reply's list kept current asks `rooms()`
  // once, and one that never asks sees the protocol as it was before.
  // `chat` and `history` take a `room` of their own.

  rooms(): Promise<RoomsOk> {
    return this.request<RoomsOk>('rooms', {});
  }

  /** Join a room. Joining one already joined answers as the first join
   *  did; what a client rejoins after a fresh login is its own to keep. */
  async roomJoin(room: number): Promise<RoomJoinOk> {
    const ok = await this.request<RoomJoinOk>('room_join', { room });
    if (!this.roomHistoryIds.has(room)) {
      this.roomHistoryIds.set(room, ok.last_id ?? 0);
      this.persist();
    }
    return ok;
  }

  async roomPart(room: number): Promise<Record<string, never>> {
    const ok = await this.request<Record<string, never>>('room_part', { room });
    this.roomHistoryIds.delete(room);
    this.persist();
    return ok;
  }

  /** Set a room's topic, or with room 0 the lobby's subject. */
  roomTopic(room: number, topic: string): Promise<Record<string, never>> {
    return this.request('room_topic', { room, topic });
  }

  roomCreate(params: RoomCreateParams): Promise<RoomOk> {
    return this.request<RoomOk>('room_create', params);
  }

  roomEdit(params: RoomEditParams): Promise<RoomOk> {
    return this.request<RoomOk>('room_edit', params);
  }

  /** Part its members and hide it; its log stays, under retention. */
  roomArchive(room: number): Promise<Record<string, never>> {
    return this.request('room_archive', { room });
  }

  roomUnarchive(room: number): Promise<Record<string, never>> {
    return this.request('room_unarchive', { room });
  }

  // --- news (hxd-ng's docs/news.md §9) ----------------------------------
  //
  // Thin on purpose: every one of these is one request and its reply.
  // What changed while a view was open arrives as `news_posted` and
  // friends, which say "your copy is stale" and nothing more — whether
  // to refetch is the caller's decision, because only it knows what it
  // is showing.

  /** The tree under `parent` (the root when absent), `depth` levels deep. */
  newsTree(params: NewsTreeParams = {}): Promise<NewsTreeOk> {
    return this.request<NewsTreeOk>('news_tree', params);
  }

  /** One category's threads, newest first. */
  newsThreads(params: NewsThreadsParams): Promise<NewsThreadsOk> {
    return this.request<NewsThreadsOk>('news_threads', params);
  }

  /** A thread in reading order, paged forward with `after`. */
  newsThread(params: NewsThreadParams): Promise<NewsThreadOk> {
    return this.request<NewsThreadOk>('news_thread', params);
  }

  async newsArticle(id: number): Promise<NewsArticle> {
    const ok = await this.request<{ article: NewsArticle }>('news_article', { id });
    return ok.article;
  }

  /** Post an article, or a reply when `parent` is set. The article shows
   *  up for everyone — its author included — through `news_posted`. */
  newsPost(params: NewsPostParams): Promise<NewsPostOk> {
    return this.request<NewsPostOk>('news_post', params);
  }

  /** Delete an article, leaving its tombstone in the thread. `reason` is
   *  for the moderation record, when it is someone else's article; a
   *  server may take it and not yet keep it. */
  newsDelete(id: number, reason?: string): Promise<Record<string, never>> {
    return this.request('news_delete', reason === undefined ? { id } : { id, reason });
  }

  /** The articles whose bodies point at this one. */
  newsRefs(id: number, limit?: number): Promise<NewsRefsOk> {
    return this.request<NewsRefsOk>('news_refs', limit === undefined ? { id } : { id, limit });
  }

  newsNodeCreate(params: NewsNodeCreateParams): Promise<NewsNodeOk> {
    return this.request<NewsNodeOk>('news_node_create', params);
  }

  newsNodeRename(id: number, name: string): Promise<Record<string, never>> {
    return this.request('news_node_rename', { id, name });
  }

  newsNodeDelete(id: number): Promise<NewsNodeDeleteOk> {
    return this.request<NewsNodeDeleteOk>('news_node_delete', { id });
  }

  /** Full-text search. Rate-limited per session: `rate_limited` means
   *  wait and ask again, never that nothing matched. */
  newsSearch(params: NewsSearchParams): Promise<NewsSearchOk> {
    return this.request<NewsSearchOk>('news_search', params);
  }

  // --- news subscriptions (hxd-ng's docs/news.md §10) -------------------
  //
  // What reaches you arrives as `news_notify`; these requests decide what
  // does — what is followed, what is muted, and how far each has been
  // read. A guest is refused `no_mailbox` and a server that keeps no
  // subscriptions `not_available` — `news.subscribe` in the login reply
  // says which before anything is asked.

  /** Follow a thread or a category. Something new starts caught up; one
   *  already followed keeps its place, and stops being `auto`. */
  newsSubscribe(scope: NewsScope): Promise<NewsSubscribeOk> {
    return this.request<NewsSubscribeOk>('news_subscribe', scope);
  }

  /** Stop following. Asking twice is not an error. Replies to your own
   *  articles still reach you afterwards; `newsMute` is how to say never. */
  newsUnsubscribe(scope: NewsScope): Promise<Record<string, never>> {
    return this.request('news_unsubscribe', scope);
  }

  /** Mute or unmute. Muting something not followed is allowed, and is
   *  what keeps posting there from subscribing you again. */
  newsMute(scope: NewsScope, muted: boolean): Promise<Record<string, never>> {
    return this.request('news_mute', { ...scope, muted });
  }

  /** Everything this account follows or has muted, newest first. */
  newsSubs(): Promise<NewsSubsOk> {
    return this.request<NewsSubsOk>('news_subs', {});
  }

  /** Say the reader has been shown the scope up to article `upTo`.
   *  Explicit, like `msgRead`: fetching a thread never implies it, since
   *  a client may fetch what it never draws. */
  newsSeen(scope: NewsScope, upTo: number): Promise<NewsSeenOk> {
    return this.request<NewsSeenOk>('news_seen', { ...scope, up_to: upTo });
  }

  // --- push devices (hxd-ng's docs/push-notifications.md §8) ------------
  //
  // The server never asks for a device: the client gets the user's
  // permission, subscribes with `push.vapid`, and hands over what the
  // browser gave it. `logout` leaves devices registered on purpose —
  // being away is when a notification is worth having.

  /** Register this device, or replace its endpoint. Idempotent per
   *  `devid`, so a client re-registers on every login. */
  pushRegister(params: PushRegisterParams): Promise<PushRegisterOk> {
    return this.request<PushRegisterOk>('push_register', params);
  }

  /** Stop notifying a device. See `PushUnregisterParams` for why the
   *  empty request means this device and not every one. */
  pushUnregister(params: PushUnregisterParams = {}): Promise<Record<string, never>> {
    return this.request('push_unregister', params);
  }

  // --- moderation (hxd-ng's docs/moderation.md §5) ---------------------
  //
  // `report` is anyone's. The rest answer `access_denied` to a session
  // that is not `moderator`, except `kick`, which asks the kick
  // privilege instead. Every act takes a reason and writes an audit row
  // before it does anything; acting on what a report named closes that
  // report as `removed` without a separate `reportClose`.

  /** Report a line, an image, a message you received, a person or an
   *  article. Rate-limited per account. */
  report(params: ReportParams): Promise<ReportOk> {
    return this.request<ReportOk>('report', params);
  }

  /** Reports, newest first. */
  reports(params: ReportsParams = {}): Promise<ReportsOk> {
    return this.request<ReportsOk>('reports', params);
  }

  /** Dismiss a report, or close it as a duplicate of another. A
   *  moderator may not dismiss one about themselves. */
  reportClose(params: ReportCloseParams): Promise<Record<string, never>> {
    return this.request('report_close', params);
  }

  /** Take a public line's words back. It keeps its id and place, every
   *  reader is told with `chat_redacted`, and an image it carried is
   *  revoked with it. */
  redact(id: number, reason: string): Promise<Record<string, never>> {
    return this.request('redact', { id, reason });
  }

  /** Drop an image's bytes now. `block`, the server's default, also
   *  refuses the same canonical bytes if they are uploaded again. */
  revoke(media: string, reason: string, block?: boolean): Promise<Record<string, never>> {
    return this.request('revoke', block === undefined ? { media, reason } : { media, reason, block });
  }

  /** Take a person's recent lines, images and articles. */
  purge(params: PurgeParams): Promise<PurgeOk> {
    return this.request<PurgeOk>('purge', params);
  }

  /** Disconnect someone, and optionally ban them and purge their output. */
  kick(params: KickParams): Promise<Record<string, never>> {
    return this.request('kick', params);
  }

  /** The audit trail, newest first. */
  moderationLog(params: ModerationLogParams = {}): Promise<ModerationLogOk> {
    return this.request<ModerationLogOk>('moderation_log', params);
  }

  // --- accounts (hxd-ng's docs/account-admin.md §5) -------------------
  //
  // Each asks its own bit — read, create, modify or delete users — and a
  // write is refused `outranked` when the account holds, or would be
  // given, a bit this session does not hold.

  accountList(): Promise<AccountListOk> {
    return this.request<AccountListOk>('account_list', {});
  }

  accountGet(login: string): Promise<AccountOk> {
    return this.request<AccountOk>('account_get', { login });
  }

  accountCreate(params: AccountEditParams): Promise<AccountOk> {
    return this.request<AccountOk>('account_create', params);
  }

  /** Change an account. Never makes one. */
  accountUpdate(params: AccountEditParams): Promise<AccountOk> {
    return this.request<AccountOk>('account_update', params);
  }

  accountDelete(login: string): Promise<Record<string, never>> {
    return this.request('account_delete', { login });
  }

  // --- roles (hxd-ng's docs/roles.md §7.2) ----------------------------
  //
  // Reading needs read_users; writing needs `roles.manage_roles`, and a
  // write is refused `outranked` when the role, or anyone holding it,
  // may do what this session may not.

  roleList(): Promise<RoleListOk> {
    return this.request<RoleListOk>('role_list', {});
  }

  roleGet(name: string): Promise<RoleGetOk> {
    return this.request<RoleGetOk>('role_get', { name });
  }

  roleCreate(params: RoleEditParams): Promise<RoleOk> {
    return this.request<RoleOk>('role_create', params);
  }

  /** Change a role. Never makes one. */
  roleUpdate(params: RoleEditParams): Promise<RoleOk> {
    return this.request<RoleOk>('role_update', params);
  }

  /** Takes it from every account holding it, and what it gave with it. */
  roleDelete(name: string): Promise<Record<string, never>> {
    return this.request('role_delete', { name });
  }

  // --- instant messaging (docs/hotline-ng.md §7.5) ---------------------
  //
  // Every account is named by login. An instant message is a `msg` by
  // `to_login`, answered `requested` where it became a message request.
  // An account that has blocked this one reads as missing, `no_such_user`;
  // this one's own block of it is `friend_add`'s `blocked`.

  /** This account's roster; asking also hands over what waited. */
  friends(): Promise<FriendsOk> {
    return this.family<FriendsOk>('friends', {});
  }

  /** Ask for friendship, or accept theirs where they asked first. */
  friendAdd(login: string, note?: string): Promise<FriendStateOk> {
    return this.family<FriendStateOk>('friend_add', note === undefined ? { login } : { login, note });
  }

  friendRespond(login: string, accept: boolean): Promise<FriendStateOk> {
    return this.family<FriendStateOk>('friend_respond', { login, accept });
  }

  /** End a friendship, for both; withdraw a request sent, or decline
   *  one received. */
  friendRemove(login: string): Promise<Record<string, never>> {
    return this.family<Record<string, never>>('friend_remove', { login });
  }

  /** The name this account shows a friend by; `null` clears it. */
  friendAlias(login: string, alias: string | null): Promise<Record<string, never>> {
    return this.family<Record<string, never>>('friend_alias', { login, alias });
  }

  setPresence(params: PresenceParams): Promise<Record<string, never>> {
    return this.family<Record<string, never>>('presence', params);
  }

  findUser(login: string): Promise<MessagingUserOk> {
    return this.family<MessagingUserOk>('find_user', { login });
  }

  userProfile(login: string): Promise<MessagingUserOk> {
    return this.family<MessagingUserOk>('user_profile', { login });
  }

  /** Acknowledge the `im` `login` sent under `guid`: received, or with
   *  `read` read. */
  receipt(login: string, guid: string, read = false): Promise<Record<string, never>> {
    return this.family<Record<string, never>>('receipt', read ? { login, guid, read } : { login, guid });
  }

  typing(login: string, typing: boolean): Promise<Record<string, never>> {
    return this.family<Record<string, never>>('typing', { login, typing });
  }

  /** The message requests waiting for this account and its approvals,
   *  every page of them, as the wire requires a client to read; a
   *  sender whose requests span pages is one entry. Listing makes this a
   *  session that understands requests. Past the pages this reads, the
   *  answer keeps the `cursor` to go on from; at a cursor the server
   *  hands back again, it stops with none. */
  async requests(cursor?: string): Promise<RequestsOk> {
    let all: RequestsOk | null = null;
    // A cursor handed back again would read a page already merged.
    const asked = new Set(cursor === undefined ? [] : [cursor]);
    for (let page = 0; page < REQUESTS_PAGES; page++) {
      const ok = await this.family<RequestsOk>('requests', cursor === undefined ? {} : { cursor });
      all = all ? mergeRequests(all, ok) : ok;
      cursor = ok.cursor;
      if (cursor === undefined) return all;
      if (asked.has(cursor)) {
        this.trace('in', 'requests-stopped', `cursor ${cursor} again`, true);
        const done = { ...all };
        delete done.cursor;
        return done;
      }
      asked.add(cursor);
    }
    this.trace('in', 'requests-stopped', `more at ${cursor}`, true);
    return all!;
  }

  /** Approve the conversation with `login`, delete its request, or end
   *  an approval. */
  requestAnswer(login: string, action: RequestAction): Promise<Record<string, never>> {
    return this.family<Record<string, never>>('request_answer', { login, action });
  }

  /** Decline every friend request and delete every message request
   *  received in the span; approvals and friendships are untouched. */
  requestsClear(params: RequestsClearParams = {}): Promise<RequestsClearOk> {
    return this.family<RequestsClearOk>('requests_clear', params);
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
    if (frame.error?.code === FLOODING) this.flooded = true;
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
      const { id, room } = (frame.data ?? {}) as { id?: unknown; room?: unknown };
      if (typeof id === 'number') this.noteHistoryId(id, typeof room === 'number' ? room : 0);
    }
    if (frame.ev === 'room_member_parted') {
      const { room, uid } = frame.data as Events['room_member_parted'];
      if (uid === this.self?.uid) this.roomHistoryIds.delete(room);
    }
    if (frame.ev === 'account_changed') this.adoptAccess(frame.data as SelfAccess);
    if (frame.ev === 'roles_changed') {
      this.roles = { ...this.roles, list: (frame.data as Events['roles_changed']).list };
    }
    if (frame.ev === 'roster_stale') {
      this.rosterStale = true;
      // Not awaited: events go on arriving meanwhile.
      void this.refreshRoster();
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
    const raw = saveSession(this.creds.sessionStore, {
      url: this.creds.url,
      session: this.session,
      token: this.token,
      seq: this.seq,
      caps: this.caps,
      grace: this.grace,
      video: this.video,
      historyId: this.lastHistoryId,
      roomHistoryIds: [...this.roomHistoryIds],
      media: this.media,
      banner: this.banner,
      avatars: this.avatars,
      news: this.news,
      push: this.push,
      moderator: this.moderator,
      manageRooms: this.manageRooms,
      moderation: this.moderation,
      accounts: this.accounts,
      roles: this.roles,
      files: this.files,
      messaging: this.messaging,
      speaks: this.speaks,
      writer: this.writer,
      login: this.self?.identity?.account ?? this.creds.login,
    });
    // A write that failed left the record as it was, still this one's.
    if (raw !== null) this.savedRaw = raw;
  }

  private forget(): void {
    clearSaved(this.creds.sessionStore, this.savedRaw);
    this.savedRaw = null;
  }

  private noteHistoryId(id: number, room = 0): boolean {
    if (!Number.isSafeInteger(id)) return false;
    if (room) {
      // Only a joined room's, so the record stays as small as the joins.
      const seen = this.roomHistoryIds.get(room);
      if (seen === undefined || id <= seen) return false;
      this.roomHistoryIds.set(room, id);
      return true;
    }
    if (id <= this.lastHistoryId) return false;
    this.lastHistoryId = id;
    return true;
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

function readRaw(store?: SessionStore): string | null {
  try {
    return (store ?? sessionStorage).getItem(SAVED_KEY);
  } catch {
    return null;
  }
}

function parseSaved(raw: string | null): Saved | null {
  try {
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

/** The record as written, or null if it could not be. */
function saveSession(store: SessionStore | undefined, s: Saved): string | null {
  const raw = JSON.stringify(s);
  try {
    (store ?? sessionStorage).setItem(SAVED_KEY, raw);
    return raw;
  } catch {
    /* private browsing, storage disabled — resume across reloads is a
       convenience, never a correctness requirement */
    return null;
  }
}

/** Remove the record only if it is still `mine`: another window sharing
 *  the store may have written its own since. */
function clearSaved(store: SessionStore | undefined, mine: string | null): void {
  try {
    const s = store ?? sessionStorage;
    if (mine !== null && s.getItem(SAVED_KEY) === mine) s.removeItem(SAVED_KEY);
  } catch {
    /* as above */
  }
}
