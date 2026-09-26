/** Rendering chat.
 *
 * Hotline's own layout was `\r%13.13s:  %s` — the nick right-aligned in
 * a thirteen-character column, then the text. That alignment is the
 * reason a Hotline window is so easy to read at a glance, and it is kept
 * here: a fixed nick column, right-aligned, with the message body
 * starting on one shared left edge. What is *not* kept is the
 * thirteen-byte truncation, which existed because the server was
 * formatting into a fixed-width buffer; the ng wire hands us
 * `{from, text, style}` and lets the client lay it out.
 *
 * Runs of lines from one person collapse into one labelled block, the
 * modern convention, which costs nothing and reads better than the same
 * name repeated eleven times.
 */

import { lineReport } from '../moderation';
import { continuesRun, type Conversation, type Line } from '../state';
import type { Store } from '../state';
import { clock, fill, h, linkify } from './dom';
import { face } from './avatar';
import { icon } from './icons';
import { chatNodes } from './markdown';
import { mediaEl, type MediaCache } from './media';

/** Chat-gutter icons stay at 1× — at 2× they compete with the text for
 *  attention, and the roster is where you go to look at people. */
const CHAT_SCALE = 1;

export interface TranscriptOptions {
  /** Draw what people typed as GtkHx's markdown. Off, a line is the text
   *  exactly as typed, with only its bare URLs made links. The line keeps
   *  its source either way, so flipping it redraws what is already here. */
  markdown: boolean;
  /** This session may redact public lines, so a line with an id offers
   *  to. Anyone may report. */
  moderator?: boolean;
}

/** The line each drawn row is, for a click on one of its buttons to
 *  find. A map rather than an index on the row: trimming and merging
 *  move indices, and a row never changes which line it is. */
const rows = new WeakMap<Element, Line>();

/** The line a row inside the transcript was drawn from. */
export function lineOf(el: Element): Line | undefined {
  const row = el.closest('.line');
  return row ? rows.get(row) : undefined;
}

export function renderTranscript(
  el: HTMLElement,
  conv: Conversation,
  store: Store,
  media: MediaCache,
  opts: TranscriptOptions,
): void {
  const nodes: HTMLElement[] = [];
  let prev: Line | undefined;
  for (const line of conv.lines) {
    nodes.push(lineEl(line, prev, conv, store, media, opts));
    prev = line;
  }
  fill(el, ...nodes);
  scrollToEnd(el);
}

export function appendLine(
  el: HTMLElement,
  line: Line,
  conv: Conversation,
  store: Store,
  media: MediaCache,
  opts: TranscriptOptions,
): void {
  const atBottom = isAtBottom(el);
  const prev = conv.lines[conv.lines.length - 2];
  el.append(lineEl(line, prev, conv, store, media, opts));
  while (el.childElementCount > conv.lines.length) el.firstElementChild?.remove();
  if (atBottom) scrollToEnd(el);
}

export function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

export function scrollToEnd(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight;
}

/** Redraw without moving the reader. At the newest line they stay there;
 *  scrolled back, the line at the top of the view stays where it was,
 *  however the lines above it changed height. `redraw` must leave one
 *  element per line, in the same order, as `renderTranscript` does. */
export function keepingPlace(el: HTMLElement, redraw: () => void): void {
  if (isAtBottom(el)) {
    redraw();
    return;
  }
  const top = el.getBoundingClientRect().top;
  const k = [...el.children].findIndex((c) => c.getBoundingClientRect().bottom > top);
  const was = el.children[k]?.getBoundingClientRect().top;
  redraw();
  const now = el.children[k]?.getBoundingClientRect().top;
  if (was !== undefined && now !== undefined) el.scrollTop += now - was;
}

/** The clock is printed only when it changes. A room where thirty lines
 *  all say 03:46 has spent a column telling you nothing; the full
 *  timestamp stays on the line's tooltip either way. */
function stamp(line: Line, prev: Line | undefined): string {
  const now = clock(line.t);
  return prev && clock(prev.t) === now ? '' : now;
}

function lineEl(
  line: Line,
  prev: Line | undefined,
  conv: Conversation,
  store: Store,
  media: MediaCache,
  opts: TranscriptOptions,
): HTMLElement {
  const el = line.kind === 'chat' ? chatLine(line, prev, store, media, opts) : eventLine(line, prev, media, opts);
  const acts = actions(line, conv, store, opts);
  if (acts) el.append(acts);
  rows.set(el, line);
  return el;
}

/** What can be done to a line from where it is drawn: report it, and
 *  for a moderator, redact it. Buttons carry only a verb; the shell
 *  finds the line with `lineOf` and does the rest. */
function actions(line: Line, conv: Conversation, store: Store, opts: TranscriptOptions): HTMLElement | null {
  const report = lineReport(line, conv, store.self, (uid) => store.user(uid) !== undefined) !== null;
  const redact =
    !!opts.moderator &&
    conv.kind === 'lobby' &&
    line.id !== undefined &&
    !line.deleted &&
    (line.kind === 'chat' || line.kind === 'action');
  if (!report && !redact) return null;
  return h(
    'span',
    { class: 'line-actions' },
    report ? h('button', { type: 'button', class: 'ghost small', dataset: { act: 'report' }, title: 'Tell the moderators about this' }, 'Report') : null,
    redact ? h('button', { type: 'button', class: 'ghost small danger', dataset: { act: 'redact' }, title: 'Remove this line for everyone' }, 'Redact') : null,
  );
}

