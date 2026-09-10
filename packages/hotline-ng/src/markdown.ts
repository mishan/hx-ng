/**
 * Markdown, as this library reads it: two dialects over one inline
 * scanner, and never HTML.
 *
 * **Chat** is GtkHx's dialect, exactly — `**bold**`, `*italic*` /
 * `_italic_`, `` `code` ``, `~~strike~~`, `[label](url)`, backslash
 * escapes, fenced code (including the one-line ```` ```like this``` ````
 * form) and `>` quotes at a line start. It is a port of GtkHx's scanner
 * (`hxchat-layout/src/markdown.rs`) rather than an interpretation of the
 * same list, because a line has to look the same in both clients, and
 * the rules that decide that — flanking, the intraword `_`, which
 * backtick run closes which, what an unmatched delimiter does — are the
 * subtle part. Headings, lists, rules and tables are deliberately absent:
 * `# 1`, `---` and `2. yes` are ordinary chat.
 *
 * **Articles** are documents, and get CommonMark-ish blocks — headings,
 * lists, quotes, fenced and indented code, rules, GitHub pipe tables —
 * over the same inline scanner, with CommonMark's links on top of it:
 * destinations in `<…>` or with balanced parentheses, titles, autolinks,
 * reference definitions, character references, and the `news:` scheme
 * in every one of those forms, because the server records a reference
 * from each of them. Two things CommonMark has are changed on purpose,
 * as they are on the server (hxd-ng's `docs/news.md` §5.2). Raw HTML is
 * opaque: an inline tag or an HTML block is shown as the characters
 * typed and is never markdown, never linked and never a reference, so
 * `<a title="#51">` is one piece of literal text. Text *between* tags is
 * prose like any other. And an image is never fetched, because an
 * article's pictures are its attachments and a body that fetches a URL
 * reports every reader's address to a stranger: `![alt](https://…)` is a
 * link labeled `alt` to where the picture would have come from, and
 * `![alt](news:51)` a reference labeled `alt`.
 *
 * **Links go only where a reader can see.** In an article, a
 * `[label](url)` whose scheme is not on the allowlist renders as the
 * literal characters, brackets, label and all, rather than as a link
 * whose destination nobody can inspect. In chat it is GtkHx's answer,
 * which is not quite that: no link, and the brackets and destination
 * stay as typed, but the label between them is read like any other text.
 *
 * **Pathological input is bounded.** Emphasis nesting is capped, so a
 * line of asterisks cannot recurse into the stack; block containers are
 * capped too, past which the rest is a paragraph; a table has only the
 * cells its rows hold, and a delimiter row too wide for any reader is
 * not a table; and the searches for a closing delimiter, a bracket's
 * match, a destination's end and a code span's closing run are memoized
 * or precomputed per string, so a long body scans in roughly linear time
 * rather than retrying the same dead end from every opener. The
 * memoization changes nothing about the answers — a test drives it
 * against a straight port of the Rust — only what they cost.
 *
 * Plain data in, plain data out; no DOM. Drawing it is the caller's job,
 * and the only safe way to draw it is as text nodes.
 */

import { referenceSpans } from './news.js';
import type { NewsReference } from './protocol.js';

/** A run of rendered text and how it is styled. Adjacent runs never share
 *  every property; the delimiters are gone and escapes are resolved. */
export interface MdRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  /** Inline code: inert, never linked, never scanned for references. */
  code?: boolean;
  /** A link on an allowed scheme — `http`, `https`, `ftp`, `hotline`,
   *  `mailto`. Consecutive runs with the same `href` are one link. */
  href?: string;
  /** An article reference the server resolved: a `news:51` link or a
   *  `#51`, in an article only. */
  ref?: NewsReference;
  /** Raw HTML inline in an article — a tag, a comment — where CommonMark
   *  would read one. Drawn as the characters typed, and nothing in it is
   *  a link: not a `#51`, not a bare URL. A whole HTML block is a block
   *  of its own. */
  html?: boolean;
}

export type MdAlign = 'left' | 'center' | 'right' | null;

/** A block of a parsed body. Chat produces only paragraphs, code and
 *  quotes; the rest are articles'. */
export type MdBlock =
  | { type: 'paragraph'; content: MdRun[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: MdRun[] }
  /** Inert: drawn as the text it holds. `language` is the fence's info
   *  word, when there was one. */
  | { type: 'code'; text: string; language?: string }
  | { type: 'quote'; children: MdBlock[] }
  /** `tight` is CommonMark's: no blank lines between or inside the items,
   *  so they read as lines rather than as paragraphs. */
  | { type: 'list'; ordered: boolean; start: number; tight: boolean; items: MdBlock[][] }
  | { type: 'rule' }
  /** A row has the cells it was written with, never more than the head
   *  and possibly fewer: the ones it lacks are empty, and drawing them is
   *  the caller's business. */
  | { type: 'table'; align: MdAlign[]; head: MdRun[][]; rows: MdRun[][][] }
  /** A CommonMark HTML block: its lines exactly as typed, to be drawn as
   *  text. Never markdown, never linked, never a reference. */
  | { type: 'html'; text: string };

/** A chat body's block-level pieces, before inline parsing: GtkHx's
 *  `RawBlock`, kept because its shape is what the ported tests pin. */
export type ChatBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string; language: string | null }
  | { kind: 'quote'; text: string; depth: number };

/** Cap on emphasis nesting. `**a *b* a**` is depth 2. Real messages never
 *  approach this; it exists so a line of asterisks cannot recurse the
 *  scanner into the stack. GtkHx's `MAX_DEPTH`. */
const MAX_DEPTH = 8;

/** Cap on block containers — quotes and list items — in an article. Past
 *  it, what is left is one paragraph. Deep enough for any outline
 *  anybody writes; shallow enough that a body of nothing but `>` is a
 *  few dozen elements rather than a DOM the browser gives up on. */
const MAX_BLOCK_DEPTH = 16;

/** Widest delimiter row that makes a table; past it the lines are a
 *  paragraph. No table anybody reads is near it, on a phone or anywhere
 *  else. What it bounds is the drawing: a browser lays a table out on a
 *  grid of rows by columns however few cells the markup holds, so a
 *  short header of thousands of columns over thousands of one-word rows
 *  would be a small body with a huge grid behind it. The server's parser
 *  has no such cap, and reads a wider one as a table. */
const MAX_TABLE_COLUMNS = 64;

// --- the inline scanner --------------------------------------------------

const BOLD = 1;
const ITALIC = 2;
const CODE = 4;
const STRIKE = 8;
const HTML = 16;

const BACKSLASH = 0x5c;
const AMP = 0x26;
const LT = 0x3c;
const GT = 0x3e;
const BACKTICK = 0x60;
const STAR = 0x2a;
const UNDERSCORE = 0x5f;
const TILDE = 0x7e;
const LBRACKET = 0x5b;
const LPAREN = 0x28;
const RPAREN = 0x29;
const BANG = 0x21;

/** Characters a backslash escapes. A backslash before anything else is
 *  itself literal — `C:\path` must not lose its separators. */
const ESCAPABLE = new Set(['\\', '*', '_', '`', '~', '[', ']', '(', ')', '>', '#']);

/** Rust's `is_ascii_whitespace`: space, tab, LF, FF, CR. Not VT. */
const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;

const isAlnum = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** ASCII punctuation: what a backslash escapes in an article, as in
 *  CommonMark. */
const isPunct = (c: number): boolean =>
  (c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e);

/**
 * The named character references an article decodes: markup's own, the
 * typographic ones people actually type, and the two ASCII marks that
 * change what a body means here — a `#` that makes a reference, a `:`
 * that makes a scheme. Any other name stays as typed. That is a known
 * difference from the server, whose parser knows all of HTML's: there,
 * `&frac12;` is a character, and here it is eight. A table of two
 * thousand names is not worth carrying for that; numeric references,
 * which reach every character, are decoded in full.
 */
