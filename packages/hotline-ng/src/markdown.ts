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
 * over the same inline scanner, plus the `news:` scheme. Two things
 * CommonMark has are missing on purpose, as they are on the server
 * (hxd-ng's `docs/news.md` §5.2): raw HTML, which is simply text here
 * because nothing is ever interpreted as HTML; and images, because an
 * article's pictures are its attachments and a body that fetches a URL
 * reports every reader's address to a stranger. `![alt](url)` in an
 * article stays exactly the characters typed.
 *
 * **Links go only where a reader can see.** A `[label](url)` whose scheme
 * is not on the allowlist renders as the literal characters, brackets and
 * all, rather than as a link whose destination nobody can inspect.
 *
 * **Pathological input is bounded.** Emphasis nests at most eight deep, so
 * a line of five thousand asterisks cannot recurse into the stack; block
 * containers nest at most sixteen deep, past which the rest is a
 * paragraph; and the searches for a closing delimiter, a bracket's match
 * and a code span's closing run are memoized per string, so a long body
 * scans in roughly linear time rather than retrying the same dead end
 * from every opener. The memoization changes nothing about the answers —
 * a test drives it against a straight port of the Rust — only what they
 * cost.
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
  | { type: 'table'; align: MdAlign[]; head: MdRun[][]; rows: MdRun[][][] };

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
 *  anybody writes; shallow enough that a body of five thousand `>` is a
 *  few dozen elements rather than a DOM the browser gives up on. */
const MAX_BLOCK_DEPTH = 16;

// --- the inline scanner --------------------------------------------------

const BOLD = 1;
const ITALIC = 2;
const CODE = 4;
const STRIKE = 8;

const BACKSLASH = 0x5c;
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

/**
 * Schemes a `[label](url)` may point at: what GtkHx's URL detector
 * accepts, minus its bare-host autolink forms. Anything else —
 * `javascript:`, `data:`, `file:`, a scheme nobody recognizes — makes the
 * whole construct render as the literal characters typed.
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
}

const CHAT: Mode = { article: false, refs: new Map() };

const UNKNOWN = -2;
const FAIL = -1;

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

  constructor(readonly s: string) {
    this.n = s.length;
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
   * unclosed backtick run ends the search. An empty span (`****`) is not
   * emphasis, which is the start position's special case.
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
      if (s.startsWith(delim, i)) return canClose(this, i) ? -(i + 2) : i + 2;
      return i + 1;
    });
  }

  /** Close for single-character emphasis. A doubled run is skipped whole,
   *  so `*a**b*` does not close on the pair; `_` closes only at a word
   *  boundary. */
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

  /** Each `[`'s balancing `]`, or -1. GtkHx counts depth forward from
   *  the bracket with a backslash skipping the next character; a stack
   *  over the whole string gives the same pairs in one pass. */
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
  // `news:` scheme, digits only. Linked only when it resolved; otherwise
  // the label is the text the author wrote around a pointer to nothing.
  const m = /^news:(\d{1,10})$/.exec(href);
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
    if (c === BACKSLASH && i + 1 < n) {
      const next = s[i + 1]!;
      if (ESCAPABLE.has(next)) {
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

    if (depth < MAX_DEPTH) {
      // **bold** and ~~strike~~ — the two-character delimiters first, so
      // `**` is never an empty `*` pair.
      const two = c === STAR && s.charCodeAt(i + 1) === STAR ? '**' : c === TILDE && s.charCodeAt(i + 1) === TILDE ? '~~' : null;
      if (two) {
        if (canOpen(src, i + 2)) {
          const close = src.findDelim(i + 2, two);
          if (close >= 0) {
            flush(i);
            scan(new Source(s.slice(i + 2, close)), base | (two === '**' ? BOLD : STRIKE), target, depth + 1, out, mode);
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
          scan(new Source(s.slice(i + 1, close)), base | ITALIC, target, depth + 1, out, mode);
          i = close + 1;
          lit = i;
          continue;
        }
        i += 1;
        continue;
      }

      if (c === LBRACKET) {
        const link = src.link(i);
        if (link) {
          // `![alt](url)` in an article is the characters typed: its
          // pictures are its attachments. In chat it is GtkHx's answer —
          // a `!` and then a link — which draws no image either.
          if (mode.article && i > 0 && s.charCodeAt(i - 1) === BANG) {
            i = link.end;
            continue;
          }
          const t = linkTarget(link.href, mode);
          if (t !== undefined) {
            flush(i);
            // At MAX_DEPTH: a label is text, and a link inside a link is
            // not markdown — the balanced brackets would otherwise let
            // the inner one parse.
            scan(new Source(link.label), base, t, MAX_DEPTH, out, mode);
            i = link.end;
            lit = i;
            continue;
          }
          // A scheme nobody can vouch for: the whole construct stays as
          // typed, so the reader sees what was written rather than a
          // link they cannot inspect.
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
  if (p.target?.href !== undefined) run.href = p.target.href;
  if (p.target?.ref) run.ref = p.target.ref;
  return run;
}

function inline(src: string, mode: Mode): MdRun[] {
  const out = new Builder();
  scan(new Source(src), 0, null, 0, out, mode);
  if (!mode.article) return out.pieces.map(toRun);
  // The `#51` shorthand, by the server's own rule (`referenceSpans`), in
  // prose only. The server scans each stretch of text between two pieces
  // of markup on its own — never across an emphasis boundary, a link or a
  // code span — which is exactly what one run is here.
  const refs = [...mode.refs.values()];
  return out.pieces.flatMap((p) => {
    const run = toRun(p);
    if (run.code || p.target || refs.length === 0) return [run];
    return referenceSpans(run.text, refs).map((span) => ({ ...run, text: span.text, ...('ref' in span ? { ref: span.ref } : {}) }));
  });
}

/**
 * Inline markdown: GtkHx's chat dialect by default, or an article's when
 * `article` is given — which adds the `news:` scheme, draws `![]()` as
 * text, and links the references in `article.refs`.
 *
 * Never fails: anything that does not close renders as the characters
 * that were typed.
 */
export function parseInline(src: string, article?: { refs: readonly NewsReference[] }): MdRun[] {
  return inline(src, article ? { article: true, refs: new Map(article.refs.map((r) => [r.id, r])) } : CHAT);
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

/** Would this line open a block of its own, and so end a lazily
 *  continued paragraph or a table? */
function startsBlock(line: string): boolean {
  const l = detab(line);
  const ind = indentOf(l);
  if (ind >= 4) return false;
  const t = l.slice(ind);
  if (fenceOpen(t) || atxLevel(t) || t[0] === '>' || isRule(t)) return true;
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

function parseBlocks(input: readonly string[], depth: number, mode: Mode): MdBlock[] {
  const para = (text: string): MdBlock[] => (text ? [{ type: 'paragraph', content: inline(text, mode) }] : []);
  if (depth > MAX_BLOCK_DEPTH) return para(joinParagraph(input.filter((l) => !isBlank(l))));

  const lines = input.map(detab);
  const out: MdBlock[] = [];
  let open: string[] = [];
  const flush = () => {
    if (open.length) out.push(...para(joinParagraph(open)));
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

    const level = atxLevel(t);
    if (level) {
      flush();
      out.push({ type: 'heading', level: level as 1, content: inline(headingText(t.slice(level)), mode) });
      i++;
      continue;
    }

    // A line of `=` or `-` under a paragraph makes it a heading, and that
    // takes precedence over `---` being a rule.
    if (open.length && /^(?:=+|-+)[ \t]*$/.test(t)) {
      out.push({ type: 'heading', level: t[0] === '=' ? 1 : 2, content: inline(joinParagraph(open), mode) });
      open = [];
      i++;
      continue;
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
    // cells. It may cut a paragraph short, and runs to a blank line or
    // the next block.
    if (t.includes('|') && i + 1 < lines.length) {
      const d = lines[i + 1]!;
      const di = indentOf(d);
      const align = di < 4 ? delimiterRow(d.slice(di)) : null;
      const head = splitRow(t);
      if (align && head.length === align.length) {
        flush();
        const cells = (row: string[]) => align.map((_, k) => inline(row[k] ?? '', mode));
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
  return parseBlocks(lf(body).split('\n'), 0, { article: true, refs: new Map(refs.map((r) => [r.id, r])) });
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
