/**
 * The client shell: it owns the connection, the store, and the layout
 * that shows them.
 *
 * The wiring principle throughout is that the server is the source of
 * truth. Nothing is drawn optimistically off the back of a request — a
 * line of chat appears when the `chat` event carrying it arrives, which
 * is also how the sender sees their own line, because a Hotline server
 * echoes chat to everyone including its author. Private messages are the
 * one exception the protocol forces: `msg` has no echo, so the sender's
 * own half of a PM is added locally and marked as such.
 */

import type { Session } from '../session';
import {
  captureBlockedReason,
  Connection,
  errorText,
  hasSavedSession,
  newGuid,
  screenShareBlockedReason,
  VoiceSession,
  WireFailure,
  CAP_CHAT_GUID,
  CAP_FILES,
  CAP_HISTORY,
  CAP_INBOX,
  CAP_SIGNED,
  BAD_SIGNATURE,
  CERT_CHANGED,
  NOT_SEALED,
  SIGNED_SKEW_SECONDS,
  base64urlToBytes,
  canonicalText,
  fingerprintFromString,
  signChatRequest,
  signMsgRequest,
  signNewsPost,
  sealMsgRequest,
  isFingerprint,
  mediaBlockedReason,
  type BlockParams,
  type ChatStyle,
  type Signs,
  type ConnState,
  type Credentials,
  type Events,
  type InboxOk,
  type HistoryOk,
  type Media,
  type MsgOk,
  type MsgParams,
  type SignedMsgRequest,
  type NewsNode,
  type NewsPostParams,
  type NewsPostOk,
  type PersonRef,
  type RemoteVideo,
  type ReportParams,
  type User,
  type VideoKind,
} from '@hotline-ng/client';

import { ClassicConnection, type ClassicHooks } from '../classic/connection';
import { route } from '../classic/route';
import { serverFromUrl, type AppConfig } from '../config';
import { durationWords, DURATIONS, lineReport, parseDuration, personRef } from '../moderation';
import { notifyText } from '../news';
import {
  messageAddress,
  Cursor,
  LOBBY,
  type Conversation,
  type ConvId,
  type Line,
  Store,
  styleToKind,
} from '../state';
import { ask, choose, type Field } from './ask';
import { connectScreen, remembered, type ConnectScreen, type Details } from './connect';
import { openContacts } from './contacts';
import { canonicalFingerprint, contactLookup, contactName, contactOf, type ContactOf } from '../contacts';
import { DebugPanel } from './debug';
import { badge, clock, fill, h } from './dom';
import { FilesView } from './files';
import { icon } from './icons';
import { type AvatarChoice, pickIcon } from './iconpicker';
import { IdentityPanel } from './identity';
import { installButton } from './install';
import { takeScanFragment, type Scanned } from '../identity/scan';
import { getActiveDevice, getDevice, newsGuids, peers, sealedReplay, type StoredDevice } from '../identity/storage';
import {
  PeerMemory,
  adoption,
  chooseDeniable,
  conversationIdentity,
  deniableChoice,
  lineFingerprint,
  neverSealedFallback,
  neverSeals,
  rememberIdentity,
  sealTarget,
  sealedBefore,
  sighting,
  signedTo,
  splitUtf8,
} from '../sealing';
import { KeyWithdrawn, checkHostKey, type ServerKeyCheck } from '../identity/trust';
import {
  ArticleReader,
  LineReader,
  MessageReader,
  beforeUnsigned,
  readPmSigning,
  readSealing,
  readSigning,
  rememberSigningDevice,
  sealedFor,
  signingDeviceFor,
  signsFor,
  writePmSigning,
  writeSealing,
  writeSigning,
  type LineRead,
  type LineSignature,
  type PinnedKey,
  type SignScope,
  unreadable,
} from '../signing';
import { renderRoster } from './roster';
import { openSettings, type Theme } from './settings';
import { Tiles } from './tiles';
import { BannerStrip } from './banner';
import { INTERVAL_MS, UpdateCheck } from '../update';
import { MediaCache } from './media';
import { avatars, face } from './avatar';
import { closedForReporter, ModerationView, problem as moderationProblem } from './moderation';
import { AccountsView } from './accounts';
import { FriendsView } from './friends';
import { mayAdminister } from '../accounts';
import { NewsView } from './news';
import { appendLine, isAtBottom, keepingPlace, lineOf, renderTranscript, scrollToEnd, signedName, spoken, type TranscriptOptions } from './transcript';
import { wrapSelection } from './markdown';
import { contentWords, disablePush, enablePush, pushEnabled, pushSupported, refreshPush } from '../push/client';
import { awayCount, clearAway, showBadge } from '../push/badge';
import { isPushOpenMessage, parseOpenParam, type PushOpen, type PushOpenReply } from '../push/notice';
import { createPanes, type PaneNode, type Panes } from 'mullion';

/** Mark an element as one of the tiler's panes.
 *
 *  The tiler takes its panes from the document: `catalog` is a list of
 *  ids and everything else about a pane -- its title, how narrow it may
 *  be made -- is an attribute on the element. That suits a page whose
 *  panels are written in markup. Nothing here is: `index.html` is a
 *  `<div id="root">` and the shell is built by `h()`, so what is one
 *  attribute over there is four assignments here, on an element we made
 *  a line ago and already know everything about.
 */
function pane(el: HTMLElement, id: string, title: string, min: number): HTMLElement {
  el.id = id;
  el.dataset.pane = '';
  el.dataset.paneTitle = title;
  el.dataset.paneMin = String(min);
  return el;
}

/** A pane that starts out of the layout, for `available()` to bring in. */
function offPane(el: HTMLElement): HTMLElement {
  el.setAttribute('data-pane-off', '');
  return el;
}

/** Every panel this client tiles, in the order the shell builds them. */
const PANES = ['rail', 'chat', 'news', 'files', 'friends', 'reports', 'accounts', 'roster'];

/** Where they go the first time somebody opens this in a window with
 *  room. Chat, news and files are tabs of one leaf, which is the whole
 *  point: they take turns in the same space today, by hiding each other. */
const LAYOUT: PaneNode = {
  dir: 'row',
  size: [0.16, 0.62, 0.22],
  kids: [
    { tabs: ['rail'] },
    { tabs: ['chat', 'news', 'files', 'friends', 'reports', 'accounts'] },
    { tabs: ['roster'] },
  ],
};

/** Codes that mean "not for you, not now, not ever on this session":
 *  no log configured, no privilege, or a request this server will not
 *  parse. Asking again would only produce the same answer. */
/** A notification's ask, held for a session it belongs to. */
interface PendingOpen {
  server: string;
  account: string;
  open: PushOpen;
}

/** The ask a notification opened this page with: `?open=`, and the
 *  `?server=` and `?account=` it was for, which its worker always sets. */
function pendingFromUrl(): PendingOpen | null {
  const q = new URLSearchParams(location.search);
  const server = serverFromUrl();
  const account = q.get('account');
  if (!q.has('open') || server === null || account === null) return null;
  return { server, account, open: parseOpenParam(q.get('open')) };
}

const HISTORY_REFUSALS = new Set(['not_available', 'access_denied', 'bad_request']);

const THEME_KEY = 'hxd-ng.theme';
const SELF_VIEW_KEY = 'hxd-ng.selfview';
const MARKDOWN_KEY = 'hxd-ng.markdown';
/** The phone layout, as `styles.css` draws it: where the rail is a
 *  drawer and the title bar's buttons live at its foot. */
const PHONE = '(max-width: 44rem)';

/** What `App.sendSigned` sends: how to sign it, and how to send it
 *  either way. */
interface SignedSend<Q, R> {
  /** `line`, `message` or `article`, in what the user is asked. */
  what: string;
  /** Why it goes unsigned, where only the caller knows: asked once any
   *  key check under way has ended. */
  cannot?: () => string | null | Promise<string | null>;
  /** Where the note that it goes unsigned is said: the transcript
   *  unless this says otherwise. */
  say?: (text: string) => void;
  sign(): Promise<Q>;
  signed(req: Q): Promise<R>;
  unsigned(): Promise<R>;
  /** Put back what was written, for one that did not go. */
  restore(): void;
}

const UNSIGNED_HERE: Record<SignScope, string> = {
  lobby: 'Lobby signing is on, but your lines here go unsigned',
  pm: 'Signing private messages is on, but this one goes unsigned',
  news: 'Signing articles is on, but this one goes unsigned',
};

/** The cleartext `msg` limit (§4.3), which a signed text is held to
 *  rather than cut (§3.2). */
const CLEAR_MSG_MAX_BYTES = 4096;
/** The text a sealed message may carry (§4.3). */
const SEALED_MSG_MAX_BYTES = 8192;

/** A friend's typing flag lapses after this, unless said again; one's
 *  own is said again at the shorter interval while typing goes on
 *  (§7.5). */
const TYPING_SHOWN_MS = 10_000;
const TYPING_RENEW_MS = 5_000;

/** How long after a resume the events it replays may still arrive. */
const RESUME_REPLAY_MS = 5000;

/** One message a private message went as, for the sender's own copy. */
interface SentPm {
  ok: MsgOk;
  text: string;
  signature?: LineSignature;
  sealed?: boolean;
  /** The guid it went under, which a friend's receipts name. */
  guid?: string;
}

const SIGNED_WHAT: Record<SignScope, string> = { lobby: 'lines', pm: 'private messages', news: 'articles' };

export class App {
  private store = new Store();
  private conn: Session | null = null;
  private media: VoiceSession | null = null;
  private debug: DebugPanel;
  private identityPanel: IdentityPanel;
  /** Set when this page was opened by a QR code, or by a broken one. */
  private openPanelForScan = false;
  private pingTimer: number | null = null;
  private historyLoading = false;
  /** A server that refuses `history` refuses it for the whole session.
   *  The cap is echoed whether or not this account may read the log
   *  (hxd-ng's `docs/chat-history.md` §5), so an account without the
   *  privilege would otherwise be told so again on every scroll to the
   *  top, forever. */
  private historyRefused = false;
  private url = '';
  /** The store revision the transcript element was last drawn from. */
  private drawnRevision = 0;
  /** Inline images: one fetch per handle, and the blob URLs to release
   *  when the session ends. Named for pictures rather than `media`,
   *  which on this page has meant the voice session since before there
   *  were any. */
  private images = new MediaCache();
  // The composer, or with the chat covered, the rail's way back to what
  // covers it.
  private banner = Object.assign(new BannerStrip(), {
    onHidden: () =>
      (this.composer.offsetParent ? this.composer : this.rail.querySelector<HTMLElement>('[aria-current="page"]'))?.focus(),
  });
  /** An image uploaded and waiting for the line that will carry it, and
   *  the file name the chip shows it under. Attaching uploads
   *  immediately — the server has to see the bytes to say whether it
   *  will take them, and finding out at send time would lose the
   *  message with them. */
  private attached: { media: Media; name: string } | null = null;
  /** Bumped by anything that abandons an attachment. An upload that was
   *  already in flight lands afterwards and must not resurrect the chip
   *  or become the image on the next line — the user has removed it,
   *  picked another file, or lost the session since. */
  private uploads = 0;
  /** Whether one's own camera is shown back to oneself. A preview is the
   *  only way to find out that a camera is pointed at the ceiling, or
   *  that it is not sending at all, without asking the room. */
  private selfView = readSelfView();
  /** Whether chat is drawn as markdown — GtkHx's "Render markdown", on
   *  by default. Receiving markdown means a literal `*emphasis*` from a
   *  1997 client comes out in italics; this is for anybody who would
   *  rather see exactly what was typed. What is sent never changes. */
  private markdown = readMarkdown();
  /** Whether this user signs the lobby's lines, off by default, private
   *  messages sealed and not in the clear, and articles, as hxd-ng's
   *  `docs/e2e-messages.md` §8 asks; and seals private messages, on by
   *  default. */
  private signLobby = readSigning('lobby');
  private pmSigning = readPmSigning();
  private sealPms = readSealing();
  private signNews = readSigning('news');
  /** This device's keys and certificate, for a session that may sign
   *  and seal. */
  private signer: { key: CryptoKey; enc: CryptoKey; cert: Uint8Array } | null = null;
  /** Each roster session's certificate as `device_cert` gave it, with
   *  the fingerprint it was asked for under, until that uid's session
   *  changes or the server says its key has. */
  private certs = new Map<number, { fingerprint: string; cert: Uint8Array }>();
  /** The uids whose rows said `sealed` this connection, and under which
   *  fingerprint: a message to one that goes in the clear is asked about
   *  first (§8), even once the row says nothing of an identity. */
  private sealedRows = new Map<number, string>();
  /** Who private messages were verified from, or sealed to, across
   *  reloads (§4.4, §8). */
  private peerMemory = new PeerMemory(peers);
  /** The conversations told this session cannot seal. */
  private cannotSealNoted = new Set<ConvId>();
  /** When the last resume was answered, whose replay is older than it
   *  looks; and whether the clock was warned of this connection. */
  private resumedAt = 0;
  private clockWarned = false;
  /** The fingerprint this session proved, which a private message to it
   *  is signed to. */
  private proved: string | null = null;
  /** The key this host is pinned to; `null` while a changed one is not
   *  accepted, and then nothing is signed. */
  private pinned: PinnedKey | null = null;
  private lines = new LineReader(null);
  private messages = new MessageReader(null, sealedReplay);
  private articles = new ArticleReader(null);
  /** Said once a connection, for each scope and reason: signing is on
   *  there, and this goes unsigned. */
  private unsignedNoted = new Set<string>();
  /** For each conversation, the other session it was last told its
   *  sealed messages go to. */
  private recipientWarned = new Map<ConvId, string>();
  /** Each identity a conversation was seen under besides its own, warned
   *  of once a connection. */
  private identityWarned = new Set<string>();
  /** The ng address the key was checked at, to check it again. */
  private keyUrl = '';
  private repinning: Promise<void> | null = null;
  /** What arrives on the wire, shown in its order: a chat line once it
   *  is read, and whatever came after it behind it. */
  private shown: Promise<void> = Promise.resolve();
  /** Lines a moderator blanked this session, for a copy that is shown
   *  only after: one still being read, or on a page fetched before. */
  private redacted = new Set<number>();

  // Long-lived DOM.
  private shell = h('div', { class: 'app', hidden: true });
  /** Above the connect form and the shell alike: a page left open on
   *  either is the one still running an old build. Always in the tree,
   *  and empty with no banner, so a screen reader hears it filled. */
  private updateBar = h('div', { role: 'status' });
  private updates = new UpdateCheck(__BUILD__.id, (url, init) => fetch(url, init), Date.now);
  private serverName = h('h1', { class: 'server-name' });
  private subject = h('span', { class: 'subject' });
  private pill = h('button', { class: 'pill', title: 'Connection state' });
  private rail = h('nav', { class: 'rail' });
  private callbar = h('div', { class: 'callbar', hidden: true });
  private tiles = new Tiles();
  private transcript = h('div', { class: 'transcript' });
  /** Each new line of the conversation on screen, for a screen reader:
   *  the transcript is redrawn whole too often to be a live region. */
  private heard = h('div', { class: 'sr-only', role: 'log' });
  private composer = h('textarea', {
    class: 'composer-input',
    rows: 1,
    placeholder: 'Say something to everyone…',
    ariaLabel: 'Message',
    spellcheck: true,
  });
  private composerHint = h('span', { class: 'composer-hint' });
  /** This conversation's sealed messages go deniably, or signed. */
  private deniableBtn = h('button', { type: 'button', class: 'ghost deniable-switch', hidden: true }, 'deniable');
  /** This conversation's fingerprint, compared or not, and the way to
   *  compare it. */
  private compareBtn = h('button', { type: 'button', class: 'ghost compare-switch', hidden: true });
  private attachBtn = h(
    'button',
    { class: 'ghost attach', title: 'Attach an image', ariaLabel: 'Attach an image', hidden: true },
    '📎',
  );
  /** The file picker, kept out of the layout: the paperclip clicks it. */
  private filePicker = h('input', { type: 'file', hidden: true });
  /** What is attached, with a way to change your mind before sending. */
  private attachChip = h('div', { class: 'attach-chip', hidden: true });
  private rosterEl = h('aside', { class: 'roster' });
  private scrim = h('div', { class: 'scrim' });
  private peopleBtn = h(
    'button',
    { class: 'ghost people-toggle', title: 'Show the user list' },
    'People',
  );
  private mailBtn = h('button', { class: 'ghost mail-button', hidden: true }, 'Mail');
  /** The title bar's less-used buttons: in the row on a wide screen,
   *  at the foot of the drawer on a phone. */
  private extras = h('div', { class: 'topbar-extras' });
  /** Opens the rail as a drawer from the left; only on a phone. A
   *  disclosure rather than an ARIA menu: what it shows is the rail, the
   *  same list of buttons a wide screen has in a column. */
  private menuBtn = h(
    'button',
    {
      class: 'ghost menu-toggle',
      type: 'button',
      title: 'Conversations and more',
      // Its text is a glyph, and a glyph is what a screen reader would say.
      ariaLabel: 'Conversations and more',
      ariaExpanded: 'false',
    },
    '\u2630',
  );
  /** The bottom of the drawer, which holds the title bar's buttons while
   *  the layout is a phone's. Empty, and not drawn, otherwise. */
  private drawerFoot = h('div', { class: 'rail-foot' });
  /** How far `msg_read` has been told we have got. Selecting the same
   *  conversation twice does not ask again, and two marks in flight
   *  cannot write each other's answers. */
  private readCursor = new Cursor();
  private meButton = h('button', { class: 'identity', title: 'Change your icon' });
  /** Transcript, attachment chip and composer: the half of the main
   *  column the news reader takes the place of while it is open. */
  private chatPane = h('div', { class: 'chat-pane' });
  private news = new NewsView({
    conn: () => this.conn,
    // An identity login says which account it landed on; a classic one
    // is the account that was typed. A guest is nobody either way.
    me: () => this.conn?.self?.identity?.account ?? this.account,
    onUnread: () => this.renderRail(),
    articles: () => this.articles,
    post: (params, category) => this.postNews(params, category),
    contact: (fp) => this.contactOf()(fp),
  });
  private panes: Panes | null = null;
  /** Where the tiler draws, when it is on. Its own box inside `.panes`
   *  so the shell's own children are what it adopts from. */
  private tiler = h('div', { class: 'tiler' });
  private newsOpen = false;
  private files = new FilesView(() => this.conn);
  private filesOpen = false;
  /** Reports and the audit trail, for a moderator; a pane nobody else
   *  is offered. */
  private moderation = new ModerationView({
    conn: () => this.conn,
    store: this.store,
    onCount: () => this.renderRail(),
    openArticle: (id) => this.openNewsArticle(id),
  });
  private reportsOpen = false;
  /** The account editor, for a session that may read or make accounts. */
  private accountsView = new AccountsView(() => this.conn);
  private accountsOpen = false;
  private friends = new FriendsView({
    conn: () => this.conn,
    message: (login, name) => this.select(this.store.openPm({ login, nick: name }).id),
    onCount: () => this.renderRail(),
  });
  private friendsOpen = false;
  /** The friend this session last told it is typing to, if any, and
   *  the timer saying it again while it is. */
  private typingTo: string | null = null;
  private typingRenew: number | null = null;
  private typingIdle: number | null = null;
  /** A friend's typing flag, shown until it lapses. */
  private typingShown = new Map<ConvId, number>();
  /** Instant messages shown and not yet told read, by conversation. */
  private pendingReads = new Map<ConvId, string[]>();
  /** Each instant message shown, by sender and guid: one handed over
   *  again is acknowledged again and not shown twice. */
  private imSeen = new Set<string>();
  /** The account typed at the connect form, or `null` for a guest. */
  private account: string | null = null;
  /** Notifications on this device, for this server and account. Shown
   *  only where the server offers them and the browser can take them. */
  private notifyBtn = h('button', { class: 'ghost', hidden: true }, 'Notify');
  /** What a notification tapped before there was a session asked to be
   *  shown, and whose it was: kept until a login to that server as that
   *  account, and shown only then. Either the `?open=` a notice opened
   *  this page with, or one tapped while this page sat at the form. */
  private pendingOpen: PendingOpen | null = pendingFromUrl();
  /** The connect form, while it is up. */
  private connectForm: ConnectScreen | null = null;