const NAMED = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
  ['copy', '©'],
  ['reg', '®'],
  ['trade', '™'],
  ['hellip', '…'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['laquo', '«'],
  ['raquo', '»'],
  ['bull', '•'],
  ['middot', '·'],
  ['deg', '°'],
  ['plusmn', '±'],
  ['times', '×'],
  ['divide', '÷'],
  ['euro', '€'],
  ['pound', '£'],
  ['yen', '¥'],
  ['cent', '¢'],
  ['sect', '§'],
  ['para', '¶'],
  ['larr', '←'],
  ['rarr', '→'],
  ['num', '#'],
  ['colon', ':'],
]);

/** A character reference, CommonMark's shapes: `&#35;`, `&#x23;`, `&name;`. */
const ENTITY = /&(?:#[xX]([0-9A-Fa-f]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/y;

/** The character reference at `at`, decoded, and where it ends; or null
 *  for none, or a name not in `NAMED`. A code point that is no character
 *  — zero, a surrogate, past Unicode — is U+FFFD, as CommonMark says. */
function entityAt(s: string, at: number): [text: string, end: number] | null {
  ENTITY.lastIndex = at;
  const m = ENTITY.exec(s);
  if (!m) return null;
  if (m[3] !== undefined) {
    const v = NAMED.get(m[3]);
    return v === undefined ? null : [v, ENTITY.lastIndex];
  }
  const cp = m[1] !== undefined ? parseInt(m[1], 16) : Number(m[2]);
  const ok = cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
  return [String.fromCodePoint(ok ? cp : 0xfffd), ENTITY.lastIndex];
}

/** A link destination as it is meant: backslash escapes resolved and
 *  character references decoded. This is what is checked against the
 *  allowlist, so `&#106;avascript:` is refused as `javascript:` is. */
function unescapeDest(raw: string): string {
  let out = '';
  let k = 0;
  while (k < raw.length) {
    const c = raw.charCodeAt(k);
    if (c === BACKSLASH && isPunct(raw.charCodeAt(k + 1))) {
      out += raw[k + 1];
      k += 2;
      continue;
    }
    const e = c === AMP ? entityAt(raw, k) : null;
    if (e) {
      out += e[0];
      k = e[1];
      continue;
    }
    out += raw[k];
    k++;
  }
  return out;
}

/** Spaces and tabs from `at`, and at most one line ending among them:
 *  what may separate a link's parts. */
function skipLinkSpace(s: string, at: number): number {
  let k = at;
  let lines = 0;
  for (;;) {
    const c = s.charCodeAt(k);
    if (c === 0x20 || c === 0x09) k++;
    else if (c === 0x0a && lines++ === 0) k++;
    else return k;
  }
}

/** A link label as a reference definition is looked up by: CommonMark's
 *  normalization, whitespace collapsed and case folded. Null when it is
 *  no label at all — blank, too long, or with a bracket of its own. */
function labelKey(label: string): string | null {
  if (label.length > 999) return null;
  for (let k = 0; k < label.length; k++) {
    const c = label.charCodeAt(k);
    if (c === BACKSLASH) k++;
    else if (c === LBRACKET || c === 0x5d) return null;
  }
  let key = label.replace(/[ \t\r\n]+/g, ' ');
  if (key.startsWith(' ')) key = key.slice(1);
  if (key.endsWith(' ')) key = key.slice(0, -1);
  return key ? key.toLowerCase().toUpperCase() : null;
}

/**
 * Schemes a `[label](url)` may point at: what GtkHx's URL detector
 * accepts, minus its bare-host autolink forms. Anything else —
 * `javascript:`, `data:`, `file:`, a scheme nobody recognizes — is no
 * link: in an article the whole construct is the literal characters
 * typed, and in chat it is what GtkHx makes of it (see `scan`).
 */
export function schemeAllowed(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return ['http://', 'https://', 'ftp://', 'hotline://', 'mailto:'].some((s) => lower.startsWith(s));
}

/** Where a link's label goes: a URL, a resolved article, or — for a
 *  `news:` link the server did not resolve — nowhere, the label drawn as
 *  text. An object so that runs of one label can be told from the runs
 *  of a neighboring link with the same target. */
interface Target {
  href?: string;
  ref?: NewsReference;
}

interface Piece {
  text: string;
  attrs: number;
  target: Target | null;
}

class Builder {
  readonly pieces: Piece[] = [];

  push(text: string, attrs: number, target: Target | null): void {
    if (!text) return;
    const last = this.pieces[this.pieces.length - 1];
    if (last && last.attrs === attrs && last.target === target) last.text += text;
    else this.pieces.push({ text, attrs, target });
  }
}

/** What differs between the dialects inside a line. */
interface Mode {
  article: boolean;
  refs: ReadonlyMap<number, NewsReference>;
  /** An article's link reference definitions, by `labelKey`: where each
   *  goes, unescaped. The first definition of a label wins. */
  defs: Map<string, string>;
  /** Inline content waiting for every definition in the body to be seen,
   *  since a reference may come before the line that defines it. */
  later: [runs: MdRun[], text: string][];
}

const CHAT: Mode = { article: false, refs: new Map(), defs: new Map(), later: [] };

const articleMode = (refs: readonly NewsReference[]): Mode => ({
  article: true,
  refs: new Map(refs.map((r) => [r.id, r])),
  defs: new Map(),
  later: [],
});

const UNKNOWN = -2;
const FAIL = -1;

/** CommonMark's open and closing tags (spec §6.6), whitespace spelled
 *  out rather than `\s`, which would take Unicode spaces too. Sticky, so
 *  a match starts where it is asked to. */
const OPEN_TAG =
  /<[A-Za-z][A-Za-z0-9-]*(?:[ \t\n\f\r]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n\f\r]*=[ \t\n\f\r]*(?:[^ \t\n\f\r"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t\n\f\r]*\/?>/y;
const CLOSE_TAG = /<\/[A-Za-z][A-Za-z0-9-]*[ \t\n\f\r]*>/y;

/** CommonMark's autolinks (spec §6.5): a scheme and no spaces, or an
 *  address, in angle brackets. Sticky, from the character after the `<`. */
const AUTOLINK_URI = /[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\x00-\x20<>]*>/y;
const AUTOLINK_EMAIL =
  /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/y;

/** A link found in an article: its label's source, where it goes —
 *  unescaped, not yet checked — and the offset just past it. */
interface Link {
  label: string;
  href: string;
  end: number;
}

/**
 * One string the scanner is working through, and what it has learned
 * about it.
 *
 * GtkHx's searches — for a closing `**`, for a bracket's match, for the
 * end of a URL — each walk forward from where they start, and each is
 * *memoryless*: where a walk goes from position `i` does not depend on
 * where it began. So whatever one walk learns about a position holds for
 * every later walk through it, and remembering it turns "every opener
 * rescans to the end of the body" into one pass per string and delimiter.
 * The walks themselves are the Rust's, step for step.
 */
class Source {
  readonly n: number;
  private memos = new Map<string, Int32Array>();
  private runs: Map<number, number[]> | null = null;
  private brackets: Int32Array | null = null;
  private found = new Map<string, [from: number, at: number]>();
  private parens: { next: Int32Array; stop: Int32Array; depth: Int32Array } | null = null;

  /** `article` is the dialect: in an article a tag, an autolink and a
   *  code span bind tighter than emphasis and brackets, as CommonMark
   *  has it. */
  constructor(
    readonly s: string,
    readonly article = false,
  ) {
    this.n = s.length;
  }

  /** In an article, the end of a raw-HTML tag or an autolink at `at`,
   *  which nothing may close or open inside; otherwise -1. */
  private opaque(at: number): number {
    if (!this.article || this.s.charCodeAt(at) !== LT) return -1;
    const auto = this.autolink(at);
    return auto ? auto.end : this.htmlTag(at);
  }

  code(i: number): number {
    return this.s.charCodeAt(i);
  }

  /** Length of the run of backticks at `at`. */
  backtickRun(at: number): number {
    let k = at;
    while (k < this.n && this.s.charCodeAt(k) === BACKTICK) k++;
    return k - at;
  }

  /**
   * A code span opening at `at`: `[contentStart, contentEnd, end]`, or
   * null. CommonMark's rule, and GtkHx's: a span opens with a run of N
   * backticks and closes on the next run of *exactly* N, which is what
   * lets ``` `` `b` `` ``` hold a backtick of its own. The next run of
   * exactly N is looked up rather than walked to.
   */
  codeSpan(at: number): [number, number, number] | null {
    const n = this.backtickRun(at);
    const starts = this.runStarts().get(n);
    if (!starts) return null;
    // The first run of this length starting after `at`. `at` may sit
    // inside a longer run — an escape can split one — and the run that
    // contains it starts before it, so it is never its own closer.
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! > at) hi = mid;
      else lo = mid + 1;
    }
    const close = starts[lo];
    return close === undefined ? null : [at + n, close, close + n];
  }

  /** Every maximal backtick run, by length, in order. */
  private runStarts(): Map<number, number[]> {
    if (this.runs) return this.runs;
    const runs = new Map<number, number[]>();
    let i = 0;
    while (i < this.n) {
      if (this.s.charCodeAt(i) !== BACKTICK) {
        i++;
        continue;
      }
      const len = this.backtickRun(i);
      const list = runs.get(len);
      if (list) list.push(i);
      else runs.set(len, [i]);
      i += len;
    }
    return (this.runs = runs);
  }

  /** Follow a memoryless walk from `start` to its answer, remembering it
   *  for every position passed through. `step` answers a position with
   *  the next one, `FAIL`, or `-(found + 2)`. */
  private walk(key: string, start: number, limit: number, step: (i: number) => number): number {
    let memo = this.memos.get(key);
    if (!memo) {
      memo = new Int32Array(this.n).fill(UNKNOWN);
      this.memos.set(key, memo);
    }
    const path: number[] = [];
    let i = start;
    let result: number;
    for (;;) {
      if (i >= limit) {
        result = FAIL;
        break;
      }
      const known = memo[i]!;
      if (known !== UNKNOWN) {
        result = known;
        break;
      }
      path.push(i);
      const next = step(i);
      if (next === FAIL) {
        result = FAIL;
        break;
      }
      if (next <= -2) {
        result = -(next + 2);
        break;
      }
      i = next;
    }
    for (const p of path) memo[p] = result;
    return result;
  }

  /**
   * Next unescaped `**` or `~~` at or after `from` that may close, or -1.
   * Skips code spans, so `` **a `b**` c** `` closes at the last `**`; an
   * unclosed backtick run ends the search. In an article it skips a tag
   * or an autolink the same way, so a `**` inside one closes nothing. An
   * empty span (`****`) is not emphasis, which is the start position's
   * special case.
   */
  findDelim(from: number, delim: '**' | '~~'): number {
    const s = this.s;
    const start = s.startsWith(delim, from) ? from + 2 : from;
    return this.walk(delim, start, this.n - 1, (i) => {
      const c = s.charCodeAt(i);
      if (c === BACKSLASH) return i + 2;
      if (c === BACKTICK) {
        const span = this.codeSpan(i);
        return span ? span[2] : FAIL;
      }
      const opaque = this.opaque(i);
      if (opaque >= 0) return opaque;
      if (s.startsWith(delim, i)) return canClose(this, i) ? -(i + 2) : i + 2;
      return i + 1;
    });
  }

  /** Close for single-character emphasis. A doubled run is skipped whole,
   *  so `*a**b*` does not close on the pair; `_` closes only at a word
   *  boundary. Code spans, and in an article tags and autolinks, are
   *  stepped over as `findDelim` steps over them. */
  findItalicClose(from: number, open: number): number {
    const s = this.s;
    const start = s.charCodeAt(from) === open && s.charCodeAt(from + 1) !== open ? from + 1 : from;
    return this.walk(String.fromCharCode(open), start, this.n, (i) => {
      const c = s.charCodeAt(i);
      if (c === BACKSLASH) return i + 2;
      if (c === BACKTICK) {
        const span = this.codeSpan(i);
        return span ? span[2] : FAIL;
      }
      const opaque = this.opaque(i);
      if (opaque >= 0) return opaque;
      if (c === open) {
        if (s.charCodeAt(i + 1) === open) return i + 2;
        if (!canClose(this, i)) return i + 1;
        if (open === UNDERSCORE && !intrawordCloseOk(this, i)) return i + 1;
        return -(i + 2);
      }
      return i + 1;
    });
  }

  /**
   * `[label](url)` at `open`: the label, the destination and the offset
   * past the closing paren, or null. The label's brackets balance; the
   * URL has no whitespace in it, so a stray `](` does not swallow the
   * rest of the line looking for a paren.
   */
  link(open: number): { label: string; href: string; end: number } | null {
    const close = this.bracketMatch()[open]!;
    if (close < 0 || this.s.charCodeAt(close + 1) !== LPAREN) return null;
    const urlStart = close + 2;
    const s = this.s;
    const urlEnd = this.walk(')', urlStart, this.n, (j) => {
      const c = s.charCodeAt(j);
      if (c === RPAREN) return -(j + 2);
      if (c === BACKSLASH) return j + 2;
      if (isWs(c)) return FAIL;
      return j + 1;
    });
    if (urlEnd < 0) return null;
    const label = s.slice(open + 1, close);
    const href = s.slice(urlStart, urlEnd);
    if (!label || !href) return null;
    return { label, href, end: urlEnd + 1 };
  }

  /**
   * A link at `open` in an article, CommonMark's forms: inline —
   * `[label](dest)`, `[label](<dest>)`, either with a `"title"`,
   * `'title'` or `(title)` after it — and then, with `defs` to look in,
   * full `[label][ref]`, collapsed `[label][]` and shortcut `[label]`
   * references. Null when none of them is here. The title is read to
   * find where the link ends, and is otherwise dropped: nothing here
   * shows one.
   */
  articleLink(open: number, defs: ReadonlyMap<string, string>): Link | null {
    const s = this.s;
    const match = this.bracketMatch();
    const close = match[open]!;
    if (close < 0) return null;
    const label = s.slice(open + 1, close);
    if (!label) return null;
    if (s.charCodeAt(close + 1) === LPAREN) {
      const inline = this.inlineDest(close + 2);
      if (inline) return { label, ...inline };
    }
    if (!defs.size) return null;
    const lookup = (name: string) => {
      const key = labelKey(name);
      return key === null ? undefined : defs.get(key);
    };
    // Followed by a label of its own, it is a full or collapsed reference
    // or nothing: never a shortcut, even when that label is undefined.
    if (s.charCodeAt(close + 1) === LBRACKET) {
      const ref = match[close + 1]!;
      if (ref >= 0) {
        const href = lookup(ref === close + 2 ? label : s.slice(close + 2, ref));
        return href === undefined ? null : { label, href, end: ref + 1 };
      }
    }
    const href = lookup(label);
    return href === undefined ? null : { label, href, end: close + 1 };
  }

  /** What follows an inline link's `(` at `at`: the destination,
   *  unescaped, and the offset past the closing `)`. */
  private inlineDest(at: number): { href: string; end: number } | null {
    const s = this.s;
    const dest = this.destination(skipLinkSpace(s, at));
    if (!dest || !dest.raw) return null;
    let k = skipLinkSpace(s, dest.end);
    if (k > dest.end && s.charCodeAt(k) !== RPAREN) {
      const title = this.title(k);
      if (title < 0) return null;
      k = skipLinkSpace(s, title);
    }
    if (s.charCodeAt(k) !== RPAREN) return null;
    return { href: unescapeDest(dest.raw), end: k + 1 };
  }

  /**
   * A link destination at `at`: `<…>`, which may be empty and holds no
   * line break and no unescaped `<`; or a run with no space or control
   * character in it whose parentheses balance, ending before the `)`
   * that does not. Its source and the offset past it, or null.
   *
   * The bare form's end is looked up rather than walked to: a walk that
   * counts parentheses is not memoryless, and `[a](b` repeated would
   * otherwise send every attempt to the end of the body. Unlike the
   * server's parser, nesting is not capped.
   */
  destination(at: number): { raw: string; end: number } | null {
    const s = this.s;
    if (s.charCodeAt(at) === LT) {
      const close = this.walk('<>', at + 1, this.n, (j) => {
        const c = s.charCodeAt(j);
        if (c === GT) return -(j + 2);
        if (c === LT || c === 0x0a) return FAIL;
        return c === BACKSLASH && isPunct(s.charCodeAt(j + 1)) ? j + 2 : j + 1;
      });
      return close < 0 ? null : { raw: s.slice(at + 1, close), end: close + 1 };
    }
    const { next, stop, depth } = this.parenIndex();
    const space = stop[at]!;
    // The first point after `at` where the depth falls below where it
    // started is just past the `)` that ends the destination.
    const paren = next[at]! - 1;
    if (paren >= at && paren < space) return { raw: s.slice(at, paren), end: paren };
    if (depth[space] !== depth[at]) return null;
    return { raw: s.slice(at, space), end: space };
  }

  /** A link title at `at` — `"…"`, `'…'` or `(…)`, escapes allowed, and
   *  in the last no unescaped `(` — and the offset past it, or -1. */
  title(at: number): number {
    const s = this.s;
    const open = s.charCodeAt(at);
    const closer = open === LPAREN ? RPAREN : open;
    if (open !== 0x22 && open !== 0x27 && open !== LPAREN) return -1;
    const close = this.walk(`title${s[at]}`, at + 1, this.n, (j) => {
      const c = s.charCodeAt(j);
      if (c === closer) return -(j + 2);
      if (open === LPAREN && c === LPAREN) return FAIL;
      return c === BACKSLASH && isPunct(s.charCodeAt(j + 1)) ? j + 2 : j + 1;
    });
    return close < 0 ? -1 : close + 1;
  }

  /**
   * What `destination` looks up, built once per string. `depth[k]` is
   * the parenthesis depth before `k`, escapes skipped; `next[k]` the
   * first later point where the depth is below `depth[k]`, or -1; and
   * `stop[k]` the first space or control character at or after `k`.
   * A backslash escapes whatever follows it here, as `bracketMatch`'s
   * does, which is CommonMark's escaping for everything that could be a
   * parenthesis.
   */
  private parenIndex(): { next: Int32Array; stop: Int32Array; depth: Int32Array } {
    if (this.parens) return this.parens;
    const s = this.s;
    const n = this.n;
    const depth = new Int32Array(n + 1);
    let d = 0;
    for (let k = 0; k < n; k++) {
      depth[k] = d;
      const c = s.charCodeAt(k);
      if (c === BACKSLASH && k + 1 < n) {
        depth[++k] = d;
        continue;
      }
      if (c === LPAREN) d++;
      else if (c === RPAREN) d--;
    }
    depth[n] = d;
    const next = new Int32Array(n + 1).fill(-1);
    const stack: number[] = [];
    for (let k = n; k >= 0; k--) {
      while (stack.length && depth[stack[stack.length - 1]!]! >= depth[k]!) stack.pop();
      if (stack.length) next[k] = stack[stack.length - 1]!;
      stack.push(k);
    }
    const stop = new Int32Array(n + 1);
    stop[n] = n;
    for (let k = n - 1; k >= 0; k--) stop[k] = s.charCodeAt(k) <= 0x20 ? k : stop[k + 1]!;
    return (this.parens = { next, stop, depth });
  }

  /** An autolink at `at` — `<https://…>`, `<news:51>`, `<a@b.example>` —
   *  as its text, its destination and the offset past it, or null. Its
   *  text is exactly what was typed: no escapes, no references. */
  autolink(at: number): { text: string; href: string; end: number } | null {
    const s = this.s;
    if (s.charCodeAt(at) !== LT) return null;
    for (const [re, mailto] of [
      [AUTOLINK_URI, false],
      [AUTOLINK_EMAIL, true],
    ] as const) {
      re.lastIndex = at + 1;
      if (re.test(s)) {
        const text = s.slice(at + 1, re.lastIndex - 1);
        return { text, href: mailto ? `mailto:${text}` : text, end: re.lastIndex };
      }
    }
    return null;
  }

  /**
   * The end of a raw-HTML tag at `at`, or -1: CommonMark's inline shapes
   * — an open or closing tag, a comment, a processing instruction, a
   * declaration, a CDATA section — which is what the server's parser
   * sets apart as HTML and does not scan for `#51`. Nothing is made of
   * it but that; it is drawn as typed.
   */
  htmlTag(at: number): number {
    const s = this.s;
    const after = (term: string, from: number) => {
      const k = this.find(term, from);
      return k < 0 ? -1 : k + term.length;
    };
    if (s.startsWith('<!--', at)) {
      // `<!-->` and `<!--->` are whole comments, as CommonMark has it.
      if (s.startsWith('>', at + 4)) return at + 5;
      if (s.startsWith('->', at + 4)) return at + 6;
      return after('-->', at + 4);
    }
    if (s.startsWith('<?', at)) return after('?>', at + 2);
    if (s.startsWith('<![CDATA[', at)) return after(']]>', at + 9);
    if (s.startsWith('<!', at)) return /[A-Za-z]/.test(s[at + 2] ?? '') ? after('>', at + 3) : -1;
    for (const re of [OPEN_TAG, CLOSE_TAG]) {
      re.lastIndex = at;
      if (re.test(s)) return re.lastIndex;
    }
    return -1;
  }

  /** The next `term` at or after `from`, or -1. A scan asks with `from`
   *  rising, so the last answer usually still holds, and a body of
   *  unclosed `<!--` is not one search to the end for each. */
  private find(term: string, from: number): number {
    const last = this.found.get(term);
    if (last && last[0] <= from && (last[1] < 0 || last[1] >= from)) return last[1];
    const at = this.s.indexOf(term, from);
    this.found.set(term, [from, at]);
    return at;
  }

  /** Each `[`'s balancing `]`, or -1. GtkHx counts depth forward from
   *  the bracket with a backslash skipping the next character; a stack
   *  over the whole string gives the same pairs in one pass. In an
   *  article a code span, a tag or an autolink binds tighter, as in
   *  CommonMark, and a bracket inside one pairs with nothing outside. */
  private bracketMatch(): Int32Array {
    if (this.brackets) return this.brackets;
    const match = new Int32Array(this.n).fill(-1);
    const stack: number[] = [];
    let i = 0;
    while (i < this.n) {
      const c = this.s.charCodeAt(i);
      if (c === BACKSLASH) {
        i += 2;
        continue;
      }
      if (this.article && c === BACKTICK) {
        const span = this.codeSpan(i);
        i = span ? span[2] : i + this.backtickRun(i);
        continue;
      }
      const opaque = this.opaque(i);
      if (opaque >= 0) {
        i = opaque;
        continue;
      }
      if (c === LBRACKET) stack.push(i);
      else if (c === 0x5d) {
        const o = stack.pop();
        if (o !== undefined) match[o] = i;
      }
      i++;
    }
    return (this.brackets = match);
  }
}

/** CommonMark's left-flanking rule, which is what stops `2 * 3 * 4` from
 *  losing its asterisks: an opener must be followed by non-whitespace. */
function canOpen(src: Source, after: number): boolean {
  return after < src.n && !isWs(src.code(after));
}

/** The right-flanking counterpart: a closer must follow non-whitespace. */
function canClose(src: Source, at: number): boolean {
  return at > 0 && !isWs(src.code(at - 1));
}

/** `_` opens only at a word boundary, so snake_case survives. */
function intrawordOk(src: Source, i: number): boolean {
  const beforeOk = i === 0 || !isAlnum(src.code(i - 1));
  const afterOk = i + 1 < src.n && src.code(i + 1) !== UNDERSCORE;
  return beforeOk && afterOk;
}

/** `_` closes only at a word boundary. */
function intrawordCloseOk(src: Source, i: number): boolean {
  return i + 1 >= src.n || !isAlnum(src.code(i + 1));
}

/** Strip one leading and one trailing space when both are there and the
 *  content is not all spaces — the padding that separates a span's
 *  delimiters from a backtick inside it. */
function stripCodePad(s: string): string {
  return s.length >= 2 && s[0] === ' ' && s[s.length - 1] === ' ' && /[^ ]/.test(s) ? s.slice(1, -1) : s;
}

/** What a link's destination makes of its label: a target, `null` to
 *  draw the label as text, or `undefined` when the construct is not a
 *  link at all and stays literal. */
function linkTarget(href: string, mode: Mode): Target | null | undefined {
  if (schemeAllowed(href)) return { href };
  if (!mode.article) return undefined;
  // The server's rule for a reference (hxd-ng's `hxd-markdown`): the
  // `news:` scheme, in any case, and digits only. Linked only when it
  // resolved; otherwise the label is the text the author wrote around a
  // pointer to nothing.
  const m = /^news:(\d{1,10})$/i.exec(href);
  if (!m) return undefined;
  const ref = mode.refs.get(Number(m[1]));
  return ref ? { ref } : null;
}

function scan(src: Source, base: number, target: Target | null, depth: number, out: Builder, mode: Mode): void {
  const s = src.s;
  const n = src.n;
  let i = 0;
  // Start of the current literal run, flushed lazily so plain text costs
  // one push rather than one per character.
  let lit = 0;
  const flush = (upto: number) => {
    if (upto > lit) out.push(s.slice(lit, upto), base, target);
  };

  while (i < n) {
    const c = s.charCodeAt(i);

    // A backslash escape: the next character is literal, whatever it is.
    // Chat escapes GtkHx's set; an article, CommonMark's.
    if (c === BACKSLASH && i + 1 < n) {
      const next = s[i + 1]!;
      if (mode.article ? isPunct(s.charCodeAt(i + 1)) : ESCAPABLE.has(next)) {
        flush(i);
        out.push(next, base, target);
        i += 2;
        lit = i;
        continue;
      }
      i += 1;
      continue;
    }

    // `code` — inert contents, so it is tried before anything else.
    if (c === BACKTICK) {
      const span = src.codeSpan(i);
      if (span) {
        flush(i);
        out.push(stripCodePad(s.slice(span[0], span[1])), base | CODE, target);
        i = span[2];
        lit = i;
        continue;
      }
      // An unmatched run is literal. Skip the *whole* run: resuming at its
      // second backtick would let a shorter run inside it close against
      // something further on.
      i += src.backtickRun(i);
      continue;
    }

    if (c === LT && mode.article) {
      // An autolink — `<https://…>`, `<news:51>` — is a link like any
      // other, its destination judged the same way, and refused it is the
      // characters typed. Not in a link's label, where a link is not
      // markdown.
      const auto = depth < MAX_DEPTH ? src.autolink(i) : null;
      if (auto) {
        const t = linkTarget(auto.href, mode);
        if (t !== undefined) {
          flush(i);
          out.push(auto.text, base, t);
          lit = auto.end;
        }
        i = auto.end;
        continue;
      }
      // Raw HTML: one opaque piece, as the server's parser reads it, so
      // what is inside a tag is neither markdown nor a `#51`. It is still
      // drawn as the characters typed. Chat has no such thing; GtkHx
      // reads a `<` as a `<`.
      const end = src.htmlTag(i);
      if (end >= 0) {
        flush(i);
        out.push(s.slice(i, end), base | HTML, target);
        i = end;
        lit = i;
        continue;
      }
    }

    // A character reference in an article is the character it names, as
    // on the server: `&#35;51` is a `#51`, and a reference.
    if (c === AMP && mode.article) {
      const e = entityAt(s, i);
      if (e) {
        flush(i);
        out.push(e[0], base, target);
        i = e[1];
        lit = i;
        continue;
      }
    }

    if (depth < MAX_DEPTH) {
      // **bold** and ~~strike~~ — the two-character delimiters first, so
      // `**` is never an empty `*` pair.
      const two = c === STAR && s.charCodeAt(i + 1) === STAR ? '**' : c === TILDE && s.charCodeAt(i + 1) === TILDE ? '~~' : null;
      if (two) {
        if (canOpen(src, i + 2)) {
          const close = src.findDelim(i + 2, two);
          if (close >= 0) {
            flush(i);
            scan(new Source(s.slice(i + 2, close), mode.article), base | (two === '**' ? BOLD : STRIKE), target, depth + 1, out, mode);
            i = close + 2;
            lit = i;
            continue;
          }
        }
        i += 2;
        continue;
      }

      // *italic* and _italic_, the second only at a word boundary so the
      // snake_case identifiers chat is full of come through intact.
      if ((c === STAR && canOpen(src, i + 1)) || (c === UNDERSCORE && canOpen(src, i + 1) && intrawordOk(src, i))) {
        const close = src.findItalicClose(i + 1, c);
        if (close >= 0) {
          flush(i);
          scan(new Source(s.slice(i + 1, close), mode.article), base | ITALIC, target, depth + 1, out, mode);
          i = close + 1;
          lit = i;
          continue;
        }
        i += 1;
        continue;
      }

      if (c === LBRACKET) {
        const link = mode.article ? src.articleLink(i, mode.defs) : src.link(i);
        if (link) {
          // `![alt](url)` in an article — its `!` still in the literal
          // run, so not escaped — is a link to where the picture would
          // have come from, as the server has it: an article's pictures
          // are its attachments, and nothing here is ever fetched. In
          // chat it is GtkHx's answer, a `!` and then a link, which draws
          // no image either.
          const image = mode.article && i > lit && s.charCodeAt(i - 1) === BANG;
          const t = linkTarget(link.href, mode);
          if (t !== undefined) {
            flush(image ? i - 1 : i);
            // At MAX_DEPTH: a label is text, and a link inside a link is
            // not markdown — the balanced brackets would otherwise let
            // the inner one parse.
            scan(new Source(link.label, mode.article), base, t, MAX_DEPTH, out, mode);
            i = link.end;
            lit = i;
            continue;
          }
          // A scheme nobody can vouch for, so no link: the reader sees
          // what was written rather than a link they cannot inspect. In
          // an article the whole construct stays as typed, label and
          // all. In chat this is GtkHx's answer, which steps past the
          // `[` and reads on, so emphasis in the label is still drawn —
          // a line has to look the same in both clients.
          if (mode.article) {
            i = link.end;
            continue;
          }
        }
        i += 1;
        continue;
      }
    }

    i += 1;
  }
  flush(n);
}

function toRun(p: Piece): MdRun {
  const run: MdRun = { text: p.text };
  if (p.attrs & BOLD) run.bold = true;
  if (p.attrs & ITALIC) run.italic = true;
  if (p.attrs & STRIKE) run.strike = true;
  if (p.attrs & CODE) run.code = true;
  if (p.attrs & HTML) run.html = true;
  if (p.target?.href !== undefined) run.href = p.target.href;
  if (p.target?.ref) run.ref = p.target.ref;
  return run;
}

function inline(src: string, mode: Mode): MdRun[] {
  const out = new Builder();
  scan(new Source(src, mode.article), 0, null, 0, out, mode);
  if (!mode.article) return out.pieces.map(toRun);
  // The `#51` shorthand, by the server's own rule (`referenceSpans`), in
  // prose only. The server scans each stretch of text between two pieces
  // of markup on its own — never across an emphasis boundary, a link or a
  // code span — which is exactly what one run is here. A raw-HTML tag is
  // not prose to the server, and is not scanned.
  const refs = [...mode.refs.values()];
  return out.pieces.flatMap((p) => {
    const run = toRun(p);
    if (run.code || run.html || p.target || refs.length === 0) return [run];
    return referenceSpans(run.text, refs).map((span) => ({ ...run, text: span.text, ...('ref' in span ? { ref: span.ref } : {}) }));
  });
}

/**
 * Inline markdown: GtkHx's chat dialect by default, or an article's when
 * `article` is given — which adds CommonMark's links and the `news:`
 * scheme, draws `![]()` as a link, and links the references in
 * `article.refs`. One line has no reference definitions; `parseArticle`
 * finds those in the body around it.
 *
 * Never fails: anything that does not close renders as the characters
 * that were typed.
 */
export function parseInline(src: string, article?: { refs: readonly NewsReference[] }): MdRun[] {
  return inline(src, article ? articleMode(article.refs) : CHAT);
}

// --- chat blocks -------------------------------------------------------------

/** Rust's `char::is_whitespace`, which is what GtkHx's `trim_start` trims:
 *  Unicode White_Space, and not the BOM that JavaScript's `\s` takes. */
const WHITE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

function skipWhite(s: string, k: number): number {
  while (k < s.length && WHITE.test(s[k]!)) k++;
  return k;
}

const trimStartWhite = (s: string): string => s.slice(skipWhite(s, 0));

function trimWhite(s: string): string {
  let end = s.length;
  while (end > 0 && WHITE.test(s[end - 1]!)) end--;
  return trimStartWhite(s.slice(0, end));
}

/** A quote line's depth and what follows its markers: `>` after `>`,
 *  whitespace between them ignored. */
function quoteMarkers(trimmed: string): { depth: number; rest: string } {
  let depth = 0;
  let k = 0;
  while (trimmed[k] === '>') {
    depth++;
    k = skipWhite(trimmed, k + 1);
  }
  return { depth, rest: trimmed.slice(k) };
}

/** Line endings as the ng wire carries them, whatever a legacy client
 *  typed. */
const lf = (s: string): string => s.replace(/\r\n?/g, '\n');

/**
 * A chat body's blocks: fenced code, `>` quotes, and the paragraphs
 * between. GtkHx's `split_blocks`, line for line.
 *
 * A fence that opens and closes on one line is a code block — it is how
 * anybody types one into a box that sends on Enter. An unterminated fence
 * runs to the end: treating it as literal would make a message someone is
 * still typing flicker between two renderings. Consecutive quote lines of
 * one depth are one quote.
 */
export function splitChatBlocks(body: string): ChatBlock[] {
  const out: ChatBlock[] = [];
  const lines = body.split('\n');
  let para: string | null = null;
  const flush = () => {
    if (para) out.push({ kind: 'paragraph', text: para });
    para = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = trimStartWhite(line);

    if (trimmed.startsWith('```')) {
      flush();
      const rest = trimmed.slice(3);
      if (rest.endsWith('```')) {
        out.push({ kind: 'code', text: rest.slice(0, -3), language: null });
        continue;
      }
      const lang = trimWhite(rest);
      const code: string[] = [];
      while (++i < lines.length) {
        const l = lines[i]!;
        if (trimStartWhite(l).startsWith('```')) break;
        code.push(l);
      }
      out.push({ kind: 'code', text: code.join('\n'), language: lang || null });
      continue;
    }

    if (trimmed.startsWith('>')) {
      flush();
      const { depth, rest } = quoteMarkers(trimmed);
      let text = rest;
      while (i + 1 < lines.length) {
        const next = trimStartWhite(lines[i + 1]!);
        if (!next.startsWith('>')) break;
        const q = quoteMarkers(next);
        if (q.depth !== depth) break;
        text += `\n${q.rest}`;
        i++;
      }
      out.push({ kind: 'quote', text, depth });
      continue;
    }

    para = para === null ? line : `${para}\n${line}`;
  }
  flush();
  return out;
}

function nestQuote(depth: number, inner: MdBlock[]): MdBlock[] {
  let blocks = inner;
  for (let d = 0; d < Math.min(depth, MAX_DEPTH); d++) blocks = [{ type: 'quote', children: blocks }];
  return blocks;
}

/** A chat line, parsed: GtkHx's blocks, each quote nested as deep as its
 *  markers said (up to the emphasis cap), and the inline dialect inside. */
export function parseChat(body: string): MdBlock[] {
  return splitChatBlocks(lf(body)).flatMap((b): MdBlock[] => {
    if (b.kind === 'code') return [b.language ? { type: 'code', text: b.text, language: b.language } : { type: 'code', text: b.text }];
    const para: MdBlock = { type: 'paragraph', content: parseInline(b.text) };
    return b.kind === 'quote' ? nestQuote(b.depth, [para]) : [para];
  });
}

// --- article blocks ------------------------------------------------------------

function isBlank(line: string): boolean {
  for (let k = 0; k < line.length; k++) if (line[k] !== ' ' && line[k] !== '\t') return false;
  return true;
}

/** Tabs in a line's indentation, as the spaces they stand for at stops of
 *  four. Tabs after the first character that is not one are content. */
function detab(line: string): string {
  if (!line.startsWith('\t') && !/^ *\t/.test(line)) return line;
  let out = '';
  let k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    out += line[k] === '\t' ? ' '.repeat(4 - (out.length % 4)) : ' ';
    k++;
  }
  return out + line.slice(k);
}

