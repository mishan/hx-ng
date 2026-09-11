/**
 * The news reader: the tree, a category's threads, and a thread in the
 * order it reads.
 *
 * The server is the source of truth here as everywhere else in this
 * client. A post appears when a refetch shows it, never optimistically,
 * and the `news_*` events are what they are on the wire — "your copy is
 * stale", sent to every reader — so all they do here is refresh whatever
 * is on screen, or note that it must be refreshed when next shown. They
 * raise no badge: an event that goes to everyone for every post is not
 * something addressed to you (hxd-ng's `docs/news.md` §9.3).
 *
 * What *is* addressed to you is `news_notify`, and only an account that
 * may hold subscriptions ever sees one: the Follow and Mute buttons, the
 * counts beside what is followed, and the Following screen are all drawn
 * only where the login reply's `news.subscribe` says so, so a server
 * older than subscriptions gets exactly the reader it always did.
 *
 * A body is drawn as its article's `mime` says. `text/plain` is text: the
 * only things turned into links are a URL, as in chat, and a `#51` the
 * server resolved to an article. `text/markdown` is parsed by the
 * library's article dialect and drawn as elements and text nodes — never
 * as HTML — with the same rule for references: only an id in the
 * article's `refs` is a link, whether it was written `#51` or
 * `[text](news:51)`. Search snippets and notification excerpts are the
 * server's plain text, and stay that.
 */

import {
  blocksText,
  errorText,
  markedSpans,
  newsScopeOf,
  parseArticle,
  referenceSpans,
  WireFailure,
  type Connection,
  type Events,
  type NewsArticle,
  type NewsAttachment,
  type NewsHit,
  type NewsNode,
  type NewsNodeKind,
  type NewsReference,
  type NewsScope,
  type NewsSub,
  type NewsThread,
} from '@hotline-ng/client';

import {
  attachmentLabel,
  attachmentProblem,
  canReply,
  coalesced,
  draftProblem,
  excerpt,
  expiredAttachments,
  expiryProblem,
  Following,
  highestId,
  indexTree,
  isMarkdown,
  isOwn,
  Jumps,
  markdownOffered,
  nextSearchOffset,
  notifiesThread,
  replySubject,
  staleProblem,
  tooManyAttachments,
  trailTo,
  type DraftAttachment,
} from '../news';
import { fill, h, linkify } from './dom';
import { blockNodes, wrapSelection } from './markdown';
import { MediaCache } from './media';

const NEWS_MARKDOWN_KEY = 'hxd-ng.news-markdown';

/** Whether a new draft is markdown, where the server takes it: on unless
 *  this reader turned it off last time. */
