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
  type LineReactions,
  type ReactionChange,
  type ReactionCount,
  type ReactionKey,
  type ReactionKind,
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
/** The most stored messages a catch-up reads again, the conversation on
 *  screen's first: four `reactions` requests, which leave most of
 *  hxd-ng's default request bucket to the rest of a catch-up. */
const MESSAGES_MAX = 200;
/** How long a line read again as it came into view is not read again. */
const SEEN_AGAIN_MS = 60_000;
/** How long lines coming into view are gathered before they are read. */
const SEEN_GATHER_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One of the server's own emoji as a line's key is held: under a name
 *  no emoji has, since none holds a space. */
export function customKey(id: number): string {
  return `custom ${id}`;
}

/** The catalog id a held key names, if it is a server emoji. */
export function customOf(key: string): number | undefined {
  const m = /^custom (\d+)$/.exec(key);
  return m ? Number(m[1]) : undefined;
}

/** A key off the wire as it is held, or `undefined` for a kind this
 *  client does not know. */
export function heldKey(k: ReactionKey): string | undefined {
  return Number.isSafeInteger(k.custom) ? customKey(k.custom!) : typeof k.emoji === 'string' ? k.emoji : undefined;
}

/** A held key as `react` sends it. */
export function wireKey(key: string): ReactionKey {
  const id = customOf(key);
  return id !== undefined ? { custom: id } : { emoji: key };
}

/** A summary as the wire carries it, as held: `undefined` for none. A
 *  key of a kind this client does not know is left out. */