function indentOf(line: string): number {
  let k = 0;
  while (line[k] === ' ') k++;
  return k;
}

/** Drop up to `cols` leading spaces. */
function stripCols(line: string, cols: number): string {
  return line.slice(Math.min(cols, indentOf(line)));
}

/** Trim spaces and tabs, and nothing else: no regex, whose backtracking
 *  on a line of nothing but spaces is quadratic. */
function trimSpaces(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  return s.slice(a, b);
}

/** `---`, `***`, `___`: three or more of one, spaces between allowed. */
function isRule(t: string): boolean {
  const c = t[0];
  if (c !== '-' && c !== '*' && c !== '_') return false;
  let count = 0;
  for (let k = 0; k < t.length; k++) {
    if (t[k] === c) count++;
    else if (t[k] !== ' ' && t[k] !== '\t') return false;
  }
  return count >= 3;
}

function fenceOpen(t: string): { mark: string; info: string } | null {
  const c = t[0];
  if (c !== '`' && c !== '~') return null;
  let k = 0;
  while (t[k] === c) k++;
  if (k < 3) return null;
  const info = t.slice(k);
  // A backtick fence's info string has no backtick: ```` ```x``` ```` in
  // an article is a code span in a paragraph, as CommonMark has it.
  if (c === '`' && info.includes('`')) return null;
  return { mark: t.slice(0, k), info: trimSpaces(info) };
}

