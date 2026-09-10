/** What the news reader decides that has nothing to do with the DOM.
 *  The view in `ui/news.ts` reads from here; nothing here reads from it. */

import type { NewsArticle, NewsAuthor, NewsConfig, NewsNode } from '@hotline-ng/client';

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
