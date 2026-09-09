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

import {
  captureBlockedReason,
  Connection,
  errorText,
  hasSavedSession,
  newGuid,
  screenShareBlockedReason,
  VoiceSession,
  WireFailure,
  CAP_HISTORY,
  CAP_INBOX,
  isFingerprint,
  mediaBlockedReason,
  type BlockParams,
  type ConnState,
  type Credentials,
  type InboxOk,
  type HistoryOk,
  type Media,
  type MsgParams,
  type RemoteVideo,
  type User,
  type VideoKind,
} from '@hotline-ng/client';

import type { AppConfig } from '../config';
import {
  addressOf,
  Cursor,
  LOBBY,
  type Conversation,
  type ConvId,
  type Line,
  Store,
  styleToKind,
} from '../state';
import { connectScreen, remembered, type Details } from './connect';
import { DebugPanel } from './debug';
import { clock, fill, h } from './dom';
import { icon } from './icons';
import { pickIcon } from './iconpicker';
import { IdentityPanel } from './identity';
import { renderRoster } from './roster';
import { Tiles } from './tiles';
import { MediaCache } from './media';
import { appendLine, isAtBottom, renderTranscript, scrollToEnd } from './transcript';

/** Codes that mean "not for you, not now, not ever on this session":
 *  no log configured, no privilege, or a request this server will not
 *  parse. Asking again would only produce the same answer. */
const HISTORY_REFUSALS = new Set(['not_available', 'access_denied', 'bad_request']);

const THEME_KEY = 'hxd-ng.theme';
const SELF_VIEW_KEY = 'hxd-ng.selfview';
type Theme = 'auto' | 'dark' | 'light';

export class App {
  private store = new Store();
  private conn: Connection | null = null;
  private media: VoiceSession | null = null;
  private debug: DebugPanel;
  private identityPanel: IdentityPanel;
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
  /** An image uploaded and waiting for the line that will carry it.
   *  Attaching uploads immediately — the server has to see the bytes to
   *  say whether it will take them, and finding out at send time would
   *  lose the message with them. */
  private attached: Media | null = null;
  /** Whether one's own camera is shown back to oneself. A preview is the
   *  only way to find out that a camera is pointed at the ceiling, or
   *  that it is not sending at all, without asking the room. */
  private selfView = readSelfView();

