/**
 * The Hotline-ng wire, in TypeScript.
 *
 * This file is the client-side twin of `crates/hxd-ng-session/src/proto.rs`
 * and the spec it implements, `docs/hotline-ng.md` §5–§7 plus the voice
 * (`docs/voice.md` §8) and video (`docs/capabilities-video.md`) bindings.
 * When the server's shapes change, this is the file that changes with it —
 * nothing below `wire/` should ever hand-roll a frame.
 *
 * Three envelope shapes, discriminated by their first key: a request
 * carries `id`, a reply `reply`, an event `seq`.
 */

// --- Envelopes ----------------------------------------------------------

export interface ReqFrame {
  id: number;
  req: string;
  params: unknown;
}

export interface ReplyFrame {
  reply: number;
  ok?: unknown;
  error?: WireError;
}

export interface EventFrame {
  seq: number;
  ev: string;
  data: unknown;
}

export interface WireError {
  code: string;
  text: string;
}

export type ServerFrame = ReplyFrame | EventFrame;

export function isReply(f: ServerFrame): f is ReplyFrame {
  return (f as ReplyFrame).reply !== undefined;
}

export function isEvent(f: ServerFrame): f is EventFrame {
  return (f as EventFrame).seq !== undefined;
}

// --- Shared shapes ------------------------------------------------------

/** Presence, as §2's table defines it. `idle` and `detached` both show as
 *  the away colour to a 1.x client; only ng clients can tell them apart. */
export type Status = 'active' | 'idle' | 'detached';

/** Whether the link this session is held on is encrypted, from
 *  `hotline-ng-identity.md` §10. A plain-TCP legacy session reads as
 *  `cleartext`, and so does a tunnel that told the server its own
 *  downstream hop was — a session may declare itself less safe than it
 *  looks, never more. It is present on every roster row whether or not
 *  the server runs the identity endpoints, so a client can warn before a
 *  private message goes somewhere unencrypted without feature-detecting
 *  anything. */
export type Transport = 'encrypted' | 'cleartext';

/** What a roster row is entitled to show about someone's identity, and
 *  no more: never `age` or `outcome`, which are the server's business
 *  and their owner's. */
export interface RosterIdentity {
  /** 52 characters, Crockford base32. May be shortened to 8 for display. */
  fingerprint: string;
  /** `alice@hl.example`, or null when no attestation was accepted. */
  handle: string | null;
}

export interface User {
  uid: number;
  nick: string;
  icon: number;
  admin: boolean;
  status: Status;
  transport: Transport;
  /** Absent unless the socket holding this session proved an identity. */
  identity?: RosterIdentity;
}

/** The extra identity facts the login reply's `self` carries, which are
 *  for the user themself and appear on nobody else's roster row. */
export interface SelfIdentity extends RosterIdentity {
  /** Seconds since the oldest surviving attestation's registration; 0
   *  when unattested. */
  age: number;
  /** What account association happened: `linked`, `created`, `guest`,
   *  `unattested_guest`, or `classic_pending_link`. A prediction made at
   *  `/identity/auth` and confirmed here — this one is authoritative. */
  outcome: string;
  /** The account this session landed on, or null for a guest. */
  account: string | null;
}

/** `self` in the login reply: a roster row plus what only its owner sees. */
export interface SelfUser extends User {
  identity?: SelfIdentity;
}

/** The `from` object on chat, msg and broadcast events: a uid and the
 *  nick as it stood when the line was sent, which is deliberately not the
 *  same thing as the roster's current nick.
 *
 *  `login` appears on `msg` only, and only when there is somebody to
 *  reply to — a guest has none, and neither does a sender whose account
 *  has since gone. `uid` is 0 on a message that waited: the sender had no
 *  session when it was flushed, so there is no roster row to point at and
 *  `login` is the only durable handle on them.
 */
export interface Sender {
  uid: number;
  nick: string;
  login?: string;
}

// --- Inline media (docs/inline-media.md §8) -----------------------------

