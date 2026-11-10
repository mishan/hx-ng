/**
 * The server's own emoji (hxd-ng's `docs/server-emoji.md`): the catalog
 * a client keeps of them, and what a line's references make of its
 * text. Plain data and promises, so it runs wherever `protocol` does.
 */

import type { EmojiEntry, EmojiListOk, EmojiListParams, EmojiRef, LiveEmoji } from './protocol.js';

/** The most references a server keeps of one line or message. */
export const EMOJI_REFS_MAX = 32;

/**
 * One server's catalog as this client holds it, entries kept by id,
 * live and removed: a removed one keeps its last name, which is what a
 * reaction made with it is still shown as.
 *
 * `refresh` asks from the revision held, or for everything when it holds
 * none, and pages to the end before anything it holds changes. It keeps
 * the first page's revision, so the next delta covers what changed while
 * it paged, and starts again from nothing when a later page of a delta
 * comes back whole: entries were forgotten, or the catalog restored, in
 * between, and what it holds may name ids nothing will mention again.
 */
export class EmojiCatalog {
  /** The revision the entries are good for; `null` until the first
   *  listing has been read. */
  revision: number | null = null;
  private byId = new Map<number, EmojiEntry>();
  private byName = new Map<string, LiveEmoji>();
  private running: Promise<boolean> | null = null;
  private next: Promise<boolean> | null = null;

  /** `list` is `Connection.emojiList`, or anything that answers as it
   *  does. */
  constructor(private list: (params: EmojiListParams) => Promise<EmojiListOk>) {}

  /** Bring the catalog up to date, answering whether anything it holds
   *  changed. A call while one is under way is answered by one more
   *  after it, which every such call shares, since a change it was
   *  called for may have come after the first had read its page. A
   *  refusal leaves what is held as it was. */
  refresh(): Promise<boolean> {
    if (!this.running) {
      this.running = this.pull().finally(() => (this.running = null));
      return this.running;
    }
    this.next ??= this.running
      .catch(() => false)
      .then(() => {
        this.next = null;
        return this.refresh();
      });
    return this.next;
  }

  /** The entry an id names, live or removed. */
  get(id: number): EmojiEntry | undefined {
    return this.byId.get(id);
  }

  /** The entry an id names, while it is live. */
  live(id: number): LiveEmoji | undefined {
    const e = this.byId.get(id);
    return e && !('removed' in e) ? e : undefined;
  }

  /** The live entry with this name now. */
  named(name: string): LiveEmoji | undefined {
    return this.byName.get(name);
  }

  /** Every live entry, by name. */
  entries(): LiveEmoji[] {
    return [...this.byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  private async pull(): Promise<boolean> {
    let from = this.revision ?? undefined;
    for (;;) {
      const first = await this.list(from === undefined ? {} : { revision: from });
      const whole = first.delta !== true;
      const held = whole ? new Map<number, EmojiEntry>() : new Map(this.byId);
      let page = first;
      let got = 0;
      let restart = false;
      for (;;) {
        for (const e of page.emoji ?? []) held.set(e.id, e);
        got += page.emoji?.length ?? 0;
        const last = page.emoji?.at(-1)?.id;
        if (page.has_more !== true || last === undefined) break;
        // A whole listing goes on as one from nothing, which stays whole
        // however the catalog moves meanwhile.
        page = await this.list({ ...(whole || from === undefined ? {} : { revision: from }), after: last });
        if (!whole && page.delta !== true) {
          restart = true;
          break;
        }
      }
      if (restart) {
        from = undefined;
        continue;
      }
      this.byId = held;
      this.byName = new Map([...held.values()].flatMap((e): [string, LiveEmoji][] => ('removed' in e ? [] : [[e.name, e]])));
      this.revision = first.revision;
      return whole || got > 0;
    }
  }
}

/** A run of text, or a name its references make one of the server's
 *  emoji. */
export type EmojiSegment = string | EmojiRef;

/**
 * `text` split where it says `:name:` and a reference binds that name to
 * an id the catalog has live, which is the only thing that makes a name
 * an emoji: never the name alone, which stays the text it is. A name is
 * drawn as the id's picture, whatever the catalog calls that id now.
 */
export function emojiSegments(
  text: string,
  refs: readonly EmojiRef[] | undefined,
  catalog: Pick<EmojiCatalog, 'live'>,
): EmojiSegment[] {
  if (!refs?.length) return text ? [text] : [];
  const bound = new Map<string, number>();
  for (const r of refs) if (!bound.has(r.name)) bound.set(r.name, r.id);
  return scan(text, (name) => {
    const id = bound.get(name);
    return id !== undefined && catalog.live(id) ? { name, id } : undefined;
  });
}

/**
 * The references a send of `text` carries: for each name it says as
 * `:name:`, in the order first said, the entry live under that name now;
 * at most as many as a server keeps. A name is unique among live
 * entries, so this is also the ref a picker would have recorded, unless
 * the catalog changed since, when the server would drop that one.
 */
export function emojiRefsFor(text: string, catalog: Pick<EmojiCatalog, 'named'>): EmojiRef[] {
  const out: EmojiRef[] = [];
  const names = new Set<string>();
  for (const s of scan(text, (name) => {
    const id = catalog.named(name)?.id;
    return id === undefined ? undefined : { name, id };
  })) {
    if (typeof s === 'string' || names.has(s.name)) continue;
    names.add(s.name);
    out.push(s);
    if (out.length === EMOJI_REFS_MAX) break;
  }
  return out;
}

const NAME = /^[a-z0-9_]{2,32}$/;

/** `text` in runs, with each `:name:` that `bind` binds taken out. A
 *  colon that closes a name not bound may open the next, so `:no:yes:`
 *  binds `yes`. */
function scan(text: string, bind: (name: string) => EmojiRef | undefined): EmojiSegment[] {
  const out: EmojiSegment[] = [];
  let plain = 0;
  for (let open = text.indexOf(':'); open >= 0; ) {
    const close = text.indexOf(':', open + 1);
    if (close < 0) break;
    const name = text.slice(open + 1, close);
    const ref = NAME.test(name) ? bind(name) : undefined;
    if (!ref) {
      open = close;
      continue;
    }
    if (open > plain) out.push(text.slice(plain, open));
    out.push(ref);
    plain = close + 1;
    open = text.indexOf(':', plain);
  }
  if (plain < text.length) out.push(text.slice(plain));
  return out;
}