function fenceCloses(t: string, mark: string): boolean {
  let k = 0;
  while (t[k] === mark[0]) k++;
  return k >= mark.length && isBlank(t.slice(k));
}

function atxLevel(t: string): number {
  let k = 0;
  while (k < 7 && t[k] === '#') k++;
  return k >= 1 && k <= 6 && (k === t.length || t[k] === ' ' || t[k] === '\t') ? k : 0;
}

/** A heading's text, without its optional closing run of `#`. */
function headingText(rest: string): string {
  const r = trimSpaces(rest);
  let k = r.length;
  while (k > 0 && r[k - 1] === '#') k--;
  if (k === 0) return '';
  return r[k - 1] === ' ' || r[k - 1] === '\t' ? trimSpaces(r.slice(0, k)) : r;
}

interface ListMarker {
  ordered: boolean;
  /** The bullet, or an ordered list's `.` or `)`: a list continues only
   *  with items that share it. */
  ch: string;
  start: number;
  /** Columns from the marker's start to the item's content. */
  width: number;
  content: string;
}

function listMarker(t: string): ListMarker | null {
  let k = 0;
  let ordered = false;
  let start = 1;
  let ch: string;
  const c = t[0];
  if (c === '-' || c === '*' || c === '+') {
    ch = c;
    k = 1;
  } else {
    while (k < 9 && t[k] !== undefined && t[k]! >= '0' && t[k]! <= '9') k++;
    if (k === 0 || (t[k] !== '.' && t[k] !== ')')) return null;
    ordered = true;
    start = Number(t.slice(0, k));
    ch = t[k]!;
    k++;
  }
  if (k < t.length && t[k] !== ' ' && t[k] !== '\t') return null;
  let sp = 0;
  while (t[k + sp] === ' ' || t[k + sp] === '\t') sp++;
  const rest = t.slice(k + sp);
  if (!rest) return { ordered, ch, start, width: k + 1, content: '' };
  // Five spaces or more after the marker is an item that opens with
  // indented code, and the content column is one past the marker.
  if (sp > 4) return { ordered, ch, start, width: k + 1, content: ' '.repeat(sp - 1) + rest };
  return { ordered, ch, start, width: k + sp, content: rest };
}