/**
 * An image on a chat line or a private message.
 *
 * The bytes are never here: `id` is an opaque handle, twenty-two
 * characters of base64url, and the bytes come from `GET /media/{id}`
 * with the session's own credential. Everything else is the server's
 * measurement of the image *it* encoded — it decoded whatever was
 * uploaded and wrote the canonical copy itself — so `width`, `height`
 * and `bytes` can be trusted to size a placeholder before a byte of it
 * has arrived.
 *
 * `id` is **absent when the bytes have gone**: expired, evicted, or
 * revoked by a moderator. The rest survives, because "an 800×600 PNG
 * was here" is worth drawing and an empty line is not.
 */
export interface Media {
  id?: string;
  /** The canonical MIME type: one of `image/jpeg`, `image/png`,
   *  `image/gif`, whatever the sender's file was. */
  type: string;
  width: number;
  height: number;
  bytes: number;
}

/** What the server will accept, from the login reply. A client checks a
 *  file against these before spending an upload to be told no. */
export interface MediaLimits {
  max_bytes: number;
  max_dimension: number;
  max_pixels: number;
  max_frames: number;
  max_duration_ms: number;
  /** The MIME types a file picker should offer. Read rather than
   *  hard-coded, so a server that one day allows a fourth needs no new
   *  client. */
  types: string[];
}

/** Why a file cannot be sent, in words for the person who picked it, or
 *  `null` when it can. Checked here so the answer is instant and local;
 *  the server checks everything again, and its answer is the one that
 *  counts. */
export function mediaBlockedReason(file: { type: string; size: number }, limits: MediaLimits): string | null {
  if (!limits.types.includes(file.type)) {
    const names = limits.types.map((t) => t.replace('image/', '').toUpperCase()).join(', ');
    return `This server takes ${names} images only.`;
  }
  if (file.size > limits.max_bytes) {
    return `That image is ${Math.round(file.size / 1024)} KB; this server takes up to ${Math.round(limits.max_bytes / 1024)} KB.`;
  }
  return null;
}

export interface ServerInfo {
  name: string;
  subject: string;
  agreement?: string;
}

export type ChatStyle = 'normal' | 'action';

// --- Handshake ----------------------------------------------------------

export interface LoginParams {
  login?: string;
  password?: string;
  nick?: string;
  icon?: number;
}

export interface VideoLimits {
  max_width: number;
  max_height: number;
  max_fps: number;
  max_bitrate: number;
  max_per_room: number;
}

export interface VideoConfig {
  camera: VideoLimits;
  screen: VideoLimits;
}

export interface HistoryConfig {
  max_lines: number;
  max_days: number;
}

export interface LoginOk {
  session: string;
  token: string;
  self: SelfUser;
  server: ServerInfo;
  users: User[];
  /** `null` when this account may not detach — a resume will never
   *  succeed, so the client must log in again rather than try. */
  detach: { grace: number } | null;
  caps: string[];
  seq: number;
  /** Present only when the server offers video. */
  video?: VideoConfig;
  /** Present whenever the server has an inbox, so a badge can be drawn
   *  before any mail arrives. Absent is not zero: it means this server
   *  stores nothing, and the client should not offer a mail view. */
  inbox?: InboxCounts;
  /** Present only when the server keeps public-chat history. */
  history?: HistoryConfig;
  /** Present exactly when `caps` lists `media`. Absent means no images:
   *  do not draw the paperclip. */
  media?: MediaLimits;
  /** Present exactly when `caps` lists `news`: what this session may do
   *  there, and the ceilings it will be held to. */
  news?: NewsConfig;
}

export interface ResumeParams {
  session: string;
  token: string;
  last_seq: number;
}

export interface ResumeOk {
  replay: number;
  self: SelfUser;
}

export interface SyncOk {
  server: ServerInfo;
  users: User[];
  seq: number;
}

// --- Private messages (docs/private-messages.md §7) ---------------------

/**
 * Who a private message is for. Exactly one of `to` and `to_login`: a
 * request carrying both is `bad_request`, because guessing which was
 * meant is how a message reaches the wrong person.
 *
 * `to` names a uid on the roster. `to_login` names an account whether or
 * not it holds a session, and is the only way to answer mail that
 * arrived while its sender was gone — the `msg` event for one carries
 * `uid: 0`.
 */
export type MsgParams = { text: string; guid?: string; media?: string } & (
  | { to: number; to_login?: never }
  | { to_login: string; to?: never }
);

