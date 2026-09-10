/** What the news reader decides that has nothing to do with the DOM.
 *  The view in `ui/news.ts` reads from here; nothing here reads from it. */

import {
  newsScopeOf,
  type Events,
  type NewsArticle,
  type NewsAuthor,
  type NewsConfig,
  type NewsNode,
  type NewsScope,
  type NewsSub,
} from '@hotline-ng/client';

/** A reply's default subject: the parent's with one `Re: ` in front, never
 *  a growing stack of them. */
export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** The opening of a body for a listing: one line, cut at a word where
 *  there is one near the limit. */
export function excerpt(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Did the account this session is write this?
 *
 * Only an article with a login can be anyone's: a guest's has none,
 * because everyone who walks through `guest` shares one login and so it
 * names nobody. The server keeps logins canonical and lowercase, and a
 * login typed at the connect form may not be, hence the fold.
 */
export function isOwn(author: NewsAuthor, me: string | null): boolean {
  return !!me && !!author.login && author.login.toLowerCase() === me.toLowerCase();
}

/** May a reply go under this article? The server decides, and says so if
 *  asked anyway; this is for not offering a button that can only fail. */
export function canReply(article: NewsArticle, cfg: NewsConfig | null): boolean {
  if (!cfg?.post || article.deleted) return false;
  return cfg.max_depth === undefined || article.depth < cfg.max_depth;
}

/** Is this body markdown? Only when its article says so: a `text/plain`
 *  author did not write markdown, and their asterisks are asterisks. */
export function isMarkdown(mime: string | undefined): boolean {
  return (mime ?? '').split(';')[0]!.trim().toLowerCase() === 'text/markdown';
}

/** May a post say `text/markdown`? Not on a server whose `markdown` is
 *  `off` — it would answer `bad_body_type` — nor on one that does not
 *  list it; `render` and `source` are the same thing to a client. */
export function markdownOffered(cfg: NewsConfig | null): boolean {
  return !!cfg && cfg.markdown !== 'off' && (cfg.body_types ?? []).includes('text/markdown');
}

/** The server's limits are in UTF-8 bytes, not characters. */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Why a draft cannot be posted, or `null` when it can.
 *
 * Checked here for a fast, specific answer before anything is sent; the
 * server checks it all again and its answer is the one that counts. The
 * body is measured with LF line endings because that is how the server
 * stores and measures it.
 */
export function draftProblem(subject: string, body: string, cfg: NewsConfig): string | null {
  const s = subject.trim();
  if (!s) return 'An article needs a subject.';
  if (byteLength(s) > cfg.max_subject) return `That subject is too long: ${cfg.max_subject} bytes at most.`;
  if (byteLength(body.replace(/\r\n?/g, '\n')) > cfg.max_body) {
    return `That article is too long: ${Math.floor(cfg.max_body / 1024)} KB at most.`;
  }
  return null;
}

/**
 * Where the next page of search results starts, or `null` when there is
 * nothing more to ask for.
 *
 * Counted in what the server has handed out, not in what is shown: pages
 * over a relevance order shift when something is posted between them,
 * and a hit shown twice is dropped, so the count on screen can stand
 * still while the offset must not. An empty page is the end whatever
 * `total` says, and so is the deepest a search may reach.
 */
export function nextSearchOffset(offset: number, got: number, total: number, reachable = Infinity): number | null {
  const next = offset + got;
  return got > 0 && next < Math.min(total, reachable) ? next : null;
}

/** Every node in a tree answer, by id — nested children included. */
export function indexTree(nodes: readonly NewsNode[], into = new Map<number, NewsNode>()): Map<number, NewsNode> {
  for (const n of nodes) {
    into.set(n.id, n);
    if (n.children) indexTree(n.children, into);
  }
  return into;
}

/**
 * The nodes from the root down to `id`, inclusive, or `null` when the
 * index does not reach it — a node deeper than the tree request went, or
 * one deleted since. A loop in the parents is `null` too, rather than a
 * hang: it cannot happen on a sane server, and a client should not be
 * the thing that finds out.
 */
export function trailTo(id: number, index: ReadonlyMap<number, NewsNode>): NewsNode[] | null {
  const out: NewsNode[] = [];
  const seen = new Set<number>();
  let cur = index.get(id);
  while (cur) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    out.unshift(cur);
    if (cur.parent === null) return out;
    cur = index.get(cur.parent);
  }
  return null;
}