/** May this list item cut a paragraph short? Only with something in it,
 *  and an ordered one only from 1 — so a sentence that wraps onto
 *  "2011. was a year" stays a sentence. */
const interrupts = (m: ListMarker): boolean => m.content.trim() !== '' && (!m.ordered || m.start === 1);

/** The tag names that open CommonMark's sixth kind of HTML block, in
 *  pulldown-cmark's list, which is the server's parser's. */
const HTML_BLOCK_TAGS = new Set(
  (
    'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt ' +
    'fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link ' +
    'main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead ' +
    'title tr track ul'
  ).split(' '),
);

/**
 * The HTML block a line opens, if it opens one: CommonMark's seven kinds
 * as pulldown-cmark reads them. `end` is what a line must contain to end
 * the block, that line included, or null for a block that runs to a
 * blank line. Only the seventh, a complete tag alone on its line, cannot
 * cut a paragraph short.
 */
function htmlBlock(t: string): { end: string | null; interrupts: boolean } | null {
  if (t.charCodeAt(0) !== LT) return null;
  // Ended by the closing tag of the one that opened it, in lowercase.
  // CommonMark takes any of the four in any case; the server's parser
  // does this, and a block has to end in the same place for both.
  const raw = /^<(pre|script|style|textarea)(?:[ \t>]|$)/i.exec(t);
  if (raw) return { end: `</${raw[1]!.toLowerCase()}>`, interrupts: true };
  if (t.startsWith('<!--')) return { end: '-->', interrupts: true };
  if (t.startsWith('<?')) return { end: '?>', interrupts: true };
  if (t.startsWith('<![CDATA[')) return { end: ']]>', interrupts: true };
  if (/^<![A-Za-z]/.test(t)) return { end: '>', interrupts: true };
  const block = /^<\/?([A-Za-z0-9]+)(?:[ \t>]|\/>|$)/.exec(t);
  if (block && HTML_BLOCK_TAGS.has(block[1]!.toLowerCase())) return { end: null, interrupts: true };
  if (/^<\/?(?:pre|script|style|textarea)(?![A-Za-z0-9-])/i.test(t)) return null;
  for (const re of [OPEN_TAG, CLOSE_TAG]) {
    re.lastIndex = 0;
    if (re.test(t) && isBlank(t.slice(re.lastIndex))) return { end: null, interrupts: false };
  }
  return null;
}