/** A public chat line. `text` may be empty when `media` is present: the
 *  image is the message. */
export interface ChatParams {
  text: string;
  style?: ChatStyle;
  /** A handle from `POST /media`, which must be this session's own
   *  upload and still live. */
  media?: string;
}

/**
 * A fresh `guid` for a `msg`.
 *
 * `crypto.randomUUID` is not used directly because it is
 * `[SecureContext]`: it is missing on a page served over plain http to
 * anything but localhost, which is exactly how this client is reached
 * from a phone on the LAN during development. `getRandomValues` carries
 * no such restriction, so the fallback is a real v4 UUID rather than a
 * weaker one.
 */
export function newGuid(): string {
  // `protocol` is the layer this package promises runs anywhere, so the
  // absence of a CSPRNG is said plainly rather than thrown as a
  // ReferenceError from the middle of the fallback. A guid picked
  // without one would be worse than none: two clients could collide and
  // the server would treat one person's message as a duplicate of
  // another's.
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('newGuid needs Web Crypto: no global `crypto.getRandomValues` here');
  }
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 1
  const hex = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface MsgOk {
  /** True when the message waited rather than going to a live session,
   *  and nothing else. There is deliberately no id here: the id is the
   *  *recipient's* handle for marking read, and handing a monotonic one
   *  to the sender would tell them how much mail this server carries. */
  queued: boolean;
}

export interface InboxCounts {
  unread: number;
  total: number;
}

/**
 * One stored message, as `inbox` lists it.
 *
 * No uid: the sender may be long gone, and a uid from then may belong to
 * someone else now. A client that wants to reply names `from.login`,
 * which is absent exactly when there is nobody to reply to.
 */
export interface StoredMessage {
  id: number;
  from: { nick: string; login?: string };
  text: string;
  /** Unix seconds, when it was sent. */
  at: number;
  read: boolean;
  /** The image it was sent with, resolved as of now: with an `id` while
   *  the bytes are still there, without one when they have gone. */
  media?: Media;
}

export interface InboxParams {
  /** Page backwards from this id, exclusive. */
  before?: number;
  /** 1–200, default 50. */
  limit?: number;
}

export interface InboxOk extends InboxCounts {
  /** Newest first. */
  messages: StoredMessage[];
}

// --- Public chat history (docs/chat-history.md §7) ---------------------

/** The durable sender identity a history row can safely expose. There
 *  is deliberately no uid: it may belong to somebody else now. */
export interface HistorySender {
  /** Absent on a deleted row. */
  nick?: string;
  icon: number;
}

/** Metadata that remains after the image bytes or handle disappear. */
export interface HistoryMedia extends Media {
  /** The line itself was redacted, so the image went with it — as
   *  against a handle that merely expired, which leaves `id` absent and
   *  says nothing about why. */
  removed?: boolean;
}

export interface HistoryLine {
  id: number;
  /** Unix seconds. */
  at: number;
  from: HistorySender;
  text: string;
  style: ChatStyle;
  deleted?: boolean;
  media?: HistoryMedia;
}

export interface HistoryParams {
  /** Page backwards from this id, exclusive. */
  before?: number;
  /** Page forwards from this id, exclusive. */
  after?: number;
  /** 1–200, default 50. Both cursors define an exclusive range. */
  limit?: number;
}

export interface HistoryOk {
  /** Always oldest first, whichever cursor was used. */
  lines: HistoryLine[];
  /** More rows exist in the direction of this request. */
  has_more: boolean;
}

/** Who to block. Exactly one of the three, and `fingerprint` only
 *  unblocks: it names a block, not a person. */
export type BlockParams =
  | { uid: number; login?: never; fingerprint?: never }
  | { login: string; uid?: never; fingerprint?: never }
  | { fingerprint: string; uid?: never; login?: never };

/**
 * One entry of the `blocks` list. Objects rather than bare logins
 * because a block can be held against an identity admitted as a guest:
 * its login is `guest` and the fingerprint is what tells it apart, so a
 * list of logins would name something `unblock` could not resolve once
 * that guest had left.
 */