// --- following (hxd-ng's docs/news.md §10) ------------------------------

/** One name for a scope, the way the server spells its collapse key:
 *  `thread:398`, `category:7`. */
export function scopeKey(scope: NewsScope): string {
  return scope.thread !== undefined ? `thread:${scope.thread}` : `category:${scope.category}`;
}

/**
 * The `up_to` for what is on screen: the highest article id in it, or
 * `null` when nothing is. The highest rather than the last, because a
 * thread reads in reply order and its newest article may sit anywhere
 * in it.
 */
export function highestId(items: readonly { id: number }[]): number | null {
  let top: number | null = null;
  for (const { id } of items) if (top === null || id > top) top = id;
  return top;
}

/** The line a notification is announced with, for a transcript. */
export function notifyText(d: Events['news_notify']): string {
  const who = d.from.nick || 'Someone';
  const subject = `“${d.subject}”`;
  const said =
    d.reason === 'reply'
      ? `${who} replied to you: ${subject}`
      : d.reason === 'reference'
        ? `${who} cited your article in ${subject}`
        : d.scope === 'category'
          ? `${who} started ${subject}`
          : `${who} posted in ${subject}`;
  const words = excerpt(d.excerpt, 80);
  return words ? `${said} — ${words}` : said;
}

/**
 * Is a notification about the thread with this root, the one on screen?
 * Only a thread-scoped one is: a category-scoped one for the same root
 * counts against the category, which drawing the thread does not
 * acknowledge, so it still needs saying.
 */
export function notifiesThread(d: Events['news_notify'], root: number | null): boolean {
  return d.scope === 'thread' && root !== null && d.root === root;
}

/**
 * Wrap a fetch so a burst of calls is at most one in flight and one
 * queued behind it. Every call's promise settles after a fetch that
 * began after the call did, so a caller that has just changed something
 * still sees the change; the calls in between share that one fetch.
 * `run` must not reject.
 */
export function coalesced(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const call = (): Promise<void> => {
    if (!running) {
      running = run().finally(() => (running = null));
      return running;
    }
    // Chained on the promise whose `finally` clears `running`, so by
    // the time this runs the slot is free and it starts a fetch.
    queued ??= running.then(() => {
      queued = null;
      return call();
    });
    return queued;
  };
  return call;
}

/** A count the server keeps no subscription for: a reply to your own
 *  article in a thread you stopped following still notifies you, and
 *  deserves a badge until you have seen it. */
interface Loose {
  category: number;
  unread: number;
  /** The newest article notified, which is what has to be drawn before
   *  the count is seen. */
  top: number;
  /** The highest `up_to` already sent for it, while the list is not
   *  loaded; a redraw at or below it does not send again. */
  claimed?: number;
}

/**
 * What this account follows, and how much in each is unread.
 *
 * The server's numbers, held between the moments it says them: a
 * `news_subs` answer replaces the lot, a `news_notify` updates the scope
 * it counts against, and a `news_seen` answer the scope it acknowledged.
 * Nothing here counts articles for itself — a badge the client computed
 * would drift from the one the server computes, and only the server can
 * leave out what you wrote yourself or what has since been deleted.
 */
export class Following {
  private subs = new Map<string, NewsSub>();
  private loose = new Map<string, Loose>();
  /** Has `news_subs` answered since the session began? Until it has,
   *  the login reply's total is the best number there is. */
  loaded = false;

  /** A fresh `news_subs` answer. A loose count its list now covers is
   *  folded into the subscription's, which the server already counted. */
  load(subs: readonly NewsSub[]): void {
    this.subs = new Map(subs.map((s) => [scopeKey(newsScopeOf(s)), s]));
    for (const key of this.loose.keys()) if (this.subs.has(key)) this.loose.delete(key);
    this.loaded = true;
  }