  constructor(
    private root: HTMLElement,
    private config: AppConfig,
  ) {
    this.store.me = () => this.conn?.self?.identity?.account ?? this.account;
    this.debug = new DebugPanel(
      () => this.facts(),
      () => this.media?.stats() ?? Promise.resolve({ media: 'not connected' }),
    );
    // Identity is server-independent (`docs/identity-keys.md` §4 — one
    // key, many servers), but the panel still needs *a* server address
    // for the `hlid link` line and the card fallback fetch. The
    // connected server wins once there is one; before that, the
    // deployment's own default is the reasonable guess — it is, after
    // all, "the ordinary case of the client sitting in front of its own
    // server" the rest of this client already assumes.
    // The scan fragment is read here, before anything else can navigate
    // away from it — `takeScanFragment` also clears it from the address
    // bar, since the pairing secret in it should not survive a copied
    // URL or a bookmark (`identity-enrollment.md` §5.6).
    let scanned: Scanned | null = null;
    let scanError: string | null = null;
    try {
      scanned = takeScanFragment();
    } catch (e) {
      scanError = e instanceof Error ? e.message : String(e);
    }
    this.identityPanel = new IdentityPanel(
      () => this.url || this.config.defaultServer,
      scanned,
      scanError,
    );
    this.openPanelForScan = scanned !== null || scanError !== null;
    this.buildShell();
    this.applyTheme(readTheme());

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        this.debug.toggle();
      }
      if (e.key === 'Escape' && document.body.classList.contains('show-roster')) {
        this.showRoster(false);
      }
      if (e.key === 'Escape' && document.body.classList.contains('show-drawer')) {
        this.showDrawer(false);
        this.menuBtn.focus();
      }
    });

    // Coming back to the app is seeing what the badge counted, whether
    // or not there is a session to have counted it in.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return this.noteTyping(true);
      this.renderUnreadTitle();
      const conv = this.store.conversation(this.store.active);
      if (conv && !this.store.covered) this.flushReads(conv);
    });
    void this.paintBadge(0);
    window.addEventListener('pagehide', () => this.noteTyping(true));

    // A notification tapped while this page is open: its worker asks
    // whose this page is, and if it picks this one, says to act.
    if (pushSupported()) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (!isPushOpenMessage(e.data)) return;
        const m = e.data;
        const here = this.pushReply(m.server, m.account);
        if (m.act && here === 'match') this.followPush(m.open);
        if (m.act && here === 'idle') {
          this.pendingOpen = { server: m.server, account: m.account, open: m.open };
          this.connectForm?.fill({ url: m.server, login: m.account });
        }
        e.ports[0]?.postMessage(here);
      });
    }
    // Once read, `?open=` has done its job; a reload should not redo it.
    // `?server=` stays: it is what the form was pointed at.
    const q = new URLSearchParams(location.search);
    if (q.has('open') || q.has('account')) {
      const url = new URL(location.href);
      url.searchParams.delete('open');
      url.searchParams.delete('account');
      history.replaceState(history.state, '', url);
    }
  }

  mount(): void {
    this.connectForm = connectScreen(
      this.config,
      (d) => this.connect(d),
      () => this.identityPanel.toggle(true),
    );
    if (this.pendingOpen?.account) {
      this.connectForm.fill({ url: this.pendingOpen.server, login: this.pendingOpen.account });
    }
    const screen = this.connectForm.el;
    this.root.append(this.updateBar, screen, this.shell, this.debug.el, this.identityPanel.el);
    this.watchForUpdates();

    // After the shell is in the document: the tiler finds its panes with
    // getElementById, so nothing it is given may still be detached.
    this.panes = createPanes({
      root: this.tiler,
      catalog: PANES,
      layouts: { hotline: LAYOUT },
      mode: 'hotline',
      store: 'hx-panes',
      editing: '.composer-input, .md-body',
      on: true,
      // The whole of what tiling asks of a page: a reader that nobody
      // can see does not have to fetch anything, and one brought forward
      // does. `shown` and not `show`, because the layout owns `hidden`
      // while it is up and `show` would write it.
      onShow: (id, on) => {
        if (id === 'news') this.news.shown(on);
        else if (id === 'files') this.files.shown(on);
        else if (id === 'reports') this.moderation.shown(on);
        else if (id === 'accounts') this.accountsView.shown(on);
        else if (id === 'friends') this.friends.shown(on);
      },
    });

    // `?debug` opens the drawer before the first frame, which is what you
    // want when the thing you are debugging is the login itself.
    if (new URLSearchParams(location.search).has('debug')) this.debug.toggle(true);

    // A page opened by a QR code has one job, and the user is standing
    // in front of a terminal waiting for it. Opening the panel is not a
    // convenience here — the code expires in ten minutes.
    if (this.openPanelForScan) this.identityPanel.toggle(true);

    // A certificate past two-thirds of its lifetime renews itself when
    // something is listening (`identity-enrollment.md` §8) — the whole
    // point of routing a renewal by `prev` is that the user types
    // nothing. Fire-and-forget: with no agent running this is one 404
    // and nothing else, and the panel's banner is what nags.
    void this.identityPanel.tryAutoRenewal();

    // A reload is a dropped connection like any other: if this tab still
    // holds a session for the server it was last on, go straight back
    // into it rather than making someone log in again to reach the room
    // they never left.
    const saved = remembered(this.config);
    if (hasSavedSession(saved.url)) {
      screen.hidden = true;
      const splash = h('div', { class: 'connect' }, h('p', { class: 'muted' }, 'Resuming your session…'));
      screen.before(splash);
      this.connect(saved, { resumeOnly: true })
        .catch((e: Error) => {
          screen.hidden = false;
          // A session refused for now, or out of reach, is kept for the
          // next reload; logging in here would start another beside it.
          this.connectForm?.fail(
            hasSavedSession(saved.url)
              ? `${e.message.replace(/([^.!?])$/, '$1.')} Your session is still there: reload to go back into it.`
              : e.message,
          );
        })
        .finally(() => splash.remove());
    }
  }

  // --- connecting -------------------------------------------------------

  private async connect(d: Details, opts: { resumeOnly?: boolean } = {}): Promise<void> {
    // A retry after a failed connect starts a fresh session; anything
    // the last one left on the strip belongs to a peer connection that
    // no longer exists.
    this.tiles.clear();
    // Likewise the news reader: what it held was read through the last
    // session, and this one may not be allowed to see it.
    this.news.reset();
    this.newsOpen = false;
    this.files.reset();
    this.filesOpen = false;
    this.moderation.reset();
    this.reportsOpen = false;
    this.accountsView.reset();
    this.accountsOpen = false;
    this.friends.reset();
    this.friendsOpen = false;
    this.noteTyping(true);
    this.pendingReads.clear();
    this.imSeen.clear();
    this.store.covered = false;
    if (!this.tiling) this.chatPane.hidden = false;
    this.account = d.login.trim() || null;
    const creds: Credentials = { ...d };
    // Whether `start` logged in rather than resumed: a login draws the
    // banner itself, and a resume after a reload has to draw it from the
    // session it saved.
    let loggedIn = false;
    // A classic server, behind a relay, or the ng listener the address
    // has always meant. The discovery document says which.
    const way = await route(d.url);
    // A relay on the host's web port may front another server there; a
    // password goes to it only once the user has seen whose it is.
    if (way.shared && d.login.trim()) {
      const named = way.name ? `“${way.name}”` : 'a Hotline server it does not name';
      const yes = await ask({
        title: 'Log in here?',
        body:
          `No relay answered beside ${d.url}. The one on the host's web port leads to ${named}, ` +
          `which may be another server on that host. Send the login for ${d.login.trim()} there?`,
        fields: [],
        ok: 'Log in',
      });
      if (yes === null) throw new Error('Not connected: the relay found may front a different server.');
    }
    const hooks: ClassicHooks = {
      onAgreement: async (text, signal) =>
        (await ask({ title: 'Agreement', body: text, fields: [], ok: 'Agree', signal })) !== null,
      onTrace: (e) => this.debug.push(e),
      onState: (s, detail) => this.onState(s, detail),
      onModuleFailed: () => this.checkForUpdate(true),
      onLogin: (ok) => {
        this.store.server = ok.server;
        this.store.forgetPmUids();
        // A new session: receipts owed under the last are not its to send.
        this.pendingReads.clear();
        // Every login, not just the first: a resume that fails after a
        // server restart logs in again on this connection, and the
        // operator may have changed the banner, or taken it down.
        loggedIn = true;
        // A login, not a resume: the device is the one it proved, and on
        // a reconnect the key is checked again before it is signed to.
        this.useDevice(way.url, active);
        if (started) void this.repin();
        this.banner.show(conn);
        // Present whenever the *server* keeps mail — which is not the
        // same as this account having a mailbox. A guest on a server with
        // an inbox is told `{0, 0}` here and then refused `no_inbox` when
        // it asks, so this is a provisional yes that the first `inbox`
        // call confirms or withdraws.
        this.store.mail = ok.inbox ?? null;
        if (this.media) this.media.limits = ok.video ?? null;
        if (ok.server.agreement) {
          this.store.add(LOBBY, {
            t: Date.now(),
            kind: 'notice',
            text: ok.server.agreement,
          });
        }
      },
      onSnapshot: ({ self, users, server, stale }) => {
        this.store.self = self;
        this.store.server = server;
        this.store.replaceRoster(users);
        if (!stale) this.certs.clear();
        this.sealedRows.clear();
        for (const u of users) this.noteSealed(u);
        // The block a login or a sync carries, as it stands now.
        this.friends.onBlock();
        this.panes?.available('friends', this.conn?.messaging?.takes_part === true);
        this.renderAll();
        // Only the roster: every client was told at once, and nothing
        // else was missed.
        if (stale) return;
        // A snapshot after the first is a resync or a fresh login on the
        // same socket, and either way the news events in between are gone
        // — and the counts beside what is followed are the server's to
        // restate.
        this.news.onReconnected();
        void this.news.refreshFollowing();
        // So are the reports filed and closed in between.
        void this.moderation.recount();
        // And a change to this account, which the sync restates.
        this.onAccountChanged();
      },
      onResumed: (replay) => {
        this.resumedAt = Date.now();
        this.say(
          replay > 0
            ? `Reconnected — ${replay} ${replay === 1 ? 'message' : 'messages'} replayed.`
            : 'Reconnected.',
        );
        // A refresh tried while the socket was down could only say "not
        // connected", and nothing would ever try again.
        this.news.onReconnected();
        void this.news.refreshFollowing();
        const conv = this.store.conversation(this.store.active);
        if (conv && !this.store.covered && document.visibilityState === 'visible') this.flushReads(conv);
      },
      onMissedMail: (ok) => {
        void this.mergeStoredMail(ok).then((n) => {
          if (n) {
            this.say(
              `Recovered ${n} private ${n === 1 ? 'message' : 'messages'} that arrived while this client was behind.`,
            );
          }
        });
      },
      onFriends: ({ friends }) => this.friends.onFriends(friends),
      onMissedHistory: (ok) => {
        void this.historyLines(ok).then((lines) => {
          if (!lines) return;
          if (this.store.mergeHistory(lines, ok.has_more, 'newer') && this.store.active === LOBBY) {
            this.renderTranscript();
          }
          this.blank([...this.redacted]);
        });
      },
      onEnded: (reason) => {
        this.say(reason);
        this.noteTyping(true);
        this.pendingReads.clear();
        this.media?.teardown();
        this.banner.clear();
        // The handles die with the session, so the blob URLs may as
        // well: keeping them would leak every picture this page has
        // seen, and nothing could refetch them anyway.
        this.images.clear();
        avatars.clear();
        this.clearAttachment();
        // The news reader goes with the session it read through, and the
        // chat pane comes back so the reason just said is on screen.
        this.news.reset();
        this.showNews(false);
        this.files.reset();
        this.showFiles(false);
        this.moderation.reset();
        this.showReports(false);
        this.panes?.available('reports', false);
        this.accountsView.reset();
        this.showAccounts(false);
        this.panes?.available('accounts', false);
        this.friends.reset();
        this.showFriends(false);
        this.panes?.available('friends', false);
        // The paperclip goes with the session it belonged to. Left up,
        // it opens a picker whose upload can only fail with "not logged
        // in" — inert chrome saying something this client cannot do.
        this.attachBtn.hidden = true;
        this.notifyBtn.hidden = true;
        if (this.pingTimer !== null) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
      },
    };
    let started = false;
    this.keyUrl = way.url;
    this.pinned =
      way.wire === 'ng'
        ? await this.pinServerKey(way.url).catch((e: unknown) => {
            this.say(`This server's key could not be checked, so nothing will be signed here: ${this.problem(e)}`);
            return null;
          })
        : null;
    this.lines = new LineReader(this.pinned);
    this.articles = new ArticleReader(this.pinned, newsGuids);
    this.messages = new MessageReader(null, sealedReplay);
    this.certs.clear();
    this.sealedRows.clear();
    this.cannotSealNoted.clear();
    this.clockWarned = false;
    this.unsignedNoted.clear();
    this.recipientWarned.clear();
    this.identityWarned.clear();
    this.redacted.clear();
    // Merged under what this page noted already, so a record another tab
    // wrote since is seen.
    await this.peerMemory.load().catch(() => {});
    // The device the session proves: for a saved session it resumes, the
    // one that session logged in with, whichever is active now; for an
    // identity login, the active one.
    const active = d.identity ? await getActiveDevice().catch(() => null) : null;
    const resuming = way.wire === 'ng' && hasSavedSession(way.url);
    const saved = resuming ? signingDeviceFor(way.url) : null;
    const resumed = saved ? await getDevice(saved).catch(() => null) : null;
    const signs = this.useDevice(way.url, resuming ? resumed : active);
    const conn: Session =
      way.wire === 'classic'
        ? new ClassicConnection({ ...d, url: way.url, name: way.name }, hooks)
        : new Connection(
            {
              ...creds,
              url: way.url,
              messaging: true,
              ...(signs ? { signs, sealed: true } : {}),
              // Asked as the login goes out, a fresh one after a failed
              // resume included: it proves the active device.
              ...(d.identity
                ? {
                    identity: { ...d.identity, signs: () => signsFor(active?.cert, this.signLobby), sealed: () => sealedFor(active?.cert) },
                  }
                : {}),
            },
            hooks,
          );
    this.conn = conn;
    this.images.attach(conn);
    avatars.attach(conn);
    // Voice and video ride the ng wire; a classic server has neither here.
    this.media = !(conn instanceof Connection) ? null : new VoiceSession(conn, {
      onLog: (text, bad) => this.say(bad ? `Media error: ${text}` : text),
      onRoom: () => {
        this.renderRoster();
        this.refreshTileLabels();
      },
      onControls: () => this.renderCallbar(),
      onRemoteVideo: (v) => this.showRemoteTile(v),
      onRemoteVideoEnded: (mid) => this.tiles.drop(mid),
      onLocalVideo: (kind, stream) => this.showSelfTile(kind, stream),
    });
    this.bindEvents(conn);

    try {
      await conn.start(opts);
      started = true;
    } catch (e) {
      this.conn = null;
      this.media = null;
      this.images.attach(null);
      avatars.attach(null);
      throw new Error(
        e instanceof WireFailure ? errorText(e.wire) : e instanceof Error ? e.message : String(e),
      );
    }

    for (const el of this.root.querySelectorAll('.connect')) el.remove();
    this.connectForm = null;
    this.shell.hidden = false;
    this.url = d.url;
    if (this.media) this.media.limits = conn.video;
    // The paperclip appears only where it works: the server offers the
    // capability, or it does not and inert chrome would be a promise
    // this client cannot keep.
    this.attachBtn.hidden = conn.media === null;
    this.filePicker.accept = conn.media?.types.join(',') ?? '';
    // The reports pane is a moderator's. The count the login reply gave
    // is where the badge starts; a listing corrects it — which matters
    // after a reload, when the count is the one saved with the session
    // and the events since have been replayed on top of it.
    this.moderation.reset(conn.moderation?.open ?? 0);
    if (!loggedIn) this.banner.show(conn);
    // A moderator on a server that keeps no reports can still redact,
    // but has no queue to open.
    const reports = conn.moderator && conn.moderation !== null;
    this.panes?.available('reports', reports);
    if (reports) void this.moderation.recount();
    this.panes?.available('accounts', mayAdminister(conn.accounts));
    this.panes?.available('friends', conn.messaging?.takes_part === true);
    this.renderAll();
    this.composer.focus();
    // Conversations live in memory and die with the page; the mailbox
    // does not. Pulling the first page back means a reload lands you in
    // threads that still have their history, and it is also the only way
    // to see mail past `deliver_at_flush`, which the login flush caps.
    if (conn.hasCap(CAP_INBOX)) void this.loadMail({ initial: true });
    if (conn.hasCap(CAP_HISTORY)) {
      this.historyRefused = false;
      void this.loadHistory({ initial: true }).catch((e: Error) =>
        this.say(e instanceof WireFailure ? errorText(e.wire) : e.message),
      );
    }
    this.pingTimer = window.setInterval(() => {
      if (conn.state === 'online') void conn.ping().then(() => this.renderPill());
    }, 15000);
    void this.initPush(conn);
    const pending = this.pendingOpen;
    this.pendingOpen = null;
    if (pending && this.pushReply(pending.server, pending.account) === 'match') this.followPush(pending.open);
  }

  // --- notifications ----------------------------------------------------

  /** The account notifications are filed under here, for keeping one
   *  person's worker apart from another's in a shared browser. */
  private pushAccount(): string {
    return this.conn?.self?.identity?.account ?? this.account ?? '';
  }

  /** Offer the switch where it can work, and bring a device that already
   *  had notifications on up to date: a changed endpoint, or a server
   *  that has changed its key since. */
  private async initPush(conn: Session): Promise<void> {
    const offered = conn.push !== null && pushSupported();
    this.notifyBtn.hidden = !offered;
    if (!offered) return;
    try {
      await refreshPush(conn, this.url, this.pushAccount());
    } catch (e) {
      this.say(`Notifications on this device could not be renewed: ${this.problem(e)}`);
    }
    await this.paintNotify();
  }

  private async paintNotify(): Promise<void> {
    const on = await pushEnabled(this.url, this.pushAccount()).catch(() => false);
    this.notifyBtn.classList.toggle('on', on);
    this.notifyBtn.setAttribute('aria-pressed', String(on));
    this.notifyBtn.title = on
      ? 'Notifications: on for this device. Click to turn them off here.'
      : 'Notifications: off. Click to be notified here of private messages and news while you are away.';
  }

  private async togglePush(): Promise<void> {
    const conn = this.conn;
    if (!conn?.push) return;
    const server = this.url;
    const account = this.pushAccount();
    try {
      // The painted state, not a fresh look at the registration: that is
      // a promise, and Safari takes the permission prompt only while the
      // click that asked for it is still the thing running.
      if (this.notifyBtn.getAttribute('aria-pressed') === 'true') {
        await disablePush(conn, server, account);
        this.say('Notifications are off on this device.');
      } else {
        // Before the browser's own prompt, what the server will send: the
        // only point at which somebody can decide knowing it.
        if (!confirm(`${contentWords(conn.push.content)}\n\nTurn on notifications for this device?`)) return;
        await enablePush(conn, server, account);
        this.say('Notifications are on. Private messages and news for you will reach this device while you are away.');
      }
    } catch (e) {
      this.say(this.problem(e));
    }
    await this.paintNotify();
  }

  /** Whose this page is, as a notification's worker asks it: a notice
   *  for one account is never shown in another's session, even on the
   *  same server in the same browser. */
  private pushReply(server: string, account: string): PushOpenReply {
    if (!this.url) return 'idle';
    return server === this.url && account === this.pushAccount() ? 'match' : 'other';
  }

  /** Show what a notification was about: the conversation with whoever
   *  wrote, or the article. */
  private followPush(open: PushOpen): void {
    if (!this.conn) return;
    if (open.msg) {
      this.select(this.store.openPm({ login: open.msg, nick: open.nick ?? open.msg }).id);
    } else if (open.article !== undefined) {
      this.openNewsArticle(open.article);
    }
  }

  private problem(e: unknown): string {
    return e instanceof WireFailure ? errorText(e.wire) : e instanceof Error ? e.message : String(e);
  }

  private bindEvents(conn: Session): void {
    conn.on('user_joined', (d) => {
      this.store.put(d.user);
      this.certs.delete(d.user.uid);
      this.noteSealed(d.user);
      this.inOrder(() => this.push(LOBBY, { t: Date.now(), kind: 'notice', text: `${d.user.nick} joined.` }));
      this.renderRoster();
    });

    conn.on('user_changed', (d) => {
      const before = this.store.user(d.user.uid);
      this.store.put(d.user);
      this.noteSealed(d.user);
      if (before && before.nick !== d.user.nick) {
        const text = `${before.nick} is now known as ${d.user.nick}.`;
        this.inOrder(() => this.push(LOBBY, { t: Date.now(), kind: 'notice', text }));
        const pm = this.store.pmWith({ uid: d.user.uid });
        if (pm) pm.title = d.user.nick;
      }
      if (d.user.uid === this.store.self?.uid) this.store.self = d.user;
      this.renderRoster();
      this.renderRail();
      this.renderMe();
      this.refreshTileLabels();
      // A face in the chat gutter is looked up live, so the lines already
      // drawn are the one place a new or cleared picture would go stale.
      if (before?.avatar?.id !== d.user.avatar?.id) {
        keepingPlace(this.transcript, () => this.renderTranscript());
      }
    });

    conn.on('user_parted', (d) => {
      const gone = this.store.remove(d.uid);
      this.certs.delete(d.uid);
      this.sealedRows.delete(d.uid);
      const text = `${gone?.nick ?? `uid ${d.uid}`} left.`;
      this.inOrder(() => this.push(LOBBY, { t: Date.now(), kind: 'notice', text }));
      this.renderRoster();
    });

    conn.on('chat', (d) => {
      if (d.id !== undefined && this.store.hasHistory(d.id)) return;
      // `at` is required by the current wire, but pre-history servers
      // did not send it. Keep those servers usable while deployments
      // roll forward.
      const at = Number.isFinite(d.at) ? d.at : Math.floor(Date.now() / 1000);
      this.checkClock(at);
      // Read before it is shown: a copy of a signed line already here is
      // not shown at all, and one read for a session since replaced
      // belongs to none on screen.
      const lines = this.lines;
      const read = lines.live({ ...d, at }, this.store.user(d.from.uid)).catch(() => unreadable(d.signed));
      this.inOrder(async () => {
        const { signature, duplicate } = await read;
        if (duplicate || lines !== this.lines) return;
        this.push(LOBBY, {
          t: at * 1000,
          kind: styleToKind(d.style),
          from: d.from,
          text: d.text,
          id: d.id,
          media: d.media,
          ...(signature ? { signature } : {}),
          ...(d.signed !== undefined ? { signed: d.signed } : {}),
        });
        if (d.id !== undefined && this.redacted.has(d.id)) this.blank([d.id]);
      });
    });

    // An image someone posted has been revoked by a moderator. Drop the
    // bytes we hold and redraw: the line stays, the placeholder says
    // what happened, and nothing refetches it.
    conn.on('media_revoked', (d) => {
      this.images.revoke(d.id);
      this.renderTranscript();
    });

    // A moderator redacted a public line: blank it where it sits, and let
    // go of any image it carried. The reader stays where they were.
    conn.on('chat_redacted', (d) => {
      this.redacted.add(d.id);
      this.inOrder(() => this.blank([d.id]));
    });

    // A purge of a flood, told as one event for many lines rather than
    // one per line. Blank them all, then draw once.
    conn.on('chat_purged', (d) => {
      for (const id of d.ids) this.redacted.add(id);
      this.inOrder(() => this.blank(d.ids));
    });

    conn.on('report', (d) => this.moderation.onReport(d));
    // `conn.accounts` is already what the account may do now.
    conn.on('account_changed', () => this.onAccountChanged());
    conn.on('roles_changed', () => {
      this.renderRoster();
      this.accountsView.rolesChanged();
    });
    conn.on('report_closed', (d) => {
      if (d.yours) this.say(closedForReporter(d.id, d.outcome));
      // A moderator who filed it hears it once, as the reporter.
      if (this.conn?.moderator) this.moderation.onClosed(d.id);
    });

    conn.on('msg', (d) => {
      // `at` rather than now: a message that waited in the store was
      // *sent* whenever it was sent, and stamping the flush time on it
      // would make a week-old message read as having just arrived.
      // The login flush and an `inbox` page carry the same rows, and
      // which arrives first is a race. Whichever loses is dropped here.
      if (d.id !== undefined && this.store.hasMail(d.id)) return;
      this.checkClock(d.at, d.queued);
      // Read before it is shown, in its place among the lines, as a chat
      // line is; a sealed one opened there too.
      const messages = this.messages;
      const row = d.from.uid > 0 ? this.store.user(d.from.uid) : undefined;
      const sealed = d.sealed !== undefined;
      const read: Promise<LineRead | null> = d.sealed_lost
        ? Promise.resolve(null)
        : sealed
          ? messages.sealed(d, row)
          : messages.live(d, row).catch(() => unreadable(d.signed));
      this.inOrder(async () => {
        const opened = await read;
        if (messages !== this.messages) return void (opened && messages.unshown(opened).catch(() => {}));
        if (d.id !== undefined && this.store.hasMail(d.id)) return;
        if (!opened) {
          const conv = this.store.openPm({ uid: d.from.uid, login: d.from.login, nick: d.from.nick });
          this.push(conv.id, {
            t: d.at * 1000,
            kind: 'system',
            text: `A sealed message to this device, from the one the server calls ${d.from.nick}, was lost: this session could not open sealed messages when it came back.`,
          });
          return this.renderRail();
        }
        const { signature, duplicate } = opened;
        if (duplicate) {
          if (d.id !== undefined) this.store.skipMail({ uid: d.from.uid, login: d.from.login }, d.id);
          return;
        }
        const conv = this.store.openPm({ uid: d.from.uid, login: d.from.login, nick: d.from.nick });
        // An `id` means the server stored it, so both counters move. Moving
        // only `unread` was enough to render "1 unread of 0 stored" until
        // the next reply corrected it.
        if (d.id !== undefined) this.store.noteStoredMessage();
        const signed = sealed ? opened.whole : d.signed;
        this.push(conv.id, {
          t: d.at * 1000,
          kind: 'chat',
          from: d.from,
          text: opened.text ?? d.text,
          queued: d.queued,
          id: d.id,
          media: d.media,
          ...(signature ? { signature } : {}),
          ...(signed !== undefined ? { signed } : {}),
          ...(sealed ? { sealed: true } : this.clearMark()),
          ...(opened.hidden ? { hidden: true } : {}),
        });
        const seen = sighting(signature, this.verifiedUnder(conv), d.from);
        if (seen) void rememberIdentity(conv, this.peerMemory, this.keyUrl, seen.fingerprint, seen.who, sealed ? { sealed: true } : {});
        this.renderRail();
        this.renderMail();
      });
    });

    conn.on('im', (d) => this.onIm(d));
    conn.on('receipt', (d) => {
      const conv = this.store.receipt(d.login, d.guid, d.read);
      if (conv?.id === this.store.active) keepingPlace(this.transcript, () => this.renderTranscript());
    });
    conn.on('typing', (d) => {
      const conv = this.store.pmWith({ login: d.login });
      if (conv) this.setTyping(conv, d.typing);
    });
    conn.on('friend', (d) => this.friends.onFriend(d));
    conn.on('friend_request', (d) => {
      this.friends.onFriendRequest(d);
      this.say(`${d.login} asks to be your friend. Friends has the request.`);
    });
    conn.on('presence', (d) => {
      this.friends.onPresence(d);
      const conv = d.state === 'offline' ? this.store.pmWith({ login: d.login }) : undefined;
      if (conv?.typing) this.setTyping(conv, false);
    });
    conn.on('requests_changed', (d) => this.friends.onRequestsChanged(d));

    // News events say "your copy is stale", to every reader. They are not
    // notifications — nothing here raises a badge — so all they do is
    // have the reader refresh what it shows, or remember to when next
    // opened.
    conn.on('news_posted', (d) => this.news.onPosted(d));
    conn.on('news_edited', (d) => this.news.onEdited(d));
    conn.on('news_deleted', (d) => this.news.onDeleted(d));
    conn.on('news_purged', (d) => this.news.onPurged(d));
    conn.on('news_node', (d) => this.news.onNode(d));
    conn.on('news_node_deleted', (d) => this.news.onNodeDeleted(d));
    // This one *is* addressed to you: it goes only to the account being
    // notified, after the server has decided it should ring.
    conn.on('news_notify', (d) => this.onNewsNotify(d));

    conn.on('notice', (d) => {
      this.push(LOBBY, { t: Date.now(), kind: 'notice', text: d.text });
    });

    conn.on('broadcast', (d) => {
      this.push(LOBBY, { t: Date.now(), kind: 'broadcast', from: d.from, text: d.text });
    });

    conn.on('subject', (d) => {
      this.store.server = { ...this.store.server, subject: d.subject };
      this.renderTopbar();
      this.push(LOBBY, { t: Date.now(), kind: 'notice', text: `Subject: ${d.subject}` });
    });

    conn.on('kicked', () => {
      this.push(LOBBY, {
        t: Date.now(),
        kind: 'notice',
        text: 'You were disconnected by an administrator.',
      });
    });
  }

  private onState(s: ConnState, detail?: string): void {
    this.renderPill(detail);
    if (s !== 'online' && this.media?.joined) {
      // A dropped socket takes the peer connection with it: the SFU's
      // session is keyed to ours and there is nothing to salvage. Voice
      // is rejoined by hand after a resume, deliberately — nobody wants
      // their microphone reopened without being asked.
      this.media.teardown();
      this.say('Voice ended with the connection.');
    }
  }

  // --- video tiles ------------------------------------------------------

  private tileLabel(uid: number, kind: VideoKind): string {
    return `${this.store.nickOf(uid)} — ${kind}`;
  }

  private showRemoteTile(v: RemoteVideo): void {
    this.tiles.show(v.mid, v.stream, this.tileLabel(v.uid, v.kind));
  }

  /** One's own capture, shown back to oneself. Mirrored, muted, and at
   *  the front of the strip — it is a reference, not a participant. */
  private showSelfTile(kind: VideoKind, stream: MediaStream | null): void {
    const key = `self:${kind}`;
    if (!stream || !this.selfView) return this.tiles.drop(key);
    this.tiles.show(key, stream, `You — ${kind}`, { mirror: kind === 'camera', order: -1 });
  }

  private applySelfView(): void {
    const media = this.media;
    if (!media) return;
    for (const kind of ['camera', 'screen'] as const) {
      this.showSelfTile(kind, media.localVideo(kind));
    }
  }

  /** Captions carry nicks, and nicks change. */
  private refreshTileLabels(): void {
    for (const v of this.media?.remoteVideo() ?? []) {
      this.tiles.label(v.mid, this.tileLabel(v.uid, v.kind));
    }
  }

  // --- sending ----------------------------------------------------------

  private async send(text: string): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    if (text.startsWith('/')) return this.command(text);

    // Taken before anything is awaited: a second Enter while the send is
    // in flight must not send the same image twice. Every path below
    // that does *not* send it puts it back — the bytes are on the
    // server and the handle is still good, and making someone pick the
    // file again because the recipient had left is a poor answer.
    const attached = this.attached;
    this.clearAttachment();

    const conv = this.store.conversation(this.store.active);
    if (conv?.kind === 'pm') {
      const to = this.addressFor(conv);
      if (!to) {
        this.restoreAttachment(attached);
        return this.say(
          `There is no way to reach ${conv.title}: they have left, and the message they sent named no account to answer.`,
        );
      }
      // A guid makes a resend the same message rather than a second one.
      // Nothing here resends automatically yet, so today this only stops
      // a double-tap from arriving twice — but it is the field that makes
      // a retry safe at all, and it costs one line.
      const guid = newGuid();
      const media = attached?.media.id;
      const params: MsgParams =
        'to_login' in to
          ? { to_login: to.to_login, text, guid, media }
          : { to: to.to, text, guid, media };
      // PMs have no echo, so the sender's own half is local, a line for
      // each message it went as.
      const me = this.store.self;
      let sent = 0;
      let queued = false;
      let requested = false;
      await this.sendPm(conv, params, ({ ok, text: part, signature, sealed, guid: under }) => {
        this.push(conv.id, {
          t: Date.now(),
          kind: 'chat',
          from: { uid: me?.uid ?? 0, nick: me?.nick ?? 'you' },
          text: part,
          local: true,
          media: sent ? undefined : attached?.media,
          ...(signature ? { signature } : {}),
          ...(sealed !== undefined ? { sealed } : {}),
          ...(under !== undefined ? { guid: under } : {}),
        });
        sent += part.length;
        queued ||= ok.queued;
        requested ||= ok.requested === true;
      }).catch((e: unknown) => {
        if (!sent) this.restoreAttachment(attached);
        this.restoreComposer(text.slice(sent), 'normal');
        throw e;
      });
      if (requested) {
        this.say(`${conv.title} is not your friend, so that went as a message request: they see it only if they look at their requests.`);
      } else if (queued) {
        this.say(`${conv.title} is not here. The server is holding that for them.`);
      }
      return;
    }
    // Public chat echoes, so the sender's own copy comes back off the
    // wire with the image on it; nothing is pushed locally here.
    await this.sendChat(text, 'normal', attached?.media.id).catch((e: unknown) => {
      this.restoreAttachment(attached);
      throw e;
    });
  }

  /** A lobby line, with a `guid` where the server honors one, and signed
   *  where this user signs the lobby and the server carries it. */
  private async sendChat(text: string, style: ChatStyle, media?: string): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    if (!(conn instanceof Connection)) {
      await (style === 'action' ? conn.request('chat', { text, style }) : conn.chat({ text, media }));
      return;
    }
    const params = { text, style, media };
    const unsigned = conn.hasCap(CAP_CHAT_GUID) ? { ...params, guid: newGuid() } : params;
    // A media-only line has no text to sign, and goes as it is.
    if (!text) return void (await conn.chat(unsigned));
    const restore = () => this.restoreComposer(text, style);
    if (!this.signLobby) return void (await this.sendUnsigned(conn, 'lobby', { unsigned: () => conn.chat(unsigned), restore }));
    const id = crypto.getRandomValues(new Uint8Array(16));
    await this.sendSigned(conn, 'lobby', {
      what: 'line',
      sign: () =>
        signChatRequest(this.signer!.key, { id, cert: this.signer!.cert, server: this.pinned!.key, room: 0, text, act: style === 'action' }),
      signed: (req) => conn.chat({ ...params, ...req }),
      unsigned: () => conn.chat(unsigned),
      restore,
    });
  }

  /** A private message, sealed where this user seals them and it can be
   *  (`sendSealed`), and otherwise in the clear, asked about first if it
   *  could have been sealed to them before, and in as many messages as
   *  the server's limit takes; never in a private chat, which this
   *  client does not join. Each message it went as is handed to `sent`
   *  as it goes, for the sender's own copy. */
  private async sendPm(conv: Conversation, params: MsgParams, sent: (part: SentPm) => void): Promise<void> {
    const conn = this.conn;
    if (!conn) throw new Error('Not connected.');
    if (!(conn instanceof Connection)) return sent({ ok: await conn.msg(params), text: params.text, guid: params.guid });
    const parts = splitUtf8(params.text, CLEAR_MSG_MAX_BYTES);
    if (this.sealPms) {
      // Nothing is sealed or signed while a key check, or its warning,
      // is open.
      await this.repinning;
      const never = neverSeals({ sealing: conn.sealing, device: this.signer !== null });
      if (never === null) {
        const sealed = await this.sendSealed(conn, conv, params);
        if ('ok' in sealed) return sent({ ...sealed, text: params.text, guid: params.guid });
        await this.unsealedAfter(conv, sealed.why, parts.length);
      } else if (neverSealedFallback({ device: this.signer !== null }, this.wasSealed(conv)) === 'ask') {
        await this.unsealedAfter(conv, never, parts.length);
      } else if (!this.cannotSealNoted.has(conv.id)) {
        this.cannotSealNoted.add(conv.id);
        this.push(conv.id, { t: Date.now(), kind: 'system', local: true, text: `Private messages here go in the clear, not sealed: this session cannot seal them, as ${never}.` });
      }
    }
    // Once one piece goes unsigned, so do the rest, rather than ask again.
    let sign = true;
    for (const [i, text] of parts.entries()) {
      const part = i === 0 ? { ...params, text } : { ...params, text, guid: newGuid(), media: undefined };
      const clear = await this.sendClear(conn, conv, part, sign);
      sign = clear.signature !== undefined;
      sent({ ...clear, text, guid: part.guid, ...this.clearMark() });
    }
  }

  /** `sealed: false` on a private message in the clear, where this
   *  session could have sealed it or the user would have, so that every
   *  one says (§8). */
  private clearMark(): { sealed?: false } {
    return this.conn instanceof Connection && (this.conn.sealing || this.sealPms) ? { sealed: false } : {};
  }

  /** Seal to the device of a session holding the identity this
   *  conversation was verified under, or with none known the one the
   *  roster shows at its uid, as its certificate says once it is checked
   *  against that identity, signed or deniably as this conversation goes;
   *  or why it cannot be. A key the server says changed is fetched and
   *  sealed to once more, and never a reason to send in the clear. */
  private async sendSealed(
    conn: Connection,
    conv: Conversation,
    params: MsgParams,
  ): Promise<{ ok: MsgOk; signature: LineSignature; sealed: true } | { why: string }> {
    const signer = this.signer!;
    if (params.media) return { why: 'an image cannot be sealed' };
    const text = canonicalText(params.text);
    if (new TextEncoder().encode(text).length > SEALED_MSG_MAX_BYTES) {
      return { why: `it is longer than the ${SEALED_MSG_MAX_BYTES} bytes a sealed message may be` };
    }
    const { known, hint } = conversationIdentity(conv, this.peerMemory, this.keyUrl);
    let target = sealTarget(conv, known, this.store.roster(), hint);
    if ('changed' in target) {
      await this.acceptIdentity(conv, target.changed, target.was, 'sealed');
      target = { uid: target.uid, fingerprint: target.changed };
    }
    if ('cannot' in target) return { why: target.cannot };
    const { uid, fingerprint: to } = target;
    if (uid !== conv.peer.uid && this.recipientWarned.get(conv.id) !== `sealed ${uid} ${to}`) {
      this.recipientWarned.set(conv.id, `sealed ${uid} ${to}`);
      const nick = this.store.user(uid)?.nick ?? `uid ${uid}`;
      this.push(conv.id, { t: Date.now(), kind: 'system', local: true, text: `Sealed to ${nick}, the session holding the identity ${conv.title}'s messages here were under.` });
    }
    const deniable = this.deniable(conv);
    const message = { id: crypto.getRandomValues(new Uint8Array(16)), cert: signer.cert, to: fingerprintFromString(to)!, text };
    const sent = Math.floor(Date.now() / 1000);
    let resealed = false;
    for (;;) {
      try {
        const { cert, held } = await this.recipientCert(conn, uid, to);
        let req: { sealed: string; cert: string };
        try {
          req = await sealMsgRequest({ sign: signer.key, enc: signer.enc }, message, cert, deniable, sent);
        } catch (e) {
          this.certs.delete(uid);
          // One held from before may have expired since: the server's
          // word now is asked for.
          if (held) continue;
          return { why: `the certificate the server gave for them did not pass: ${this.problem(e)}` };
        }
        const ok = await conn.msg({ to: uid, ...req });
        void rememberIdentity(conv, this.peerMemory, this.keyUrl, to, { login: conv.peer.login, nick: conv.title }, { sealed: true });
        const signature: LineSignature = {
          state: deniable ? 'deniable' : 'verified',
          signer: this.proved,
          to,
          sent,
          sentAtAnotherTime: false,
          signatureExpected: false,
        };
        return { ok, signature, sealed: true };
      } catch (e) {
        if (!(e instanceof WireFailure)) throw e;
        if (e.wire.code === CERT_CHANGED && !resealed) {
          resealed = true;
          this.certs.delete(uid);
          continue;
        }
        if (e.wire.code === NOT_SEALED || e.wire.code === 'not_delivered') return { why: (e.wire.text || errorText(e.wire)).replace(/\.$/, '') };
        throw new Error(`Not sent: ${e.wire.text || errorText(e.wire)}`);
      }
    }
  }

  /** `uid`'s certificate as `device_cert` answers it, held while that
   *  session is the one asked for; `held` when it was. */
  private async recipientCert(conn: Connection, uid: number, fingerprint: string): Promise<{ cert: Uint8Array; held: boolean }> {
    const held = this.certs.get(uid);
    if (held?.fingerprint === fingerprint) return { cert: held.cert, held: true };
    const cert = base64urlToBytes((await conn.deviceCert(uid)).cert);
    this.certs.set(uid, { fingerprint, cert });
    return { cert, held: false };
  }

  /** The identity this conversation's messages were verified under, or
   *  sealed to: this page's, or the one last remembered for its login. */
  private verifiedUnder(conv: Conversation): string | null {
    return conversationIdentity(conv, this.peerMemory, this.keyUrl).known;
  }

  /** A conversation's sealed messages go deniably by its own switch, or
   *  by the user's choice to sign none. */
  private deniable(conv: Conversation): boolean {
    return deniableChoice(conv, this.peerMemory, this.keyUrl) ?? this.pmSigning === 'never';
  }

  private noteSealed(u: User): void {
    if (u.identity?.sealed) this.sealedRows.set(u.uid, u.identity.fingerprint);
  }

  private wasSealed(conv: Conversation): boolean {
    const fps = [this.verifiedUnder(conv), this.peerMemory.byNick(this.keyUrl, conv.title), this.rosterFingerprint(conv)];
    return sealedBefore(conv, fps, this.sealedRows, this.peerMemory, this.keyUrl);
  }

  /** Before one that could not be sealed goes in the clear: asked, each
   *  time, to someone it could have been sealed to before, and not sent
   *  if not; said once a connection otherwise. */
  private async unsealedAfter(conv: Conversation, why: string, parts: number): Promise<void> {
    if (this.wasSealed(conv)) {
      const yes = await ask({
        title: 'Send it unsealed?',
        body:
          `${conv.title} could open sealed messages before, but this one cannot be sealed: ${why}. Sent in the clear, the servers on its way can read it` +
          (parts > 1 ? `, and it goes as ${parts} messages, the most the server carries in each.` : '.'),
        fields: [],
        ok: 'Send unsealed',
      });
      if (yes === null) throw new Error('Not sent: it could not be sealed.');
      return;
    }
    const noted = `seal ${why}`;
    if (!this.unsignedNoted.has(noted)) this.say(`Sealing private messages is on, but this one goes in the clear: ${why}.`);
    this.unsignedNoted.add(noted);
  }

  /** A private message in the clear, signed where `sign` lets it, this
   *  user signs every one, the session can, and the recipient has an
   *  identity to sign it to. */
  private async sendClear(
    conn: Connection,
    conv: Conversation,
    params: MsgParams,
    sign: boolean,
  ): Promise<{ ok: MsgOk; signature?: LineSignature }> {
    if (!sign || this.pmSigning !== 'always' || !params.text) return { ok: await conn.msg(params) };
    let to: string | null = null;
    const id = crypto.getRandomValues(new Uint8Array(16));
    let sent = 0;
    return this.sendSigned<SignedMsgRequest, { ok: MsgOk; signature?: LineSignature }>(conn, 'pm', {
      what: 'message',
      // Asked only once this session can sign it, its key checked.
      cannot: async () => {
        to = await this.signedRecipient(conv);
        return to ? null : `${conv.title} did not log in with an identity to sign them to.`;
      },
      sign: () => {
        // The cleartext limit, which the server holds a signed text to
        // rather than cut it.
        if (new TextEncoder().encode(canonicalText(params.text)).length > CLEAR_MSG_MAX_BYTES) {
          throw new Error(`it is longer than the ${CLEAR_MSG_MAX_BYTES} bytes a signed message may be`);
        }
        // Signed again after a refusal to the same identity, whatever
        // the roster says now (§4.4).
        sent = Math.floor(Date.now() / 1000);
        return signMsgRequest(this.signer!.key, { id, cert: this.signer!.cert, to: fingerprintFromString(to!)!, text: params.text }, sent);
      },
      signed: async (req) => ({
        ok: await conn.msg({ ...params, ...req }),
        signature: { state: 'verified', signer: this.proved, to: to!, sent, sentAtAnotherTime: false, signatureExpected: false },
      }),
      unsigned: async () => ({ ok: await conn.msg(params) }),
      // The sender puts back all that was not sent, this piece and after.
      restore: () => {},
    });
  }

  /** The identity a private message in the clear is signed to (§4.9),
   *  as `signedTo` has it, asked about first where the row shows another
   *  than the one known, and not sent if not; `null` with none to sign
   *  to. */
  private async signedRecipient(conv: Conversation): Promise<string | null> {
    const row = conv.peer.uid !== undefined ? this.store.user(conv.peer.uid) : undefined;
    const to = signedTo(conversationIdentity(conv, this.peerMemory, this.keyUrl), row ? this.rosterFingerprint(conv) : undefined);
    if (!('changed' in to)) return to.to;
    await this.acceptIdentity(conv, to.changed, to.was, 'signed');
    return to.changed;
  }

  /** The user asked whether a conversation goes to `changed`, an
   *  identity other than `was`, the one it was last seen under, and
   *  moved there on a yes, its choice of deniable with it; not sent on a
   *  no. The user's word alone moves a conversation to another identity. */
  private async acceptIdentity(conv: Conversation, changed: string, was: string, how: 'sealed' | 'signed'): Promise<void> {
    const compared = this.comparedWarning(conv, was);
    const yes = await ask({
      title: compared ? 'Not the fingerprint you compared' : how === 'sealed' ? 'Seal to another identity?' : 'Sign to another identity?',
      body:
        compared +
        `${conv.title} was last under the identity ${was.slice(0, 16)} here, but the server now shows ${changed.slice(0, 16)} for them, ` +
        (how === 'sealed'
          ? 'and no session with the first. Sealed to the second, only whoever holds it can read this. '
          : 'Signed to the second, it is addressed to whoever holds it. ') +
        'If you did not expect a new key, check it with them another way first.',
      fields: [],
      ok: how === 'sealed' ? 'Seal to the new one' : 'Sign to the new one',
    });
    if (yes === null) throw new Error('Not sent: the server shows them under another identity.');
    const deniable = conv.deniable ?? this.peerMemory.get(this.keyUrl, was)?.deniable;
    conv.verified = changed;
    void this.peerMemory.note(changed, this.keyUrl, { login: conv.peer.login, nick: conv.title }, { accepted: true, ...(deniable === undefined ? {} : { deniable }) });
  }

  /** Said first, where the identity a conversation is leaving is one
   *  the user compared: that is the change comparing exists to catch. */
  private comparedWarning(conv: Conversation, was: string): string {
    if (!this.peerMemory.compared(was)) return '';
    return `You compared ${contactName(contactOf(this.peerMemory, was)) ?? conv.title}'s fingerprint; this one is different. `;
  }

  private rosterFingerprint(conv: Conversation): string | null {
    const row = conv.peer.uid !== undefined ? this.store.user(conv.peer.uid) : undefined;
    const fp = row?.identity?.fingerprint;
    return fp && fingerprintFromString(fp) ? fp : null;
  }

  /** An article, signed where this user signs them and the session can,
   *  into the category's guid and under its parent as it was read. */
  private async postNews(params: NewsPostParams, category: NewsNode): Promise<{ id: number; note?: string }> {
    const conn = this.conn;
    if (!conn) throw new Error('Not connected.');
    if (!(conn instanceof Connection) || !this.signNews) return conn.newsPost(params);
    const mime = params.mime ?? 'text/plain';
    // As hxd-ng keeps a subject: one line, trimmed, a tab as a space.
    const subject = params.subject.replaceAll('\t', ' ').trim();
    const id = crypto.getRandomValues(new Uint8Array(16));
    let note: string | undefined;
    // Read once the key is checked, under the key it is signed for.
    const parentOf = () => (params.parent === undefined ? null : this.articles.replyParent(params.parent));
    const ok: NewsPostOk = await this.sendSigned(conn, 'news', {
      what: 'article',
      cannot: async () => {
        const key = await this.articles.categoryKey(category);
        if ('why' in key) return `${key.why}, to sign it into.`;
        if (params.parent !== undefined && !parentOf()) return 'the article it answers could not be read.';
        return mime !== 'text/plain' && mime !== 'text/markdown' ? `an article is not signed as ${mime}.` : null;
      },
      say: (text) => (note = text),
      sign: async () => {
        const key = await this.articles.categoryKey(category);
        if ('why' in key) throw new Error(key.why);
        const parent = parentOf();
        return signNewsPost(this.signer!.key, {
          id,
          cert: this.signer!.cert,
          server: this.pinned!.key,
          category: key.guid,
          ...(parent ? { parent } : {}),
          subject,
          body: params.body,
          mime: mime as 'text/plain' | 'text/markdown',
        });
      },
      signed: (req) => conn.newsPost({ ...params, subject: req.subject, body: req.body, mime: req.mime, signed: req.signed }),
      unsigned: () => conn.newsPost(params),
      restore: () => undefined,
    });
    return { id: ok.id, ...(note ? { note } : {}) };
  }

  /**
   * Send signed where the user signs `scope` and this session can, and
   * unsigned otherwise, saying why once a connection. Nothing is lost to
   * signing: one that cannot be signed, or whose signature the server
   * refuses, asks before it goes unsigned, and goes back where it was
   * written if not. A refused signature, perhaps under a key the server
   * has moved to (hxd-ng's `docs/e2e-messages.md` §4.13), has the key
   * checked again and is signed again once, under the same id (§3.6).
   */
  private async sendSigned<Q, R>(conn: Connection, scope: SignScope, o: SignedSend<Q, R>): Promise<R> {
    // A key check under way leaves nothing pinned until it ends; wait for
    // it rather than send unsigned what would have been signed.
    await this.repinning;
    const why = this.whyUnsigned(conn, scope) ?? (await o.cannot?.()) ?? null;
    if (why && scope === 'lobby' && beforeUnsigned(this.signLobby, conn) === 'ask') {
      return this.unsignedAfter(conn, scope, o, `This ${o.what} cannot be signed: ${why}`, 'it cannot be signed');
    }
    if (why) {
      if (!this.unsignedNoted.has(`${scope} ${why}`)) (o.say ?? ((t: string) => this.say(t)))(`${UNSIGNED_HERE[scope]}: ${why}`);
      this.unsignedNoted.add(`${scope} ${why}`);
      return this.sendUnsigned(conn, scope, o);
    }
    let req: Q;
    try {
      req = await o.sign();
    } catch (e) {
      return this.unsignedAfter(conn, scope, o, `This ${o.what} could not be signed: ${this.problem(e)}`, 'it could not be signed');
    }
    try {
      return await o.signed(req);
    } catch (e) {
      let refused = e;
      if (e instanceof WireFailure && e.wire.code === BAD_SIGNATURE) {
        await this.repin();
        if (!this.whyUnsigned(conn, scope)) {
          try {
            return await o.signed(await o.sign());
          } catch (again) {
            refused = again;
          }
        }
      }
      if (!(refused instanceof WireFailure && refused.wire.code === BAD_SIGNATURE)) {
        o.restore();
        throw refused;
      }
      return this.unsignedAfter(conn, scope, o, `The server refused its signature: ${errorText(refused.wire)}`, 'the server refused its signature');
    }
  }

  private async unsignedAfter<R>(conn: Connection, scope: SignScope, o: SignedSend<unknown, R>, body: string, why: string): Promise<R> {
    const stop = scope === 'lobby' && beforeUnsigned(this.signLobby, conn) === 'ask';
    const yes = await ask(
      stop
        ? {
            title: 'Stop signing lobby lines?',
            body: `${body} You sign every lobby line, so none goes unsigned until you turn that off.`,
            fields: [],
            ok: 'Stop signing and send',
          }
        : { title: 'Send it unsigned?', body, fields: [], ok: 'Send unsigned' },
    );
    if (yes === null) {
      o.restore();
      throw new Error(`Not sent: ${why}.`);
    }
    if (stop) await this.setSignLobby(false, conn);
    return this.sendUnsigned(conn, scope, o);
  }

  /** Send unsigned, but a lobby line only once the server no longer says
   *  this session signs every one (hxd-ng's `docs/e2e-messages.md`
   *  §4.6), and never while this user still does. */
  private async sendUnsigned<R>(conn: Connection, scope: SignScope, o: Pick<SignedSend<unknown, R>, 'unsigned' | 'restore'>): Promise<R> {
    if (scope === 'lobby') {
      // Only a live socket can be told, and a login or resume under way
      // may be saying `default` on its own.
      if (beforeUnsigned(this.signLobby, conn) === 'tell' && conn.state === 'online') await this.tellSigns(conn);
      // Asked again: a request answered may have carried another
      // choice than this one, and the session moved on meanwhile.
      if (beforeUnsigned(this.signLobby, conn) !== 'send') {
        o.restore();
        throw new Error('Not sent: the server may still say you sign every lobby line.');
      }
    }
    return o.unsigned();
  }

  /** Turn signing every lobby line on or off, told to the server, and
   *  put back as the server has it if it refuses. What it is now. */
  private async setSignLobby(on: boolean, conn = this.conn): Promise<boolean> {
    this.signLobby = on;
    writeSigning('lobby', on);
    if (conn instanceof Connection && !(await this.tellSigns(conn))) {
      this.signLobby = conn.signing === 'default';
      writeSigning('lobby', this.signLobby);
    }
    return this.signLobby;
  }

  /** Bring the server's `signs` to this user's lobby choice, so the
   *  roster says it (§4.6): now on a live socket where the server echoed
   *  it, and otherwise at the next resume. False when the server refused
   *  it. */
  private async tellSigns(conn: Connection): Promise<boolean> {
    // A session says `signs` only where its device can sign, so either
    // value is its to say.
    if (!conn.signs) return true;
    const signs = this.signLobby ? 'default' : 'able';
    if (!conn.signing || conn.state !== 'online') {
      conn.signs = signs;
      return true;
    }
    try {
      await conn.setSigns(signs);
      return true;
    } catch (e) {
      // A socket lost meanwhile: the resume says it.
      if (!(e instanceof WireFailure)) return true;
      // Not restated at the next resume either.
      conn.signs = conn.signing ?? conn.signs;
      this.say(`The server could not be told whether you sign every lobby line: ${this.problem(e)}`);
      return false;
    }
  }

  /** Put a line that was not sent back where it was typed, unless
   *  something else has been typed since. */
  private restoreComposer(text: string, style: ChatStyle): void {
    if (this.composer.value) return;
    this.composer.value = style === 'action' ? `/me ${text}` : text;
    this.autoGrow();
  }

  /** The device a session proves, remembered with the tab for a resume,
   *  and what it says of signing, `undefined` for one that cannot sign. */
  private useDevice(url: string, device: StoredDevice | null): Signs | undefined {
    rememberSigningDevice(url, device?.devicePub ?? null);
    const signs = signsFor(device?.cert, this.signLobby);
    this.signer = signs && device?.cert ? { key: device.deviceSign, enc: device.deviceEnc, cert: device.cert } : null;
    this.proved = device?.cert ? (device.fingerprint ?? null) : null;
    this.messages.prove(this.proved, this.signer?.enc ?? null);
    return signs;
  }

  /** Check the host's key again, for what is signed and read from now.
   *  Nothing is signed while it is checked, a warning left open
   *  included, and every caller meanwhile waits on the one check. */
  private repin(): Promise<void> {
    this.repinning ??= (async () => {
      const [url, conn] = [this.keyUrl, this.conn];
      this.pinned = null;
      try {
        const pinned = await this.pinServerKey(url);
        if (url !== this.keyUrl || conn !== this.conn) return;
        this.pinned = pinned;
        this.lines.repin(pinned);
        this.articles.repin(pinned);
      } catch (e) {
        if (url !== this.keyUrl || conn !== this.conn) return;
        this.say(`This server's key could not be checked again, so nothing will be signed here: ${this.problem(e)}`);
        this.lines.repin(null);
        this.articles.repin(null);
      } finally {
        this.repinning = null;
      }
    })();
    return this.repinning;
  }

  /** After every chat line already read is shown. */
  private inOrder(fn: () => void | Promise<void>): void {
    this.shown = this.shown.then(fn).catch((e: unknown) => this.say(`A line could not be shown: ${this.problem(e)}`));
  }

  /** Blank lines a moderator redacted, those held among them. */
  private blank(ids: readonly number[]): void {
    const done = this.store.redactAll(ids);
    if (!done.blanked) return;
    for (const handle of done.handles) this.images.revoke(handle);
    if (this.store.active === LOBBY) keepingPlace(this.transcript, () => this.renderTranscript());
  }

  /** Why what is sent in `scope` goes unsigned with signing on there,
   *  or `null` when it is signed. */
  private whyUnsigned(conn: Connection, scope: SignScope): string | null {
    const what = SIGNED_WHAT[scope];
    // A signed line's id is its guid (hxd-ng's `docs/e2e-messages.md` §4.6).
    if (!conn.hasCap(CAP_SIGNED) || (scope === 'lobby' && !conn.hasCap(CAP_CHAT_GUID))) return `this server does not carry signed ${what}.`;
    if (!this.pinned) return "this server's key is not pinned.";
    if (!this.signer) return 'this session did not log in with a device whose certificate may sign messages.';
    if (!conn.signing) return `the server will not carry signed ${what} from this session.`;
    return null;
  }

  // --- attaching an image (docs/inline-media.md §8) ---------------------

  /**
   * Take a file and hold its handle for the next line.
   *
   * The upload happens now rather than at send time, for two reasons.
   * The server is the only thing that can say whether it will take these
   * bytes — it re-encodes them and may refuse the format, the size or
   * the rate — and finding that out at send time would lose the typed
   * message along with the picture. And a handle in hand makes the send
   * itself one small frame.
   */
  private async attach(file: File): Promise<void> {
    const conn = this.conn;
    if (!conn?.media) return;
    // The local check is for a fast, specific answer; the server checks
    // everything again and its answer is the one that counts.
    const blocked = mediaBlockedReason(file, conn.media);
    if (blocked) return this.say(blocked);
    // Whatever was attached is being replaced, which retires anything
    // still in flight for it as well as the chip.
    this.clearAttachment();
    const mine = this.uploads;
    this.showAttachment(null, file.name);
    try {
      const media = await conn.uploadMedia(file);
      // Removed, replaced, or the session ended while this was in the
      // air: the answer is no longer anybody's.
      if (mine !== this.uploads) return;
      this.attached = { media, name: file.name };
      this.showAttachment(media, file.name);
      this.composer.focus();
    } catch (e) {
      if (mine !== this.uploads) return;
      this.clearAttachment();
      this.say(e instanceof WireFailure ? errorText(e.wire) : (e as Error).message);
    }
  }

  private showAttachment(media: Media | null, name: string): void {
    const label = media
      ? `${name} — ${media.width}×${media.height}, ready to send`
      : `${name} — uploading…`;
    const remove = h('button', { class: 'ghost', title: 'Remove this image', ariaLabel: 'Remove this image' }, '✕');
    remove.onclick = () => this.clearAttachment();
    fill(this.attachChip, h('span', {}, label), remove);
    this.attachChip.hidden = false;
  }

  private clearAttachment(): void {
    this.attached = null;
    this.attachChip.hidden = true;
    this.filePicker.value = '';
    this.uploads++;
  }

  /** Put back an attachment a send did not manage to use. */
  private restoreAttachment(attached: { media: Media; name: string } | null): void {
    if (!attached) return;
    this.attached = attached;
    this.showAttachment(attached.media, attached.name);
  }

  private async command(raw: string): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const [word, ...rest] = raw.slice(1).split(' ');
    const arg = rest.join(' ');
    switch ((word ?? '').toLowerCase()) {
      case 'me':
        if (arg) await this.sendChat(arg, 'action');
        return;
      case 'msg': {
        const [who, ...words] = rest;
        if (!who) return this.say('Usage: /msg <nick or account> <text>');
        // A roster row if there is one, and otherwise the argument is
        // taken as an account name. That second case is the whole point
        // of `to_login`: it is how you write to somebody who is not here,
        // and how you answer mail that arrived while they were gone.
        const target = this.findUser(who);
        const conv = target
          ? this.store.openPm({ uid: target.uid, nick: target.nick })
          : this.store.openPm({ login: who, nick: who });
        this.select(conv.id);
        if (words.length) await this.send(words.join(' '));
        return;
      }
      case 'mail':
        return this.loadMail();
      case 'news':
        if (!conn.news) return this.say('This server has no news.');
        return this.showNews(true);
      case 'files':
        if (!conn.hasCap(CAP_FILES)) return this.say('This server has no file area.');
        return this.showFiles(true);
      case 'history':
        if (!conn.hasCap(CAP_HISTORY)) return this.say('This server does not keep chat history.');
        if (this.historyRefused) return this.say('This server will not show you its chat history.');
        if (this.store.active !== LOBBY) return this.say('Chat history belongs to the lobby.');
        if (this.store.historyExhausted) return this.say('That is the beginning of the conversation.');
        await this.loadHistory();
        return;

      // Blocking is account-level and outlives any session, which is why
      // it is worth doing from here rather than leaving it to an
      // operator: it is how you stop someone putting mail in your queue.
      case 'block':
      case 'unblock': {
        if (!arg) return this.say(`Usage: /${word} <nick, account or fingerprint>`);
        const on = word === 'block';
        // A nick on the roster names a uid, which is the only way to
        // block an identity admitted as a guest — they have a
        // fingerprint to hold it against but no login of their own.
        const target = this.findUser(arg);
        const who: BlockParams = target
          ? { uid: target.uid }
          : // A fingerprint names a block rather than a person, so only
            // `unblock` takes one.
            !on && isFingerprint(arg)
            ? { fingerprint: arg }
            : { login: arg };
        await (on ? conn.block(who) : conn.unblock(who));
        return this.say(
          on
            ? `Blocked ${target?.nick ?? arg}. They can no longer send you private messages.`
            : `Unblocked ${target?.nick ?? arg}.`,
        );
      }

      case 'blocks': {
        const { blocked } = await conn.blocks();
        if (!blocked.length) return this.say('You have not blocked anyone.');
        return this.say(
          `Blocked: ${blocked
            .map((b) => (b.fingerprint ? `${b.login} (${b.fingerprint.slice(0, 8)}…)` : b.login))
            .join(', ')}`,
        );
      }

      // Moderation, answered here rather than by `send`'s catch: these say
      // `no_such_user` for nobody by that name, and the message wording
      // that catch would use gets that wrong.
      case 'report':
      case 'kick':
      case 'ban':
      case 'purge':
        return this.moderationCommand(word!.toLowerCase(), rest).catch((e: unknown) => this.say(moderationProblem(e)));
      case 'accounts':
        if (!conn.accounts) return this.say('This server does not administer accounts.');
        if (!mayAdminister(conn.accounts)) return this.say('Your account may not read or make accounts.');
        return this.showAccounts(true);
      case 'reports':
        if (!conn.moderator) return this.say('Only a moderator reads the reports.');
        if (!conn.moderation) return this.say('This server keeps no reports.');
        return this.showReports(true);

      case 'nick':
        if (!arg) return this.say('Usage: /nick <name>');
        await conn.request('nick', { nick: arg });
        return;
      case 'icon': {
        const id = Number(arg);
        if (!Number.isInteger(id)) return this.say('Usage: /icon <number>');
        await conn.request('nick', { icon: id });
        return;
      }
      case 'drop':
        // The manual version of losing your network, so resume can be
        // exercised without unplugging anything.
        this.say(conn.classic ? 'Dropping the socket; a classic session ends with it.' : 'Dropping the socket; the session should resume.');
        conn.drop();
        return;
      case 'clear': {
        const conv = this.store.conversation(this.store.active);
        if (conv) conv.lines.length = 0;
        this.renderTranscript();
        return;
      }
      case 'close':
        this.closeConversation(this.store.active);
        return;
      case 'logout':
        await conn.logout();
        location.reload();
        return;
      case 'debug':
        this.debug.toggle();
        return;
      case 'help':
        return this.say(
          (conn.classic
            ? '/me · /msg <nick> <text> · /news · /files · '
            : '/me · /msg <nick or account> <text> · /history · /mail · /news · /files · /block <who> · /unblock <who> · /blocks · ' +
              '/report <who> [reason] · ') +
            (!conn.classic && (conn.moderator || this.store.self?.admin) ? '/kick <nick> [reason] · /ban <nick> <length> [reason] · ' : '') +
            (conn.moderator ? '/purge <who> [length] [reason] · /reports · ' : '') +
            (mayAdminister(conn.accounts) ? '/accounts · ' : '') +
            '/nick <name> · /icon <n> · /clear · /close · /drop · /debug · /logout',
        );
      default:
        return this.say(`Unknown command: /${word}`);
    }
  }

  /** `/report`, `/kick`, `/ban` and `/purge`: the menu's acts without
   *  the menu, and anything left out of the line asked for as the menu
   *  would. */
  private async moderationCommand(word: string, rest: string[]): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    switch (word) {
      case 'report': {
        const [who, ...why] = rest;
        if (!who) return this.say('Usage: /report <nick, account or fingerprint> [reason]');
        const target = this.findUser(who);
        const ref = personRef(who, target);
        const reason = why.join(' ').trim();
        if (!reason) return this.reportPerson(target?.nick ?? who, ref);
        return this.fileReport({ user: ref, reason });
      }
      case 'kick':
      case 'ban': {
        const [who, ...more] = rest;
        const usage = word === 'ban' ? 'Usage: /ban <nick> <10m, 2h, 3d, 1w…> [reason]' : 'Usage: /kick <nick> [reason]';
        if (!who) return this.say(usage);
        const target = this.findUser(who);
        if (!target) return this.say(`Nobody here is called ${who}.`);
        let ban: number | undefined;
        if (word === 'ban') {
          ban = parseDuration(more.shift() ?? '') ?? undefined;
          if (ban === undefined) return this.say(usage);
        }
        const reason = more.join(' ').trim();
        // A kick's reason is optional, so there is nothing to ask for:
        // what was typed is what is done. The menu is where a purge goes
        // with it.
        await conn.kick({ uid: target.uid, ...(ban ? { ban } : {}), ...(reason ? { reason } : {}) });
        return;
      }
      case 'purge': {
        const [who, ...more] = rest;
        const usage = 'Usage: /purge <nick, account or fingerprint> [10m, 2h, 3d…] [reason]';
        if (!who) return this.say(usage);
        const target = this.findUser(who);
        const since = more.length ? parseDuration(more[0]!) : null;
        if (since !== null) more.shift();
        const reason = more.join(' ').trim();
        return this.purge(target?.nick ?? who, personRef(who, target), { since: since ?? 3600, reason });
      }
    }
  }

  private findUser(needle: string): User | undefined {
    const byId = Number(needle);
    if (Number.isInteger(byId) && this.store.user(byId)) return this.store.user(byId);
    const lower = needle.toLowerCase();
    return this.store.roster().find((u) => u.nick.toLowerCase() === lower)
      ?? this.store.roster().find((u) => u.nick.toLowerCase().startsWith(lower));
  }

  // --- conversations ----------------------------------------------------

  private select(id: ConvId): void {
    const conv = this.store.conversation(id);
    if (!conv) return;
    this.store.active = id;
    // Closing the news reader sees what it uncovers, so this one goes
    // first: the conversation the reader was covering has still not
    // been looked at.
    if (this.newsOpen) this.showNews(false);
    else if (this.filesOpen) this.showFiles(false);
    else if (this.reportsOpen) this.showReports(false);
    else if (this.accountsOpen) this.showAccounts(false);
    else if (this.friendsOpen) this.showFriends(false);
    else this.seen(conv);
    this.noteTyping();
    this.renderRail();
    this.renderTranscript();
    this.renderComposerHint();
    this.composer.focus();
  }

  /** The reader is looking at this conversation now: its badge goes, and
   *  so does its share of the count in the title. */
  private seen(conv: Conversation): void {
    conv.unread = 0;
    this.renderUnreadTitle();
    this.flushReads(conv);
    // Reading is a thing the server keeps for us, so tell it — while
    // there is a session to tell. Failure is worth a line but not worth
    // interrupting the selection over.
    if (this.conn?.state !== 'online') return;
    this.markRead(conv).catch((e: Error) =>
      this.say(e instanceof WireFailure ? errorText(e.wire) : e.message),
    );
  }

  private closeConversation(id: ConvId): void {
    if (id === LOBBY) return;
    this.store.closePm(id);
    this.renderRail();
    this.renderTranscript();
    this.renderComposerHint();
  }

  // --- news -------------------------------------------------------------

  /** Swap the chat pane for the news reader, or back. The call bar and the
   *  video tiles sit above both, so a call carries on whichever is shown. */
  private showNews(open: boolean): void {
    if (open && this.filesOpen) this.showFiles(false);
    if (open && this.reportsOpen) this.showReports(false);
    if (open && this.accountsOpen) this.showAccounts(false);
    if (open && this.friendsOpen) this.showFriends(false);
    const was = this.newsOpen;
    this.newsOpen = open;
    // The conversation the reader covers stays the active one, and what
    // arrives in it while nobody can see it is unread like anywhere else.
    this.store.covered = open;
    this.raise(open ? 'news' : 'chat', open);
    if (this.tiling) this.news.shown(open);
    else this.news.show(open);
    // Coming back to it is looking at it, the same as picking it.
    const conv = this.store.conversation(this.store.active);
    if (was && !open && conv) this.seen(conv);
    this.renderRail();
  }

  /** Bring a pane to the front, whichever layout is up.
   *
   *  Tiled, these three are tabs of one leaf and raising one is the whole
   *  of the switch. Untiled, the shell is what it was and they take turns
   *  by hiding each other. The two cannot both write `hidden`: that is
   *  also what `available()` reads to decide a pane is not in this mode,
   *  so a chat pane the app hid would leave the layout entirely. */
  private raise(id: string, open: boolean): void {
    if (this.panes?.tiled()) this.panes.present(id, { focus: false });
    else this.chatPane.hidden = open;
  }

  /** Whether the layout is what decides who is on screen. */
  private get tiling(): boolean {
    return this.panes?.tiled() === true;
  }

  private showFiles(open: boolean): void {
    if (open && this.newsOpen) this.showNews(false);
    if (open && this.reportsOpen) this.showReports(false);
    if (open && this.accountsOpen) this.showAccounts(false);
    if (open && this.friendsOpen) this.showFriends(false);
    const was = this.filesOpen;
    this.filesOpen = open;
    this.store.covered = open;
    this.raise(open ? 'files' : 'chat', open);
    if (this.tiling) this.files.shown(open);
    else this.files.show(open);
    const conv = this.store.conversation(this.store.active);
    if (was && !open && conv) this.seen(conv);
    this.renderRail();
  }

  /** The moderator's reports, in the same space the readers take. */
  private showReports(open: boolean): void {
    if (open && this.newsOpen) this.showNews(false);
    if (open && this.filesOpen) this.showFiles(false);
    if (open && this.accountsOpen) this.showAccounts(false);
    if (open && this.friendsOpen) this.showFriends(false);
    const was = this.reportsOpen;
    this.reportsOpen = open;
    this.store.covered = open;
    this.raise(open ? 'reports' : 'chat', open);
    if (this.tiling) this.moderation.shown(open);
    else this.moderation.show(open);
    const conv = this.store.conversation(this.store.active);
    if (was && !open && conv) this.seen(conv);
    this.renderRail();
  }

  /** What this session's account may do changed: `conn.accounts` is
   *  already what it may do now. */
  private onAccountChanged(): void {
    const may = mayAdminister(this.conn?.accounts ?? null);
    this.panes?.available('accounts', may);
    if (!may && this.accountsOpen) this.showAccounts(false);
    this.accountsView.refresh();
    this.files.refresh();
    this.renderRail();
  }

  /** The account editor, in the same space the readers take. */
  private showAccounts(open: boolean): void {
    if (open && this.newsOpen) this.showNews(false);
    if (open && this.filesOpen) this.showFiles(false);
    if (open && this.reportsOpen) this.showReports(false);
    if (open && this.friendsOpen) this.showFriends(false);
    const was = this.accountsOpen;
    this.accountsOpen = open;
    this.store.covered = open;
    this.raise(open ? 'accounts' : 'chat', open);
    if (this.tiling) this.accountsView.shown(open);
    else this.accountsView.show(open);
    const conv = this.store.conversation(this.store.active);
    if (was && !open && conv) this.seen(conv);
    this.renderRail();
  }

  /** Friends and message requests, in the same space the readers take. */
  private showFriends(open: boolean): void {
    if (open && this.newsOpen) this.showNews(false);
    if (open && this.filesOpen) this.showFiles(false);
    if (open && this.reportsOpen) this.showReports(false);
    if (open && this.accountsOpen) this.showAccounts(false);
    const was = this.friendsOpen;
    this.friendsOpen = open;
    this.store.covered = open;
    this.raise(open ? 'friends' : 'chat', open);
    if (this.tiling) this.friends.shown(open);
    else this.friends.show(open);
    const conv = this.store.conversation(this.store.active);
    if (was && !open && conv) this.seen(conv);
    this.renderRail();
  }

  /** An instant message (§7.5), shown in the conversation with its
   *  sender as a private message is, acknowledged once it is and told
   *  read once it is on screen. One whose guid and sender were shown
   *  already is a repeat, acknowledged again and not shown. */
  private onIm(d: Events['im']): void {
    const conn = this.conn;
    const login = d.from.login;
    const ack = () => void conn?.receipt(login, d.guid).catch(() => {});
    const key = `${login.toLowerCase()} ${d.guid}`;
    if (this.imSeen.has(key) || (d.id !== undefined && this.store.hasMail(d.id))) return ack();
    this.imSeen.add(key);
    if (d.approval) this.friends.noteApproval(login);
    this.checkClock(d.at, d.queued);
    const messages = this.messages;
    const as: Events['msg'] = {
      from: { uid: 0, nick: d.from.nick, login, ...(d.from.fingerprint !== undefined ? { fingerprint: d.from.fingerprint } : {}) },
      text: d.text,
      at: d.at,
      queued: d.queued,
      ...(d.id !== undefined ? { id: d.id } : {}),
      ...(d.signed !== undefined ? { signed: d.signed } : {}),
    };
    const read = messages.live(as, undefined).catch(() => unreadable(d.signed));
    this.inOrder(async () => {
      const { signature, duplicate } = await read;
      if (messages !== this.messages || conn !== this.conn) return;
      if (duplicate) return ack();
      const friend = this.friends.book.get(login);
      const conv = this.store.openPm({ login, nick: friend?.alias ?? d.from.nick });
      this.setTyping(conv, false);
      this.push(conv.id, {
        t: d.at * 1000,
        kind: 'chat',
        from: { nick: d.from.nick, login },
        text: d.text,
        queued: d.queued,
        id: d.id,
        guid: d.guid,
        ...(signature ? { signature } : {}),
        ...(d.signed !== undefined ? { signed: d.signed } : {}),
      });
      ack();
      const seen = sighting(signature, this.verifiedUnder(conv), d.from);
      if (seen) void rememberIdentity(conv, this.peerMemory, this.keyUrl, seen.fingerprint, seen.who, {});
      this.pendingReads.set(conv.id, [...(this.pendingReads.get(conv.id) ?? []), d.guid]);
      if (conv.id === this.store.active && !this.store.covered && document.visibilityState === 'visible') this.flushReads(conv);
      this.renderRail();
    });
  }

  /** A friend's typing flag, which lapses unless it is said again. */
  private setTyping(conv: Conversation, on: boolean): void {
    clearTimeout(this.typingShown.get(conv.id));
    this.typingShown.delete(conv.id);
    if (on) this.typingShown.set(conv.id, window.setTimeout(() => this.setTyping(conv, false), TYPING_SHOWN_MS));
    if (conv.typing === on) return;
    conv.typing = on;
    if (conv.id === this.store.active) this.renderComposerHint();
  }

  /** By login, where that is an instant message or mail. A present
   *  non-friend, under no approval, by uid: by login it would go as a
   *  message request, or be refused (§7.5). */
  private addressFor(conv: Conversation): ReturnType<typeof messageAddress> {
    return messageAddress(conv, {
      takesPart: this.conn?.messaging?.takes_part === true,
      present: (uid) => this.store.user(uid) !== undefined,
      mayIm: (login) => this.friends.mayIm(login),
    });
  }

  /** Tell a friend which of their messages are now read. */
  /** A receipt lost with a socket that may resume waits for the resume;
   *  one the server refused, or one for a session since gone, does not. */
  private flushReads(conv: Conversation): void {
    const conn = this.conn;
    const guids = this.pendingReads.get(conv.id);
    const login = conv.peer.login;
    if (!guids || !login || conn?.state !== 'online') return;
    const session = conn.session;
    this.pendingReads.delete(conv.id);
    for (const guid of guids) {
      void conn.receipt(login, guid, true).catch((e: unknown) => {
        if (e instanceof WireFailure || this.conn !== conn || conn.session !== session) return;
        this.pendingReads.set(conv.id, [...(this.pendingReads.get(conv.id) ?? []), guid]);
      });
    }
  }

  /** Tell the friend this conversation is with whether a message to them
   *  is being written: on each change, and again while it goes on, since
   *  the flag lapses, until a pause in the typing as long as the
   *  renewal. `stop` for that pause, leaving, the page or the tab. */
  private noteTyping(stop = false): void {
    const conn = this.conn;
    const conv = this.store.conversation(this.store.active);
    const login = conv?.kind === 'pm' ? conv.peer.login : undefined;
    const text = this.composer.value.trim();
    const to = !stop && login && text && !text.startsWith('/') && this.friends.book.isFriend(login) ? login : null;
    if (this.typingIdle !== null) clearTimeout(this.typingIdle);
    this.typingIdle = to ? window.setTimeout(() => this.noteTyping(true), TYPING_RENEW_MS) : null;
    if (to === this.typingTo) return;
    if (this.typingTo) void conn?.typing(this.typingTo, false).catch(() => {});
    if (this.typingRenew !== null) clearInterval(this.typingRenew);
    this.typingRenew = null;
    if (to) {
      const say = () => void conn?.typing(to, true).catch(() => {});
      say();
      this.typingRenew = window.setInterval(say, TYPING_RENEW_MS);
    }
    this.typingTo = to;
  }

  /** Something in the news is yours: count it on the rail, and say so
   *  in the conversation on screen, as a line that opens the article —
   *  unless the reader has that thread in front of them already. */
  private onNewsNotify(d: Events['news_notify']): void {
    const onScreen = this.news.onNotify(d);
    this.renderRail();
    if (onScreen) return;
    this.push(this.store.active, {
      // When it was posted, as for chat; a replayed one is not new.
      t: Number.isFinite(d.at) ? d.at * 1000 : Date.now(),
      kind: 'notice',
      text: notifyText(d),
      article: d.article,
    });
  }

  private openNewsArticle(id: number): void {
    if (!this.conn?.news) return;
    this.showNews(true);
    this.news.openArticle(id);
  }

  // --- moderation (hxd-ng's docs/moderation.md) -----------------------

  /** Report a line from where it is drawn. */
  private async reportLine(line: Line, conv: Conversation): Promise<void> {
    const target = lineReport(line, conv, this.store.self, (uid) => this.store.user(uid) !== undefined);
    if (!target) return;
    const who = signedName(line.signature, line.from?.nick ?? '').name || 'someone';
    const pasted = 'user' in target && target.user !== undefined;
    const reason = await this.reportReason(
      `Report ${who}’s ${conv.kind === 'lobby' ? 'line' : 'message'}`,
      line.sealed && line.signed === undefined
        ? 'It was sealed deniably, so it carries no signature: the words go with your report as your account of them, and the moderators cannot check that they were sent.'
        : pasted
          ? 'The server kept no copy of it, so the words go with your report as your account of them.'
          : conv.kind === 'lobby'
            ? 'The moderators are shown the line.'
            : 'The moderators are shown the message: reporting it is you choosing to show them.',
    );
    if (reason === null) return;
    await this.fileReport({ ...target, reason } as ReportParams);
  }

  private async redactLine(line: Line): Promise<void> {
    const conn = this.conn;
    if (!conn || line.id === undefined) return;
    const a = await ask({
      title: `Redact ${line.from?.nick ? `${line.from.nick}’s` : 'this'} line`,
      body: `Its words go from every client and from history${line.media ? ', and the image it carried with them' : ''}. The line keeps its place, blank.`,
      fields: [{ kind: 'text', name: 'reason', label: 'Reason', required: true, max: 512 }],
      ok: 'Redact',
      danger: true,
    });
    if (!a) return;
    // Nothing is blanked here: `chat_redacted` does that, for this
    // client as for everyone else.
    await conn.redact(line.id, String(a.reason));
  }

  private async reportReason(title: string, body: string): Promise<string | null> {
    const a = await ask({
      title,
      body,
      fields: [{ kind: 'textarea', name: 'reason', label: 'What is wrong with it', required: true, max: 1024 }],
      ok: 'Report',
    });
    return a ? String(a.reason) : null;
  }

  private async fileReport(params: ReportParams): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const ok = await conn.report(params);
    this.say(
      ok.outcome === 'removed'
        ? 'Thank you — that has already been removed.'
        : ok.follow_up
          ? `Report #${ok.id} is with the moderators. You will hear how it ends.`
          : `Report #${ok.id} is with the moderators. A guest has no mailbox, so you will not hear how it ends.`,
    );
  }

  /** What can be done to someone on the roster, besides writing to them. */
  private async personMenu(u: User): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    // The kick is the kick bit's, which the roster does not show this
    // client about itself; an administrator or a moderator is offered
    // it, and the server has the last word.
    // Not on a classic server, which has no reports and whose kick this
    // client does not send yet.
    // The server's own account is beyond all three, and a linked server's
    // user beyond a report or a purge here, which cannot cross the link.
    const mayKick = !conn.classic && !u.system && (conn.moderator || this.store.self?.admin === true);
    const local = !conn.classic && !u.system && !u.remote;
    const fp = u.identity?.fingerprint && fingerprintFromString(u.identity.fingerprint) ? u.identity.fingerprint : null;
    const choice = await choose(u.nick, [
      ['message', 'Send a private message'],
      ...(fp ? [['compare', 'Compare fingerprint'] as ['compare', string]] : []),
      ...(local ? [['report', 'Report to the moderators…'] as ['report', string]] : []),
      ...(mayKick ? [['kick', 'Disconnect…', true] as ['kick', string, boolean]] : []),
      ...(local && conn.moderator ? [['purge', 'Purge recent output…', true] as ['purge', string, boolean]] : []),
    ]);
    try {
      if (choice === 'message') {
        this.select(this.store.openPm({ uid: u.uid, nick: u.nick }).id);
        this.showRoster(false);
      } else if (choice === 'compare') await this.openContacts({ fingerprint: fp!, nick: u.nick });
      else if (choice === 'report') await this.reportPerson(u.nick, { uid: u.uid });
      else if (choice === 'kick') await this.kick(u);
      else if (choice === 'purge') await this.purge(u.nick, { uid: u.uid });
    } catch (e) {
      this.say(moderationProblem(e));
    }
  }

  private async reportPerson(name: string, who: PersonRef): Promise<void> {
    const reason = await this.reportReason(`Report ${name}`, 'The moderators are told who, and your reason is the whole of the evidence.');
    if (reason === null) return;
    await this.fileReport({ user: who, reason });
  }

  private async kick(u: User): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const lengths = DURATIONS.map(([sec, words]) => [String(sec), words] as [string, string]);
    const a = await ask({
      title: `Disconnect ${u.nick}`,
      body: 'The room is told who did it.',
      fields: [
        { kind: 'choice', name: 'ban', label: 'And ban them for', options: [['', 'no ban — they may come back'], ...lengths] },
        ...(conn.moderator
          ? [{ kind: 'choice', name: 'purge', label: 'Taking their output from the last', options: [['', 'nothing — leave what they said'], ...lengths.slice(0, 4)] } satisfies Field]
          : []),
        { kind: 'text', name: 'reason', label: 'Reason', max: 512 },
      ],
      ok: 'Disconnect',
      danger: true,
    });
    if (!a) return;
    const reason = String(a.reason ?? '');
    const purge = a.purge ? Number(a.purge) : undefined;
    // The server's rule, said before asking rather than after: a purge is
    // an act, and every act is on the record with a reason.
    if (purge && !reason) return this.say('A purge needs a reason. Nothing was done.');
    await conn.kick({
      uid: u.uid,
      ...(a.ban ? { ban: Number(a.ban) } : {}),
      ...(purge ? { purge } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  private async purge(name: string, who: PersonRef, preset: { since?: number; reason?: string } = {}): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    let since = preset.since;
    let reason = preset.reason;
    if (since === undefined || !reason) {
      const a = await ask({
        title: `Purge ${name}`,
        body: 'Their public lines, images and news articles from the window go, from every client and from history, under one record.',
        fields: [
          { kind: 'choice', name: 'since', label: 'From the last', options: DURATIONS.map(([sec, w]) => [String(sec), w]), value: String(since ?? 3600) },
          { kind: 'text', name: 'reason', label: 'Reason', required: true, max: 512, value: reason ?? '' },
        ],
        ok: 'Purge',
        danger: true,
      });
      if (!a) return;
      since = Number(a.since);
      reason = String(a.reason);
    }
    const done = await conn.purge({ ...who, since, reason });
    this.say(
      `Purged ${name}'s last ${durationWords(since)}: ${done.lines} ${done.lines === 1 ? 'line' : 'lines'}, ` +
        `${done.media} ${done.media === 1 ? 'image' : 'images'}, ${done.articles} ${done.articles === 1 ? 'article' : 'articles'}.`,
    );
  }

  // --- public chat history ---------------------------------------------

  /** A page of history as lines, each signature read and a copy of a
   *  signed line already here left out. */
  private async historyLines(ok: HistoryOk): Promise<Line[] | null> {
    const lines = this.lines;
    const reads = await Promise.all(
      ok.lines.map((line) => (line.deleted ? null : lines.history(line).catch(() => unreadable(line.signed)))),
    );
    // Read for a session since replaced: its page is not this one's.
    if (lines !== this.lines) return null;
    // Paging still moves past what is left out.
    this.store.skipHistory(ok.lines.filter((_, i) => reads[i]?.duplicate).map((line) => line.id));
    return ok.lines.flatMap((line, i): Line[] => {
      const read = reads[i];
      if (read?.duplicate) return [];
      return [
        {
          t: line.at * 1000,
          kind: line.deleted ? 'deleted' : styleToKind(line.style),
          from: line.deleted
            ? undefined
            : { nick: line.from.nick, icon: line.from.icon },
          text: line.deleted ? 'Message deleted.' : line.text,
          id: line.id,
          deleted: line.deleted,
          media: line.media,
          ...(read?.signature ? { signature: read.signature } : {}),
          ...(line.signed !== undefined ? { signed: line.signed } : {}),
        },
      ];
    });
  }

  /** Check the host's key against its pin before anything is signed
   *  there (hxd-ng's `docs/e2e-messages.md` §4.13). A followed handover
   *  moves the pin with a note; a key changed any other way waits for
   *  the user, and until they accept it nothing is signed. */
  private async pinServerKey(url: string): Promise<PinnedKey | null> {
    let check: ServerKeyCheck | null;
    try {
      check = await checkHostKey(url);
    } catch (e) {
      if (this.signLobby || e instanceof KeyWithdrawn) {
        this.say(`This server's key could not be checked, so nothing will be signed here: ${this.problem(e)}`);
      }
      return null;
    }
    if (!check) return null;
    let outcome = check.outcome;
    if (outcome.outcome === 'follow') {
      this.say('This server has moved to the new key it announced in advance. Lines signed under its old key still count as said here.');
    }
    if (outcome.outcome === 'warn') {
      // Before a login, as the login will say it.
      const conn = this.conn instanceof Connection && this.conn.state === 'online' ? this.conn : null;
      const held = conn ? beforeUnsigned(this.signLobby, conn) === 'ask' : this.signLobby;
      const yes = await ask({
        title: "This server's key has changed",
        body:
          'The server at this address now proves a different key from the one this browser remembers, without a handover from the old one. ' +
          'That can be a lost or rotated key, or someone else answering in its place. ' +
          'Until you accept the new key, this client signs nothing here and checks no signature against it' +
          (held ? ', and your lobby lines are held until you accept it or stop signing them.' : '.'),
        fields: [],
        ok: 'Accept the new key',
        danger: true,
      });
      if (yes === null) {
        this.say('Not accepting the new server key: nothing will be signed here this session.');
        return null;
      }
      outcome = await check.accept();
      if (outcome.outcome === 'warn') {
        this.say('The new server key could not be accepted, so nothing will be signed here this session.');
        return null;
      }
    }
    return check.pinned();
  }

  /** Load the newest public page at login, then page backwards whenever
   *  the reader reaches the top. Redrawing after a prepend changes the
   *  scroll height, so move the viewport by exactly that delta rather
   *  than making the line under their eyes jump. */
  private async loadHistory(opts: { initial?: boolean } = {}): Promise<void> {
    const conn = this.conn;
    if (!conn || this.historyLoading || this.historyRefused || !conn.hasCap(CAP_HISTORY)) return;
    // Asking a socket that is down only ever answers "not connected",
    // and the scroll handler would ask again on the next scroll.
    if (conn.state !== 'online') return;
    if (!opts.initial && this.store.historyExhausted) return;

    this.historyLoading = true;
    try {
      const before = opts.initial ? undefined : this.store.oldestHistoryId;
      const page = await conn.history(before === undefined ? {} : { before });
      const lines = await this.historyLines(page);
      if (!lines) return;
      // Measured here rather than before the request: a live line
      // arriving while it was in flight has already changed the height,
      // and counting that as part of the prepend is the jump this
      // arithmetic exists to prevent.
      const oldHeight = this.transcript.scrollHeight;
      const oldTop = this.transcript.scrollTop;
      const added = this.store.mergeHistory(lines, page.has_more, 'older');
      if (added && this.store.active === LOBBY) {
        this.renderTranscript();
        if (!opts.initial) {
          this.transcript.scrollTop = oldTop + this.transcript.scrollHeight - oldHeight;
        }
      }
      this.blank([...this.redacted]);
    } catch (e) {
      // A refusal is about this account and this server, not about this
      // request: remember it rather than rediscovering it every time
      // the reader reaches the top. At login it is not worth
      // interrupting anyone over — the transcript simply starts empty.
      if (e instanceof WireFailure && HISTORY_REFUSALS.has(e.wire.code)) {
        this.historyRefused = true;
        if (opts.initial) return;
      }
      throw e;
    } finally {
      this.historyLoading = false;
    }
  }

  // --- mail -------------------------------------------------------------

  /**
   * Fold a page of stored messages into the conversations they belong
   * to, and report how many were new.
   *
   * Deduplicated on the store's id, because mail reaches this client two
   * ways by design: the login flush pushes `msg` events for what is
   * unread, and `inbox` lists the same rows. Neither is redundant — the
   * flush is capped by `deliver_at_flush` and the list is not — so both
   * run and this is where they meet.
   *
   * Appended rather than merged by timestamp. These are older than what
   * is on screen and it shows, which is why they are marked `queued`: a
   * line stamped Tuesday sitting under one from just now is better than
   * a client that quietly reorders a transcript.
   */
  private async mergeStoredMail(ok: InboxOk): Promise<number> {
    let added = 0;
    // `inbox` lists newest first; put them back in the order they were
    // sent, and read them in it, so within a page the first of two
    // copies is the earlier (§3.6). A page read for a session since
    // replaced is not this one's.
    const sent = [...ok.messages].reverse();
    const messages = this.messages;
    const reads = await Promise.all(sent.map((m) => messages.stored(m).catch(() => unreadable(m.signed))));
    if (messages !== this.messages) return 0;
    for (const [i, m] of sent.entries()) {
      if (this.store.hasMail(m.id)) continue;
      if (reads[i]?.duplicate) {
        this.store.skipMail({ login: m.from.login }, m.id);
        continue;
      }
      const conv = this.store.openPm({ login: m.from.login, nick: m.from.nick });
      const signature = reads[i]?.signature;
      // The server knows whether this was read, possibly by another
      // client on the same account. Recovering it must not raise a badge
      // over mail its owner has already dealt with.
      this.push(
        conv.id,
        {
          t: m.at * 1000,
          kind: 'chat',
          from: { uid: 0, nick: m.from.nick, login: m.from.login },
          text: m.text,
          queued: true,
          id: m.id,
          // Live `msg` events carry this; a page of the mailbox has to
          // as well, or a private image disappears on reload and on
          // every older page.
          media: m.media,
          ...(signature ? { signature } : {}),
          ...(m.signed !== undefined ? { signed: m.signed } : {}),
          ...this.clearMark(),
        },
        !m.read,
      );
      added++;
    }
    this.store.notePage(ok);
    this.renderRail();
    this.renderMail();
    return added;
  }

  /**
   * Pull a page of the mailbox: the newest on the first call, then
   * backwards from the oldest already held.
   *
   * `initial` is the quiet one that runs at login — it says nothing when
   * there was nothing, because "no mail" is not news. Every other call
   * came from someone asking, and a request that produces no visible
   * change has to say why.
   */
  private async loadMail(opts: { initial?: boolean } = {}): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    if (!conn.hasCap(CAP_INBOX)) return this.say('This server does not keep private messages.');
    const before = opts.initial ? undefined : this.store.oldestMailId;
    if (!opts.initial && this.store.mailExhausted) {
      return this.say('That is the whole mailbox — there is nothing older.');
    }
    try {
      const page = await conn.inbox(before === undefined ? {} : { before });
      // `mergeStoredMail` records the page — the cursor moved either way,
      // so asking again goes further back even when nothing here was new.
      const added = await this.mergeStoredMail(page);
      if (opts.initial) {
        if (added) {
          this.say(
            `${added} stored ${added === 1 ? 'message' : 'messages'} loaded from your mailbox.`,
          );
        }
      } else if (added) {
        this.say(`Loaded ${added} earlier ${added === 1 ? 'message' : 'messages'}.`);
      } else if (this.store.mailExhausted) {
        this.say('That is the whole mailbox — there is nothing older.');
      } else {
        this.say('Nothing new in that page; ask again to go further back.');
      }
    } catch (e) {
      // `no_inbox` is the ordinary answer for a guest: the server keeps
      // mail, this account has nowhere to keep any. Not worth
      // interrupting anyone over at login — but the badge the login
      // reply invited us to draw is now known to be meaningless, so take
      // it down rather than leaving a control that only ever errors.
      if (e instanceof WireFailure && e.wire.code === 'no_inbox') {
        this.store.mail = null;
        this.renderMail();
        if (opts.initial) return;
      }
      throw e;
    }
  }

  /**
   * Tell the server we have read this conversation.
   *
   * `msg_read` is a cursor across the whole mailbox rather than a
   * per-conversation mark: `up_to` marks everything of ours below that
   * id, whoever sent it. That is the wire's design and it is why the
   * unread count this client shows is the server's one number and not a
   * per-thread tally — a per-thread badge would drift the moment you
   * opened the newest thread first.
   */
  private async markRead(conv: Conversation): Promise<void> {
    const conn = this.conn;
    if (!conn || conv.kind !== 'pm' || !this.store.mail) return;
    let top = 0;
    // Only mail we received has an id worth marking, a copy left out as
    // a duplicate included; our own half of the conversation is local
    // and never had one.
    for (const id of conv.mailIds) if (id > top) top = id;

    const claim = this.readCursor.claim(top);
    if (!claim) return;
    try {
      const counts = await conn.msgRead(claim.to);
      // Only the newest mark may write the answer: an older reply
      // arriving late says nothing true about where the mailbox stands.
      if (!claim.owns()) return;
      this.store.mail = counts;
      this.renderMail();
    } catch (e) {
      // Nothing was marked, so stop claiming it was — otherwise one
      // failure silently retires every id below it for the session.
      claim.release();
      throw e;
    }
  }

  private renderMail(): void {
    const mail = this.store.mail;
    this.mailBtn.hidden = mail === null;
    if (!mail) return;
    fill(
      this.mailBtn,
      h('span', {}, 'Mail'),
      mail.unread ? badge(mail.unread) : null,
    );
    this.mailBtn.classList.toggle('unread', mail.unread > 0);
    this.mailBtn.title = this.store.mailExhausted
      ? `${mail.unread} unread of ${mail.total} stored — all of it is loaded`
      : `${mail.unread} unread of ${mail.total} stored. Click to load earlier messages.`;
    this.paintMenuUnread();
  }

  private push(id: ConvId, line: Line, fresh = true): void {
    const conv = this.store.add(id, line, fresh);
    if (!conv) return;
    const fp = conv.kind === 'pm' ? lineFingerprint(line) : null;
    if (fp) this.adoptIdentity(conv, fp);
    if (id === this.store.active) {
      // Appending one line assumes the DOM still matches the array it was
      // drawn from. A merge rewrites that array, so redraw instead.
      if (this.store.revision !== this.drawnRevision) this.renderTranscript();
      else appendLine(this.transcript, line, conv, this.store, this.images, this.transcriptOptions());
      const mine = line.from?.uid !== undefined && line.from.uid === this.store.self?.uid;
      if (fresh && !mine && !this.store.covered) {
        this.heard.append(h('p', {}, spoken(line, this.contactOf())));
        while (this.heard.childElementCount > 20) this.heard.firstElementChild?.remove();
      }
    }
    // The active conversation's badge moves too while the news reader
    // covers it.
    if (id !== this.store.active || this.store.covered) this.renderRail();
    this.renderUnreadTitle();
  }

  /** A message in a conversation under `fp`, as `adoption` has it,
   *  warned of once a connection; only the user's word moves the
   *  conversation, when the next sealed one goes. */
  private adoptIdentity(conv: Conversation, fp: string): void {
    const ids = conversationIdentity(conv, this.peerMemory, this.keyUrl);
    if (adoption(ids, fp) === 'adopt') return void (conv.verified = fp);
    const was = (ids.known ?? ids.hint)!;
    const warned = `${conv.id} ${was} ${fp}`;
    if (this.identityWarned.has(warned)) return;
    this.identityWarned.add(warned);
    this.push(conv.id, {
      t: Date.now(),
      kind: 'system',
      local: true,
      text:
        this.comparedWarning(conv, was) +
        `${conv.title} was last seen here under the identity ${was.slice(0, 16)}, but that message is under ${fp.slice(0, 16)}. ` +
        'Nothing is sealed or signed to the second unless you agree to it when you next send one. If you did not expect a new key, check it with them another way.',
    });
  }

  /** Something this client wants to say about itself. */
  private say(text: string): void {
    this.push(this.store.active, { t: Date.now(), kind: 'system', text, local: true });
  }

  /** This clock against the server's `at` on what it relays (§3.10),
   *  warned of once a connection past the skew allowance: a sealed
   *  message's freshness is judged by this clock alone, and is never set
   *  from the server's. One that arrives just after a resume may have
   *  waited, and one that is queued did, so only an `at` ahead of this
   *  clock counts then. */
  private checkClock(at: number, queued = false): void {
    if (this.clockWarned) return;
    const off = Date.now() / 1000 - at;
    const waited = queued || Date.now() - this.resumedAt < RESUME_REPLAY_MS;
    if (off > -SIGNED_SKEW_SECONDS && (off < SIGNED_SKEW_SECONDS || waited)) return;
    this.clockWarned = true;
    const minutes = Math.round(Math.abs(off) / 60);
    this.say(
      `This device's clock is about ${minutes} minutes ${off > 0 ? 'ahead of' : 'behind'} the server's. ` +
        'Sealed messages are judged by this clock, so some may not be shown until it is set right.',
    );
  }

  // --- rendering --------------------------------------------------------

  private renderAll(): void {
    this.renderTopbar();
    this.renderRail();
    this.renderRoster();
    this.renderTranscript();
    this.renderCallbar();
    this.renderPill();
    this.renderMe();
    this.renderMail();
    this.renderComposerHint();
  }

  private renderTopbar(): void {
    this.serverName.textContent = this.store.server.name || this.config.title;
    this.subject.textContent = this.store.server.subject || '';
    this.subject.hidden = !this.store.server.subject;
  }

  private renderPill(detail?: string): void {
    const conn = this.conn;
    const state = conn?.state ?? 'offline';
    const label =
      state === 'online'
        ? conn?.rtt !== null && conn?.rtt !== undefined
          ? `online · ${conn.rtt} ms`
          : 'online'
        : state === 'reconnecting'
          ? 'reconnecting'
          : state === 'connecting'
            ? 'connecting'
            : 'offline';
    this.pill.className = `pill ${state}`;
    // The label is hidden on a phone, where the coloured dot is the whole
    // message and the title bar has no room for the rest of it.
    fill(this.pill, h('span', { class: 'pill-label' }, label));
    this.pill.title = detail ?? (conn?.grace ? `Grace window: ${conn.grace}s` : 'This account cannot detach');
  }

  private renderMe(): void {
    const me = this.store.self;
    if (!me) return;
    fill(this.meButton, face(me, 2), h('span', { class: 'nick' }, me.nick));
  }

  private renderRail(): void {
    const items = [...this.store.conversations.values()].map((c) => {
      const active =
        !this.newsOpen && !this.filesOpen && !this.reportsOpen && !this.accountsOpen && !this.friendsOpen && c.id === this.store.active;
      // Only a conversation whose other half is on the roster has a face
      // to show. One carried by an account alone — mail from someone who
      // is not here — falls back to the default icon.
      const peer = c.peer.uid !== undefined ? this.store.user(c.peer.uid) : undefined;
      const el = h(
        'button',
        {
          class: `rail-item${active ? ' on' : ''}${c.unread ? ' unread' : ''}`,
          ariaCurrent: active ? 'page' : null,
          dataset: { key: `c:${c.id}` },
        },
        c.kind === 'lobby'
          ? h('span', { class: 'rail-glyph', ariaHidden: 'true' }, '#')
          : peer
            ? face(peer, 1)
            : icon(128, 1),
        h('span', { class: 'rail-title' }, c.title),
        c.kind === 'pm' && this.sealsDeniably(c) ? h('span', { class: 'rail-tag' }, 'deniable') : null,
        c.unread ? badge(c.unread) : null,
      );
      el.onclick = () => this.select(c.id);
      if (c.kind !== 'pm') return el;
      // Beside the conversation's button rather than in it, where it
      // could be neither focused nor told apart from it.
      const close = h(
        'button',
        {
          class: 'rail-close',
          title: 'Close',
          ariaLabel: `Close the conversation with ${c.title}`,
          dataset: { key: `x:${c.id}` },
        },
        '×',
      );
      close.onclick = () => this.closeConversation(c.id);
      return h('div', { class: 'rail-pm' }, el, close);
    });
    // News sits under the lobby: it is the server's, like the lobby, and
    // not a conversation with anyone. Only where the server has some and
    // the session is still there to read it through.
    const conn = this.conn;
    let news: HTMLElement | null = null;
    if (conn?.news && conn.state !== 'offline') {
      // The badge counts what is followed, from `news_notify` and the
      // server's own totals — never `news_posted`, which every reader
      // gets for every post.
      const unread = this.news.unread;
      news = h(
        'button',
        {
          class: `rail-item${this.newsOpen ? ' on' : ''}${unread ? ' unread' : ''}`,
          title: unread ? `${unread} unread in what you follow` : 'News',
          ariaCurrent: this.newsOpen ? 'page' : null,
          dataset: { key: 'news' },
        },
        h('span', { class: 'rail-glyph', ariaHidden: 'true' }, '¶'),
        h('span', { class: 'rail-title' }, 'News'),
        unread ? badge(unread) : null,
      );
      news.onclick = () => this.showNews(true);
    }
    let files: HTMLElement | null = null;
    if (conn?.hasCap(CAP_FILES) && conn.state !== 'offline') {
      files = h(
        'button',
        {
          class: `rail-item${this.filesOpen ? ' on' : ''}`,
          title: 'Files',
          ariaCurrent: this.filesOpen ? 'page' : null,
          dataset: { key: 'files' },
        },
        h('span', { class: 'rail-glyph', ariaHidden: 'true' }, '▤'),
        h('span', { class: 'rail-title' }, 'Files'),
      );
      files.onclick = () => this.showFiles(true);
    }
    let friends: HTMLElement | null = null;
    if (conn?.messaging?.takes_part && conn.state !== 'offline') {
      const waiting = this.friends.count;
      friends = h(
        'button',
        {
          class: `rail-item${this.friendsOpen ? ' on' : ''}${waiting ? ' unread' : ''}`,
          title: waiting ? `${waiting} waiting for an answer` : 'Friends',
          ariaCurrent: this.friendsOpen ? 'page' : null,
          dataset: { key: 'friends' },
        },
        h('span', { class: 'rail-glyph', ariaHidden: 'true' }, '@'),
        h('span', { class: 'rail-title' }, 'Friends'),
        waiting ? badge(waiting, 'waiting') : null,
      );
      friends.onclick = () => this.showFriends(true);
    }
    let reports: HTMLElement | null = null;
    if (conn?.moderator && conn.moderation && conn.state !== 'offline') {
      const open = this.moderation.queue.count;
      reports = h(
        'button',
        {
          class: `rail-item${this.reportsOpen ? ' on' : ''}${open ? ' unread' : ''}`,
          title: open ? `${open} ${open === 1 ? 'report' : 'reports'} waiting` : 'Reports',
          ariaCurrent: this.reportsOpen ? 'page' : null,
          dataset: { key: 'reports' },
        },
        h('span', { class: 'rail-glyph', ariaHidden: 'true' }, '⚑'),
        h('span', { class: 'rail-title' }, 'Reports'),
        open ? badge(open, 'waiting') : null,
      );
      reports.onclick = () => this.showReports(true);
    }
    let accounts: HTMLElement | null = null;
    if (conn && mayAdminister(conn.accounts) && conn.state !== 'offline') {
      accounts = h(
        'button',
        {
          class: `rail-item${this.accountsOpen ? ' on' : ''}`,
          title: 'Accounts',
          ariaCurrent: this.accountsOpen ? 'page' : null,
          dataset: { key: 'accounts' },
        },
        h('span', { class: 'rail-glyph', ariaHidden: 'true' }, '☺'),
        h('span', { class: 'rail-title' }, 'Accounts'),
      );
      accounts.onclick = () => this.showAccounts(true);
    }
    const [lobby, ...rest] = items;
    // Everything above the drawer's foot is redrawn and the foot is left
    // where it is: taken out and put back, it would drop the focus from
    // whichever of its buttons had it, every time anything arrived.
    // The rest is put back with the focus where it was.
    const focused = this.rail.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
    if (this.drawerFoot.parentNode !== this.rail) this.rail.append(this.drawerFoot);
    while (this.rail.firstChild !== this.drawerFoot) this.rail.firstChild!.remove();
    this.drawerFoot.before(
      ...[h('h2', { class: 'rail-head' }, 'Conversations'), lobby, news, files, friends, reports, accounts, ...rest].filter(
        (el): el is HTMLElement => !!el,
      ),
    );
    if (focused) this.rail.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
    this.paintMenuUnread();
  }

  /** A dot on ☰ for anything unread behind it, which on a phone is
   *  everything the rail and the mailbox count. */
  private paintMenuUnread(): void {
    // News, Reports and Friends count only while the rail has them to show, on
    // the same terms `renderRail` draws them.
    const conn = this.conn;
    const live = !!conn && conn.state !== 'offline';
    const any =
      [...this.store.conversations.values()].some((c) => c.unread > 0) ||
      (this.store.mail?.unread ?? 0) > 0 ||
      (live && !!conn.news && this.news.unread > 0) ||
      (live && conn.moderator && !!conn.moderation && this.moderation.queue.count > 0) ||
      (live && !!conn.messaging?.takes_part && this.friends.count > 0);
    this.menuBtn.classList.toggle('unread', any);
  }

  private renderRoster(): void {
    renderRoster(this.rosterEl, this.store, this.media, this.conn?.roles?.list ?? null, {
      onMessage: (u) => {
        this.select(this.store.openPm({ uid: u.uid, nick: u.nick }).id);
        this.showRoster(false);
      },
      onMore: (u) => void this.personMenu(u),
      onClose: () => this.showRoster(false),
    });
  }

  private renderTranscript(): void {
    const conv = this.store.conversation(this.store.active);
    if (conv) renderTranscript(this.transcript, conv, this.store, this.images, this.transcriptOptions());
    this.drawnRevision = this.store.revision;
  }

  private transcriptOptions(): TranscriptOptions {
    return { markdown: this.markdown, moderator: this.conn?.moderator ?? false, contact: this.contactOf() };
  }

  private contactOf(): ContactOf {
    return contactLookup(this.peerMemory, this.proved);
  }

  /** The fingerprint a conversation is under, or with none known, the
   *  one its row shows. */
  private conversationFingerprint(conv: Conversation): string | null {
    return this.verifiedUnder(conv) ?? this.rosterFingerprint(conv);
  }

  /** Contacts, or the one to compare with someone, read afresh so what
   *  another tab marked or forgot shows. */
  private async openContacts(only?: { fingerprint: string; nick: string }): Promise<void> {
    await this.peerMemory.load().catch(() => {});
    const self = this.proved ?? (await getActiveDevice().catch(() => null))?.fingerprint ?? null;
    const fp = only && canonicalFingerprint(only.fingerprint);
    openContacts(
      {
        memory: this.peerMemory,
        self,
        changed: () => {
          keepingPlace(this.transcript, () => this.renderTranscript());
          this.renderComposerHint();
        },
      },
      only && fp ? { ...only, fingerprint: fp } : undefined,
    );
  }

  private renderComposerHint(): void {
    const conv = this.store.conversation(this.store.active);
    const pm = conv?.kind === 'pm';
    this.composer.placeholder = pm ? `Message ${conv.title}…` : 'Say something to everyone…';
    // `transport` is on every roster row whether or not the server runs
    // the identity endpoints, and this is what it is for: a private
    // message to a session on a plain TCP legacy socket crosses the
    // network in the clear, and the only moment that is worth saying is
    // the moment before it is sent.
    const peer = pm && conv.peer.uid !== undefined ? this.store.user(conv.peer.uid) : undefined;
    // Unknown (a linked server's user) warns too, as what it is: it may be
    // in the clear, and nothing here can say it is not.
    const transport = peer?.transport;
    const deniable = pm && this.sealsDeniably(conv);
    this.composerHint.textContent = !pm
      ? 'public chat'
      : transport === 'cleartext'
        ? `private message — ${peer?.nick} is on an unencrypted connection`
        : transport === 'unknown'
          ? `private message — whether ${peer?.nick}'s connection is encrypted is not known`
          : deniable
            ? 'private message — sealed deniably'
            : 'private message';
    if (pm && conv.typing) this.composerHint.textContent += ` — ${conv.title} is typing…`;
    this.composerHint.classList.toggle('warn', !!peer && transport !== 'encrypted');
    const shown = pm ? this.conversationFingerprint(conv) : null;
    const fp = shown && canonicalFingerprint(shown);
    this.compareBtn.hidden = !fp;
    if (pm && fp) {
      const compared = this.peerMemory.compared(fp);
      this.compareBtn.textContent = compared ? 'compared' : 'not compared';
      this.compareBtn.ariaLabel = `Compare fingerprints with ${conv.title}: ${this.compareBtn.textContent}`;
      this.compareBtn.title = compared
        ? `You compared ${conv.title}'s fingerprint out of band. Click to see it.`
        : `You have not compared ${conv.title}'s fingerprint out of band. Click to compare it.`;
    }
    this.deniableBtn.hidden = !pm || !(this.conn instanceof Connection && this.conn.sealing && this.sealPms);
    this.deniableBtn.setAttribute('aria-pressed', String(deniable));
    this.deniableBtn.title = deniable
      ? 'Sealed messages here are deniable: they know it is from you, and can prove it to nobody. Click to sign them instead.'
      : 'Sealed messages here are signed, so they can show anyone you sent them. Click to seal them deniably instead.';
  }

  /** Whether this conversation's sealed messages go deniably, where this
   *  session seals them at all. */
  private sealsDeniably(conv: Conversation): boolean {
    return this.sealPms && this.conn instanceof Connection && this.conn.sealing && this.deniable(conv);
  }

  private renderUnreadTitle(): void {
    const total = [...this.store.conversations.values()].reduce((n, c) => n + c.unread, 0);
    const name = this.store.server.name || this.config.title;
    document.title = total ? `(${total}) ${name}` : name;
    void this.paintBadge(total);
  }

  /** The icon's badge says what the title says. Out of sight, what the
   *  service worker counted meanwhile may be more, and the larger of the
   *  two is the one that is not wrong; on screen, the worker's count has
   *  been seen and goes. */
  private async paintBadge(total: number): Promise<void> {
    if (document.visibilityState === 'visible') {
      await clearAway();
      await showBadge(total);
    } else {
      await showBadge(Math.max(total, await awayCount()));
    }
  }

  /** The voice and video controls, rebuilt from scratch on every change:
   *  the set of things you can do depends on what the server offers, what
   *  you have joined, and what you are publishing, and rebuilding is
   *  cheaper to reason about than patching six buttons in place. */
  private renderCallbar(): void {
    const media = this.media;
    if (!media || !media.hasVoice) {
      this.callbar.hidden = true;
      return;
    }
    this.callbar.hidden = false;
    const buttons: HTMLElement[] = [];
    const add = (label: string, on: boolean, fn: () => Promise<void>, cls = '') => {
      const b = h('button', { class: `call ${cls}${on ? ' on' : ''}` }, label);
      b.onclick = () => {
        b.disabled = true;
        fn()
          .catch((e: Error) => this.say(e instanceof WireFailure ? errorText(e.wire) : e.message))
          .finally(() => (b.disabled = false));
      };
      buttons.push(b);
    };

    // Capture permission is a property of how the page was *served*, not
    // of the server or the account, so it is checked here and reported
    // in the bar rather than discovered by a failed tap.
    const noCapture = captureBlockedReason();
    const disable = (why: string) => {
      const b = buttons[buttons.length - 1] as HTMLButtonElement;
      b.disabled = true;
      b.title = why;
    };

    if (!media.joined) {
      add('Join voice', false, () => media.join(), 'suggest');
      if (noCapture) disable(noCapture);
    } else {
      add(media.muted ? 'Unmute' : 'Mute', !media.muted, () => media.setMuted(!media.muted));
      add('Leave voice', false, () => media.leave());
      if (media.hasVideo) {
        const cam = media.publishing.includes('camera');
        add(cam ? 'Stop camera' : 'Camera', cam, () => media.toggleCamera());
        if (cam) add(media.camPaused ? 'Resume' : 'Pause', media.camPaused, () => media.togglePause());
        const scr = media.publishing.includes('screen');
        add(scr ? 'Stop sharing' : 'Share screen', scr, () => media.toggleShare());
        const noShare = scr ? null : screenShareBlockedReason();
        if (noShare) disable(noShare);
        add(
          media.watching ? 'Stop watching' : 'Watch video',
          media.watching,
          () => media.setWatching(!media.watching),
        );
        // Only worth a button once there is something of one's own to
        // look at; before that it is a switch with nothing behind it.
        if (media.publishing.length) {
          add('Self view', this.selfView, async () => {
            this.selfView = !this.selfView;
            writeSelfView(this.selfView);
            this.applySelfView();
            this.renderCallbar();
          });
          // The one switch whose label does not change with it.
          buttons[buttons.length - 1]!.setAttribute('aria-pressed', String(this.selfView));
        }
      }
    }
    const detail = media.joined
      ? `${media.participants.length} in voice${media.codec ? ` · ${media.codec}` : ''}`
      : noCapture
        ? noCapture
        : media.hasVideo
          ? 'voice and video'
          : 'voice';
    fill(
      this.callbar,
      ...buttons,
      h('span', { class: `call-detail ${noCapture && !media.joined ? 'warn' : 'muted'}` }, detail),
    );
  }

  // --- shell ------------------------------------------------------------

  private buildShell(): void {
    // The roster is a column on a desktop and a slide-in panel on a
    // phone; this button only exists for the second case, and CSS is
    // what decides which case we are in.
    this.peopleBtn.onclick = () =>
      this.showRoster(!document.body.classList.contains('show-roster'));
    this.scrim.onclick = () => {
      this.showRoster(false);
      this.showDrawer(false);
    };

    const identityBtn = h('button', { class: 'ghost', title: 'Device keys, enrollment, and renewal' }, 'Identity');
    identityBtn.onclick = () => this.identityPanel.toggle();

    // Theme, markdown and the rest are this browser's, set once and left
    // alone; a dialog holds them rather than a switch each in the bar.
    const settingsBtn = h('button', { class: 'ghost', title: 'Theme, markdown, video and debugging' }, 'Settings');
    settingsBtn.onclick = () => this.openSettings();

    const contactsBtn = h('button', { class: 'ghost', title: 'Who you have messaged under a key, and their fingerprints to compare' }, 'Contacts');
    contactsBtn.onclick = () => void this.openContacts();

    this.extras.append(this.notifyBtn, installButton(), identityBtn, contactsBtn, settingsBtn);

    // On a phone the rail is a drawer from the left, and ☰ opens it.
    // Anything picked in it — a conversation, a reader, a button at its
    // foot — is somewhere to go, so the drawer gets out of the way.
    this.menuBtn.setAttribute('aria-controls', 'rail');
    this.menuBtn.onclick = () => this.showDrawer(!document.body.classList.contains('show-drawer'));
    // By the time this runs, what was picked has had its click: a
    // conversation has focused the composer and Settings its dialog.
    // Anything else would leave the focus on a button that is sliding
    // out of sight, so it goes back to ☰.
    this.rail.addEventListener('click', (e) => {
      if (!document.body.classList.contains('show-drawer')) return;
      if (!(e.target as Element).closest('button')) return;
      this.showDrawer(false);
      const at = document.activeElement;
      if (!at || at === document.body || this.rail.contains(at)) this.menuBtn.focus();
    });
    const phone = matchMedia(PHONE);
    phone.addEventListener('change', () => this.placeTopbar(phone.matches));

    this.pill.onclick = () => this.debug.toggle();
    this.notifyBtn.onclick = () => void this.togglePush();
    this.meButton.onclick = () => void this.editSelf();
    this.mailBtn.onclick = () =>
      this.loadMail().catch((e: Error) =>
        this.say(e instanceof WireFailure ? errorText(e.wire) : e.message),
      );

    this.composer.onkeydown = (e) => {
      // GtkHx's shortcuts: wrap the selection, or put a pair down to type
      // into. The box then says exactly what will be sent.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'b' || e.key === 'i')) {
        e.preventDefault();
        const c = this.composer;
        const w = wrapSelection(c.value, c.selectionStart, c.selectionEnd, e.key === 'b' ? '**' : '*');
        c.value = w.value;
        c.setSelectionRange(w.start, w.end);
        this.autoGrow();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = this.composer.value.trim();
        // An image *is* the message when there is one, so an empty
        // composer with something attached still sends.
        if (!text && !this.attached) return;
        this.composer.value = '';
        this.autoGrow();
        this.noteTyping();
        this.send(text).catch((err: Error) =>
          this.say(err instanceof WireFailure ? errorText(err.wire) : err.message),
        );
      }
    };
    this.composer.oninput = () => {
      this.autoGrow();
      this.noteTyping();
    };

    // Attaching, three ways in. The paperclip opens the picker; the
    // picker's `accept` list is the server's own, so a phone's photo
    // roll filters itself. Pasting is the one people reach for without
    // being told it exists — a screenshot in the clipboard and Ctrl-V —
    // and it costs six lines.
    this.attachBtn.onclick = () => this.filePicker.click();
    this.deniableBtn.onclick = () => {
      const conv = this.store.conversation(this.store.active);
      if (conv?.kind !== 'pm') return;
      void chooseDeniable(conv, this.peerMemory, this.keyUrl, !this.deniable(conv));
      this.renderRail();
      this.renderComposerHint();
    };
    this.compareBtn.onclick = () => {
      const conv = this.store.conversation(this.store.active);
      const fp = conv?.kind === 'pm' ? this.conversationFingerprint(conv) : null;
      if (fp) void this.openContacts({ fingerprint: fp, nick: conv!.title });
    };
    this.filePicker.onchange = () => {
      const file = this.filePicker.files?.[0];
      if (file) void this.attach(file);
    };
    this.composer.addEventListener('paste', (e) => {
      if (!this.conn?.media) return;
      const file = [...(e.clipboardData?.items ?? [])]
        .filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile())
        .find((f): f is File => !!f && this.conn!.media!.types.includes(f.type));
      if (!file) return;
      e.preventDefault();
      void this.attach(file);
    });

    // Opening the debug drawer, or any other resize, must not silently
    // scroll the newest line out of view.
    let pinned = true;
    this.transcript.addEventListener('scroll', () => {
      pinned = isAtBottom(this.transcript);
      if (
        !pinned &&
        this.transcript.scrollTop < 64 &&
        this.store.active === LOBBY &&
        !this.store.historyExhausted
      ) {
        void this.loadHistory().catch((e: Error) =>
          this.say(e instanceof WireFailure ? errorText(e.wire) : e.message),
        );
      }
    });
    new ResizeObserver(() => {
      if (pinned) scrollToEnd(this.transcript);
    }).observe(this.transcript);
    // A news notice is a link the transcript cannot follow on its own:
    // opening the article means swapping the chat pane for the reader.
    this.transcript.addEventListener('click', (e) => {
      const act = (e.target as Element | null)?.closest<HTMLElement>('button[data-act]');
      const line = act ? lineOf(act) : undefined;
      if (act && line) {
        const conv = this.store.conversation(this.store.active);
        if (!conv) return;
        if (act.dataset.act === 'reveal') {
          line.hidden = false;
          return keepingPlace(this.transcript, () => this.renderTranscript());
        }
        const run = act.dataset.act === 'redact' ? this.redactLine(line) : this.reportLine(line, conv);
        run.catch((err: unknown) => this.say(moderationProblem(err)));
        return;
      }
      const link = (e.target as Element | null)?.closest<HTMLElement>('a[data-article]');
      if (!link) {
        // A touch screen has no hover to bring a line's buttons up, so a
        // tap on the line does — and a tap on another line moves them.
        if (!matchMedia('(hover: none)').matches) return;
        const row = (e.target as Element | null)?.closest('.line');
        if (!row || (e.target as Element).closest('a, button, img')) return;
        const was = row.classList.contains('picked');
        for (const el of this.transcript.querySelectorAll('.line.picked')) el.classList.remove('picked');
        row.classList.toggle('picked', !was);
        return;
      }
      e.preventDefault();
      this.openNewsArticle(Number(link.dataset.article));
    });

    this.chatPane.append(
      this.transcript,
      this.heard,
      // The chip sits above the composer rather than inside it: the
      // composer is one row of controls, and an attachment is a thing
      // already sent to the server that the next line will carry.
      this.attachChip,
      h('div', { class: 'composer' }, this.attachBtn, this.composer, this.compareBtn, this.deniableBtn, this.composerHint, this.filePicker),
    );

    this.shell.append(
      h(
        'header',
        { class: 'topbar' },
        this.menuBtn,
        h('div', { class: 'server' }, this.serverName, this.subject),
        h('div', { class: 'spacer' }),
        this.meButton,
        this.pill,
        this.mailBtn,
        this.peopleBtn,
        this.extras,
      ),
      this.banner.el,
      h(
        'div',
        { class: 'panes' },
        pane(this.rail, 'rail', 'Conversations', 180),
        h(
          'main',
          {},
          this.callbar,
          // The video strip lives above the transcript and is owned by
          // the tile renderer, which is the only thing that knows what a
          // browser needs before it will paint a `<video>`.
          this.tiles.el,
          // Chat and the two server readers take turns in this space —
          // tiled they are three tabs of one leaf and take none.
          pane(this.chatPane, 'chat', 'Chat', 320),
          pane(this.news.el, 'news', 'News', 360),
          pane(this.files.el, 'files', 'Files', 320),
          // Off until someone who takes part in messaging logs in.
          offPane(pane(this.friends.el, 'friends', 'Friends', 320)),
          // Off until a moderator logs in: nobody else has any reports.
          offPane(pane(this.moderation.el, 'reports', 'Reports', 360)),
          // Off until someone who may read or make accounts logs in.
          offPane(pane(this.accountsView.el, 'accounts', 'Accounts', 360)),
        ),
        // Both live inside `.panes` rather than the document, so the
        // slide-in panel is bounded by the pane area and never covers
        // the title bar — including the button that opens it.
        this.scrim,
        pane(this.rosterEl, 'roster', 'People', 200),
        // Where the layout is drawn, when there is one. Empty and
        // invisible otherwise, and the shell is the shell it always was.
        this.tiler,
      ),
    );
    this.placeTopbar(phone.matches);
  }

  /** Where the title bar's own buttons go: in the bar, or on a phone,
   *  where the bar has room for little more than the server's name, at
   *  the foot of the drawer. Moved rather than drawn twice, so each is
   *  still the one button that paints itself. */
  private placeTopbar(phone: boolean): void {
    if (phone) {
      this.drawerFoot.append(this.meButton, this.mailBtn, this.extras);
    } else {
      this.pill.before(this.meButton);
      this.pill.after(this.mailBtn);
      this.peopleBtn.after(this.extras);
      this.showDrawer(false);
    }
  }

  /** Open or close the rail as a drawer, on a phone. Out the same ways
   *  as the roster: ☰ again, the scrim, Escape, or picking something. */
  private showDrawer(open: boolean): void {
    if (open) this.showRoster(false);
    document.body.classList.toggle('show-drawer', open);
    this.menuBtn.classList.toggle('on', open);
    this.menuBtn.setAttribute('aria-expanded', String(open));
  }

  /** Ask now, on coming back to the page, and every so often while it
   *  stays in front; a hidden page asks when it is next shown. */
  private watchForUpdates(): void {
    document.addEventListener('visibilitychange', () => this.checkForUpdate());
    window.setInterval(() => this.checkForUpdate(), INTERVAL_MS);
    this.checkForUpdate();
  }

  /** Not under the dev server, which has no `version.json` to ask. */
  private checkForUpdate(urgent = false): void {
    if (import.meta.env.DEV || document.visibilityState !== 'visible') return;
    void this.updates.check(urgent).then((build) => {
      if (build) this.offerUpdate();
    });
  }

  /** Offered, never done: a reload takes a half-typed line, or a call,
   *  with it. */
  private offerUpdate(): void {
    const said = h('span', {}, 'A new version of the client is available.');
    const reload = h('button', { class: 'primary', type: 'button' }, 'Reload');
    reload.onclick = async () => {
      reload.disabled = true;
      // A reload revalidates the page itself, but a Home Screen app's
      // next cold launch opens its start URL from the HTTP cache, which
      // may hold the old `index.html` for as long as the host allows.
      // `reload` fetches past it and stores the new one there. And it
      // is the proof the server is reachable: an app offline would
      // reload onto an error page with no way back.
      const ok = await fetch('./', { cache: 'reload', signal: AbortSignal.timeout(5000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) {
        location.reload();
        return;
      }
      reload.disabled = false;
      said.textContent = 'A new version of the client is available, but it could not be reached. Check the connection and try again.';
    };
    const hide = h('button', { class: 'ghost', type: 'button', title: 'Dismiss', ariaLabel: 'Dismiss' }, '×');
    hide.onclick = () => this.updateBar.replaceChildren();
    this.updateBar.replaceChildren(h('div', { class: 'update-banner' }, said, reload, hide));
  }

  private openSettings(): void {
    openSettings({
      theme: readTheme(),
      setTheme: (t) => this.applyTheme(t),
      markdown: this.markdown,
      // Only how the lines are drawn changes, so a reader back in the
      // history stays on what they were reading. Every line still holds
      // the text it arrived as, so there is nothing to redraw from that
      // is not already kept.
      setMarkdown: (on) => {
        this.markdown = on;
        writeMarkdown(on);
        keepingPlace(this.transcript, () => this.renderTranscript());
      },
      selfView: this.selfView,
      setSelfView: (on) => {
        this.selfView = on;
        writeSelfView(on);
        this.applySelfView();
        this.renderCallbar();
      },
      signLobby: this.signLobby,
      setSignLobby: (on) => this.setSignLobby(on),
      sealPms: this.sealPms,
      setSealPms: (on) => {
        this.sealPms = on;
        writeSealing(on);
        this.renderRail();
        this.renderComposerHint();
      },
      signPms: this.pmSigning,
      setSignPms: (choice) => {
        this.pmSigning = choice;
        writePmSigning(choice);
        this.renderRail();
        this.renderComposerHint();
      },
      signNews: this.signNews,
      setSignNews: (on) => {
        this.signNews = on;
        writeSigning('news', on);
      },
      openDebug: () => this.debug.toggle(true),
    });
  }

  /** Open or close the narrow-layout roster panel.
   *
   *  A panel you cannot dismiss is worse than no panel, so there are
   *  four ways out and this is the one place that knows about all of
   *  them: the same button (which stays reachable because the panel is
   *  confined to the pane area), the scrim behind it, Escape, and
   *  picking someone to message. */
  private showRoster(open: boolean): void {
    if (open) this.showDrawer(false);
    document.body.classList.toggle('show-roster', open);
    this.peopleBtn.classList.toggle('on', open);
    this.peopleBtn.setAttribute('aria-expanded', String(open));
    this.peopleBtn.title = open ? 'Hide the user list' : 'Show the user list';
  }

  private async editSelf(): Promise<void> {
    const me = this.store.self;
    const conn = this.conn;
    if (!me || !conn) return;
    // A refusal is thrown as text for the picker to show: it stays open,
    // so another file can be chosen without starting over.
    const failed = (e: unknown): Error =>
      new Error(e instanceof WireFailure ? errorText(e.wire) : String(e));
    const avatar: AvatarChoice | undefined = conn.avatars
      ? {
          limits: conn.avatars,
          has: me.avatar !== undefined,
          upload: async (file) => {
            await conn.uploadAvatar(file).catch((e: unknown) => {
              throw failed(e);
            });
          },
          remove: async () => {
            await conn.clearAvatar().catch((e: unknown) => {
              throw failed(e);
            });
          },
        }
      : undefined;
    const picked = await pickIcon(me.icon, avatar, me.nick);
    if (picked === null) return;
    const change = {
      ...(picked.icon !== me.icon && { icon: picked.icon }),
      ...(picked.nick && picked.nick !== me.nick && { nick: picked.nick }),
    };
    if (!Object.keys(change).length) return;
    try {
      await conn.request('nick', change);
    } catch (e) {
      this.say(e instanceof WireFailure ? errorText(e.wire) : String(e));
    }
  }

  private autoGrow(): void {
    this.composer.style.height = 'auto';
    this.composer.style.height = `${Math.min(this.composer.scrollHeight, 160)}px`;
  }

  private applyTheme(t: Theme): void {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* storage disabled; the theme simply resets next load */
    }
  }

  private facts(): Record<string, unknown> {
    const c = this.conn;
    return {
      'client time': clock(),
      url: this.url || '—',
      state: c?.state ?? 'offline',
      session: c?.session ?? '—',
      'token held': c?.token ? 'yes (not shown)' : 'no',
      uid: c?.self?.uid ?? '—',
      nick: c?.self?.nick ?? '—',
      icon: c?.self?.icon ?? '—',
      admin: c?.self?.admin ?? '—',
      status: c?.self?.status ?? '—',
      seq: c?.seq ?? 0,
      'ping rtt': c?.rtt !== null && c?.rtt !== undefined ? `${c.rtt} ms` : '—',
      'detach grace': c?.grace !== null && c?.grace !== undefined ? `${c.grace}s` : 'not permitted',
      caps: c?.caps ?? [],
      'video limits': c?.video ?? null,
      news: c?.news ?? null,
      server: this.store.server.name,
      subject: this.store.server.subject,
      roster: this.store.users.size,
      conversations: [...this.store.conversations.keys()],
      viewport: `${Math.round(window.innerWidth)}×${Math.round(window.innerHeight)}`,
    };
  }
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'dark' || t === 'light' || t === 'auto') return t;
  } catch {
    /* fall through */
  }
  return 'auto';
}

function readSelfView(): boolean {
  try {
    return localStorage.getItem(SELF_VIEW_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeSelfView(on: boolean): void {
  try {
    localStorage.setItem(SELF_VIEW_KEY, on ? 'on' : 'off');
  } catch {
    /* storage disabled; the preference lasts this page load */
  }
}

function readMarkdown(): boolean {
  try {
    return localStorage.getItem(MARKDOWN_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeMarkdown(on: boolean): void {
  try {
    localStorage.setItem(MARKDOWN_KEY, on ? 'on' : 'off');
  } catch {
    /* storage disabled; the preference lasts this page load */
  }
}