/** Would this line open a block of its own, and so end a lazily
 *  continued paragraph or a table? */
function startsBlock(line: string): boolean {
  const l = detab(line);
  const ind = indentOf(l);
  if (ind >= 4) return false;
  const t = l.slice(ind);
  if (fenceOpen(t) || atxLevel(t) || t[0] === '>' || isRule(t) || htmlBlock(t)?.interrupts) return true;
  const m = listMarker(t);
  return !!m && interrupts(m);
}

/** A table row's cells, with `\|` as a pipe in a cell. */
function splitRow(line: string): string[] {
  let s = trimSpaces(line);
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
    } else if (s[k] === '|') {
      cells.push(trimSpaces(cur));
      cur = '';
    } else cur += s[k];
  }
  cells.push(trimSpaces(cur));
  return cells;
}

/** A GitHub table's delimiter row — `| :--- | ---: |` — as alignments,
 *  or null when the line is not one. It must have a pipe, so `---` under
 *  a line of text stays a heading underline. */
function delimiterRow(line: string): MdAlign[] | null {
  if (!line.includes('|')) return null;
  const cells = splitRow(line);
  const align: MdAlign[] = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return align;
}

/** A paragraph's lines as one string: each line trimmed, and a trailing
 *  backslash — CommonMark's hard break — dropped, since every line break
 *  in a paragraph is drawn as one anyway. */