export interface BlockEntry {
  login: string;
  /** Present exactly when the block is keyed on one; 52 characters. */
  fingerprint?: string;
}

export interface BlocksOk {
  blocked: BlockEntry[];
}

/** How long a fingerprint is in its displayed form: 32 bytes of SHA-256
 *  in Crockford base32, which packs 260 bits into 52 characters. */
export const FINGERPRINT_CHARS = 52;

/**
 * Does this look like a fingerprint rather than an account name?
 *
 * The question a client asks of `/unblock`'s argument, which may be
 * either. Length is what discriminates — no login is 52 characters —
 * and the case is not checked because the server's parser lowercases
 * before decoding, and folds `O` to `0` and `I` and `L` to `1`. A
 * fingerprint copied out of something that shouted it is still one.
 *
 * Deliberately a *guess*, not validation: the server does the real
 * parsing and refuses what does not decode. Being slightly generous
 * here costs a refused request, where being strict costs a fingerprint
 * silently treated as a login and refused for the wrong reason.
 */
export function isFingerprint(s: string): boolean {
  return s.length === FINGERPRINT_CHARS && /^[0-9a-z]+$/i.test(s);
}

// --- News (hxd-ng's docs/news.md §9) -------------------------------------

/** A bundle holds bundles and categories; a category holds articles and
 *  nothing else. The 1.5 wire's rules, kept so the two wires are one
 *  tree. */
export type NewsNodeKind = 'bundle' | 'category';

export interface NewsNode {
  id: number;
  /** `null` for a node at the root of the tree. */
  parent: number | null;
  kind: NewsNodeKind;
  /** Unique among its siblings. */
  name: string;
  /** Sub-nodes for a bundle; live articles for a category. */
  count: number;
  /** Unix seconds. */
  created_at: number;
  /** Present on a bundle the request's `depth` reached into. */
  children?: NewsNode[];
}

/** Who wrote an article, as they were when they wrote it: a rename
 *  later does not rewrite it. `login` and `fingerprint` are absent for a
 *  guest, and both are absent — with `nick` empty — on a tombstone. */
export interface NewsAuthor {
  nick: string;
  login?: string;
  /** 52 characters, Crockford base32. */
  fingerprint?: string;
}

/**
 * Where a body's `#51` pointed, resolved once when it was posted and
 * reported as the target stands now. A deleted target says so and
 * nothing else — the link stays, and says it leads nowhere.
 */
export interface NewsReference {
  id: number;
  /** Absent when the target is deleted. */
  subject?: string;
  /** The target's author's nick. Absent when the target is deleted. */
  from?: string;
  at: number;
  deleted: boolean;
}

/** An image on an article. Always an empty list on a server whose news
 *  takes no attachments (`NewsConfig.attach`). */
export interface NewsAttachment {
  id: string;
  type: string;
  width: number;
  height: number;
  bytes: number;
  name?: string;
}

export interface NewsArticle {
  id: number;
  category: number;
  /** `null` for a thread's starter. */
  parent: number | null;
  /** Equal to `id` for a starter. */
  root: number;
  /** 0 for a starter. */
  depth: number;
  from: NewsAuthor;
  subject: string;
  /** Exactly as typed, LF line endings. Empty on a tombstone. */
  body: string;
  /** How to read `body`: `text/plain`, or `text/markdown` on a server
   *  whose `NewsConfig.markdown` is not `off`. */
  mime: string;
  /** Unix seconds. */
  at: number;
  /** A tombstone keeps its id, place and time and loses its words. Its
   *  replies stay where they are. */
  deleted: boolean;
  attachments: NewsAttachment[];
  refs: NewsReference[];
  /** How many articles point at this one; `newsRefs` lists them. */
  referenced_by: number;
}

/** A thread as a listing shows it: the starter whole, and what happened
 *  to it since. */
export interface NewsThread {
  article: NewsArticle;
  /** Everything under the starter, tombstones included. */
  replies: number;
  last_at: number;
  last_id: number;
}

/** The login reply's `news` block, present exactly when `caps` lists
 *  `news`. `post` and `attach` are *this session's* permissions, so a
 *  compose button can be grayed out before anyone types. */
