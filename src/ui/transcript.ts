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

import { signerLabel, type ContactOf } from '../contacts';
import { lineReport } from '../moderation';
import type { LineSignature } from '../signing';
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
  /** The contact pinned to a signer, which names what it signed. */
  contact?: ContactOf;
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
  const body = line.hidden
    ? { nodes: hiddenNodes(line), block: false }
    : opts.markdown
      ? chatNodes(line.text)
      : { nodes: linkify(line.text), block: false };
  const who = speaker(line, opts.contact);

  return h(
    'div',
    {
      class: `line chat${sameSpeaker ? ' cont' : ''}${me ? ' mine' : ''}${line.queued ? ' queued' : ''}${line.signature ? ` sig-${line.signature.state}` : ''}`,
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
        class: `name${who.cls}`,
        title: who.title || (from?.login ?? (from?.uid !== undefined ? `uid ${from.uid}` : '')),
      },
      sameSpeaker ? '' : who.name,
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
      sealedTag(line),
      ...signatureTag(line.signature),
      sameSpeaker ? null : who.compared,
      sameSpeaker ? null : who.aside,
      ...body.nodes,
      // An image is a block under the text, not a word in it: a line
      // may carry one with nothing said at all, which is a picture
      // posted rather than an empty message.
      uncovered(line),
      line.media ? mediaEl(line.media, media) : null,
    ),
  );
}

/** Whether a line carries a signature that parsed, or a deniable box
 *  that opened, which names it. */
export function signedBy(sig: LineSignature | undefined): sig is LineSignature {
  return sig !== undefined && ['verified', 'elsewhere', 'unverified', 'deniable'].includes(sig.state);
}

/** In place of a sealed one's text the server could have written: a
 *  way to see it anyway, for this one message. */
function hiddenNodes(line: Line): HTMLElement[] {
  const why =
    line.signature?.state === 'invalid'
      ? 'Its signature does not check, so it is not from the user named.'
      : 'There is nothing to check who sealed it against.';
  return [
    h('span', { class: 'sig-note' }, `Text hidden. ${why} `),
    h('button', { type: 'button', class: 'ghost small', dataset: { act: 'reveal' } }, 'Show anyway'),
  ];
}

/** Whether a private message was sealed, said for each one where it
 *  could have been. */
function sealedTag(line: Line): HTMLElement | null {
  if (line.sealed === undefined) return null;
  return line.sealed
    ? h('span', { class: 'sig sig-sealed', title: 'Sealed to one device: no server on its way could read it' }, 'sealed')
    : h('span', { class: 'sig sig-clear', title: 'Sent in the clear: the servers on its way could read it' }, 'not sealed');
}

/** Who a line is shown as from. */
function speaker(line: Line, contact?: ContactOf): Signed {
  return signedName(line.signature, line.from?.nick ?? '', contact);
}

type Signed = {
  name: string;
  title: string;
  /** Named by a key, or by the name the user compared it as. */
  cls: '' | ' signer' | ' contact';
  aside: HTMLElement | null;
  /** The tag, and whether it says compared. */
  compared: HTMLElement | null;
  isCompared: boolean;
};

/** Who a line, a message or an article is shown as from, as
 *  `signerLabel` has it, and the nick the server put on a signed one as
 *  an aside the signature does not cover. */
export function signedName(sig: LineSignature | undefined, nick: string, contact?: ContactOf): Signed {
  if (!signedBy(sig)) return { name: nick, title: '', cls: '', aside: null, compared: null, isCompared: false };
  const label = signerLabel(sig, nick, contact);
  const title =
    sig.state === 'deniable'
      ? `Sealed deniably by ${sig.signer}${sig.senderKey ? `, under the device key beginning ${sig.senderKey}` : ''}${sig.to ? `, to ${sig.to}` : ''}`
      : sig.signer
        ? `Signed by ${sig.signer}${sig.home ? `, a user of ${sig.home}` : ''}${sig.to ? `, to ${sig.to}` : ''}`
        : 'Signed by a key that could not be checked';
  // Quoted, so a nick can never read as the tag beside it.
  const aside = label.nick
    ? h('span', { class: 'sig-nick', title: "The server's name for them, which the signature does not cover" }, `as "${label.nick}"`)
    : null;
  const compared =
    label.compared === null
      ? null
      : label.compared
        ? h('span', { class: 'sig sig-compared', title: 'You compared this fingerprint with them out of band' }, 'compared')
        : h('span', { class: 'sig sig-uncompared', title: 'You have not compared this fingerprint with them out of band' }, 'not compared');
  const cls = label.byKey ? ' signer' : label.compared ? ' contact' : '';
  return { name: label.name, title, cls, aside, compared, isCompared: label.compared === true };
}

const STATE_WORDS = {
  verified: 'signed',
  elsewhere: 'signed elsewhere',
  unverified: 'unverified',
  unsigned: 'signature expected',
  deniable: 'deniable',
  unopened: 'could not be opened',
} as const;

