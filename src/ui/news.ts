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
  markedSpans,
  referenceSpans,
  WireFailure,
  type Connection,
  type Events,
  type NewsArticle,
  type NewsHit,
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
  | { at: 'thread'; trail: NewsNode[]; category: NewsNode; root: number; focus?: number }
  /** A search, scoped to the category or bundle it was typed in, if any.
   *  `trail` is the bundles above the scope, for the breadcrumb. */
  | { at: 'search'; trail: NewsNode[]; q: string; scope: NewsNode | null };

type InCategory = Extract<Screen, { at: 'category' | 'thread' }>;

const inCategory = (s: Screen): s is InCategory => s.at === 'category' || s.at === 'thread';

/** Results per search page: the wire's default. */
const SEARCH_PAGE = 20;

export interface NewsHooks {
  conn: () => Connection | null;
  /** The account this session is, for "is this article mine". */
  me: () => string | null;
  say: (text: string) => void;
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
    spellcheck: false,
    hidden: true,
  });

  private screen: Screen = { at: 'tree', trail: [] };
  /** The screen's data is out of date and must be fetched when next shown. */
  private stale = true;
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
  /** The open name form: creating a node of `kind`, or renaming `node`. */
  private naming: { kind: NewsNodeKind } | { node: NewsNode } | null = null;
  private backlinks = new Map<number, NewsReference[]>();
  private hits: NewsHit[] = [];
  private hitsTotal = 0;
  private hitsCapped = false;

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

  show(on: boolean): void {
    this.el.hidden = !on;
    if (!on) return;
    if (this.stale) void this.load();
    else this.render();
  }

  /** Forget everything: the session this was reading through is gone. */
  reset(): void {
    this.generation++;
    this.cancelRefresh();
    this.screen = { at: 'tree', trail: [] };
    this.stale = true;
    this.pendingRefresh = false;
    this.managing = false;
    this.error = null;
    this.nodes = [];
    this.threads = [];
    this.articles = [];
    this.draft = null;
    this.naming = null;
    this.backlinks.clear();
    this.hits = [];
    this.searchBox.value = '';
    this.el.hidden = true;
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
    if (inCategory(s)) s.category = renamed(s.category);
    if (s.at === 'search' && s.scope) s.scope = renamed(s.scope);
    if (s.at === 'tree' && (node.parent === (s.trail.at(-1)?.id ?? null) || this.nodes.some((n) => n.id === node.id))) {
      this.invalidate();
    } else if (this.visible) {
      this.renderBar();
    }
  }

  onNodeDeleted(d: Events['news_node_deleted']): void {
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
      void this.load();
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
    this.hits = [];
    this.hitsTotal = 0;
    this.hitsCapped = false;
    this.draft = null;
    this.naming = null;
    this.backlinks.clear();
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
    try {
      const article = await conn.newsArticle(id);
      const where = await this.locate(article.category);
      this.openThread(where.trail, where.category, article.root, id);
    } catch (e) {
      this.error = describe(e);
      this.render();
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
    this.render();
  }

  private async loadOlderThreads(): Promise<void> {
    const conn = this.hooks.conn();
    const s = this.screen;
    const before = this.threads.at(-1)?.article.id;
    if (!conn || s.at !== 'category' || before === undefined) return;
    const gen = this.generation;
    try {
      const ok = await conn.newsThreads({ category: s.category.id, before });
      if (gen !== this.generation) return;
      this.threads = this.threads.concat(ok.threads.filter((t) => !this.threads.some((x) => x.article.id === t.article.id)));
      this.threadsMore = ok.has_more;
    } catch (e) {
      this.error = describe(e);
    }
    this.render();
  }

  private async loadMoreArticles(): Promise<void> {
    const conn = this.hooks.conn();
    const s = this.screen;
    const after = this.articles.at(-1)?.id;
    if (!conn || s.at !== 'thread' || after === undefined) return;
    const gen = this.generation;
    try {
      const page = await conn.newsThread({ root: s.root, after, limit: THREAD_PAGE });
      if (gen !== this.generation) return;
      this.articles = this.articles.concat(page.articles);
      this.articlesMore = page.has_more;
    } catch (e) {
      this.error = describe(e);
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
    const problem = draftProblem(d.subject, d.body, cfg);
    if (problem) {
      this.error = problem;
      return this.render();
    }
    this.busy = true;
    try {
      const params = { category: s.category.id, subject: d.subject.trim(), body: d.body };
      const { id } = await conn.newsPost(parent ? { ...params, parent: parent.id } : params);
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
    try {
      this.backlinks.set(a.id, (await conn.newsRefs(a.id)).referenced_by);
    } catch (e) {
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
      this.hooks.say(`Deleted “${node.name}”${articles ? `, and ${plural(articles, 'article', 'articles')} with it` : ''}.`);
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
    if (!conn || s.at !== 'search') return;
    const gen = this.generation;
    const offset = this.hits.length;
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
    } catch (e) {
      this.error = describe(e);
    }
    this.render();
  }

  private async openHit(hit: NewsHit): Promise<void> {
    try {
      const where = await this.locate(hit.category);
      this.openThread(where.trail, where.category, hit.root, hit.id);
    } catch (e) {
      this.error = describe(e);
      this.render();
    }
  }

  private searchView(s: Extract<Screen, { at: 'search' }>): (HTMLElement | null)[] {
    const out: (HTMLElement | null)[] = [];
    const reachable = this.hooks.conn()?.news?.search_max_results ?? Infinity;
    if (!this.stale) {
      const summary = this.hitsTotal
        ? `${plural(this.hitsTotal, 'result', 'results')} for “${s.q}”`
        : `Nothing matches “${s.q}”`;
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
    if (this.hits.length < Math.min(this.hitsTotal, reachable)) {
      const more = h('button', { class: 'news-more' }, 'More results');
      more.onclick = () => void this.loadMoreHits();
      out.push(more);
    }
    return out;
  }

  // --- drawing ----------------------------------------------------------

  private render(): void {
    this.renderBar();
    const s = this.screen;
    const content =
      s.at === 'tree'
        ? this.treeView(s)
        : s.at === 'category'
          ? this.categoryView(s)
          : s.at === 'search'
            ? this.searchView(s)
            : this.threadView();
    fill(this.body, this.error ? h('p', { class: 'news-error' }, this.error) : null, ...content);

    const target = this.scrollTo;
    this.scrollTo = null;
    if (target === 'top') this.body.scrollTop = 0;
    else if (typeof target === 'number') {
      this.body.querySelector(`#news-${target}`)?.scrollIntoView({ block: 'center' });
    }
    if (this.focusDraft) {
      this.focusDraft = false;
      const field = this.body.querySelector<HTMLElement>(
        this.draft?.parent === undefined ? '.news-compose input' : '.news-compose textarea',
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

    const actions: HTMLElement[] = [];
    const action = (label: string, fn: () => void, opts: { on?: boolean; title?: string; disabled?: boolean } = {}) => {
      const b = h('button', { class: `ghost${opts.on ? ' on' : ''}`, title: opts.title ?? label }, label);
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

    fill(this.crumbsEl, ...crumbs);
    fill(this.actionsEl, ...actions);
    // Offered where the server answers it; the placeholder says where a
    // search typed here will look.
    this.searchBox.hidden = !this.hooks.conn()?.news?.search;
    const scope = inCategory(s) ? s.category : s.at === 'tree' ? s.trail.at(-1) : s.at === 'search' ? s.scope : null;
    this.searchBox.placeholder = scope ? `Search ${scope.name}` : 'Search news';
  }

  private treeView(s: Extract<Screen, { at: 'tree' }>): (HTMLElement | null)[] {
    const out: (HTMLElement | null)[] = [];
    if (this.managing) {
      const make = (kind: NewsNodeKind, label: string) => {
        const b = h('button', { class: 'ghost' }, label);
        b.onclick = () => {
          this.naming = { kind };
          this.render();
        };
        return b;
      };
      out.push(h('div', { class: 'news-manage' }, make('category', 'New category'), make('bundle', 'New bundle')));
    }
    if (this.naming && 'kind' in this.naming) out.push(this.nameForm());
    if (!this.nodes.length && !this.stale) {
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
          this.naming = { node };
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
    const input = h('input', {
      class: 'news-name-input',
      placeholder: renaming ? 'New name' : n.kind === 'bundle' ? 'Bundle name' : 'Category name',
      value: renaming ? n.node.name : '',
    });
    const save = h('button', { class: 'primary' }, renaming ? 'Rename' : 'Create');
    const cancel = h('button', { class: 'ghost' }, 'Cancel');
    save.onclick = () => void this.saveName(input.value.trim());
    cancel.onclick = () => {
      this.naming = null;
      if (this.pendingRefresh) void this.load();
      else this.render();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') save.click();
      if (e.key === 'Escape') cancel.click();
    };
    queueMicrotask(() => input.focus());
    return h('div', { class: 'news-name-form' }, input, save, cancel);
  }

  private categoryView(s: Extract<Screen, { at: 'category' }>): (HTMLElement | null)[] {
    const out: (HTMLElement | null)[] = [];
    if (this.draft && this.draft.parent === undefined) out.push(this.composer());
    if (!this.threads.length && !this.stale) {
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
      more.onclick = () => void this.loadOlderThreads();
      out.push(more);
    }
    return out;
  }

  private threadView(): (HTMLElement | null)[] {
    const out: (HTMLElement | null)[] = this.articles.map((a) => this.articleEl(a));
    if (this.articlesMore) {
      const more = h('button', { class: 'news-more' }, 'More of this thread');
      more.onclick = () => void this.loadMoreArticles();
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
    const subject = h('input', { class: 'news-subject-input', placeholder: 'Subject', value: d.subject });
    subject.oninput = () => (d.subject = subject.value);
    const text = h('textarea', {
      class: 'news-body-input',
      rows: parent ? 4 : 8,
      placeholder: parent ? `Reply to ${parent.from.nick || 'this'}…` : 'Write something…',
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