export function summaryOf(keys: readonly ReactionCount[] | undefined, mine: readonly number[] = []): Reaction[] | undefined {
  const held = (keys ?? []).flatMap((k, i): Reaction[] => {
    const emoji = heldKey(k.key);
    return emoji !== undefined && k.count > 0 ? [{ emoji, count: k.count, mine: mine.includes(i) }] : [];
  });
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

export type Reactable =
  | { kind: 'line'; target: { line: number; room?: number } }
  | { kind: 'pm'; target: { pm: string } }
  | { kind: 'im'; target: { im: { login: string; guid: string } }; with: string };

/** What reacting to `line` in `conv` names, or `null` where nothing
 *  does or the server takes none of its kind (`kinds`). A private
 *  message received under a guid is an instant message, and one this
 *  account (`me`) sent is where the server said so; either is reacted
 *  to by its sender's login, which an identity guest's lacks. Any other
 *  stored one is reacted to by its `ref`. */
export function reactableAs(line: Line, conv: Conversation, kinds: readonly ReactionKind[], me: string | null): Reactable | null {
  if (line.elsewhere) return null;
  const room = roomOf(conv);
  const [login, other] = line.local ? [me, conv.peer.login] : [line.from?.login, line.from?.login];
  const to: Reactable | null =
    conv.kind !== 'pm'
      ? line.id === undefined
        ? null
        : { kind: 'line', target: { line: line.id, ...(room ? { room } : {}) } }
      : line.guid !== undefined && (!line.local || line.im)
        ? login && other
          ? { kind: 'im', target: { im: { login, guid: line.guid } }, with: other }
          : null
        : line.ref === undefined
          ? null
          : { kind: 'pm', target: { pm: line.ref } };
  return to && kinds.includes(to.kind) ? to : null;
}

/** An instant message's reactions once one of its two parties adds or
 *  removes `emoji`. Only two can react, so a count and whether this
 *  reader holds the key say whose it is. */
export function afterParty(held: readonly Reaction[] | undefined, emoji: string | undefined, add: boolean, mine: boolean): Reaction[] | undefined {
  // A key of a kind this client does not know, as `summaryOf` leaves out.
  if (emoji === undefined) return held?.length ? [...held] : undefined;
  const was = held?.find((r) => r.emoji === emoji);
  const me = mine ? add : !!was?.mine;
  const them = mine ? (was?.count ?? 0) > Number(!!was?.mine) : add;
  const count = Number(me) + Number(them);
  const rest = (held ?? []).map((r) => (r.emoji === emoji ? { emoji, count, mine: me } : r)).filter((r) => r.count > 0);
  if (count && !was) rest.push({ emoji, count, mine: me });
  return rest.length ? rest : undefined;
}

/** A line's reactions once this account's own add or removal of `emoji`
 *  is answered `count`: drawn at once, rather than at the batch that
 *  restates it a moment later. */
export function afterOwn(held: readonly Reaction[] | undefined, emoji: string, add: boolean, count: number): Reaction[] | undefined {
  const rest = (held ?? []).map((r) => (r.emoji === emoji ? { emoji, count, mine: add } : r)).filter((r) => r.count > 0);
  if (add && count > 0 && !rest.some((r) => r.emoji === emoji)) rest.push({ emoji, count, mine: true });
  return rest.length ? rest : undefined;
}

/** Why `emoji` cannot be added to a target of `kind` holding `held`, or
 *  `null` where it can. A key already there never counts against the
 *  server's caps, and an instant message, kept nowhere, has none. */
export function whyNotAdd(
  held: readonly Reaction[] | undefined,
  emoji: string,
  caps: Pick<ReactionsConfig, 'max_keys' | 'max_per_user'>,
  kind: ReactionKind = 'line',
): string | null {
  if (kind === 'im') return null;
  const what = kind === 'line' ? 'line' : 'message';
  const keys = held ?? [];
  const there = keys.find((r) => r.emoji === emoji);
  if (there?.mine) return null;
  if (keys.filter((r) => r.mine).length >= caps.max_per_user) {
    return `You have as many reactions on this ${what} as you may (${caps.max_per_user}). Take one away first.`;
  }
  if (!there && keys.length >= caps.max_keys) return `This ${what} has as many different reactions as it may.`;
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
  private readingMessages = false;
  private messagesAgain: readonly Conversation[] | null = null;
  private closed = false;
  private wait: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(
    private conn: Pick<Connection, 'react' | 'reactionsGet' | 'history' | 'reactions' | 'replies'>,
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
      if (this.closed) return;
      const store = this.host.store;
      for (const c of changes) {
        if (c.action === 'add' || c.action === 'remove') {
          const { login, guid } = c.target.im;
          const sent = login.toLowerCase() === store.me()?.toLowerCase();
          this.told(store.imReactions(sent ? c.from.login : login, guid, sent, (held) => afterParty(held, heldKey(c.key), c.action === 'add', false)));
        } else if (c.action === 'summary' && 'pm' in c.target) this.told(store.setPmReactions(c.target.pm, summaryOf(c.keys, c.mine)));
      }
    });
  }

  /** Add `emoji`, a held key, to `line` or take it away. A rate limit
   *  is waited out once, as long as it says. */
  async toggle(line: Line, conv: Conversation, emoji: string, add: boolean, waited = false): Promise<void> {
    const caps = this.conn.reactions;
    const to = caps && reactableAs(line, conv, caps.targets, this.host.store.me());
    if (!caps || !to || this.closed) return;
    const why = add ? whyNotAdd(line.reactions, emoji, caps, to.kind) : null;
    if (why) return this.host.refused(line, conv.id, why, false);
    let settle = (): void => {};
    try {
      if (to.kind === 'line') {
        const { count } = await this.conn.react(to.target, wireKey(emoji), { remove: !add });
        settle = () => this.apply(conv.id, [[to.target.line, afterOwn(line.reactions, emoji, add, count)]]);
      } else if (to.kind === 'im') {
        // Nobody is told of this reader's own: the tally is kept here.
        await this.conn.react(to.target, wireKey(emoji), { remove: !add, with: to.with });
        const { guid } = to.target.im;
        settle = () => this.told(this.host.store.imReactions(to.with, guid, !!line.local, (held) => afterParty(held, emoji, add, true)));
      } else {
        await this.conn.react(to.target, wireKey(emoji), { remove: !add });
      }
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
    // Answered alike whether it was applied or dropped, and told to this
    // session by no summary, so it is read back; a failure there is no
    // refusal of the reaction.
    if (to.kind === 'pm') return this.readMessages([to.target]);
    // In the answer's turn, from what the line holds then: a batch that
    // came before the answer is older than it, and is applied first.
    await this.host.seq.run(() => this.closed || settle());
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

  /** After a catch-up: the newest stored messages each of `convs` holds
   *  read again, newest first, the first conversation first and
   *  `MESSAGES_MAX` in all. A call while a read is under way is run once
   *  it is done, with the conversations it names. Sent ones are in no
   *  `inbox` page, and the catch-up's page lists only the newest
   *  received mail. */
  async refetchMessages(convs: readonly Conversation[]): Promise<void> {
    if (!this.conn.reactions?.targets.includes('pm')) return;
    if (this.readingMessages) return void (this.messagesAgain = convs);
    this.readingMessages = true;
    try {
      for (let next: readonly Conversation[] | null = convs; next && !this.closed; next = this.messagesAgain) {
        this.messagesAgain = null;
        const these = next;
        const me = this.host.store.me();
        const targets = await this.host.seq.run(() =>
          these
            .flatMap((c) =>
              c.lines
                .flatMap((l) => {
                  const to = reactableAs(l, c, ['pm'], me);
                  return to?.kind === 'pm' ? [to.target] : [];
                })
                .slice(-LIVE_LINES)
                .reverse(),
            )
            .slice(0, MESSAGES_MAX),
        );
        await this.readMessages(targets);
      }
    } finally {
      this.readingMessages = false;
    }
  }

  /** The reactions on `targets` read again, as many as one request
   *  takes at a time, and applied in each answer's turn. A rate limit is
   *  waited out as long as it says; any other refusal ends it, the
   *  messages keeping what they had. */
  private async readMessages(targets: readonly { pm: string }[]): Promise<void> {
    for (let at = 0, limited = 0; at < targets.length && !this.closed; ) {
      let read: LineReactions[];
      try {
        ({ reactions: read } = await this.conn.reactionsGet(targets.slice(at, at + IDS_MAX)));
      } catch (e) {
        if (!(e instanceof WireFailure && e.wire.code === RATE_LIMITED) || limited++ >= RATE_TRIES) return;
        await this.wait((e.wire.retry_after ?? 1) * 1000);
        continue;
      }
      limited = 0;
      at += IDS_MAX;
      await this.host.seq.run(() => {
        if (this.closed) return;
        for (const r of read) if ('pm' in r.target) this.told(this.host.store.setPmReactions(r.target.pm, summaryOf(r.keys, r.mine)));
      });
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

  private told(changed: [ConvId, Line[]] | undefined): void {
    if (changed && !this.closed) this.host.changed(...changed);
  }

  private apply(conv: ConvId, updates: Iterable<readonly [number, Reaction[] | undefined]>): void {
    if (this.closed) return;
    const lines = this.host.store.setReactions(conv, updates);
    if (lines.length) this.host.changed(conv, lines);
  }
}