  clear(): void {
    this.subs.clear();
    this.loose.clear();
    this.loaded = false;
  }

  /** Newest subscription first, as the server listed them. */
  list(): NewsSub[] {
    return [...this.subs.values()];
  }

  get(scope: NewsScope): NewsSub | undefined {
    return this.subs.get(scopeKey(scope));
  }

  /**
   * Take in a notification. Returns false when no subscription this
   * holds covers it — either there is none, or one was made since the
   * list was fetched, and only asking again says which.
   */
  notify(d: Events['news_notify']): boolean {
    const key = scopeKey(newsScopeOf(d));
    const sub = this.subs.get(key);
    if (sub) {
      this.subs.set(key, { ...sub, unread: d.unread });
      return true;
    }
    // With no cursor the server says 1 every time; the reader has been
    // told once per article all the same.
    const prev = this.loose.get(key);
    this.loose.set(key, {
      ...prev,
      category: d.category,
      unread: Math.max((prev?.unread ?? 0) + 1, d.unread),
      top: Math.max(prev?.top ?? 0, d.article),
    });
    return false;
  }

  /**
   * Should the reader's having seen `scope` up to `upTo` be sent? True
   * when it would move something — a cursor behind it, or a count above
   * zero — and in that case the count is cleared here and now, so a
   * redraw before the answer lands does not ask twice.
   *
   * A loose count clears only once what was drawn reaches the article it
   * was for: a thread's first page is not the reply on its third. Once
   * the list has loaded, a loose scope is one the server holds no row
   * for, where `news_seen` would move nothing, so it clears here and is
   * never sent.
   */
  claimSeen(scope: NewsScope, upTo: number): boolean {
    const key = scopeKey(scope);
    const sub = this.subs.get(key);
    if (sub) {
      if (upTo <= sub.last_seen && sub.unread === 0) return false;
      this.subs.set(key, { ...sub, last_seen: Math.max(sub.last_seen, upTo), unread: 0 });
      return true;
    }
    const loose = this.loose.get(key);
    if (!loose) return false;
    if (upTo >= loose.top) this.loose.delete(key);
    if (this.loaded) return false;
    // Sent anyway while the list is not in: the server may hold a
    // subscription it has not been asked about yet, whose cursor this
    // moves. With no row there, the answer is a harmless zero.
    if (loose.claimed !== undefined && upTo <= loose.claimed) return false;
    loose.claimed = upTo;
    return true;
  }

  /** The server's answer to a `news_seen`. An answer to an older claim
   *  than the newest is out of date and dropped. */
  seen(scope: NewsScope, upTo: number, unread: number): void {
    const key = scopeKey(scope);
    const sub = this.subs.get(key);
    if (!sub || upTo < sub.last_seen) return;
    this.subs.set(key, { ...sub, last_seen: upTo, unread });
  }

  /** Unread in one scope. A muted one has nothing to say. */
  unreadOf(scope: NewsScope): number {
    const key = scopeKey(scope);
    const sub = this.subs.get(key);
    return (sub && !sub.muted ? sub.unread : 0) + (this.loose.get(key)?.unread ?? 0);
  }

  /** Unread anywhere in a category: the category itself and every thread
   *  in it that is followed, so a tree row says where to look. */
  unreadIn(category: number): number {
    let n = 0;
    for (const s of this.subs.values()) if (!s.muted && s.category === category) n += s.unread;
    for (const l of this.loose.values()) if (l.category === category) n += l.unread;
    return n;
  }

  /** The rail's badge. `fallback` is the login reply's total, which
   *  stands in until the list has been fetched — alone, because it
   *  already counts every followed scope a loose count might turn out to
   *  be, and `load` settles which ones are. */
  total(fallback = 0): number {
    if (!this.loaded) return fallback;
    let n = 0;
    for (const s of this.subs.values()) if (!s.muted) n += s.unread;
    for (const l of this.loose.values()) n += l.unread;
    return n;
  }
}