export interface NewsConfig {
  post: boolean;
  attach: boolean;
  /** Present when this server accepts staged news images. */
  max_attachments?: number;
  max_attachment_bytes?: number;
  types?: string[];
  max_body: number;
  max_subject: number;
  /** Reply nesting. A reply to an article this deep is refused. */
  max_depth?: number;
  markdown: 'render' | 'source' | 'off';
  body_types: string[];
  max_refs: number;
  /** Does `news_search` answer? */
  search: boolean;
  /** The deepest a search pages; a `total` past it comes back `capped`. */
  search_max_results?: number;
  /** May this session hold subscriptions? False for a guest, which has
   *  no mailbox to keep them in, and false on a server that keeps none.
   *  Absent on a server older than subscriptions, which is the same
   *  answer: offer no Follow button. */
  subscribe?: boolean;
  /** What posting does, present when the server keeps subscriptions. */
  auto_subscribe?: NewsAutoSubscribe;
  /** Present exactly when `subscribe` is true: unread across every
   *  subscription that is not muted, so a badge can be drawn before
   *  `newsSubs` answers — the way `LoginOk.inbox` does for mail. */
  unread?: number;
}

// --- News subscriptions (hxd-ng's docs/news.md §10) ---------------------

/** What posting subscribes you to: every thread you write in, only the
 *  threads you start, or nothing you did not ask for. A subscription it
 *  made is marked `auto`. */
export type NewsAutoSubscribe = 'participated' | 'own_thread' | 'off';

/**
 * What a subscription is to: a thread, named by its starter, or a
 * category. Exactly one — both or neither is `bad_request`, for the same
 * reason `MsgParams` takes one address.
 *
 * There is deliberately no third scope for "all news": a session that is
 * attached already hears `news_posted` for everything, and a
 * notification for every post on a server is one nobody leaves on.
 */
export type NewsScope =
  | { thread: number; category?: never }
  | { category: number; thread?: never };

/** How a subscription row and a `news_notify` name their scope. */
export type NewsScopeKind = 'thread' | 'category';

/** Turn a row's `scope` and `target` back into the parameter a request
 *  takes, so a `news_subs` row or a `news_notify` can be answered with
 *  `newsSeen` or `newsUnsubscribe` without restating the wire's rule. */
export function newsScopeOf(x: { scope: NewsScopeKind; target: number }): NewsScope {
  return x.scope === 'thread' ? { thread: x.target } : { category: x.target };
}

/**
 * One subscription, as `news_subs` lists it.
 *
 * A muted row is a subscription that says never: muting something not
 * followed creates one, so posting there does not quietly subscribe you
 * again and a reply there rings nothing.
 */
export interface NewsSub {
  scope: NewsScopeKind;
  /** The thread's starter, or the category. */
  target: number;
  /** The category it lives in; equal to `target` for a category. */
  category: number;
  /** A thread's starter's subject; empty when the starter is a tombstone. */
  subject?: string;
  /** A category's name. */
  name?: string;
  /** Made by posting rather than asked for. Subscribing again makes it
   *  explicit. */
  auto: boolean;
  muted: boolean;
  /** For a thread: live articles past the cursor not written by you. For
   *  a category: new *threads* past it — a category subscription is
   *  about what was started there, not every reply. */
  unread: number;
  /** The highest article id acknowledged with `news_seen`. */
  last_seen: number;
}

/** Subscribing to something new starts caught up, so `unread` is 0;
 *  subscribing to something already followed keeps its cursor. */
export interface NewsSubscribeOk {
  unread: number;
}

export type NewsMuteParams = NewsScope & { muted: boolean };

export interface NewsSubsOk {
  /** Newest subscription first. */
  subs: NewsSub[];
}

/** `up_to` is an article id. The cursor only moves forward and stops at
 *  the newest article in the scope. */
export type NewsSeenParams = NewsScope & { up_to: number };

export interface NewsSeenOk {
  /** What is left in the scope; 0 when it is not subscribed at all. */
  unread: number;
}

/** Why a `news_notify` is yours: a reply to your article, a body that
 *  cited one (`#51`), or something new where you subscribed. */
export type NewsNotifyReason = 'reply' | 'reference' | 'subscription';

