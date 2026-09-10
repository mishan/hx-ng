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
 * Bodies are plain text and drawn as text. The only thing turned into a
 * link is what the server said was one: a URL, as in chat, and a `#51`
 * the server resolved to an article.
 */

import {
  errorText,
  referenceSpans,
  WireFailure,
  type Connection,
  type Events,
  type NewsArticle,
  type NewsNode,
  type NewsNodeKind,
  type NewsReference,
  type NewsThread,
} from '@hotline-ng/client';

import { canReply, draftProblem, excerpt, indexTree, isOwn, replySubject, trailTo } from '../news';
import { fill, h, linkify } from './dom';

type Screen =
  /** `trail` is the bundles down to the one being shown; empty is the root. */
  | { at: 'tree'; trail: NewsNode[] }
  | { at: 'category'; trail: NewsNode[]; category: NewsNode }
  /** `focus` is an article to bring into view — the one a reference named. */
  | { at: 'thread'; trail: NewsNode[]; category: NewsNode; root: number; focus?: number };

export interface NewsHooks {
  conn: () => Connection | null;
  /** The account this session is, for "is this article mine". */
  me: () => string | null;
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
  /** The open compose form: a new thread, or a reply to `parent`. Held
   *  here rather than read back off the DOM, so a redraw keeps it. */
  private draft: { parent?: number; subject: string; body: string } | null = null;
  /** The open name form: creating a node of `kind`, or renaming `node`.
   *  `name` is what is typed so far, kept for the same reason as a draft. */
  private naming: ({ kind: NewsNodeKind } | { node: NewsNode }) & { name: string } | null = null;
  private backlinks = new Map<number, NewsReference[]>();

  constructor(private hooks: NewsHooks) {
    this.el.append(this.bar, this.body);
  }

  get visible(): boolean {
    return !this.el.hidden;
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
    this.draft = null;
    this.naming = null;
    this.backlinks.clear();
    this.el.hidden = true;
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
    const s = this.screen;
    // A rename of something in the breadcrumb is a new label and nothing
    // else; take it straight from the event.
    const renamed = (n: NewsNode): NewsNode => (n.id === node.id ? { ...n, name: node.name } : n);
    s.trail = s.trail.map(renamed);
    if (s.at !== 'tree') s.category = renamed(s.category);
    if (s.at === 'tree' && (node.parent === (s.trail.at(-1)?.id ?? null) || this.nodes.some((n) => n.id === node.id))) {
      this.invalidate();
    } else if (this.visible) {
      this.renderBar();
    }
  }

