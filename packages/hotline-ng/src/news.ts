/**
 * The one piece of news that is text rather than shape: where the `#51`
 * references in a body are.
 *
 * The server finds them when an article is posted and hands back the
 * ones that named an article, as `refs` (hxd-ng's `docs/news.md` §5.3).
 * It never rewrites the body, so drawing them as links means finding
 * them again — and finding them by the *same rule*, or a client would
 * link digits the server did not resolve, or miss ones it did. This is
 * that rule, and only ids the server resolved become links: `#4000`
 * naming nothing stays the digits someone typed.
 *
 * Plain data in, plain data out; no DOM.
 */

import type { NewsReference } from './protocol.js';

/** A run of a body: text to draw as text, or a reference to draw as a
 *  link to the article it names. */
export type BodySpan = { text: string } | { text: string; ref: NewsReference };

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** ASCII punctuation, as Rust's `is_ascii_punctuation` has it. */
const isPunct = (c: string): boolean => /^[!-/:-@[-`{-~]$/.test(c);

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** May a `#` preceded by this character start a reference? Start of text,
 *  whitespace, or punctuation other than `&` (where `&#51;` is a character
 *  reference), `#` and `_`. */
function opens(prev: string | undefined): boolean {
  if (prev === undefined) return true;
  if (prev === '&' || prev === '#' || prev === '_') return false;
  return isSpace(prev) || isPunct(prev);
}

/** May a reference end before this character? End of text, whitespace,
 *  or punctuation other than `_` — never glued to a word. */
function closes(next: string | undefined): boolean {
  if (next === undefined) return true;
  if (next === '_') return false;
  return isSpace(next) || isPunct(next);
}

/**
 * Split a body into text and the references the server resolved.
 *
 * `refs` is the article's own list; an id not in it is left as text. The
 * spans concatenate back to `body` exactly.
 */
export function referenceSpans(body: string, refs: readonly NewsReference[]): BodySpan[] {
  const byId = new Map(refs.map((r) => [r.id, r]));
  const out: BodySpan[] = [];
  let text = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (c !== '#' || !opens(body[i - 1])) {
      text += c;
      i++;
      continue;
    }
    let end = i + 1;
    while (isDigit(body[end])) end++;
    const digits = body.slice(i + 1, end);
    const ref = digits.length > 0 && digits.length <= 10 && closes(body[end]) ? byId.get(Number(digits)) : undefined;
    if (!ref) {
      text += c;
      i++;
      continue;
    }
    if (text) out.push({ text });
    text = '';
    out.push({ text: body.slice(i, end), ref });
    i = end;
  }
  if (text) out.push({ text });
  return out;
}

/** A run of a search snippet: matched or not. */
export interface MarkedSpan {
  text: string;
  mark: boolean;
}

/**
 * A search hit's snippet as runs to draw, from the `marks` the server
 * sent — `[start, end)` in UTF-16 code units, which is what a string here
 * indexes by.
 *
 * The server's marks are trusted to mean something and not to be well
 * formed: a range past the end is cut to it, one that overlaps what came
 * before starts where that ended, and an empty one is dropped, as is one
 * whose ends are not numbers at all. The runs concatenate back to the
 * snippet exactly, whatever the marks said.
 */
export function markedSpans(snippet: string, marks: readonly (readonly [number, number])[]): MarkedSpan[] {
  const out: MarkedSpan[] = [];
  let at = 0;
  // Before the sort, which orders nothing sensibly around a NaN.
  const sorted = marks
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end))
    .sort((a, b) => a[0] - b[0]);
  for (const [rawStart, rawEnd] of sorted) {
    const start = Math.max(at, Math.min(Math.floor(rawStart), snippet.length));
    const end = Math.max(start, Math.min(Math.floor(rawEnd), snippet.length));
    if (end <= start) continue;
    if (start > at) out.push({ text: snippet.slice(at, start), mark: false });
    out.push({ text: snippet.slice(start, end), mark: true });
    at = end;
  }
  if (at < snippet.length) out.push({ text: snippet.slice(at), mark: false });
  return out;
}