export interface NewsTreeParams {
  /** Absent for the root. */
  parent?: number;
  /** 1–4, default 1. */
  depth?: number;
}

export interface NewsTreeOk {
  nodes: NewsNode[];
}

/** One category's threads, **newest first**. `before` pages toward
 *  older threads and `after` toward newer ones, both exclusive; either
 *  way `has_more` is about the direction asked. */
export interface NewsThreadsParams {
  category: number;
  before?: number;
  after?: number;
  /** 1–200, default 50. */
  limit?: number;
}

export interface NewsThreadsOk {
  threads: NewsThread[];
  has_more: boolean;
}

/** A thread in reading order: every reply directly under the article it
 *  answers, siblings oldest first. `after` is an article in the thread. */
export interface NewsThreadParams {
  root: number;
  after?: number;
  /** Returned by the first page and required whenever `after` is set. */
  snapshot?: number;
  /** 1–100, default 25. */
  limit?: number;
}

export interface NewsThreadOk {
  articles: NewsArticle[];
  has_more: boolean;
  /** Echo on later pages so the thread's mutable preorder stays fixed. */
  snapshot: number;
}

export interface NewsPostParams {
  category: number;
  /** The article this replies to, which must be in the same category. */
  parent?: number;
  subject: string;
  body: string;
  /** Default `text/plain`. */
  mime?: string;
  /** Handles returned by `uploadNewsAttachment`, in display order. */
  attach?: string[];
}

/** A staged image, usable by a later `newsPost` from this session. */
export interface StagedNewsAttachment extends NewsAttachment {
  expires_in: number;
}

export interface NewsPostOk {
  id: number;
}

export interface NewsRefsOk {
  /** The articles pointing at this one, newest first. */
  referenced_by: NewsReference[];
}

export interface NewsNodeCreateParams {
  parent?: number;
  kind: NewsNodeKind;
  name: string;
}

export interface NewsNodeOk {
  node: NewsNode;
}

export interface NewsNodeDeleteOk {
  /** How many articles went with it. */
  articles: number;
}

/**
 * A search. `q` is whatever was typed: the server's grammar makes
 * something of anything, so there is no error for a bad query — only
 * results or none. `phase 4` is both words, `"phase 4"` the phrase,
 * `-legacy` excludes, `subject:` and `from:` narrow to a field, and
 * `sizes*` is a prefix.
 */
export interface NewsSearchParams {
  q: string;
  /** A category, or a bundle standing for every category under it. */
  category?: number;
  /** Only this author's articles; `from:` said as a parameter. */
  from?: string;
  /** Unix seconds. */
  before?: number;
  after?: number;
  /** Default `relevance`. */
  order?: 'relevance' | 'recent';
  /** Results to skip. Paging is by offset because relevance order is
   *  not stable enough for a cursor. */
  offset?: number;
  /** 1–50, default 20. */
  limit?: number;
}

export interface NewsHit {
  id: number;
  /** The thread to open, so a hit needs no second request. */
  root: number;
  category: number;
  subject: string;
  /** The author's nick. */
  from: string;
  at: number;
  /** A stretch of the body around what matched. Text, never markup. */
  snippet: string;
  /** `[start, end)` in `snippet`, in UTF-16 code units — what a
   *  JavaScript string indexes by — so `snippet.slice(start, end)` is
   *  the match. `markedSpans` turns them into runs to draw. */
  marks: [number, number][];
}

export interface NewsSearchOk {
  hits: NewsHit[];
  /** Every match, not only the ones this page shows. */
  total: number;
  /** More matched than a search may reach; say "500+", not "500". */
  capped: boolean;
}

// --- Voice --------------------------------------------------------------

export interface VoiceParticipant {
  uid: number;
  muted: boolean;
}

/** The `voice_join` reply. There is no `cid` in it: the client named the
 *  room in the request and the server answers about that one. */
export interface VoiceJoinOk {
  sdp: string;
  codec: string;
  participants: VoiceParticipant[];
}

// --- Video --------------------------------------------------------------

export type VideoKind = 'camera' | 'screen';

export interface VideoPublication {
  uid: number;
  kind: VideoKind;
  paused: boolean;
}

export interface VideoStreamRef {
  uid: number;
  kind: VideoKind;
}

