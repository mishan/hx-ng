/** Reactions (hxd-ng's `docs/hotline-ng.md` §7.3): what a line's
 *  reactions are held as, how a change or a page replaces them, what
 *  this account may still add, and how a chip is read out. Keys are
 *  compared as the server spells them, never as they were sent. No DOM
 *  in this file. */

import {
  RATE_LIMITED,
  reactionErrorText,
  WireFailure,
  type Connection,
  type HistoryLine,
  type HistoryOk,
  type ReactionChange,
  type ReactionCount,
  type ReactionsConfig,
} from '@hotline-ng/client';

import { publicId, roomOf, type Conversation, type ConvId, type Line, type Reaction, type Sequencer, type Store } from './state';

/** The most line ids one `history` names. */
const IDS_MAX = 50;
/** How often a refetch waits out a rate limit before it gives up. */
const RATE_TRIES = 5;
/** How many of a conversation's newest lines are taken to be told live:
 *  hxd-ng's default `live_window`. Older ones are read again when shown,
 *  and a resync reads these. */
export const LIVE_LINES = 200;
/** How long a line read again as it came into view is not read again. */
const SEEN_AGAIN_MS = 60_000;
/** How long lines coming into view are gathered before they are read. */
const SEEN_GATHER_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A summary as the wire carries it, as held: `undefined` for none. A
 *  key of a kind this client does not draw, such as a server's own
 *  emoji, is left out. */
export function summaryOf(keys: readonly ReactionCount[] | undefined, mine: readonly number[] = []): Reaction[] | undefined {
  const held = (keys ?? []).flatMap((k, i): Reaction[] =>
    typeof k.key.emoji === 'string' && k.count > 0 ? [{ emoji: k.key.emoji, count: k.count, mine: mine.includes(i) }] : [],
  );
  return held.length ? held : undefined;
}

/** A history line's reactions, which a tombstone has none of. */
export function historyReactions(line: HistoryLine): Reaction[] | undefined {
  return line.deleted ? undefined : summaryOf(line.reactions, line.reactions_mine);
}

/** A `reactions_changed`'s groups by the conversation each line is in:
 *  a summary replaces whatever was held for its line, and a clear
 *  leaves it none. */
export function changesByConv(changes: readonly ReactionChange[]): Map<ConvId, [number, Reaction[] | undefined][]> {
  const out = new Map<ConvId, [number, Reaction[] | undefined][]>();
  for (const change of changes) {
    if (!('line' in change.target)) continue;
    const conv = publicId(change.target.room);
    const reactions = change.action === 'summary' ? summaryOf(change.keys, change.mine) : undefined;
    out.set(conv, [...(out.get(conv) ?? []), [change.target.line, reactions]]);
  }
  return out;
}

/** A line's reactions once this account's own add or removal of `emoji`
 *  is answered `count`: drawn at once, rather than at the batch that
 *  restates it a moment later. */
export function afterOwn(held: readonly Reaction[] | undefined, emoji: string, add: boolean, count: number): Reaction[] | undefined {
  const rest = (held ?? []).map((r) => (r.emoji === emoji ? { emoji, count, mine: add } : r)).filter((r) => r.count > 0);
  if (add && count > 0 && !rest.some((r) => r.emoji === emoji)) rest.push({ emoji, count, mine: true });
  return rest.length ? rest : undefined;
}

/** Why `emoji` cannot be added to a line holding `held`, or `null` where
 *  it can. A key already on the line never counts against the server's
 *  caps. */
export function whyNotAdd(
  held: readonly Reaction[] | undefined,
  emoji: string,
  caps: Pick<ReactionsConfig, 'max_keys' | 'max_per_user'>,
): string | null {
  const keys = held ?? [];
  const there = keys.find((r) => r.emoji === emoji);
  if (there?.mine) return null;
  if (keys.filter((r) => r.mine).length >= caps.max_per_user) {
    return `You have as many reactions on this line as you may (${caps.max_per_user}). Take one away first.`;
  }
  if (!there && keys.length >= caps.max_keys) return 'This line has as many different reactions as it may.';
  return null;
}

/** What a chip is read out as: "thumbs up, 3, including you". */
export function chipLabel(r: Reaction, name: string): string {
  return `${name}, ${r.count}${r.mine ? ', including you' : ''}`;
}

/** Who a chip stands for, as far as a summary says: it names nobody, so
 *  beyond this reader it is a count. */
export function chipWho(r: Reaction): string {
  if (!r.mine) return `${r.count} ${r.count === 1 ? 'person' : 'people'}`;
  const others = r.count - 1;
  return others ? `You and ${others} ${others === 1 ? 'other' : 'others'}` : 'You';
}

/**
 * Ask `history` for the lines `ids` name again, as many as one request
 * takes at a time, handing each page's lines to `apply`: after a resync,
 * what a client holds for lines it shows may be stale, and nothing else
 * will say so. A full reply leaves out the highest, which are asked for
 * again. A rate limit is waited out as long as it says; any other
 * refusal ends it, the lines keeping what they had.
 */
export async function refetchLines(
  ids: readonly number[],
  fetch: (ids: number[]) => Promise<HistoryOk>,
  apply: (lines: HistoryLine[]) => void,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const queue = [...new Set(ids)].sort((a, b) => a - b);
  for (let limited = 0; queue.length; ) {
    const asked = queue.slice(0, IDS_MAX);
    let page: HistoryOk;
    try {
      page = await fetch(asked);
    } catch (e) {
      if (!(e instanceof WireFailure && e.wire.code === RATE_LIMITED) || limited++ >= RATE_TRIES) return;
      await wait((e.wire.retry_after ?? 1) * 1000);
      continue;
    }
    limited = 0;
    apply(page.lines);
    const last = page.lines.at(-1)?.id;
    queue.splice(0, page.has_more && last !== undefined ? asked.filter((id) => id <= last).length : asked.length);
  }
}