function joinParagraph(lines: readonly string[]): string {
  return lines
    .map((l, k) => {
      const t = trimSpaces(l);
      return k < lines.length - 1 && t.endsWith('\\') && !t.endsWith('\\\\') ? t.slice(0, -1) : t;
    })
    .join('\n');
}

/** The `]` that closes a link label opening at `open`, or -1: the first
 *  unescaped one, with no `[` before it, within CommonMark's length. */
function labelEnd(s: string, open: number): number {
  for (let k = open + 1; k < s.length && k <= open + 1000; k++) {
    const c = s.charCodeAt(k);
    if (c === BACKSLASH) k++;
    else if (c === LBRACKET) return -1;
    else if (c === 0x5d) return k;
  }
  return -1;
}

/** Past the end of the line `at` is on, when nothing but spaces and tabs
 *  is left on it; otherwise -1. */
function lineRest(s: string, at: number): number {
  let k = at;
  while (s[k] === ' ' || s[k] === '\t') k++;
  if (k === s.length) return k;
  return s[k] === '\n' ? k + 1 : -1;
}

/**
 * Link reference definitions — `[label]: dest "title"` — at the start of
 * a paragraph's text, recorded in `mode.defs` and taken off: what is left
 * is the paragraph. A definition is not drawn, as CommonMark has it, and
 * a reference to it resolves anywhere in the body. Where it goes is only
 * recorded here; the link that uses it is judged like any other.
 */
function takeDefinitions(text: string, mode: Mode): string {
  if (text.charCodeAt(0) !== LBRACKET) return text;
  const src = new Source(text, true);
  let at = 0;
  while (text.charCodeAt(at) === LBRACKET) {
    const close = labelEnd(text, at);
    if (close < 0 || text.charCodeAt(close + 1) !== 0x3a) break;
    const key = labelKey(text.slice(at + 1, close));
    const from = skipLinkSpace(text, close + 2);
    const dest = key === null ? null : src.destination(from);
    // A bare destination has to be something; `<>` may be empty.
    if (!dest || (!dest.raw && text.charCodeAt(from) !== LT)) break;
    // A title, when one follows and ends its line; otherwise the
    // destination has to end its own.
    let end = lineRest(text, dest.end);
    const t = skipLinkSpace(text, dest.end);
    if (t > dest.end) {
      const title = src.title(t);
      const after = title < 0 ? -1 : lineRest(text, title);
      if (after >= 0) end = after;
    }
    if (end < 0) break;
    if (!mode.defs.has(key!)) mode.defs.set(key!, unescapeDest(dest.raw));
    at = end;
  }
  return text.slice(at);
}

/** Inline content for later: an empty list that `parseArticle` fills
 *  once every reference definition in the body is known. */
function later(text: string, mode: Mode): MdRun[] {
  const runs: MdRun[] = [];
  mode.later.push([runs, text]);
  return runs;
}