export interface VideoStartOk {
  codec: string;
}

/**
 * The `a=mid` grammar the SFU keys every track on, from
 * `docs/capabilities-video.md` §Track-to-User Mapping. Sections differ
 * per peer and move as subscriptions change, so a client MUST key on
 * these and never on `sdpMLineIndex`.
 */
export const MIC_SEND_MID = 'send';
export const CAM_SEND_MID = 'cam-send';
export const SCR_SEND_MID = 'scr-send';

/** The mid a client's own publication of `kind` is carried on. */
export function sendMid(kind: VideoKind): string {
  return kind === 'camera' ? CAM_SEND_MID : SCR_SEND_MID;
}

const RECV_MID = /^(cam|scr)-user-([1-9]\d*)$/;

/** Read `cam-user-12` or `scr-user-23` back into the publication it
 *  carries, or `null` for any other mid — the client's own send
 *  sections, audio, and anything a later revision adds. */
export function parseRecvMid(mid: string): VideoStreamRef | null {
  const m = RECV_MID.exec(mid);
  if (!m) return null;
  return { uid: Number(m[2]), kind: m[1] === 'cam' ? 'camera' : 'screen' };
}

// --- Events -------------------------------------------------------------

export interface Events {
  user_joined: { user: User };
  user_changed: { user: User };
  user_parted: { uid: number };
  chat: {
    from: Sender;
    text: string;
    style: ChatStyle;
    /** Present when the server persisted this public line. */
    id?: number;
    /** Unix seconds. */
    at: number;
    /** The image this line carried, when it carried one. */
    media?: Media;
  };
  notice: { text: string };
  subject: { subject: string };
  /** A private message. `id` is absent when nothing durable was stored
   *  — a message between live sessions on a server with no inbox, or one
   *  from a guest — and it is the handle `msg_read` takes. `at` is when
   *  it was *sent*, not when it arrived, which is the whole difference
   *  for mail that waited. */
  msg: { from: Sender; text: string; at: number; queued: boolean; id?: number; media?: Media };
  broadcast: { from: Sender; text: string };
  kicked: Record<string, never>;
  voice_offer: { cid: number; sdp: string };
  voice_ice: { cid: number; candidate: RTCIceCandidateInit | null };
  voice_status: { cid: number; participants: VoiceParticipant[] };
  video_status: { cid: number; publishers: VideoPublication[] };
  /** A moderator revoked an image. It reaches everyone who could have
   *  fetched it — which is to say everyone who may have it on screen.
   *  The line that carried it keeps its metadata, so the right response
   *  is to drop the picture and leave the placeholder. */
  media_revoked: { id: string };
  /**
   * An article was posted somewhere this session may read. **Cache
   * invalidation, not a notification**: it goes to every reader, so a
   * view holding that category or thread refreshes and nothing raises a
   * badge. It carries a header rather than the article because the
   * cheap refresh is usually no refetch at all.
   */
  news_posted: {
    id: number;
    category: number;
    root: number;
    parent: number | null;
    subject: string;
    from: { nick: string };
    at: number;
    attachments: number;
  };
  /** An article became a tombstone. */
  news_deleted: { id: number; category: number };
  /** A bundle or category was created or renamed. */
  news_node: { node: NewsNode };
  news_node_deleted: { id: number };
  /**
   * An article that is *yours* to hear about. Unlike `news_posted` it
   * goes only to the sessions of the account being notified, and the
   * server has already decided it should ring — catch-up, muting and
   * blocks are applied before it is sent — so a client raises a badge on
   * this and never on `news_posted`.
   */
  news_notify: {
    reason: NewsNotifyReason;
    /** The subscription, or cursor, this counts against. */
    scope: NewsScopeKind;
    target: number;
    article: number;
    root: number;
    category: number;
    subject: string;
    /** The opening of the plain body, cut short by the server. */
    excerpt: string;
    from: { nick: string; login?: string };
    at: number;
    /** Unread in that scope after this article; 1 when there is no
     *  cursor, as for a reply in a thread you do not follow. */
    unread: number;
  };
  /** The server's placeholder for a domain event this protocol revision
   *  has no mapping for. It exists so `seq` never has holes; a client's
   *  only correct response is to count it and move on. */
  unsupported: Record<string, never>;
}

