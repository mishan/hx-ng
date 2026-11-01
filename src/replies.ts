/** Replies (hxd-ng's `docs/hotline-ng.md` §7.3): what a reply names the
 *  line or message it answers by, and the quote a reply is drawn with.
 *  The server never resolves a target, so a quote is only ever what this
 *  client holds or may fetch itself. No DOM in this file. */

import { WireFailure, type HistoryLine, type HistoryOk, type ReplyKind, type ReplyTarget } from '@hotline-ng/client';

import type { ConvId, Conversation, Line } from './state';

/** How much of the answered text a quote shows. */
export const EXCERPT_CHARS = 120;

/** The most line ids one `history` names. */
const IDS_MAX = 50;

/** Refusals that would answer the same however often they were asked,
 *  such as to an account that may not read history: what they were
 *  asked for is unavailable, not still to fetch. */
const FINAL = new Set(['access_denied', 'not_available', 'bad_request', 'no_such_room']);
/** How long a fetch that failed otherwise waits before it is asked
 *  again, doubling to the most. */
const RETRY_MS = 1000;
const RETRY_MAX_MS = 60_000;

/** A reply being written, to a line of `conv`. */
export interface Replying {
  conv: ConvId;
  re: ReplyTarget;
  nick: string;
  excerpt: string;
}

/** What a quote shows: the answered line, still being fetched, or
 *  nothing this client can show, for a target redacted, retired, never
 *  seen, in another room or of a kind it cannot look up. */
export type Quote =
  | { state: 'found'; nick: string; excerpt: string; line?: Line }
  | { state: 'pending'; id: number }
  | { state: 'missing' };

/** Plain text on one line, cut at `max` characters. */
export function excerpt(text: string, max = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

function said(line: { text: string; media?: unknown }): string {
  return excerpt(line.text) || (line.media ? 'an image' : '');
}

/** The `re` a reply to `line` sends, or `null` where none can: a line
 *  by its id, an instant message received by its sender and guid, and
 *  any other stored message by its reference, each only where the server
 *  keeps that kind. */
export function replyTarget(line: Line, conv: Conversation, targets: readonly ReplyKind[]): ReplyTarget | null {
  if ((line.kind !== 'chat' && line.kind !== 'action') || line.deleted || line.hidden) return null;
  if (conv.kind === 'lobby') return line.id !== undefined && targets.includes('line') ? { line: line.id } : null;
  // One this client sent has a guid whether it went as an instant
  // message or not, so its own are named by reference alone.
  if (!line.local && line.guid !== undefined && line.from?.login && targets.includes('im')) {
    return { im: { login: line.from.login, guid: line.guid } };
  }
  return line.ref !== undefined && targets.includes('pm') ? { pm: line.ref } : null;
}

/** Start a reply to `line`, or `null` where it cannot be named. */
export function startReply(line: Line, conv: Conversation, targets: readonly ReplyKind[]): Replying | null {
  const re = replyTarget(line, conv, targets);
  if (!re) return null;
  return { conv: conv.id, re, nick: line.local ? 'yourself' : (line.from?.nick ?? ''), excerpt: said(line) };
}

const sameLogin = (a: string | undefined | null, b: string): boolean => !!a && a.toLowerCase() === b.toLowerCase();

/**
 * The quote for a line carrying `re`, from what this client holds:
 * `conv`'s own lines for a message, the lobby's and those fetched for a
 * line. Never across conversations: a reference to another pair's
 * message shows nothing, as the server meant it to.
 */
export function resolveQuote(
  re: ReplyTarget,
  conv: Conversation,
  o: { lobby: Conversation; fetched: ReadonlyMap<number, HistoryLine | null>; me: string | null },
): Quote {
  const found = (line: Line | undefined): Quote =>
    !line || line.deleted || line.hidden ? { state: 'missing' } : { state: 'found', nick: line.local ? 'you' : (line.from?.nick ?? ''), excerpt: said(line), line };
  if ('line' in re) {
    // This client joins no room, so a room's line is never one it holds.
    if (conv.kind !== 'lobby' || re.room) return { state: 'missing' };
    const held = o.lobby.lines.find((l) => l.id === re.line);
    if (held) return found(held);
    const fetched = o.fetched.get(re.line);
    if (fetched === undefined) return { state: 'pending', id: re.line };
    return !fetched || fetched.deleted ? { state: 'missing' } : { state: 'found', nick: fetched.from.nick ?? '', excerpt: said(fetched) };
  }
  if (conv.kind !== 'pm') return { state: 'missing' };
  if ('pm' in re) return found(conv.lines.find((l) => l.ref === re.pm));
  if ('im' in re) {
    const { login, guid } = re.im;
    return found(conv.lines.find((l) => l.guid === guid && (l.local ? sameLogin(o.me, login) : sameLogin(l.from?.login, login))));
  }
  return { state: 'missing' };
}

/**
 * Fetches the lines quotes name and this client does not hold, by
 * `history`'s `ids`: asked for as they come on screen, gathered for a
 * moment into requests of as many as one takes, one request at a time,
 * and the ids a full reply left out asked for again. What comes back,
 * or is known not to, is kept in `lines` for the session. A refusal
 * that would stand marks what it was for unavailable; any other failure
 * keeps it queued and asks again later, so neither asks on every redraw.
 */
export class QuoteFetcher {
  /** Each id asked for: its line, or `null` where there is none to show. */
  readonly lines = new Map<number, HistoryLine | null>();
  private queued = new Set<number>();
  /** Redacted, perhaps while a request for it was in flight. */
  private gone = new Set<number>();
  /** A run is waited for or under way, and takes what is queued. */
  private running = false;
  private retryMs = RETRY_MS;
  private closed = false;

  constructor(
    private fetch: (ids: number[]) => Promise<HistoryOk>,
    /** Some quotes can be drawn now. */
    private done: () => void,
    private wait: (run: () => void, ms: number) => void = (run, ms) => void setTimeout(run, ms),
  ) {}

  want(id: number): void {
    if (this.closed || this.lines.has(id) || this.queued.has(id)) return;
    this.queued.add(id);
    if (this.running) return;
    this.running = true;
    this.wait(() => void this.run(), 50);
  }

  /** A line redacted: its quote shows nothing now, whatever a request
   *  already in flight answers. */
  redacted(id: number): void {
    this.gone.add(id);
    if (this.lines.has(id)) this.lines.set(id, null);
  }

  /** Its connection is replaced: nothing more is asked. */
  close(): void {
    this.closed = true;
  }

  private async run(): Promise<void> {
    while (this.queued.size && !this.closed) {
      const ids = [...this.queued].sort((a, b) => a - b).slice(0, IDS_MAX);
      let page: HistoryOk;
      try {
        page = await this.fetch(ids);
      } catch (e) {
        if (!(e instanceof WireFailure && FINAL.has(e.wire.code))) {
          const after = e instanceof WireFailure && e.wire.retry_after ? e.wire.retry_after * 1000 : this.retryMs;
          this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
          this.wait(() => void this.run(), after);
          return;
        }
        page = { lines: [], has_more: false };
      }
      this.retryMs = RETRY_MS;
      const got = new Map(page.lines.map((l) => [l.id, l]));
      const last = page.lines.at(-1)?.id ?? Infinity;
      for (const id of ids) {
        // Past the last line a full reply held, an id is still to ask.
        if (page.has_more && id > last) continue;
        this.queued.delete(id);
        this.lines.set(id, this.gone.has(id) ? null : (got.get(id) ?? null));
      }
      this.done();
    }
    this.running = false;
  }
}