function parseBlocks(input: readonly string[], depth: number, mode: Mode): MdBlock[] {
  const para = (text: string): MdBlock[] => (text ? [{ type: 'paragraph', content: later(text, mode) }] : []);
  if (depth > MAX_BLOCK_DEPTH) return para(joinParagraph(input.filter((l) => !isBlank(l))));

  const lines = input.map(detab);
  const out: MdBlock[] = [];
  let open: string[] = [];
  const flush = () => {
    if (open.length) out.push(...para(takeDefinitions(joinParagraph(open), mode)));
    open = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      flush();
      i++;
      continue;
    }
    const ind = indentOf(line);

    // Indented code cannot interrupt a paragraph; there, an indented line
    // is just the paragraph going on.
    if (ind >= 4) {
      if (open.length) {
        open.push(line);
        i++;
        continue;
      }
      const code: string[] = [];
      while (i < lines.length && (isBlank(lines[i]!) || indentOf(lines[i]!) >= 4)) code.push(stripCols(lines[i++]!, 4));
      while (code.length && isBlank(code[code.length - 1]!)) code.pop();
      out.push({ type: 'code', text: code.join('\n') });
      continue;
    }

    const t = line.slice(ind);

    const fence = fenceOpen(t);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      // Unterminated, it runs to the end of what contains it — the same
      // answer chat gives, for the same reason.
      while (i < lines.length) {
        const l = lines[i]!;
        const li = indentOf(l);
        i++;
        if (li < 4 && fenceCloses(l.slice(li), fence.mark)) break;
        code.push(stripCols(l, ind));
      }
      const language = fence.info.split(/[ \t]/)[0];
      out.push(language ? { type: 'code', text: code.join('\n'), language } : { type: 'code', text: code.join('\n') });
      continue;
    }

    // An HTML block: opaque, as on the server — its lines drawn as typed,
    // and nothing in them markdown, a link or a reference.
    const html = htmlBlock(t);
    if (html && (html.interrupts || !open.length)) {
      flush();
      const block: string[] = [];
      if (html.end === null) {
        while (i < lines.length && !isBlank(lines[i]!)) block.push(lines[i++]!);
      } else {
        while (i < lines.length) {
          const l = lines[i++]!;
          block.push(l);
          if (l.includes(html.end)) break;
        }
      }
      out.push({ type: 'html', text: block.join('\n') });
      continue;
    }

    const level = atxLevel(t);
    if (level) {
      flush();
      out.push({ type: 'heading', level: level as 1, content: later(headingText(t.slice(level)), mode) });
      i++;
      continue;
    }

    // A line of `=` or `-` under a paragraph makes it a heading, and that
    // takes precedence over `---` being a rule. Under nothing but
    // reference definitions it is a line like any other.
    if (open.length && /^(?:=+|-+)[ \t]*$/.test(t)) {
      const text = takeDefinitions(joinParagraph(open), mode);
      open = [];
      if (text) {
        out.push({ type: 'heading', level: t[0] === '=' ? 1 : 2, content: later(text, mode) });
        i++;
        continue;
      }
    }

    if (isRule(t)) {
      flush();
      out.push({ type: 'rule' });
      i++;
      continue;
    }

    if (t[0] === '>') {
      flush();
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (isBlank(l)) break;
        const li = indentOf(l);
        if (li < 4 && l[li] === '>') {
          const rest = l.slice(li + 1);
          inner.push(rest[0] === ' ' || rest[0] === '\t' ? rest.slice(1) : rest);
        } else if (inner.length && !isBlank(inner[inner.length - 1]!) && !startsBlock(l)) {
          // Lazy continuation: a paragraph in a quote goes on without its
          // marker, as it does in every email ever re-wrapped.
          inner.push(l);
        } else break;
        i++;
      }
      out.push({ type: 'quote', children: parseBlocks(inner, depth + 1, mode) });
      continue;
    }

    const first = listMarker(t);
    if (first && (!open.length || interrupts(first))) {
      flush();
      const items: MdBlock[][] = [];
      let tight = true;
      let marker = first;
      let markerInd = ind;
      for (;;) {
        const contentInd = markerInd + marker.width;
        const body = [marker.content];
        i++;
        while (i < lines.length) {
          const l = lines[i]!;
          if (isBlank(l)) body.push('');
          else if (indentOf(l) >= contentInd) body.push(stripCols(l, contentInd));
          else if (body[body.length - 1] !== '' && !startsBlock(l)) body.push(l);
          else break;
          i++;
        }
        let blanks = 0;
        while (body.length > 1 && body[body.length - 1] === '') {
          body.pop();
          blanks++;
        }
        const blocks = parseBlocks(body, depth + 1, mode);
        if (blocks.length > 1 && body.includes('')) tight = false;
        items.push(blocks);
        if (i >= lines.length) break;
        const l = lines[i]!;
        const li = indentOf(l);
        const next = li < 4 && !isRule(l.slice(li)) ? listMarker(l.slice(li)) : null;
        if (!next || next.ordered !== first.ordered || next.ch !== first.ch) break;
        if (blanks) tight = false;
        marker = next;
        markerInd = li;
      }
      out.push({ type: 'list', ordered: first.ordered, start: first.start, tight, items });
      continue;
    }

    // A GitHub table: a row with a pipe, then a delimiter row with as many
    // cells, no wider than a reader could use. It may cut a paragraph
    // short, and runs to a blank line or the next block.
    if (t.includes('|') && i + 1 < lines.length) {
      const d = lines[i + 1]!;
      const di = indentOf(d);
      const align = di < 4 ? delimiterRow(d.slice(di)) : null;
      const head = splitRow(t);
      if (align && head.length === align.length && align.length <= MAX_TABLE_COLUMNS) {
        flush();
        // A row keeps the cells it was written with and no more. Padding
        // each to the head's width would make every one-word row cost as
        // much as the widest header anybody can type.
        const cells = (row: string[]) => row.slice(0, align.length).map((c) => later(c, mode));
        const rows: MdRun[][][] = [];
        i += 2;
        while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!)) rows.push(cells(splitRow(lines[i++]!)));
        out.push({ type: 'table', align, head: cells(head), rows });
        continue;
      }
    }

    open.push(line);
    i++;
  }
  flush();
  return out;
}

/**
 * A `text/markdown` article, parsed. `refs` is the article's own list:
 * only an id in it becomes a link — a `news:` link or a `#51` — exactly
 * as in a plain body, and `#51` inside code is never one.
 *
 * Every line break inside a paragraph is kept as one. CommonMark calls
 * them soft and joins the lines, but news here was written in chat-era
 * text boxes by people who pressed Enter because they meant it, and a
 * plain body shows them; a markdown one reflowing into a single line
 * would read as the client having lost them.
 */
export function parseArticle(body: string, refs: readonly NewsReference[]): MdBlock[] {
  const mode = articleMode(refs);
  const blocks = parseBlocks(lf(body).split('\n'), 0, mode);
  for (const [runs, text] of mode.later) for (const r of inline(text, mode)) runs.push(r);
  return blocks;
}

/** The words of parsed blocks with the markup gone, one block to a line:
 *  what a listing's one-line excerpt is cut from. */
export function blocksText(blocks: readonly MdBlock[]): string {
  const runs = (rs: readonly MdRun[]) => rs.map((r) => r.text).join('');
  return blocks
    .map((b): string => {
      switch (b.type) {
        case 'paragraph':
        case 'heading':
          return runs(b.content);
        case 'code':
        case 'html':
          return b.text;
        case 'quote':
          return blocksText(b.children);
        case 'list':
          return b.items.map(blocksText).join('\n');
        case 'rule':
          return '';
        case 'table':
          return [b.head, ...b.rows].map((row) => row.map(runs).join(' ')).join('\n');
      }
    })
    .filter(Boolean)
    .join('\n');
}