  // Long-lived DOM.
  private shell = h('div', { class: 'app', hidden: true });
  private serverName = h('strong', { class: 'server-name' });
  private subject = h('span', { class: 'subject' });
  private pill = h('button', { class: 'pill', title: 'Connection state' });
  private rail = h('nav', { class: 'rail' });
  private callbar = h('div', { class: 'callbar', hidden: true });
  private tiles = new Tiles();
  private transcript = h('div', { class: 'transcript' });
  private composer = h('textarea', {
    class: 'composer-input',
    rows: 1,
    placeholder: 'Say something…',
    spellcheck: true,
  });
  private composerHint = h('span', { class: 'composer-hint' });
  private attachBtn = h(
    'button',
    { class: 'ghost attach', title: 'Attach an image', hidden: true },
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
  /** How far `msg_read` has been told we have got. Selecting the same
   *  conversation twice does not ask again, and two marks in flight
   *  cannot write each other's answers. */
  private readCursor = new Cursor();
  private meButton = h('button', { class: 'identity', title: 'Change your icon' });

  constructor(
    private root: HTMLElement,
    private config: AppConfig,
  ) {
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
    this.identityPanel = new IdentityPanel(() => this.url || this.config.defaultServer);
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
    });
  }

  mount(): void {
    const screen = connectScreen(
      this.config,
      (d) => this.connect(d),
      () => this.identityPanel.toggle(true),
    );
    this.root.append(screen, this.shell, this.debug.el, this.identityPanel.el);
    // `?debug` opens the drawer before the first frame, which is what you
    // want when the thing you are debugging is the login itself.
    if (new URLSearchParams(location.search).has('debug')) this.debug.toggle(true);

    // A reload is a dropped connection like any other: if this tab still
    // holds a session for the server it was last on, go straight back
    // into it rather than making someone log in again to reach the room
    // they never left.
    const saved = remembered(this.config);
    if (hasSavedSession(saved.url)) {
      screen.hidden = true;
      const splash = h('div', { class: 'connect' }, h('p', { class: 'muted' }, 'Resuming your session…'));
      this.root.prepend(splash);
      this.connect(saved, { resumeOnly: true })
        .catch(() => {
          screen.hidden = false;
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
    const creds: Credentials = { ...d };
    const conn = new Connection(creds, {
      onTrace: (e) => this.debug.push(e),
      onState: (s, detail) => this.onState(s, detail),
      onLogin: (ok) => {
        this.store.server = ok.server;
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
      onSnapshot: ({ self, users, server }) => {
        this.store.self = self;
        this.store.server = server;
        this.store.replaceRoster(users);
        this.renderAll();
      },
      onResumed: (replay) => {
        this.say(
          replay > 0
            ? `Reconnected — ${replay} ${replay === 1 ? 'message' : 'messages'} replayed.`
            : 'Reconnected.',
        );
      },
      onMissedMail: (ok) => {
        const n = this.mergeStoredMail(ok);
        if (n) {
          this.say(
            `Recovered ${n} private ${n === 1 ? 'message' : 'messages'} that arrived while this client was behind.`,
          );
        }
      },
      onMissedHistory: (ok) => {
        if (this.mergeHistory(ok, 'newer') && this.store.active === LOBBY) {
          this.renderTranscript();
        }
      },
      onEnded: (reason) => {
        this.say(reason);
        this.media?.teardown();
        // The handles die with the session, so the blob URLs may as
        // well: keeping them would leak every picture this page has
        // seen, and nothing could refetch them anyway.
        this.images.clear();
        this.clearAttachment();
        if (this.pingTimer !== null) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
      },
    });
    this.conn = conn;
    this.images.attach(conn);
    this.media = new VoiceSession(conn, {
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
    } catch (e) {
      this.conn = null;
      this.media = null;
      this.images.attach(null);
      throw new Error(
        e instanceof WireFailure ? errorText(e.wire) : e instanceof Error ? e.message : String(e),
      );
    }

    for (const el of this.root.querySelectorAll('.connect')) el.remove();
    this.shell.hidden = false;
    this.url = d.url;
    this.media.limits = conn.video;
    // The paperclip appears only where it works: the server offers the
    // capability, or it does not and inert chrome would be a promise
    // this client cannot keep.
    this.attachBtn.hidden = conn.media === null;
    this.filePicker.accept = conn.media?.types.join(',') ?? '';
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
  }

  private bindEvents(conn: Connection): void {
    conn.on('user_joined', (d) => {
      this.store.put(d.user);
      this.push(LOBBY, { t: Date.now(), kind: 'notice', text: `${d.user.nick} joined.` });
      this.renderRoster();
    });

    conn.on('user_changed', (d) => {
      const before = this.store.user(d.user.uid);
      this.store.put(d.user);
      if (before && before.nick !== d.user.nick) {
        this.push(LOBBY, {
          t: Date.now(),
          kind: 'notice',
          text: `${before.nick} is now known as ${d.user.nick}.`,
        });
        const pm = this.store.pmWith({ uid: d.user.uid });
        if (pm) pm.title = d.user.nick;
      }
      if (d.user.uid === this.store.self?.uid) this.store.self = d.user;
      this.renderRoster();
      this.renderRail();
      this.renderMe();
      this.refreshTileLabels();
    });

    conn.on('user_parted', (d) => {
      const gone = this.store.remove(d.uid);
      this.push(LOBBY, {
        t: Date.now(),
        kind: 'notice',
        text: `${gone?.nick ?? `uid ${d.uid}`} left.`,
      });
      this.renderRoster();
    });

    conn.on('chat', (d) => {
      if (d.id !== undefined && this.store.hasHistory(d.id)) return;
      this.push(LOBBY, {
        // `at` is required by the current wire, but pre-history servers
        // did not send it. Keep those servers usable while deployments
        // roll forward.
        t: Number.isFinite(d.at) ? d.at * 1000 : Date.now(),
        kind: styleToKind(d.style),
        from: d.from,
        text: d.text,
        id: d.id,
        media: d.media,
      });
    });

    // An image someone posted has been revoked by a moderator. Drop the
    // bytes we hold and redraw: the line stays, the placeholder says
    // what happened, and nothing refetches it.
    conn.on('media_revoked', (d) => {
      this.images.revoke(d.id);
      this.renderTranscript();
    });

    conn.on('msg', (d) => {
      // `at` rather than now: a message that waited in the store was
      // *sent* whenever it was sent, and stamping the flush time on it
      // would make a week-old message read as having just arrived.
      // The login flush and an `inbox` page carry the same rows, and
      // which arrives first is a race. Whichever loses is dropped here.
      if (d.id !== undefined && this.store.hasMail(d.id)) return;
      const conv = this.store.openPm({ uid: d.from.uid, login: d.from.login, nick: d.from.nick });
      // An `id` means the server stored it, so both counters move. Moving
      // only `unread` was enough to render "1 unread of 0 stored" until
      // the next reply corrected it.
      if (d.id !== undefined) this.store.noteStoredMessage();
      this.push(conv.id, {
        t: d.at * 1000,
        kind: 'chat',
        from: d.from,
        text: d.text,
        queued: d.queued,
        id: d.id,
        media: d.media,
      });
      this.renderRail();
      this.renderMail();
    });

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

    // Taken before anything is awaited: a second Enter while an upload
    // is in flight must not send the same image twice.
    const attached = this.attached;
    this.clearAttachment();

    const conv = this.store.conversation(this.store.active);
    if (conv?.kind === 'pm') {
      const to = addressOf(conv);
      if (!to) {
        return this.say(
          `There is no way to reach ${conv.title}: they have left, and the message they sent named no account to answer.`,
        );
      }
      // A guid makes a resend the same message rather than a second one.
      // Nothing here resends automatically yet, so today this only stops
      // a double-tap from arriving twice — but it is the field that makes
      // a retry safe at all, and it costs one line.
      const guid = newGuid();
      const media = attached?.id;
      const params: MsgParams =
        'to_login' in to
          ? { to_login: to.to_login, text, guid, media }
          : { to: to.to, text, guid, media };
      const ok = await conn.msg(params);
      // PMs have no echo, so the sender's own half is local.
      const me = this.store.self;
      this.push(conv.id, {
        t: Date.now(),
        kind: 'chat',
        from: { uid: me?.uid ?? 0, nick: me?.nick ?? 'you' },
        text,
        local: true,
        media: attached ?? undefined,
      });
      if (ok.queued) {
        this.say(`${conv.title} is not here. The server is holding that for them.`);
      }
      return;
    }
    // Public chat echoes, so the sender's own copy comes back off the
    // wire with the image on it; nothing is pushed locally here.
    await conn.chat({ text, media: attached?.id });
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
    this.showAttachment(null, file.name);
    try {
      const media = await conn.uploadMedia(file);
      this.attached = media;
      this.showAttachment(media, file.name);
      this.composer.focus();
    } catch (e) {
      this.clearAttachment();
      this.say(e instanceof WireFailure ? errorText(e.wire) : (e as Error).message);
    }
  }

  private showAttachment(media: Media | null, name: string): void {
    const label = media
      ? `${name} — ${media.width}×${media.height}, ready to send`
      : `${name} — uploading…`;
    const remove = h('button', { class: 'ghost', title: 'Remove this image' }, '✕');
    remove.onclick = () => this.clearAttachment();
    fill(this.attachChip, h('span', {}, label), remove);
    this.attachChip.hidden = false;
  }

  private clearAttachment(): void {
    this.attached = null;
    this.attachChip.hidden = true;
    this.filePicker.value = '';
  }

  private async command(raw: string): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const [word, ...rest] = raw.slice(1).split(' ');
    const arg = rest.join(' ');
    switch ((word ?? '').toLowerCase()) {
      case 'me':
        if (arg) await conn.request('chat', { text: arg, style: 'action' });
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
        this.say('Dropping the socket; the session should resume.');
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
          '/me · /msg <nick or account> <text> · /history · /mail · /block <who> · /unblock <who> · /blocks · ' +
            '/nick <name> · /icon <n> · /clear · /close · /drop · /debug · /logout',
        );
      default:
        return this.say(`Unknown command: /${word}`);
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
    conv.unread = 0;
    this.renderRail();
    this.renderTranscript();
    this.renderComposerHint();
    this.composer.focus();
    // Reading is a thing the server keeps for us, so tell it. Failure is
    // worth a line but not worth interrupting the selection over.
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

  // --- public chat history ---------------------------------------------

  private mergeHistory(ok: HistoryOk, direction: 'older' | 'newer'): number {
    return this.store.mergeHistory(
      ok.lines.map((line) => ({
        t: line.at * 1000,
        kind: line.deleted ? 'deleted' : styleToKind(line.style),
        from: line.deleted
          ? undefined
          : { nick: line.from.nick, icon: line.from.icon },
        text: line.deleted ? 'Message deleted.' : line.text,
        id: line.id,
        deleted: line.deleted,
        media: line.media,
      })),
      ok.has_more,
      direction,
    );
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
      // Measured here rather than before the request: a live line
      // arriving while it was in flight has already changed the height,
      // and counting that as part of the prepend is the jump this
      // arithmetic exists to prevent.
      const oldHeight = this.transcript.scrollHeight;
      const oldTop = this.transcript.scrollTop;
      const added = this.mergeHistory(page, 'older');
      if (added && this.store.active === LOBBY) {
        this.renderTranscript();
        if (!opts.initial) {
          this.transcript.scrollTop = oldTop + this.transcript.scrollHeight - oldHeight;
        }
      }
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
  private mergeStoredMail(ok: InboxOk): number {
    let added = 0;
    // `inbox` lists newest first; put them back in the order they were sent.
    for (const m of [...ok.messages].reverse()) {
      if (this.store.hasMail(m.id)) continue;
      const conv = this.store.openPm({ login: m.from.login, nick: m.from.nick });
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
      const added = this.mergeStoredMail(page);
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
    // Only mail we received has an id worth marking; our own half of the
    // conversation is local and never had one.
    for (const l of conv.lines) if (l.id !== undefined && !l.local && l.id > top) top = l.id;

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
      mail.unread ? h('span', { class: 'badge' }, String(mail.unread)) : null,
    );
    this.mailBtn.classList.toggle('unread', mail.unread > 0);
    this.mailBtn.title = this.store.mailExhausted
      ? `${mail.unread} unread of ${mail.total} stored — all of it is loaded`
      : `${mail.unread} unread of ${mail.total} stored. Click to load earlier messages.`;
  }

  private push(id: ConvId, line: Line, fresh = true): void {
    const conv = this.store.add(id, line, fresh);
    if (!conv) return;
    if (id === this.store.active) {
      // Appending one line assumes the DOM still matches the array it was
      // drawn from. A merge rewrites that array, so redraw instead.
      if (this.store.revision !== this.drawnRevision) this.renderTranscript();
      else appendLine(this.transcript, line, conv, this.store, this.images);
    } else this.renderRail();
    this.renderUnreadTitle();
  }

  /** Something this client wants to say about itself. */
  private say(text: string): void {
    this.push(this.store.active, { t: Date.now(), kind: 'system', text, local: true });
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
    fill(this.meButton, icon(me.icon, 2), h('span', { class: 'nick' }, me.nick));
  }

  private renderRail(): void {
    const items = [...this.store.conversations.values()].map((c) => {
      const active = c.id === this.store.active;
      // Only a conversation whose other half is on the roster has a face
      // to show. One carried by an account alone — mail from someone who
      // is not here — falls back to the default icon.
      const peer = c.peer.uid !== undefined ? this.store.user(c.peer.uid) : undefined;
      const el = h(
        'button',
        { class: `rail-item${active ? ' on' : ''}${c.unread ? ' unread' : ''}` },
        c.kind === 'lobby'
          ? h('span', { class: 'rail-glyph' }, '#')
          : icon(peer?.icon ?? 128, 1),
        h('span', { class: 'rail-title' }, c.title),
        c.unread ? h('span', { class: 'badge' }, String(c.unread)) : null,
      );
      el.onclick = () => this.select(c.id);
      if (c.kind === 'pm') {
        const close = h('span', { class: 'rail-close', title: 'Close' }, '×');
        close.onclick = (e) => {
          e.stopPropagation();
          this.closeConversation(c.id);
        };
        el.append(close);
      }
      return el;
    });
    fill(this.rail, h('div', { class: 'rail-head' }, 'Conversations'), ...items);
  }

  private renderRoster(): void {
    if (!this.media) return;
    renderRoster(this.rosterEl, this.store, this.media, {
      onMessage: (u) => {
        this.select(this.store.openPm({ uid: u.uid, nick: u.nick }).id);
        this.showRoster(false);
      },
      onClose: () => this.showRoster(false),
    });
  }

  private renderTranscript(): void {
    const conv = this.store.conversation(this.store.active);
    if (conv) renderTranscript(this.transcript, conv, this.store, this.images);
    this.drawnRevision = this.store.revision;
  }

  private renderComposerHint(): void {
    const conv = this.store.conversation(this.store.active);
    const pm = conv?.kind === 'pm';
    this.composer.placeholder = pm ? `Message ${conv.title}…` : 'Say something…';
    // `transport` is on every roster row whether or not the server runs
    // the identity endpoints, and this is what it is for: a private
    // message to a session on a plain TCP legacy socket crosses the
    // network in the clear, and the only moment that is worth saying is
    // the moment before it is sent.
    const peer = pm && conv.peer.uid !== undefined ? this.store.user(conv.peer.uid) : undefined;
    const cleartext = peer?.transport === 'cleartext';
    this.composerHint.textContent = !pm
      ? 'public chat'
      : cleartext
        ? `private message — ${peer.nick} is on an unencrypted connection`
        : 'private message';
    this.composerHint.classList.toggle('warn', cleartext);
  }

  private renderUnreadTitle(): void {
    const total = [...this.store.conversations.values()].reduce((n, c) => n + c.unread, 0);
    const name = this.store.server.name || this.config.title;
    document.title = total ? `(${total}) ${name}` : name;
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
    this.scrim.onclick = () => this.showRoster(false);

    const debugBtn = h('button', { class: 'ghost', title: 'Wire trace and session state (⇧⌘D)' }, 'Debug');
    debugBtn.onclick = () => this.debug.toggle();

    const identityBtn = h('button', { class: 'ghost', title: 'Device keys, enrollment, and renewal' }, 'Identity');
    identityBtn.onclick = () => this.identityPanel.toggle();

    const themeBtn = h('button', { class: 'ghost', title: 'Theme' });
    const paintTheme = (t: Theme) => (themeBtn.textContent = t === 'auto' ? 'Auto' : t === 'dark' ? 'Dark' : 'Light');
    paintTheme(readTheme());
    themeBtn.onclick = () => {
      const next: Theme = readTheme() === 'auto' ? 'dark' : readTheme() === 'dark' ? 'light' : 'auto';
      this.applyTheme(next);
      paintTheme(next);
    };

    this.pill.onclick = () => this.debug.toggle(true);
    this.meButton.onclick = () => void this.editSelf();
    this.mailBtn.onclick = () =>
      this.loadMail().catch((e: Error) =>
        this.say(e instanceof WireFailure ? errorText(e.wire) : e.message),
      );

    this.composer.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = this.composer.value.trim();
        // An image *is* the message when there is one, so an empty
        // composer with something attached still sends.
        if (!text && !this.attached) return;
        this.composer.value = '';
        this.autoGrow();
        this.send(text).catch((err: Error) =>
          this.say(err instanceof WireFailure ? errorText(err.wire) : err.message),
        );
      }
    };
    this.composer.oninput = () => this.autoGrow();

    // Attaching, three ways in. The paperclip opens the picker; the
    // picker's `accept` list is the server's own, so a phone's photo
    // roll filters itself. Pasting is the one people reach for without
    // being told it exists — a screenshot in the clipboard and Ctrl-V —
    // and it costs six lines.
    this.attachBtn.onclick = () => this.filePicker.click();
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

    this.shell.append(
      h(
        'header',
        { class: 'topbar' },
        h('div', { class: 'server' }, this.serverName, this.subject),
        h('div', { class: 'spacer' }),
        this.meButton,
        this.pill,
        this.mailBtn,
        this.peopleBtn,
        themeBtn,
        identityBtn,
        debugBtn,
      ),
      h(
        'div',
        { class: 'panes' },
        this.rail,
        h(
          'main',
          {},
          this.callbar,
          // The video strip lives above the transcript and is owned by
          // the tile renderer, which is the only thing that knows what a
          // browser needs before it will paint a `<video>`.
          this.tiles.el,
          this.transcript,
          // The chip sits above the composer rather than inside it: the
          // composer is one row of controls, and an attachment is a
          // thing already sent to the server that the next line will
          // carry.
          this.attachChip,
          h(
            'div',
            { class: 'composer' },
            this.attachBtn,
            this.composer,
            this.composerHint,
            this.filePicker,
          ),
        ),
        // Both live inside `.panes` rather than the document, so the
        // slide-in panel is bounded by the pane area and never covers
        // the title bar — including the button that opens it.
        this.scrim,
        this.rosterEl,
      ),
    );
  }

  /** Open or close the narrow-layout roster panel.
   *
   *  A panel you cannot dismiss is worse than no panel, so there are
   *  four ways out and this is the one place that knows about all of
   *  them: the same button (which stays reachable because the panel is
   *  confined to the pane area), the scrim behind it, Escape, and
   *  picking someone to message. */
  private showRoster(open: boolean): void {
    document.body.classList.toggle('show-roster', open);
    this.peopleBtn.classList.toggle('on', open);
    this.peopleBtn.setAttribute('aria-expanded', String(open));
    this.peopleBtn.title = open ? 'Hide the user list' : 'Show the user list';
  }

  private async editSelf(): Promise<void> {
    const me = this.store.self;
    const conn = this.conn;
    if (!me || !conn) return;
    const id = await pickIcon(me.icon);
    if (id === null || id === me.icon) return;
    try {
      await conn.request('nick', { icon: id });
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