/** What the desk needs of the page around it. */
export interface DeskHost {
  store: Store;
  /** The turn every event and page takes, which the desk's own changes
   *  take too. */
  seq: Sequencer;
  /** These lines of `conv` have reactions to draw anew. */
  changed(conv: ConvId, lines: Line[]): void;
  /** Something to say under `line`: a refusal, or a wait. `denied` when
   *  the server refuses this account any reaction in `conv`. */
  refused(line: Line, conv: ConvId, text: string, denied: boolean): void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The ids of the lines `conv` holds that can carry reactions, oldest
 *  first. */
function heldIds(conv: Conversation): number[] {
  return conv.lines.flatMap((l) => (l.id === undefined || l.deleted ? [] : [l.id]));
}

/**
 * One connection's reactions: its changes, live, and its own acts, each
 * applied in the turn its answer came in, and the lines read again where
 * nothing tells them live: after a catch-up, and as an older line comes
 * into view.
 */
export class ReactionDesk {
  private asked = new Map<string, number>();
  private queued = new Map<number, Set<number>>();
  private gathering = false;
  private closed = false;
  private wait: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(
    private conn: Pick<Connection, 'react' | 'history' | 'reactions' | 'replies'>,
    private host: DeskHost,
  ) {
    this.wait = host.wait ?? sleep;
    this.now = host.now ?? Date.now;
  }

  /** Its connection is replaced: nothing more is asked or applied. */
  close(): void {
    this.closed = true;
  }

  /** A `reactions_changed`, applied in its turn. */
  changed(changes: readonly ReactionChange[]): Promise<void> {
    return this.host.seq.run(() => {
      for (const [conv, updates] of changesByConv(changes)) this.apply(conv, updates);
    });
  }

  /** Add `emoji` to `line` or take it away. A rate limit is waited out
   *  once, as long as it says. */
  async toggle(line: Line, conv: Conversation, emoji: string, add: boolean, waited = false): Promise<void> {
    const caps = this.conn.reactions;
    const id = line.id;
    if (!caps || id === undefined || this.closed) return;
    const why = add ? whyNotAdd(line.reactions, emoji, caps) : null;
    if (why) return this.host.refused(line, conv.id, why, false);
    const room = roomOf(conv);
    let count: number;
    try {
      ({ count } = await this.conn.react({ line: id, ...(room ? { room } : {}) }, { emoji }, { remove: !add }));
    } catch (e) {
      if (this.closed) return;
      if (!(e instanceof WireFailure)) throw e;
      if (e.wire.code === RATE_LIMITED && !waited) {
        const s = e.wire.retry_after ?? 1;
        this.host.refused(line, conv.id, `Slow down: trying again in ${s} s.`, false);
        await this.wait(s * 1000);
        return this.toggle(line, conv, emoji, add, true);
      }
      return this.host.refused(line, conv.id, reactionErrorText(e.wire), e.wire.code === 'access_denied');
    }
    if (this.closed) return;
    // In the answer's turn, from what the line holds then: a batch that
    // came before the answer is older than it, and is applied first.
    await this.host.seq.run(() => this.apply(conv.id, [[id, afterOwn(line.reactions, emoji, add, count)]]));
  }

  /** After a catch-up: the newest lines each of `convs` holds read again,
   *  the first conversation first. */
  async refetchHeld(convs: readonly Conversation[]): Promise<void> {
    for (const c of convs) {
      // Once the catch-up's own pages are in.
      const ids = await this.host.seq.run(() => heldIds(c).slice(-LIVE_LINES));
      if (this.closed) return;
      await this.refetch(c.id, ids);
    }
  }

  /** A line of `conv` came into view. One older than the newest
   *  `LIVE_LINES` is read again, gathered for a moment with others, and
   *  not again for a minute. */
  seen(conv: Conversation, id: number): void {
    if (this.closed || !this.conn.reactions) return;
    const ids = heldIds(conv);
    const at = ids.indexOf(id);
    if (at < 0 || at >= ids.length - LIVE_LINES) return;
    const key = `${conv.id} ${id}`;
    const now = this.now();
    if (now - (this.asked.get(key) ?? -Infinity) < SEEN_AGAIN_MS) return;
    this.asked.set(key, now);
    this.queued.set(roomOf(conv), (this.queued.get(roomOf(conv)) ?? new Set()).add(id));
    if (this.gathering) return;
    this.gathering = true;
    void this.wait(SEEN_GATHER_MS).then(async () => {
      this.gathering = false;
      const batch = [...this.queued];
      this.queued.clear();
      for (const [room, ids] of batch) await this.refetch(publicId(room), [...ids]);
    });
  }

  /** `history`'s `ids` take a session that said `replies`. */
  private refetch(conv: ConvId, ids: number[]): Promise<void> {
    if (!this.conn.replies || !ids.length) return Promise.resolve();
    const room = this.host.store.conversation(conv)?.room?.id ?? 0;
    return refetchLines(
      ids,
      (ids) => this.conn.history({ ids, ...(room ? { room } : {}) }),
      (lines) => {
        if (this.closed) return;
        void this.host.seq.run(() => this.apply(conv, lines.map((l) => [l.id, historyReactions(l)] as const)));
      },
      this.wait,
    );
  }

  private apply(conv: ConvId, updates: Iterable<readonly [number, Reaction[] | undefined]>): void {
    if (this.closed) return;
    const lines = this.host.store.setReactions(conv, updates);
    if (lines.length) this.host.changed(conv, lines);
  }
}