export type EventName = keyof Events;

// --- Error codes --------------------------------------------------------

/** Reasons a login can be refused. Wrong account and wrong password are
 *  deliberately one code; `denied` is the identity policy refusing the
 *  socket, where nothing about the credentials failed and there is
 *  nothing to retry. */
export const LOGIN_ERRORS = ['login_failed', 'denied', 'banned', 'server_full'] as const;

/** Names a server may list in the login reply's `caps`. The list is a
 *  hint for feature detection, not a switch — a server answers a request
 *  it does not offer with its own error rather than by silence — so a
 *  client uses these to decide what to *draw*. */
export const CAP_VOICE = 'voice';
export const CAP_VIDEO = 'video';
export const CAP_INBOX = 'inbox';
export const CAP_IDENTITY = 'identity';
export const CAP_HISTORY = 'history';
export const CAP_MEDIA = 'media';
export const CAP_NEWS = 'news';

/**
 * `resync_required` is not a failure: the session is still alive and the
 * connection still attached, the gap in the outbox is just too big to
 * replay. The client follows with `sync` on the same socket.
 */
export const RESYNC_REQUIRED = 'resync_required';
export const SESSION_EXPIRED = 'session_expired';
/** "Slow down", never "there is nothing more" — a loop that pages on
 *  the client's behalf has to tell the two apart. */
export const RATE_LIMITED = 'rate_limited';

/** Human wording for the codes a person can actually act on. Anything
 *  not listed falls back to the server's own `text`, which is always
 *  present and always meant for a human. */
export const ERROR_TEXT: Record<string, string> = {
  login_failed: 'That account and password did not match.',
  banned: 'This server has banned your address.',
  server_full: 'The server is full.',
  session_expired: 'Your session expired. Logging in again.',
  access_denied: 'You do not have permission to do that.',
  rate_limited: 'Slow down — the server is rate-limiting this connection.',
  not_logged_in: 'Not logged in.',
  unknown_method: 'This server is older than this client and does not know that request.',
  voice_disabled: 'This server does not offer voice chat.',
  video_disabled: 'This server does not offer video.',
  voice_full: 'That voice chat is full.',
  video_full: 'Someone else is already sharing. Ask them to stop first.',
  // The message requests. `no_such_user` is deliberately one answer for
  // "no such account", "no such uid" and "that account takes no offline
  // messages", so none of them can be told from the others — which means
  // the wording has to cover all three without implying any one.
  no_such_user: 'There is nobody here by that name who can be messaged.',
  no_inbox: 'Your account has no mailbox on this server.',
  mailbox_full: 'That mailbox is full. Try again once they have read some.',
  blocked: 'That user is not accepting messages from you.',
  denied: 'This server would not admit you.',
  name_reserved: 'That name is reserved for somebody else on this server.',
  // News. `no_news` is about the server and `access_denied` about you,
  // which is the difference between hiding the button and graying it.
  no_news: 'This server has no news.',
  no_such_node: 'That bundle or category is gone.',
  no_such_article: 'That article is gone.',
  not_a_category: 'Articles go in categories, and categories hold only articles.',
  wrong_category: 'A reply goes in the category of the article it answers.',
  too_deep: 'That is nested as deep as this server allows.',
  name_taken: 'Something there already has that name.',
  not_empty: 'That bundle still holds something. Empty it first.',
  bad_body_type: 'This server takes plain-text articles only.',
  not_available: 'This server does not offer that.',
  // Subscriptions. `no_mailbox` is about you, as `no_inbox` is: a guest
  // has nowhere to keep them.
  no_mailbox: 'You have no mailbox on this server, so there is nowhere to keep what you follow.',
  too_many_subs: 'You follow as much as this server allows. Unfollow something first.',
  server_error: 'The server had a problem with that. It has been logged.',
};

export function errorText(e: WireError): string {
  // `||` rather than `??` on the text: a server that sends an empty one
  // has said nothing, and nothing rendered as an error message is worse
  // than the bare code — at least a code can be looked up.
  return ERROR_TEXT[e.code] || e.text || e.code;
}