function readNewsMarkdown(): boolean {
  try {
    return localStorage.getItem(NEWS_MARKDOWN_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeNewsMarkdown(on: boolean): void {
  try {
    localStorage.setItem(NEWS_MARKDOWN_KEY, on ? 'on' : 'off');
  } catch {
    /* storage disabled; the choice lasts this page load */
  }
}

/** A listing's one line: the words, not the markup around them. */
function listingText(a: NewsArticle): string {
  return isMarkdown(a.mime) ? blocksText(parseArticle(a.body, [])) : a.body;
}

type Screen =
  /** `trail` is the bundles down to the one being shown; empty is the root. */
  | { at: 'tree'; trail: NewsNode[] }
  | { at: 'category'; trail: NewsNode[]; category: NewsNode }
  /** `focus` is an article to bring into view — the one a reference named. */
  | { at: 'thread'; trail: NewsNode[]; category: NewsNode; root: number; focus?: number }
  /** A search, scoped to the category or bundle it was typed in, if any.
   *  `trail` is the bundles above the scope, for the breadcrumb. */
  | { at: 'search'; trail: NewsNode[]; q: string; scope: NewsNode | null }
  /** Everything followed or muted. `trail` is always empty; it is here
   *  so every screen can be walked the same way. */
  | { at: 'following'; trail: NewsNode[] };

type InCategory = Extract<Screen, { at: 'category' | 'thread' }>;

const inCategory = (s: Screen): s is InCategory => s.at === 'category' || s.at === 'thread';

/** Results per search page: the wire's default. */
const SEARCH_PAGE = 20;

export interface NewsHooks {
  conn: () => Connection | null;
  /** The account this session is, for "is this article mine". */
  me: () => string | null;
  /** Something the rail's badge is drawn from has changed. */
  onUnread: () => void;
}

/** The largest thread page the wire allows. */
const THREAD_PAGE = 100;
/** How much of a thread a refresh re-reads before it stops and offers
 *  "more": enough for any conversation a person reads in one sitting,
 *  and a bound on a loop that a runaway thread could otherwise keep
 *  fetching. */
const THREAD_PRELOAD = 300;

function describe(e: unknown): string {
  return e instanceof WireFailure ? errorText(e.wire) : e instanceof Error ? e.message : String(e);
}

/** A time for a listing: the clock for today, the date otherwise. The
 *  full stamp is the element's title. */
function stamp(at: number): HTMLElement {
  const d = new Date(at * 1000);
  const now = new Date();
  const label =
    d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], {
          month: 'short',
          day: 'numeric',
          ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
        });
  return h('time', { class: 'muted', title: d.toLocaleString(), dateTime: d.toISOString() }, label);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export class NewsView {
  readonly el = h('section', { class: 'news', hidden: true });
  private bar = h('div', { class: 'news-bar' });
  private body = h('div', { class: 'news-body' });
  private crumbsEl = h('nav', { class: 'crumbs' });
  private actionsEl = h('div', { class: 'news-actions-bar' });
  /** Built once and never redrawn: the bar is redrawn whenever the news
   *  changes, and a box rebuilt under someone's typing loses their place
   *  in it. */
  private searchBox = h('input', {
    type: 'search',
    class: 'news-search',
    placeholder: 'Search news',
    ariaLabel: 'Search news',
    spellcheck: false,
    hidden: true,
  });

  /** Replaced, not edited, by every navigation and by `reset`: an answer
   *  to something asked from one screen checks this is still that one. */
  private screen: Screen = { at: 'tree', trail: [] };
  /** The screen's data is out of date and must be fetched when next shown. */
  private stale = true;
  /** The screen is new and its first answer has not come back: what is
   *  drawn is nothing yet, not an empty category. */
  private loading = true;
  /** An "older" or "more" page is out, and a second tap would only ask
   *  for the same one again. */
  private paging = false;
  /** Something this view has to say about what just happened — said
   *  here, not into the transcript this view is covering. */
  private notice: string | null = null;
  /** Something changed while a draft was open. Refreshing then would
   *  redraw the form under someone's fingers, so it waits to be asked. */
  private pendingRefresh = false;
  /** Bumped by every load and every navigation, so an answer that comes
   *  back after the reader has moved on is dropped rather than drawn. */
  private generation = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Node management and deleting other people's articles. Behind a
   *  switch because most readers have neither privilege, and a button
   *  that can only answer "access denied" is noise. */
  private managing = false;
  private busy = false;
  private error: string | null = null;
  /** Where to scroll once the next draw lands. */
  private scrollTo: 'top' | number | null = null;
  private focusDraft = false;

  private nodes: NewsNode[] = [];
  private threads: NewsThread[] = [];
  private threadsMore = false;
  private articles: NewsArticle[] = [];
  private articlesMore = false;
  private articleSnapshot: number | null = null;
  /** The open compose form: a new thread, or a reply to `parent`. Held
   *  here rather than read back off the DOM, so a redraw keeps it. */
  private draft: {
    parent?: number;
    subject: string;
    body: string;
    /** Send as `text/markdown` — honored only where the server takes it. */
    markdown: boolean;
    /** Showing the rendered draft rather than the box. */
    preview: boolean;
    /** Images already staged on the server, in display order. */
    attachments: DraftAttachment[];
  } | null = null;
  /** The open name form: creating a node of `kind`, or renaming `node`.
   *  `name` is what is typed so far, kept for the same reason as a draft. */
  private naming: ({ kind: NewsNodeKind } | { node: NewsNode }) & { name: string } | null = null;
  private backlinks = new Map<number, NewsReference[]>();
  private hits: NewsHit[] = [];
  private hitsTotal = 0;
  private hitsCapped = false;
  /** Where the next page of results starts, or `null` for no more. */
  private hitsNext: number | null = null;
  /** What this account follows, and the server's unread counts for it. */
  private following = new Following();
  /** Bumped by `reset`, so a subscription answer that was in flight
   *  across a change of session is not taken for the new one's. */
  private session = 0;
  /** Article images: one fetch per handle, blob URLs released with the
   *  session, and the transcript's refusals — a type a browser would
   *  execute, a handle the server already would not give. */
  private images = new MediaCache((conn, id) => conn.fetchNewsAttachment(id));
  /** Starts an image's fetch once its placeholder nears the viewport, so
   *  opening a thread does not download every picture in it. */
  private nearby: IntersectionObserver | null = null;
  /** What each placeholder still being watched will start. */
  private deferred = new Map<Element, () => void>();
  /** Whether a jump to an article may still land: of two in flight only
   *  the newer, and neither once the reader has moved on. */
  private jumps = new Jumps(() => this.screen);

  constructor(private hooks: NewsHooks) {
    this.bar.append(this.crumbsEl, h('span', { class: 'spacer' }), this.searchBox, this.actionsEl);
    this.el.append(this.bar, this.body);
    this.searchBox.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const q = this.searchBox.value.trim();
        if (q) this.openSearch(q);
      }
      if (e.key === 'Escape') this.searchBox.blur();
    };
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  /** The rail's badge: unread across what is followed. Until the list
   *  has been fetched it is the login reply's total. */
  get unread(): number {
    return this.following.total(this.hooks.conn()?.news?.unread ?? 0);
  }

  /** May this session follow anything? Feature-detected rather than
   *  assumed: absent is an older server, and false is a guest or a
   *  server that keeps no subscriptions. */
  private subscribable(): boolean {
    return this.hooks.conn()?.news?.subscribe === true;
  }

  show(on: boolean): void {
    this.el.hidden = !on;
    if (!on) return;
    if (this.stale) void this.load();
    this.render();
  }

  /** Forget everything: the session this was reading through is gone. */
  reset(): void {
    this.generation++;
    this.cancelRefresh();
    this.screen = { at: 'tree', trail: [] };
    this.stale = true;
    this.loading = true;
    this.paging = false;
    this.pendingRefresh = false;
    this.managing = false;
    this.error = null;
    this.notice = null;
    this.nodes = [];
    this.threads = [];
    this.articles = [];
    this.articleSnapshot = null;
    this.draft = null;
    this.naming = null;
    this.backlinks.clear();
    this.hits = [];
    this.hitsNext = null;
    this.searchBox.value = '';
    this.following.clear();
    this.forgetDeferred();
    this.images.clear();
    this.session++;
    this.el.hidden = true;
  }

  // --- following --------------------------------------------------------

  /**
   * Fetch what this account follows. Called when a session starts or
   * comes back, and after anything that may have changed it — posting
   * can subscribe you, depending on the server's `auto_subscribe`.
   *
   * Quiet on failure: the badge keeps what it had, and the Following
   * screen fetches for itself and says what went wrong there.
   *
   * Coalesced, because every notification in a scope the list does not
   * cover asks for it, and a burst of replies should not be a burst of
   * requests: one in flight, and one more after it for whatever changed
   * while it was out.
   */
  readonly refreshFollowing = coalesced(() => this.fetchFollowing());

  private async fetchFollowing(): Promise<void> {
    const conn = this.hooks.conn();
    if (!conn || !this.subscribable()) return;
    const session = this.session;
    try {
      const ok = await conn.newsSubs();
      if (session !== this.session) return;
      this.following.load(ok.subs);
    } catch {
      return;
    }
    this.hooks.onUnread();
    this.redrawCounts();
  }

  /**
   * A notification: something here is yours. Returns true when it is
   * already in front of the reader — it counts against the thread on
   * screen — so the caller need not announce it as well.
   */
  onNotify(d: Events['news_notify']): boolean {
    // Not covered means a subscription made since the list was fetched,
    // or none at all; only the server knows which.
    if (!this.following.notify(d)) void this.refreshFollowing();
    this.hooks.onUnread();
    const s = this.screen;
    const onScreen = this.visible && s.at === 'thread' && notifiesThread(d, s.root);
    // A thread on screen shows no counts. The `news_posted` beside this
    // refetches it, and drawing the new article acknowledges it; this
    // covers the notification arriving after that refetch did.
    if (onScreen) this.acknowledge();
    else this.redrawCounts();
    return onScreen;
  }

  /** Open the thread an article is in, focused on it: where a clicked
   *  notice leads. Whatever the view was fetching before is dropped, and
   *  fetched after all if the jump fails. */
  openArticle(id: number): void {
    this.generation++;
    this.cancelRefresh();
    this.stale = true;
    this.error = null;
    void this.goToArticle(id);
  }

  private openFollowing(): void {
    this.error = null;
    this.go({ at: 'following', trail: [] });
  }

  /** The counts beside things changed. Redraw them — but not under
   *  someone's typing, where the bar is all that may be touched. */
  private redrawCounts(): void {
    if (!this.visible) return;
    if (this.draft || this.naming) this.renderBar();
    else this.render();
  }

  /** Follow, unfollow, mute or unmute, then take the server's list as it
   *  now stands rather than guessing what the change did to it. */
  private async changeFollowing(act: (conn: Connection) => Promise<unknown>): Promise<void> {
    const conn = this.hooks.conn();
    if (!conn || this.busy) return;
    this.busy = true;
    try {
      await act(conn);
      this.error = null;
    } catch (e) {
      this.error = describe(e);
    } finally {
      this.busy = false;
    }
    await this.refreshFollowing();
    this.render();
  }

  /**
   * Tell the server what the reader has now been shown: the thread on
   * screen, or a followed category's listing, up to the highest article
   * in it. Explicit and only from here, because fetching is not reading
   * — the server never infers it, and neither does this.
   */
  private acknowledge(): void {
    const conn = this.hooks.conn();
    const s = this.screen;
    if (!conn || !this.subscribable() || !this.visible || this.stale) return;
    let scope: NewsScope;
    let upTo: number | null;
    if (s.at === 'thread') {
      scope = { thread: s.root };
      upTo = highestId(this.articles);
    } else if (s.at === 'category') {
      scope = { category: s.category.id };
      upTo = highestId(this.threads.map((t) => t.article));
    } else return;
    if (upTo === null) return;
    // A loose count can clear with nothing sent, so the badge is redrawn
    // on what changed rather than on whether anything was.
    const before = this.unread;
    const send = this.following.claimSeen(scope, upTo);
    if (this.unread !== before) this.hooks.onUnread();
    if (!send) return;
    const at = upTo;
    const session = this.session;
    conn.newsSeen(scope, at).then(
      (ok) => {
        if (session !== this.session) return;
        // Nonzero when what was drawn stops short of the newest article
        // in the scope. The counts on screen were cleared on the strength
        // of the claim, so they are redrawn; that redraw claims nothing,
        // because the cursor already stands where it would.
        const before = this.unread;
        this.following.seen(scope, at, ok.unread);
        this.hooks.onUnread();
        if (this.unread !== before) this.redrawCounts();
      },
      // The count was cleared on the strength of this; it did not
      // happen, so ask what the counts really are.
      () => {
        if (session === this.session) void this.refreshFollowing();
      },
    );
  }

  private async openSub(sub: NewsSub): Promise<void> {
    const from = this.screen;
    try {
      const where = await this.locate(sub.category);
      if (this.screen !== from) return;
      if (sub.scope === 'thread') this.openThread(where.trail, where.category, sub.target);
      else this.openCategory(where.trail, where.category);
    } catch (e) {
      if (this.screen !== from) return;
      this.error = describe(e);
      this.render();
    }
  }

  /** The session came back from a drop, resynced across a gap, or logged
   *  in again on the same socket. Whatever happened meanwhile went by
   *  unseen, and a refresh tried while the socket was down could only
   *  say "not connected". */
  onReconnected(): void {
    this.error = null;
    this.invalidate();
  }

  // --- events: "your copy is stale" ------------------------------------

  /** Something changed in a category that the Following list's rows say
   *  about it: a name, a thread starter's subject, a count, or the row
   *  itself, which the server drops with the thread or category it
   *  follows. Asked again only when the list holds anything there. */
  private refreshFollowingIn(category: number): void {
    if (this.following.touches(category)) void this.refreshFollowing();
  }

  onPosted(d: Events['news_posted']): void {
    const s = this.screen;
    if (
      (s.at === 'category' && s.category.id === d.category) ||
      (s.at === 'thread' && s.root === d.root) ||
      (s.at === 'tree' && this.nodes.some((n) => n.id === d.category))
    ) {
      this.invalidate();
    }
  }

  onDeleted(d: Events['news_deleted']): void {
    this.refreshFollowingIn(d.category);
    const s = this.screen;
    if (
      (s.at === 'category' && s.category.id === d.category) ||
      (s.at === 'thread' && this.articles.some((a) => a.id === d.id)) ||
      (s.at === 'tree' && this.nodes.some((n) => n.id === d.category))
    ) {
      this.invalidate();
    }
  }

  onNode(d: Events['news_node']): void {
    const node = d.node;
    this.refreshFollowingIn(node.id);
    const s = this.screen;
    // A rename of something in the breadcrumb is a new label and nothing
    // else; take it straight from the event.
    const renamed = (n: NewsNode): NewsNode => (n.id === node.id ? { ...n, name: node.name } : n);
    s.trail = s.trail.map(renamed);
    if (inCategory(s)) s.category = renamed(s.category);
    if (s.at === 'search' && s.scope) s.scope = renamed(s.scope);
    if (s.at === 'tree' && (node.parent === (s.trail.at(-1)?.id ?? null) || this.nodes.some((n) => n.id === node.id))) {
      this.invalidate();
    } else if (this.visible) {
      this.renderBar();
    }
  }

  onNodeDeleted(d: Events['news_node_deleted']): void {
    this.refreshFollowingIn(d.id);
    const s = this.screen;
    const gone = s.trail.findIndex((n) => n.id === d.id);
    const current = inCategory(s) ? s.category : s.at === 'search' ? s.scope : null;
    if (gone >= 0 || current?.id === d.id) {
      // What is on screen, or something above it, no longer exists. Step
      // up to the nearest level that still does and say why.
      const trail = gone >= 0 ? s.trail.slice(0, gone) : s.trail;
      this.error = 'What you were reading was deleted.';
      this.go({ at: 'tree', trail });
    } else if (s.at === 'tree' && this.nodes.some((n) => n.id === d.id)) {
      this.invalidate();
    }
  }

  private invalidate(): void {
    if (!this.visible) {
      this.stale = true;
      return;
    }
    if (this.draft || this.naming) {
      this.pendingRefresh = true;
      this.renderBar();
      return;
    }
    // A burst of posts is one refetch, not one each.
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      // A draft may have opened while this waited, and it waits too.
      if (this.draft || this.naming) {
        this.pendingRefresh = true;
        this.renderBar();
      } else void this.load();
    }, 150);
  }

  private cancelRefresh(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // --- navigation -------------------------------------------------------

  private go(screen: Screen): void {
    this.screen = screen;
    this.generation++;
    this.nodes = [];
    this.threads = [];
    this.threadsMore = false;
    this.articles = [];
    this.articlesMore = false;
    this.articleSnapshot = null;
    this.hits = [];
    this.hitsTotal = 0;
    this.hitsCapped = false;
    this.hitsNext = null;
    this.draft = null;
    this.naming = null;
    this.backlinks.clear();
    this.notice = null;
    this.paging = false;
    // The last screen comes down now rather than when this one's answer
    // lands, so nothing on it is left to click in the meantime.
    this.loading = true;
    this.render();
    this.scrollTo = screen.at === 'thread' && screen.focus !== undefined ? screen.focus : 'top';
    void this.load();
  }

  private openTree(trail: NewsNode[]): void {
    this.error = null;
    this.go({ at: 'tree', trail });
  }

  private openCategory(trail: NewsNode[], category: NewsNode): void {
    this.error = null;
    this.go({ at: 'category', trail, category });
  }

  private openThread(trail: NewsNode[], category: NewsNode, root: number, focus?: number): void {
    this.error = null;
    this.go({ at: 'thread', trail, category, root, focus });
  }

  /** Follow a reference: find the article's thread, and the category that
   *  thread is in, wherever in the tree that is. */
  private async goToArticle(id: number): Promise<void> {
    const conn = this.hooks.conn();
    if (!conn) return;
    // Its answer, or its failure, is dropped once it is no longer the
    // jump to land; `Jumps` says when that is.
    const current = this.jumps.begin();
    try {
      const article = await conn.newsArticle(id);
      if (!current()) return;
      const where = await this.locate(article.category);
      if (!current()) return;
      this.openThread(where.trail, where.category, article.root, id);
    } catch (e) {
      if (!current()) return;
      this.error = describe(e);
      // A jump from a notice dropped what the screen was fetching. With
      // nowhere to land — a pruned article, a dropped socket — the screen
      // it left is fetched after all, and the error drawn over that
      // rather than over a "Loading…" that never ends.
      if (this.stale && this.visible) void this.load();
      else this.render();
    }
  }

  /** The breadcrumb down to a category. The one on screen answers for
   *  itself; anything else takes a tree request deep enough to find it. */
  private async locate(category: number): Promise<{ trail: NewsNode[]; category: NewsNode }> {
    const s = this.screen;
    if (inCategory(s) && s.category.id === category) return { trail: s.trail, category: s.category };
    const conn = this.hooks.conn();
    const path = conn ? trailTo(category, indexTree((await conn.newsTree({ depth: 4 })).nodes)) : null;
    const found = path?.at(-1);
    if (path && found) return { trail: path.slice(0, -1), category: found };
    // Deeper than four levels: a server can nest that far, and this
    // client does not chase it. The thread still reads; only the
    // breadcrumb above it is missing.
    return {
      trail: [],
      category: { id: category, parent: null, kind: 'category', name: 'Category', count: 0, created_at: 0 },
    };
  }

  // --- loading ----------------------------------------------------------

  private async load(): Promise<void> {
    const conn = this.hooks.conn();
    if (!conn) return;
    this.cancelRefresh();
    const gen = ++this.generation;
    this.stale = false;
    this.pendingRefresh = false;
    const s = this.screen;
    try {
      if (s.at === 'tree') {
        const parent = s.trail.at(-1)?.id;
        const ok = await conn.newsTree(parent === undefined ? {} : { parent });
        if (gen !== this.generation) return;
        this.nodes = ok.nodes;
      } else if (s.at === 'category') {
        // As deep as the reader had already paged, so a refresh does not
        // throw away the older threads they scrolled down to.
        const limit = Math.min(200, Math.max(50, this.threads.length));
        const ok = await conn.newsThreads({ category: s.category.id, limit });
        if (gen !== this.generation) return;
        this.threads = ok.threads;
        this.threadsMore = ok.has_more;
      } else if (s.at === 'search') {
        // As deep as the reader had already paged, like a category.
        const limit = Math.max(SEARCH_PAGE, Math.min(50, this.hits.length));
        const ok = await conn.newsSearch(
          s.scope ? { q: s.q, category: s.scope.id, limit } : { q: s.q, limit },
        );
        if (gen !== this.generation) return;
        this.hits = ok.hits;
        this.hitsTotal = ok.total;
        this.hitsCapped = ok.capped;
        this.hitsNext = nextSearchOffset(0, ok.hits.length, ok.total, conn.news?.search_max_results);
      } else if (s.at === 'following') {
        const ok = await conn.newsSubs();
        if (gen !== this.generation) return;
        this.following.load(ok.subs);
        this.hooks.onUnread();
      } else {
        const want = Math.max(this.articles.length, THREAD_PAGE);
        let all: NewsArticle[] = [];
        let after: number | undefined;
        let snapshot: number | undefined;
        let more = true;
        while (more && all.length < want && all.length < THREAD_PRELOAD) {
          const page = await conn.newsThread(
            after === undefined
              ? { root: s.root, limit: THREAD_PAGE }
              : { root: s.root, after, snapshot, limit: THREAD_PAGE },
          );
          if (gen !== this.generation) return;
          all = all.concat(page.articles);
          more = page.has_more;
          snapshot = page.snapshot;
          after = page.articles.at(-1)?.id;
          if (after === undefined) break;
        }
        this.articles = all;
        this.articlesMore = more;
        this.articleSnapshot = snapshot ?? null;
      }
    } catch (e) {
      if (gen !== this.generation) return;
      // The thing on screen has gone — a category deleted, a thread
      // pruned. Say so and step up a level rather than drawing an error
      // over nothing.
      if (e instanceof WireFailure && (e.wire.code === 'no_such_node' || e.wire.code === 'no_such_article')) {
        this.error = errorText(e.wire);
        if (s.at === 'thread') return this.go({ at: 'category', trail: s.trail, category: s.category });
        if (s.at === 'category') return this.go({ at: 'tree', trail: s.trail });
        // A search's trail already stops above its scope, so it is the
        // scope's parent as it stands.
        if (s.at === 'search') return this.go({ at: 'tree', trail: s.trail });
        if (s.trail.length) return this.go({ at: 'tree', trail: s.trail.slice(0, -1) });
      }
      this.error = describe(e);
    }
    this.loading = false;
    this.render();
  }

  private async loadOlderThreads(): Promise<void> {
    const conn = this.hooks.conn();
    const s = this.screen;
    const before = this.threads.at(-1)?.article.id;
    if (!conn || s.at !== 'category' || before === undefined || this.paging) return;
    const gen = this.generation;
    this.paging = true;
    try {
      const ok = await conn.newsThreads({ category: s.category.id, before });
      if (gen !== this.generation) return;
      this.threads = this.threads.concat(ok.threads.filter((t) => !this.threads.some((x) => x.article.id === t.article.id)));
      this.threadsMore = ok.has_more;
    } catch (e) {
      if (gen !== this.generation) return;
      this.error = describe(e);
    } finally {
      this.paging = false;
    }
    this.render();
  }

  private async loadMoreArticles(): Promise<void> {
    const conn = this.hooks.conn();
    const s = this.screen;
    const after = this.articles.at(-1)?.id;
    const snapshot = this.articleSnapshot;
    if (!conn || s.at !== 'thread' || after === undefined || snapshot === null || this.paging) return;
    const gen = this.generation;
    this.paging = true;
    try {
      const page = await conn.newsThread({ root: s.root, after, snapshot, limit: THREAD_PAGE });
      if (gen !== this.generation) return;
      // An article already here is not drawn twice, whatever the page
      // overlapped: two elements with one id is a thread that scrolls to
      // the wrong place.
      const have = new Set(this.articles.map((a) => a.id));
      this.articles = this.articles.concat(page.articles.filter((a) => !have.has(a.id)));
      this.articlesMore = page.has_more;
      this.articleSnapshot = page.snapshot;
    } catch (e) {
      if (gen !== this.generation) return;
      this.error = describe(e);
    } finally {
      this.paging = false;
    }
    this.render();
  }

  // --- acting -----------------------------------------------------------

  private async submit(parent?: NewsArticle): Promise<void> {
    const conn = this.hooks.conn();
    const cfg = conn?.news;
    const d = this.draft;
    const s = this.screen;
    if (!conn || !cfg || !d || this.busy || !inCategory(s)) return;
    const problem =
      draftProblem(d.subject, d.body, cfg) ??
      attachmentProblem(d.attachments, cfg) ??
      expiryProblem(d.attachments, Date.now());
    if (problem) {
      this.error = problem;
      return this.render();
    }
    this.busy = true;
    try {
      // The source, verbatim, and its type: the server stores what was
      // typed and every reader renders it for themselves.
      const mime = markdownOffered(cfg) && d.markdown ? { mime: 'text/markdown' } : {};
      const params = {
        category: s.category.id,
        subject: d.subject.trim(),
        body: d.body,
        attach: d.attachments.map((a) => a.id),
        ...mime,
      };
      const { id } = await conn.newsPost(parent ? { ...params, parent: parent.id } : params);
      // Posted, wherever the reader is now. One who moved on while it
      // went is left there, along with any draft they started there.
      if (this.screen !== s) return;
      this.draft = null;
      this.error = null;
      // Posting may have subscribed the poster, which only the list says.
      void this.refreshFollowing();
      // A new thread opens; a reply is shown where it landed.
      if (s.at === 'category') this.openThread(s.trail, s.category, id);
      else {
        s.focus = id;
        this.scrollTo = id;
        await this.load();
      }
    } catch (e) {
      if (this.screen !== s) return;
      // Only a staged handle draws this from a post, and none had lapsed
      // by this page's clock or the check above would have said so.
      this.error =
        e instanceof WireFailure && e.wire.code === 'no_such_media' && d.attachments.length
          ? staleProblem(d.attachments)
          : describe(e);
      // Not busy by the time it is drawn, or the attachment picker it
      // draws stays disabled until something unrelated redraws.
      this.busy = false;
      this.render();
    } finally {
      this.busy = false;
    }
  }

  private async deleteArticle(a: NewsArticle): Promise<void> {
    const conn = this.hooks.conn();
    if (!conn) return;
    const whose = isOwn(a.from, this.hooks.me()) ? 'your article' : `${a.from.nick}’s article`;
    if (!confirm(`Delete ${whose} “${a.subject}”? Its replies stay where they are.`)) return;
    try {
      await conn.newsDelete(a.id);
      await this.load();
    } catch (e) {
      this.error = describe(e);
      this.render();
    }
  }

  private async toggleBacklinks(a: NewsArticle): Promise<void> {
    if (this.backlinks.delete(a.id)) return this.render();
    const conn = this.hooks.conn();
    if (!conn) return;
    const from = this.screen;
    try {
      const refs = (await conn.newsRefs(a.id)).referenced_by;
      if (this.screen !== from) return;
      this.backlinks.set(a.id, refs);
    } catch (e) {
      if (this.screen !== from) return;
      this.error = describe(e);
    }
    this.render();
  }

  private async saveName(name: string): Promise<void> {
    const conn = this.hooks.conn();
    const n = this.naming;
    const s = this.screen;
    if (!conn || !n || !name.trim()) return;
    try {
      if ('node' in n) await conn.newsNodeRename(n.node.id, name);
      else {
        const parent = s.trail.at(-1)?.id;
        await conn.newsNodeCreate(parent === undefined ? { kind: n.kind, name } : { kind: n.kind, name, parent });
      }
      this.naming = null;
      this.error = null;
      await this.load();
    } catch (e) {
      this.error = describe(e);
      this.render();
    }
  }

  private async deleteNode(node: NewsNode): Promise<void> {
    const conn = this.hooks.conn();
    if (!conn) return;
    const what =
      node.kind === 'category'
        ? `the category “${node.name}” and ${plural(node.count, 'article', 'articles')} in it`
        : `the bundle “${node.name}”`;
    if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
    try {
      const { articles } = await conn.newsNodeDelete(node.id);
      this.notice = `Deleted “${node.name}”${articles ? `, and ${plural(articles, 'article', 'articles')} with it` : ''}.`;
      this.error = null;
      await this.load();
    } catch (e) {
      this.error = describe(e);
      this.render();
    }
  }

  // --- searching --------------------------------------------------------

  /** Search from wherever the reader is: inside a category or a bundle
   *  the search is scoped to it, and the results offer to widen it. */
  private openSearch(q: string, everywhere = false): void {
    const s = this.screen;
    let trail: NewsNode[] = [];
    let scope: NewsNode | null = null;
    if (!everywhere) {
      if (inCategory(s)) {
        trail = s.trail;
        scope = s.category;
      } else if (s.at === 'tree' && s.trail.length) {
        trail = s.trail.slice(0, -1);
        scope = s.trail.at(-1) ?? null;
      } else if (s.at === 'search') {
        trail = s.trail;
        scope = s.scope;
      }
    }
    this.searchBox.value = q;
    this.error = null;
    this.go({ at: 'search', trail, q, scope });
  }

  private async loadMoreHits(): Promise<void> {
    const conn = this.hooks.conn();
    const s = this.screen;
    const offset = this.hitsNext;
    if (!conn || s.at !== 'search' || offset === null) return;
    const gen = this.generation;
    try {
      const ok = await conn.newsSearch(
        s.scope ? { q: s.q, category: s.scope.id, offset } : { q: s.q, offset },
      );
      if (gen !== this.generation) return;
      // Offset paging over a relevance order shifts when something is
      // posted between pages; an id seen twice is shown once.
      this.hits = this.hits.concat(ok.hits.filter((h) => !this.hits.some((x) => x.id === h.id)));
      this.hitsTotal = ok.total;
      this.hitsCapped = ok.capped;
      this.hitsNext = nextSearchOffset(offset, ok.hits.length, ok.total, conn.news?.search_max_results);
    } catch (e) {
      if (gen !== this.generation) return;
      this.error = describe(e);
    }
    this.render();
  }

  private async openHit(hit: NewsHit): Promise<void> {
    // Checked by screen, as a followed reference is: a refresh bumps the
    // generation and should not eat the click, but a reader who has gone
    // somewhere else is not dragged back.
    const from = this.screen;
    try {
      const where = await this.locate(hit.category);
      if (this.screen !== from) return;
      this.openThread(where.trail, where.category, hit.root, hit.id);
    } catch (e) {
      if (this.screen !== from) return;
      this.error = describe(e);
      this.render();
    }
  }

  private searchView(s: Extract<Screen, { at: 'search' }>): (HTMLElement | null)[] {
    const out: (HTMLElement | null)[] = [];
    const reachable = this.hooks.conn()?.news?.search_max_results ?? Infinity;
    if (!this.stale) {
      // A capped total is where the counting stopped, not how many there
      // are.
      const count = this.hitsCapped ? `${this.hitsTotal}+ results` : plural(this.hitsTotal, 'result', 'results');
      const summary = this.hitsTotal ? `${count} for “${s.q}”` : `Nothing matches “${s.q}”`;
      const head = h('p', { class: 'news-search-head' }, summary);
      if (s.scope) {
        const widen = h('button', { class: 'news-link' }, 'search everywhere');
        widen.onclick = () => this.openSearch(s.q, true);
        head.append(` in “${s.scope.name}” · `, widen);
      }
      if (this.hitsCapped) {
        head.append(` · the first ${reachable} can be shown; narrow the search to reach the rest`);
      }
      out.push(head);
    }
    for (const hit of this.hits) {
      const snippet = markedSpans(hit.snippet, hit.marks).map((span) =>
        span.mark ? h('mark', {}, span.text) : span.text,
      );
      const row = h(
        'button',
        { class: 'news-thread news-hit' },
        h('span', { class: 'news-thread-subject' }, hit.subject),
        hit.snippet ? h('span', { class: 'news-hit-snippet' }, ...snippet) : null,
        h('span', { class: 'news-thread-meta' }, `${hit.from} · `, stamp(hit.at)),
      );
      row.onclick = () => void this.openHit(hit);
      out.push(row);
    }
    if (this.hitsNext !== null) {
      const more = h('button', { class: 'news-more' }, 'More results');
      more.onclick = () => {
        more.disabled = true;
        void this.loadMoreHits();
      };
      out.push(more);
    }
    return out;
  }

  // --- drawing ----------------------------------------------------------

  private render(): void {
    this.renderBar();
    // Every placeholder the last draw was watching is about to be
    // replaced, and this draw watches its own.
    this.forgetDeferred();
    const s = this.screen;
    const content =
      s.at === 'tree'
        ? this.treeView(s)
        : s.at === 'category'
          ? this.categoryView(s)
          : s.at === 'search'
            ? this.searchView(s)
            : s.at === 'following'
              ? this.followingView()
              : this.threadView();
    fill(this.body, this.error ? h('p', { class: 'news-error' }, this.error) : null, ...content);
    if (this.notice) this.body.prepend(h('p', { class: 'news-notice' }, this.notice));
    if (this.loading) this.body.append(h('p', { class: 'news-loading' }, 'Loading…'));

    const target = this.scrollTo;
    this.scrollTo = null;
    if (target === 'top') this.body.scrollTop = 0;
    else if (typeof target === 'number') {
      this.body.querySelector(`#news-${target}`)?.scrollIntoView({ block: 'center' });
    }
    if (this.focusDraft) {
      this.focusDraft = false;
      const field = this.body.querySelector<HTMLElement>(
        this.naming
          ? '.news-name-input'
          : this.draft?.parent === undefined
            ? '.news-compose input'
            : '.news-compose textarea',
      );
      field?.focus();
    }
    this.acknowledge();
  }

  private renderBar(): void {
    const s = this.screen;
    const crumbs: HTMLElement[] = [];
    const crumb = (label: string, go: (() => void) | null) => {
      const b = h('button', { class: `crumb${go ? '' : ' current'}`, title: label }, label);
      if (go) b.onclick = go;
      else b.disabled = true;
      if (crumbs.length) crumbs.push(h('span', { class: 'crumb-sep' }, '›'));
      crumbs.push(b);
    };
    crumb('News', s.at === 'tree' && !s.trail.length ? null : () => this.openTree([]));
    s.trail.forEach((node, i) => {
      const here = s.at === 'tree' && i === s.trail.length - 1;
      crumb(node.name, here ? null : () => this.openTree(s.trail.slice(0, i + 1)));
    });
    if (inCategory(s)) {
      crumb(s.category.name, s.at === 'category' ? null : () => this.openCategory(s.trail, s.category));
    }
    if (s.at === 'thread') crumb(this.articles[0]?.subject || 'Thread', null);
    if (s.at === 'search') {
      const scope = s.scope;
      if (scope) {
        crumb(scope.name, () =>
          scope.kind === 'bundle' ? this.openTree([...s.trail, scope]) : this.openCategory(s.trail, scope),
        );
      }
      crumb(`Search: ${s.q}`, null);
    }
    if (s.at === 'following') crumb('Following', null);

    const actions: HTMLElement[] = [];
    const action = (label: string, fn: () => void, opts: { on?: boolean; title?: string; disabled?: boolean } = {}) => {
      const b = h('button', { class: `ghost${opts.on ? ' on' : ''}`, title: opts.title ?? label }, label);
      // A glyph for a label says nothing much read aloud; its title is
      // what it means.
      if (!/\p{L}/u.test(label)) b.ariaLabel = opts.title ?? label;
      b.onclick = fn;
      b.disabled = !!opts.disabled;
      actions.push(b);
    };
    if (this.pendingRefresh) action('New activity', () => void this.load(), { on: true, title: 'Something changed here. Load it.' });
    if (s.at === 'category') {
      const may = !!this.hooks.conn()?.news?.post;
      action(
        'New thread',
        () => {
          this.draft = { subject: '', body: '', markdown: readNewsMarkdown(), preview: false, attachments: [] };
          this.focusDraft = true;
          this.render();
        },
        { disabled: !may || this.draft?.parent === undefined && this.draft !== null, title: may ? 'Start a thread' : 'You may not post here.' },
      );
    }
    const followScope: NewsScope | null = !this.subscribable()
      ? null
      : s.at === 'thread'
        ? { thread: s.root }
        : s.at === 'category'
          ? { category: s.category.id }
          : null;
    if (followScope) {
      const sub = this.following.get(followScope);
      const thread = followScope.thread !== undefined;
      // A muted row is not something followed, whatever the server
      // keeps it as; it offers only to be unmuted.
      if (!sub?.muted) {
        action(
          sub ? 'Following' : 'Follow',
          () => void this.changeFollowing((c) => (sub ? c.newsUnsubscribe(followScope) : c.newsSubscribe(followScope))),
          {
            on: !!sub,
            title: sub
              ? `${sub.auto ? 'Following because you posted here.' : 'Following.'} Click to stop.${thread ? ' Replies to your own articles still reach you; Mute says never.' : ''}`
              : thread
                ? 'Be told when someone posts in this thread'
                : 'Be told when someone starts a thread here',
          },
        );
      }
      action(sub?.muted ? 'Muted' : 'Mute', () => void this.changeFollowing((c) => c.newsMute(followScope, !sub?.muted)), {
        on: !!sub?.muted,
        title: sub?.muted
          ? 'Muted. Click to be told again.'
          : thread
            ? 'Never be told about this thread, not even replies to you'
            : 'Never be told about new threads here',
      });
    }
    action('Manage', () => {
      this.managing = !this.managing;
      this.naming = null;
      this.render();
    }, { on: this.managing, title: 'Create, rename and delete — for those who may' });
    action('↻', () => void this.load(), { title: 'Refresh' });

    fill(this.crumbsEl, ...crumbs);
    fill(this.actionsEl, ...actions);
    // Offered where the server answers it; the placeholder says where a
    // search typed here will look.
    this.searchBox.hidden = !this.hooks.conn()?.news?.search;
    const scope = inCategory(s) ? s.category : s.at === 'tree' ? s.trail.at(-1) : s.at === 'search' ? s.scope : null;
    this.searchBox.placeholder = scope ? `Search ${scope.name}` : 'Search news';
    this.searchBox.ariaLabel = this.searchBox.placeholder;
  }

  private treeView(s: Extract<Screen, { at: 'tree' }>): (HTMLElement | null)[] {
    const out: (HTMLElement | null)[] = [];
    if (this.managing) {
      const make = (kind: NewsNodeKind, label: string) => {
        const b = h('button', { class: 'ghost' }, label);
        b.onclick = () => {
          this.naming = { kind, name: '' };
          this.focusDraft = true;
          this.render();
        };
        return b;
      };
      out.push(h('div', { class: 'news-manage' }, make('category', 'New category'), make('bundle', 'New bundle')));
    }
    if (this.naming && 'kind' in this.naming) out.push(this.nameForm());
    if (!s.trail.length && this.subscribable()) {
      // What is followed sits above the tree rather than in the bar:
      // it is somewhere to go, like a category, not something to do.
      const n = this.unread;
      const open = h(
        'button',
        { class: 'news-node news-following', title: 'What you follow' },
        h('span', { class: 'glyph' }, '★'),
        h('span', { class: 'name' }, 'Following'),
        n ? h('span', { class: 'badge', title: `${plural(n, 'unread article', 'unread articles')}` }, String(n)) : null,
      );
      open.onclick = () => this.openFollowing();
      out.push(h('div', { class: 'news-node-row' }, open));
    }
    if (!this.nodes.length && !this.loading) {
      out.push(h('p', { class: 'news-empty' }, s.trail.length ? 'This bundle is empty.' : 'There is no news here yet.'));
    }
    for (const node of this.nodes) {
      if (this.naming && 'node' in this.naming && this.naming.node.id === node.id) {
        out.push(this.nameForm());
        continue;
      }
      const unread = node.kind === 'category' ? this.following.unreadIn(node.id) : 0;
      const open = h(
        'button',
        { class: 'news-node' },
        h('span', { class: 'glyph' }, node.kind === 'bundle' ? '▸' : '#'),
        h('span', { class: 'name' }, node.name),
        h(
          'span',
          { class: 'count' },
          node.kind === 'bundle' ? plural(node.count, 'item', 'items') : plural(node.count, 'article', 'articles'),
        ),
        unread ? h('span', { class: 'badge', title: 'Unread in what you follow here' }, String(unread)) : null,
      );
      open.onclick = () =>
        node.kind === 'bundle' ? this.openTree([...s.trail, node]) : this.openCategory(s.trail, node);
      const row = h('div', { class: 'news-node-row' }, open);
      if (this.managing) {
        const rename = h('button', { class: 'ghost small' }, 'Rename');
        rename.onclick = () => {
          this.naming = { node, name: node.name };
          this.focusDraft = true;
          this.render();
        };
        const del = h('button', { class: 'ghost small danger' }, 'Delete');
        del.onclick = () => void this.deleteNode(node);
        row.append(rename, del);
      }
      out.push(row);
    }
    return out;
  }

  private nameForm(): HTMLElement {
    const n = this.naming!;
    const renaming = 'node' in n;
    const label = renaming ? 'New name' : n.kind === 'bundle' ? 'Bundle name' : 'Category name';
    // The value comes from state and goes back to it on every keystroke,
    // so a redraw under someone's typing keeps what they typed. Focus is
    // the render's to give, once, when the form opens.
    const input = h('input', { class: 'news-name-input', placeholder: label, ariaLabel: label, value: n.name });
    input.oninput = () => (n.name = input.value);
    const save = h('button', { class: 'primary' }, renaming ? 'Rename' : 'Create');
    const cancel = h('button', { class: 'ghost' }, 'Cancel');
    save.onclick = () => void this.saveName(n.name.trim());
    cancel.onclick = () => {
      this.naming = null;
      if (this.pendingRefresh) void this.load();
      else this.render();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') save.click();
      if (e.key === 'Escape') cancel.click();
    };
    return h('div', { class: 'news-name-form' }, input, save, cancel);
  }

  private categoryView(s: Extract<Screen, { at: 'category' }>): (HTMLElement | null)[] {
    const out: (HTMLElement | null)[] = [];
    if (this.draft && this.draft.parent === undefined) out.push(this.composer());
    if (!this.threads.length && !this.loading) {
      out.push(h('p', { class: 'news-empty' }, 'No threads here yet.'));
    }
    for (const t of this.threads) {
      const a = t.article;
      const unread = this.following.unreadOf({ thread: a.id });
      const row = h(
        'button',
        { class: `news-thread${a.deleted ? ' deleted' : ''}` },
        h(
          'span',
          { class: 'news-thread-head' },
          h('span', { class: 'news-thread-subject' }, a.deleted ? 'Deleted article' : a.subject),
          unread ? h('span', { class: 'badge', title: plural(unread, 'unread reply', 'unread replies') }, String(unread)) : null,
        ),
        a.deleted ? null : h('span', { class: 'news-thread-excerpt' }, excerpt(listingText(a))),
        h(
          'span',
          { class: 'news-thread-meta' },
          `${a.deleted ? '—' : a.from.nick} · ${plural(t.replies, 'reply', 'replies')} · `,
          stamp(t.last_at),
        ),
      );
      row.onclick = () => this.openThread(s.trail, s.category, a.id);
      out.push(row);
    }
    if (this.threadsMore) {
      const more = h('button', { class: 'news-more' }, 'Older threads');
      more.onclick = () => {
        more.disabled = true;
        void this.loadOlderThreads();
      };
      out.push(more);
    }
    return out;
  }

  private followingView(): (HTMLElement | null)[] {
    const out: (HTMLElement | null)[] = [];
    if (this.stale) return out;
    const subs = this.following.list();
    const auto = this.hooks.conn()?.news?.auto_subscribe;
    const how =
      auto === 'participated'
        ? 'Posting in a thread follows it.'
        : auto === 'own_thread'
          ? 'Starting a thread follows it.'
          : 'Follow a thread or a category from its own page.';
    out.push(h('p', { class: 'news-search-head' }, subs.length ? how : `You follow nothing yet. ${how}`));
    for (const sub of subs) {
      const scope = newsScopeOf(sub);
      const unread = this.following.unreadOf(scope);
      const label = sub.scope === 'thread' ? sub.subject || 'Deleted article' : (sub.name ?? 'Category');
      const tags = [sub.scope, sub.auto ? 'because you posted' : null, sub.muted ? 'muted' : null].filter(Boolean).join(' · ');
      const open = h(
        'button',
        { class: `news-node${sub.muted ? ' muted' : ''}` },
        h('span', { class: 'glyph' }, sub.scope === 'category' ? '#' : '¶'),
        h('span', { class: 'name' }, label),
        h('span', { class: 'count' }, tags),
        unread ? h('span', { class: 'badge' }, String(unread)) : null,
      );
      open.onclick = () => void this.openSub(sub);
      const drop = h('button', { class: 'ghost small' }, sub.muted ? 'Unmute' : 'Unfollow');
      drop.onclick = () =>
        void this.changeFollowing((c) => (sub.muted ? c.newsMute(scope, false) : c.newsUnsubscribe(scope)));
      out.push(h('div', { class: 'news-node-row' }, open, drop));
    }
    return out;
  }

  private threadView(): (HTMLElement | null)[] {
    const out: (HTMLElement | null)[] = this.articles.map((a) => this.articleEl(a));
    if (this.articlesMore) {
      const more = h('button', { class: 'news-more' }, 'More of this thread');
      more.onclick = () => {
        more.disabled = true;
        void this.loadMoreArticles();
      };
      out.push(more);
    }
    return out;
  }

  private articleEl(a: NewsArticle): HTMLElement {
    const s = this.screen;
    const cfg = this.hooks.conn()?.news ?? null;
    const focus = s.at === 'thread' && s.focus === a.id;
    const el = h('article', { class: `news-article${a.deleted ? ' deleted' : ''}${focus ? ' focus' : ''}`, id: `news-${a.id}` });
    // Indentation is how a thread shows who answered whom, and it stops
    // somewhere: past a few levels it only pushes the text off a phone.
    el.style.setProperty('--depth', String(Math.min(a.depth, 6)));

    el.append(
      h(
        'div',
        { class: 'news-meta' },
        h('span', { class: 'news-author' }, a.deleted ? 'Deleted' : a.from.nick || 'guest'),
        stamp(a.at),
        h('span', { class: 'news-id muted' }, `#${a.id}`),
      ),
    );
    if (a.deleted) {
      el.append(h('div', { class: 'news-text muted' }, 'This article was deleted.'));
    } else {
      el.append(
        h('div', { class: 'news-subject-line' }, a.subject),
        h('div', { class: isMarkdown(a.mime) ? 'news-text md' : 'news-text' }, ...this.bodyNodes(a)),
      );
      if (a.attachments.length) {
        el.append(h('div', { class: 'news-attachments' }, ...a.attachments.map((item) => this.attachmentEl(item))));
      }
    }

    const actions: HTMLElement[] = [];
    if (canReply(a, cfg)) {
      const reply = h('button', {}, 'Reply');
      reply.onclick = () => {
        this.draft = {
          parent: a.id,
          subject: replySubject(a.subject),
          body: '',
          markdown: readNewsMarkdown(),
          preview: false,
          attachments: [],
        };
        this.focusDraft = true;
        this.render();
      };
      actions.push(reply);
    }
    if (!a.deleted && (isOwn(a.from, this.hooks.me()) || this.managing)) {
      const del = h('button', { class: 'danger' }, 'Delete');
      del.onclick = () => void this.deleteArticle(a);
      actions.push(del);
    }
    if (a.referenced_by > 0) {
      const open = this.backlinks.has(a.id);
      const cited = h('button', { class: open ? 'on' : '' }, `Cited by ${a.referenced_by}`);
      cited.onclick = () => void this.toggleBacklinks(a);
      actions.push(cited);
    }
    if (actions.length) el.append(h('div', { class: 'news-actions' }, ...actions));

    const back = this.backlinks.get(a.id);
    if (back) {
      el.append(
        h(
          'div',
          { class: 'news-backlinks' },
          ...back.map((r) => {
            const link = this.refLink(r, r.deleted ? `#${r.id} (deleted)` : `#${r.id} ${r.subject ?? ''} — ${r.from ?? ''}`);
            return h('div', {}, link);
          }),
        ),
      );
    }
    if (this.draft?.parent === a.id) el.append(this.composer(a));
    return el;
  }

  /** A body as its type says: markdown drawn as elements, plain text as
   *  text — URLs and resolved references as links in both. */
  private bodyNodes(a: NewsArticle): (Node | string)[] {
    if (isMarkdown(a.mime)) {
      return blockNodes(parseArticle(a.body, a.refs), { ref: (r, label) => this.refLink(r, label) });
    }
    return referenceSpans(a.body, a.refs).flatMap((span) =>
      'ref' in span ? [this.refLink(span.ref, span.text)] : linkify(span.text),
    );
  }

  /** An article's image: a placeholder at the image's own proportions,
   *  so the thread does not reflow as pictures land, which becomes the
   *  picture once it is near enough to be worth fetching. */
  private attachmentEl(item: NewsAttachment): HTMLElement {
    const img = h('img', {
      class: 'news-attachment',
      alt: item.name ?? 'Article attachment',
      width: item.width,
      height: item.height,
    });
    const figure = h('figure', { class: 'news-attachment-wrap' }, img, item.name ? h('figcaption', {}, item.name) : null);
    this.images.attach(this.hooks.conn());
    // One already in hand goes straight in, so a redraw does not blank it.
    const held = this.images.held(item.id);
    if (held) {
      img.src = held;
      return figure;
    }
    // The fetch is what is deferred, not the `<img>`: `loading="lazy"`
    // would defer nothing, because by the time there is a `src` the
    // bytes are already here.
    this.whenNear(figure, () => {
      this.images.attach(this.hooks.conn());
      // The type is the article's, not the response's; the cache builds
      // the blob with it and refuses one a browser would execute.
      void this.images.url(item.id, item.type).then((url) => {
        // Redrawn or navigated away from while it was fetched: nothing
        // is showing this one to decode it for.
        if (!figure.isConnected) return;
        if (url) img.src = url;
        else img.classList.add('missing');
      });
    });
    return figure;
  }

  /** Call `load` once `el` is within a screen or so of the news pane's
   *  visible part — or straight away where there is no
   *  `IntersectionObserver` to ask. Watched until it fires or the next
   *  render, whichever is first. */
  private whenNear(el: Element, load: () => void): void {
    if (typeof IntersectionObserver === 'undefined') return load();
    this.nearby ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this.nearby?.unobserve(e.target);
          const run = this.deferred.get(e.target);
          this.deferred.delete(e.target);
          run?.();
        }
      },
      // The pane scrolls, not the page, so it is the root; the margin is
      // so an image is fetched before it is scrolled to rather than after.
      { root: this.body, rootMargin: '600px 0px' },
    );
    this.deferred.set(el, load);
    this.nearby.observe(el);
  }

  /** Stop watching every placeholder: they are about to be replaced, or
   *  the session they would be fetched through is over. */
  private forgetDeferred(): void {
    this.nearby?.disconnect();
    this.deferred.clear();
  }

  private refLink(r: NewsReference, label: string | (Node | string)[]): HTMLElement {
    const link = h(
      'a',
      {
        href: `#news-${r.id}`,
        class: `news-ref${r.deleted ? ' gone' : ''}`,
        title: r.deleted ? 'That article was deleted.' : `${r.subject ?? ''} — ${r.from ?? ''}`,
      },
      ...(typeof label === 'string' ? [label] : label),
    );
    link.onclick = (e) => {
      e.preventDefault();
      if (!r.deleted) void this.goToArticle(r.id);
    };
    return link;
  }

  private composer(parent?: NewsArticle): HTMLElement {
    const d = this.draft!;
    const subject = h('input', { class: 'news-subject-input', placeholder: 'Subject', ariaLabel: 'Subject', value: d.subject });
    subject.oninput = () => (d.subject = subject.value);
    const text = h('textarea', {
      class: 'news-body-input',
      rows: parent ? 4 : 8,
      placeholder: parent ? `Reply to ${parent.from.nick || 'this'}…` : 'Write something…',
      ariaLabel: parent ? 'Reply' : 'Article',
      value: d.body,
    });
    text.oninput = () => (d.body = text.value);
    // Offered only where the login reply lists `text/markdown`; anywhere
    // else a draft is plain text whatever the reader chose last time.
    const offered = markdownOffered(this.hooks.conn()?.news ?? null);
    const markdown = () => offered && d.markdown;
    const post = h('button', { class: 'primary' }, parent ? 'Post reply' : 'Post');
    post.onclick = () => void this.submit(parent);
    text.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        post.click();
      }
      // The chat composer's shortcuts, where they mean something.
      if (markdown() && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'b' || e.key === 'i')) {
        e.preventDefault();
        const w = wrapSelection(text.value, text.selectionStart, text.selectionEnd, e.key === 'b' ? '**' : '*');
        text.value = d.body = w.value;
        text.setSelectionRange(w.start, w.end);
      }
    };
    const cancel = h('button', { class: 'ghost' }, 'Cancel');
    cancel.onclick = () => {
      this.draft = null;
      this.error = null;
      if (this.pendingRefresh) void this.load();
      else this.render();
    };

    // The preview is the reader's own renderer over the draft, so what it
    // shows is what everyone will see — except references, which the
    // server resolves only once the article is posted, and so are drawn
    // here as the text they are until then.
    const preview = h('div', { class: 'news-text md news-preview', hidden: true });
    const previewBtn = h('button', { class: 'ghost' }, 'Preview');
    const showPreview = (on: boolean) => {
      d.preview = on && markdown();
      text.hidden = d.preview;
      preview.hidden = !d.preview;
      previewBtn.textContent = d.preview ? 'Edit' : 'Preview';
      if (d.preview) {
        fill(preview, ...(d.body.trim() ? blockNodes(parseArticle(d.body, [])) : [h('p', { class: 'muted' }, 'Nothing to preview yet.')]));
      }
    };
    previewBtn.onclick = () => {
      showPreview(!d.preview);
      if (!d.preview) text.focus();
    };
    const hint = h('span', { class: 'news-hint' });
    const paint = () => {
      previewBtn.hidden = !markdown();
      hint.textContent = `${markdown() ? 'Markdown' : 'Plain text'} · #123 links to article 123 · Ctrl+Enter posts`;
    };
    let toggle: HTMLElement | null = null;
    if (offered) {
      const box = h('input', { type: 'checkbox', checked: d.markdown });
      box.onchange = () => {
        d.markdown = box.checked;
        writeNewsMarkdown(box.checked);
        if (!box.checked) showPreview(false);
        paint();
      };
      toggle = h(
        'label',
        { class: 'news-md-toggle', title: 'Post as markdown: headings, lists, **bold**, [links](https://…). Off, the article is plain text, exactly as typed.' },
        box,
        'Markdown',
      );
    }
    paint();
    showPreview(d.preview);

    const cfg = this.hooks.conn()?.news;
    // Marked as of this draw. One that lapses while the form sits open is
    // caught, and named, when Post is pressed.
    const lapsed = new Set(expiredAttachments(d.attachments, Date.now()));
    const attachments = h(
      'div',
      { class: 'news-compose-attachments' },
      ...d.attachments.map((item, index) => {
        const remove = h('button', { class: 'ghost', title: 'Remove attachment' }, '×');
        remove.onclick = () => {
          d.attachments.splice(index, 1);
          this.render();
        };
        const gone = lapsed.has(index);
        return h(
          'span',
          {
            class: `news-attachment-chip${gone ? ' expired' : ''}`,
            title: gone ? 'Expired on the server. Remove it and attach it again.' : undefined,
          },
          attachmentLabel(item, index),
          remove,
        );
      }),
    );
    let picker: HTMLElement | null = null;
    if (cfg?.attach) {
      const file = h('input', {
        type: 'file',
        accept: (cfg.types ?? ['image/jpeg', 'image/png', 'image/gif']).join(','),
        multiple: true,
        ariaLabel: 'Attach images',
        disabled: this.busy,
      });
      const label = h('label', { class: `news-attach-picker${this.busy ? ' busy' : ''}` }, 'Attach images', file);
      file.onchange = async () => {
        const conn = this.hooks.conn();
        // One upload at a time: a second pick made while the first is out
        // would pass the count check against a draft the first has not
        // added to yet.
        if (!conn || !file.files || this.busy) return;
        const chosen = [...file.files];
        const max = cfg.max_attachments ?? Infinity;
        if (d.attachments.length + chosen.length > max) {
          this.error = tooManyAttachments(max);
          return this.render();
        }
        const tooLarge = chosen.find((f) => cfg.max_attachment_bytes !== undefined && f.size > cfg.max_attachment_bytes);
        if (tooLarge) {
          this.error = `${tooLarge.name} is too large.`;
          return this.render();
        }
        this.busy = true;
        file.disabled = true;
        label.classList.add('busy');
        // Canceled, replaced or logged out of while an upload was out:
        // what comes back belongs to a draft nobody is writing, and its
        // result or its error must not land on the one that is.
        const session = this.session;
        const current = () => this.draft === d && this.session === session;
        try {
          for (const image of chosen) {
            const staged = await conn.uploadNewsAttachment(image, image.name);
            if (!current()) return;
            // Counted from the answer, which the server's own clock
            // started before; a post that loses that race gets the
            // server's refusal, said the same way.
            d.attachments.push({ ...staged, expiresAt: Date.now() + staged.expires_in * 1000 });
          }
          this.error = null;
        } catch (e) {
          if (current()) this.error = describe(e);
        } finally {
          this.busy = false;
          this.render();
        }
      };
      picker = label;
    }

    return h(
      'div',
      { class: 'news-compose' },
      subject,
      text,
      preview,
      attachments,
      picker,
      h('div', { class: 'news-compose-actions' }, post, cancel, previewBtn, toggle, hint),
    );
  }
}