function chatLine(
  line: Line,
  prev: Line | undefined,
  store: Store,
  media: MediaCache,
  opts: TranscriptOptions,
): HTMLElement {

  const from = line.from;
  const sameSpeaker = continuesRun(prev, line);

  const me = from?.uid === store.self?.uid;
  // A message that waited has no live uid to look a face up by — the
  // sender had no session when it was flushed — so it gets no icon
  // rather than the wrong one.
  const user = from?.uid !== undefined && from.uid > 0 ? store.user(from.uid) : undefined;
  const iconId = user?.icon ?? from?.icon;
  // The body only: the nick is a name, and a name with asterisks in it
  // is still that name. Your own lines are drawn like anyone's, a
  // private message's local echo included, so they look as they do to
  // whoever reads them; what stays literal is this client's own notices
  // and status lines, which are drawn in `eventLine`.
  const body = opts.markdown ? chatNodes(line.text) : { nodes: linkify(line.text), block: false };

  return h(
    'div',
    {
      class: `line chat${sameSpeaker ? ' cont' : ''}${me ? ' mine' : ''}${line.queued ? ' queued' : ''}`,
      title: new Date(line.t).toLocaleString(),
    },
    h('span', { class: 'time' }, stamp(line, prev)),
    h(
      'span',
      { class: 'gutter' },
      sameSpeaker || iconId === undefined
        ? null
        : user
          ? face(user, CHAT_SCALE)
          : icon(iconId, CHAT_SCALE),
    ),
    h(
      'span',
      {
        class: 'name',
        title: from?.login ?? (from?.uid !== undefined ? `uid ${from.uid}` : ''),
      },
      sameSpeaker ? '' : (from?.nick ?? ''),
    ),
    // A `div`, because a body may hold blocks: a quote, a code block, an
    // image. A phone runs the body on beside the nick, so one with a
    // markdown block in it is marked to start on a line of its own.
    h(
      'div',
      { class: body.block ? 'text md-blocks' : 'text' },
      // The legacy wire prepends `[queued 2026-09-06 14:22 UTC]` to the
      // body because it has nowhere else to put it. Here it is a tag
      // beside the text and the timestamp is already the line's own, in
      // the reader's timezone rather than in UTC.
      line.queued ? h('span', { class: 'tag', title: 'Held by the server until you came back' }, 'queued') : null,
      ...body.nodes,
      // An image is a block under the text, not a word in it: a line
      // may carry one with nothing said at all, which is a picture
      // posted rather than an empty message.
      line.media ? mediaEl(line.media, media) : null,
    ),
  );
}

/** Actions, notices, broadcasts and this client's own remarks all read
 *  as one column of asides rather than as chat with a strange name. */
function eventLine(line: Line, prev: Line | undefined, media: MediaCache, opts: TranscriptOptions): HTMLElement {
  const prefix =
    line.kind === 'action'
      ? `${line.from?.nick ?? ''} `
      : line.kind === 'broadcast'
        ? `${line.from?.nick ?? 'server'}: `
        : '';
  const text = prefix + line.text;
  // GtkHx's rule: only a body somebody typed, in one voice, is read as
  // markdown. A `/me` and a broadcast are that — a person's words behind
  // a name this client puts there, and the name is left alone. A notice
  // is the server's (agreement text is often drawn in asterisks), a
  // system line is this client's, and a news notice is an excerpt the
  // server cut; all of those are shown as they are.
  const typed = opts.markdown && (line.kind === 'action' || line.kind === 'broadcast');
  const body = typed && line.article === undefined ? chatNodes(line.text) : null;
  const label =
    line.kind === 'broadcast' ? 'broadcast' : line.kind === 'deleted' ? 'deleted' : '';
  return h(
    'div',
    { class: `line ${line.kind}`, title: new Date(line.t).toLocaleString() },
    h('span', { class: 'time' }, stamp(line, prev)),
    h('span', { class: 'gutter' }),
    h('span', { class: 'name' }, label),
    h(
      'div',
      { class: body?.block ? 'text md-blocks' : 'text' },
      // A news notice is one link to the article it is about; the shell
      // handles the click, since only it can open the reader.
      ...(line.article !== undefined
        ? [h('a', { href: `#news-${line.article}`, class: 'news-notice', dataset: { article: String(line.article) } }, text)]
        : body
          ? [prefix, ...body.nodes]
          : linkify(text)),
      // The same renderer a chat line gets. A redacted history row is
      // the *only* line that ever carries `removed`, so drawing it any
      // other way would leave that state with no renderer at all — and
      // would say "image removed" in two visual languages depending on
      // which kind of line it landed on.
      line.media ? mediaEl(line.media, media) : null,
    ),
  );
}