  onNodeDeleted(d: Events['news_node_deleted']): void {
    const s = this.screen;
    const gone = s.trail.findIndex((n) => n.id === d.id);
    if (gone >= 0 || (s.at !== 'tree' && s.category.id === d.id)) {
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
    // Checked by screen rather than by generation: a refresh bumps that
    // too, and a post landing meanwhile is no reason to ignore the click.
    // A reader who has gone somewhere else is not dragged back.
    const from = this.screen;
    try {
      const article = await conn.newsArticle(id);
      const where = await this.locate(article.category);
      if (this.screen !== from) return;
      this.openThread(where.trail, where.category, article.root, id);
    } catch (e) {
      if (this.screen !== from) return;
      this.error = describe(e);
      this.render();
    }
  }

  /** The breadcrumb down to a category. The one on screen answers for
   *  itself; anything else takes a tree request deep enough to find it. */
  private async locate(category: number): Promise<{ trail: NewsNode[]; category: NewsNode }> {
    const s = this.screen;
    if (s.at !== 'tree' && s.category.id === category) return { trail: s.trail, category: s.category };
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
      } else {
        const want = Math.max(this.articles.length, THREAD_PAGE);
        let all: NewsArticle[] = [];
        let after: number | undefined;
        let more = true;
        while (more && all.length < want && all.length < THREAD_PRELOAD) {
          const page = await conn.newsThread(after === undefined ? { root: s.root, limit: THREAD_PAGE } : { root: s.root, after, limit: THREAD_PAGE });
          if (gen !== this.generation) return;
          all = all.concat(page.articles);
          more = page.has_more;
          after = page.articles.at(-1)?.id;
          if (after === undefined) break;
        }
        this.articles = all;
        this.articlesMore = more;
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
    if (!conn || s.at !== 'thread' || after === undefined || this.paging) return;
    const gen = this.generation;
    this.paging = true;
    try {
      const page = await conn.newsThread({ root: s.root, after, limit: THREAD_PAGE });
      if (gen !== this.generation) return;
      // An article already here is not drawn twice, whatever the page
      // overlapped: two elements with one id is a thread that scrolls to
      // the wrong place.
      const have = new Set(this.articles.map((a) => a.id));
      this.articles = this.articles.concat(page.articles.filter((a) => !have.has(a.id)));
      this.articlesMore = page.has_more;
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
    if (!conn || !cfg || !d || this.busy || s.at === 'tree') return;
    const problem = draftProblem(d.subject, d.body, cfg);
    if (problem) {
      this.error = problem;
      return this.render();
    }
    this.busy = true;
    try {
      const params = { category: s.category.id, subject: d.subject.trim(), body: d.body };
      const { id } = await conn.newsPost(parent ? { ...params, parent: parent.id } : params);
      // Posted, wherever the reader is now. One who moved on while it
      // went is left there, along with any draft they started there.
      if (this.screen !== s) return;
      this.draft = null;
      this.error = null;
      // A new thread opens; a reply is shown where it landed.
      if (s.at === 'category') this.openThread(s.trail, s.category, id);
      else {
        s.focus = id;
        this.scrollTo = id;
        await this.load();
      }
    } catch (e) {
      if (this.screen !== s) return;
      this.error = describe(e);
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

  // --- drawing ----------------------------------------------------------

  private render(): void {
    this.renderBar();
    const s = this.screen;
    const content =
      s.at === 'tree' ? this.treeView(s) : s.at === 'category' ? this.categoryView(s) : this.threadView();
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
    if (s.at !== 'tree') {
      crumb(s.category.name, s.at === 'category' ? null : () => this.openCategory(s.trail, s.category));
    }
    if (s.at === 'thread') crumb(this.articles[0]?.subject || 'Thread', null);

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
          this.draft = { subject: '', body: '' };
          this.focusDraft = true;
          this.render();
        },
        { disabled: !may || this.draft?.parent === undefined && this.draft !== null, title: may ? 'Start a thread' : 'You may not post here.' },
      );
    }
    action('Manage', () => {
      this.managing = !this.managing;
      this.naming = null;
      this.render();
    }, { on: this.managing, title: 'Create, rename and delete — for those who may' });
    action('↻', () => void this.load(), { title: 'Refresh' });

    fill(this.bar, h('nav', { class: 'crumbs' }, ...crumbs), h('span', { class: 'spacer' }), ...actions);
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
    if (!this.nodes.length && !this.loading) {
      out.push(h('p', { class: 'news-empty' }, s.trail.length ? 'This bundle is empty.' : 'There is no news here yet.'));
    }
    for (const node of this.nodes) {
      if (this.naming && 'node' in this.naming && this.naming.node.id === node.id) {
        out.push(this.nameForm());
        continue;
      }
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
      const row = h(
        'button',
        { class: `news-thread${a.deleted ? ' deleted' : ''}` },
        h('span', { class: 'news-thread-subject' }, a.deleted ? 'Deleted article' : a.subject),
        a.deleted ? null : h('span', { class: 'news-thread-excerpt' }, excerpt(a.body)),
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
      el.append(h('div', { class: 'news-subject-line' }, a.subject), h('div', { class: 'news-text' }, ...this.bodyNodes(a)));
    }

    const actions: HTMLElement[] = [];
    if (canReply(a, cfg)) {
      const reply = h('button', {}, 'Reply');
      reply.onclick = () => {
        this.draft = { parent: a.id, subject: replySubject(a.subject), body: '' };
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

  /** A body as text, with URLs and resolved references as links. */
  private bodyNodes(a: NewsArticle): (Node | string)[] {
    return referenceSpans(a.body, a.refs).flatMap((span) =>
      'ref' in span ? [this.refLink(span.ref, span.text)] : linkify(span.text),
    );
  }

  private refLink(r: NewsReference, label: string): HTMLElement {
    const link = h(
      'a',
      {
        href: `#news-${r.id}`,
        class: `news-ref${r.deleted ? ' gone' : ''}`,
        title: r.deleted ? 'That article was deleted.' : `${r.subject ?? ''} — ${r.from ?? ''}`,
      },
      label,
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
    const post = h('button', { class: 'primary' }, parent ? 'Post reply' : 'Post');
    post.onclick = () => void this.submit(parent);
    text.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        post.click();
      }
    };
    const cancel = h('button', { class: 'ghost' }, 'Cancel');
    cancel.onclick = () => {
      this.draft = null;
      this.error = null;
      if (this.pendingRefresh) void this.load();
      else this.render();
    };
    return h(
      'div',
      { class: 'news-compose' },
      subject,
      text,
      h(
        'div',
        { class: 'news-compose-actions' },
        post,
        cancel,
        h('span', { class: 'news-hint' }, 'Plain text · #123 links to article 123 · Ctrl+Enter posts'),
      ),
    );
  }
}