/** A line as the live region says it: by the name the transcript shows
 *  and with its signature's state, and a bad signature's by no name. */
export function spoken(line: Line, contact?: ContactOf): string {
  const sig = line.signature;
  const text = line.hidden ? 'text hidden' : line.text;
  if (sig?.state === 'invalid') return `Bad signature: ${text}`;
  const who = speaker(line, contact);
  const name = who.name;
  const state = [
    line.sealed ? 'sealed' : line.sealed === false ? 'not sealed' : '',
    sig ? STATE_WORDS[sig.state] : '',
    // Said where it was, but not for every stranger's line.
    who.isCompared ? 'compared' : '',
  ]
    .filter(Boolean)
    .map((w) => `, ${w}`)
    .join('');
  return name ? `${name}${state}: ${text}` : text;
}

/** A signed time, with its date unless it is today's. */
function signedAt(sent: number): string {
  const t = sent * 1000;
  const day = new Date(t).toDateString() === new Date().toDateString();
  return day ? clock(t) : `${new Date(t).toLocaleDateString()} ${clock(t)}`;
}

/** An image rides beside a signed line, outside what was signed. */
function uncovered(line: Line): HTMLElement | null {
  if (!line.media || !signedBy(line.signature)) return null;
  return h('span', { class: 'sig-note' }, 'The image is not covered by the signature.');
}

/** §8's state of a signed line, or of an unsigned one where a signature
 *  was expected: tags that outweigh the nick beside it. */
export function signatureTag(sig: LineSignature | undefined): HTMLElement[] {
  if (!sig) return [];
  const by = sig.signer ? ` by ${sig.signer}` : '';
  const at = sig.sent !== undefined ? ` ${signedAt(sig.sent)}` : '';
  const on = sig.home ? ` on ${sig.home}` : '';
  const [label, title] = {
    verified: [`signed${at}${on}`, `Signed${by}${sig.to ? ` to ${sig.to}` : ''}.`],
    elsewhere: [
      `signed elsewhere${at}: ${sig.signedFor ?? 'another scope'}`,
      `Signed${by} for ${sig.signedFor ?? 'another scope'}, so not said here.`,
    ],
    unverified: [
      `unverified${on}`,
      `Signed${by || ' by a key that could not be checked'}, ${sig.why ? `but ${sig.why}` : 'with nothing to check it against'}: not shown as from this nick.`,
    ],
    invalid: ['bad signature', 'The signature does not check: this is not from the user named.'],
    unsigned: ['signature expected', 'Unsigned, from someone seen to sign here: a signature may have been removed.'],
    deniable: [
      `deniable${at}`,
      `Sealed deniably${by}: from them, but nobody can be shown that it was, so a report of it cannot be checked.`,
    ],
    unopened: ['could not be opened', `A sealed message this device could not open${sig.why ? `: ${sig.why}` : ''}.`],
  }[sig.state];
  const tags = [h('span', { class: `sig sig-${sig.state}`, title }, label)];
  if (sig.foreignKey && sig.state !== 'invalid') {
    tags.push(
      h(
        'span',
        { class: 'sig sig-foreign', title: "Checked against the key this server gave for their home server, not against this server's own" },
        "another server's key",
      ),
    );
  }
  if (sig.sentAtAnotherTime) {
    tags.push(h('span', { class: 'sig sig-apart', title: 'Signed long before or after this server received it' }, 'sent at another time'));
  }
  return tags;
}

/** Actions, notices, broadcasts and this client's own remarks all read
 *  as one column of asides rather than as chat with a strange name. */
function eventLine(line: Line, prev: Line | undefined, media: MediaCache, opts: TranscriptOptions): HTMLElement {
  const who = line.kind === 'action' ? speaker(line, opts.contact) : null;
  const prefix = line.kind === 'broadcast' ? `${line.from?.nick ?? 'server'}: ` : '';
  const text = prefix + line.text;
  // The actor is a name, apart from the words: a bad signature strikes
  // it, as it strikes a chat line's nick.
  const actor = who
    ? [h('span', { class: `actor${who.cls}`, title: who.title }, who.name), ' ']
    : [];
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
    { class: `line ${line.kind}${line.signature ? ` sig-${line.signature.state}` : ''}`, title: new Date(line.t).toLocaleString() },
    h('span', { class: 'time' }, stamp(line, prev)),
    h('span', { class: 'gutter' }),
    h('span', { class: 'name' }, label),
    h(
      'div',
      { class: body?.block ? 'text md-blocks' : 'text' },
      ...(who ? signatureTag(line.signature) : []),
      ...actor,
      who?.compared ?? null,
      who?.aside ?? null,
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
      who ? uncovered(line) : null,
      line.media ? mediaEl(line.media, media) : null,
    ),
  );
}
