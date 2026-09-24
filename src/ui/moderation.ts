/** The moderator's view: reports waiting, reports closed, and the audit
 * trail (hxd-ng's `docs/moderation.md` §5).
 *
 * A report is acted on from here, and what acting means depends on what
 * was reported. A line is redacted, an image revoked, an article
 * deleted — each of which closes every open report on the same thing,
 * so there is no separate close to send after it. A private message has
 * no act of its own: the design's remedy for one is its sender, so the
 * report offers a purge of them. Dismissing and marking a duplicate are
 * the two closes that act on nothing.
 *
 * Nothing is drawn optimistically. What changed arrives as `report` and
 * `report_closed`, and the view redraws from those.
 */

import { WireFailure, moderationErrorText, type Connection, type ModerationAct, type Report, type ReportOutcome } from '@hotline-ng/client';

import { actSummary, DURATIONS, outcomeWords, reportHeading, ReportQueue, subjectName } from '../moderation';
import { LOBBY, type Store } from '../state';
import { ask } from './ask';
import { fill, h, linkify } from './dom';
import { INERT } from './media';
import { Sight } from './sight';

type Tab = 'open' | 'closed' | 'log';

export interface ModerationHooks {
  conn: () => Connection | null;
  store: Store;
  /** The open count moved: the rail's badge is drawn from it. */
  onCount: () => void;
  openArticle: (id: number) => void;
}

const PAGE = 50;

export function problem(e: unknown): string {
  return e instanceof WireFailure ? moderationErrorText(e.wire) : e instanceof Error ? e.message : String(e);
}

export class ModerationView {
  readonly el = h('section', { class: 'mod-view', hidden: true });
  readonly queue = new ReportQueue();
  private tab: Tab = 'open';
  private sight = new Sight();
  private openMore = false;
  private closed: Report[] = [];
  private closedMore = false;
  private log: ModerationAct[] = [];
  private logMore = false;
  private error: string | null = null;
  private notice: string | null = null;
  /** Bumped by `reset`: a listing that lands after it is for a session
   *  that is gone. */
  private generation = 0;
  /** Blob URLs of images a moderator asked to see, released on reset. */
  private urls: string[] = [];
  /** Bumped by every `report` and `report_closed`. A listing of open
   *  reports replaces what is held, so one that was asked for before an
   *  event and answered after it would undo the event — a close put
   *  back, a filing lost. Such a listing is asked for again instead. */
  private events = 0;

  constructor(private hooks: ModerationHooks) {}

  /** Untiled: the view takes the chat pane's place. */
  show(open: boolean): void {
    this.el.hidden = !open;
    this.shown(open);
  }

  /** On screen or not, without touching `hidden`. */
  shown(on: boolean): void {
    // Fetched once for each time it is brought forward (`./sight`). Back
    // from a browser tab put away, what arrived meanwhile is already in
    // the queue and only has to be drawn: a first page fetched again
    // would drop the pages a moderator had loaded below it.
    if (this.sight.set(on)) void this.load(true);
    else if (on) this.render();
  }

  /** A new session, or none: nothing held is this one's. */
  reset(open = 0): void {
    this.generation++;
    this.queue.reset(open);
    this.closed = [];
    this.log = [];
    this.openMore = false;
    this.closedMore = false;
    this.logMore = false;
    this.error = null;
    this.notice = null;
    this.tab = 'open';
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.el.replaceChildren();
  }

  /** The events in between are gone after a resync, and the count with
   *  them; the first page of open reports restates both. */
  async recount(): Promise<void> {
    const conn = this.hooks.conn();
    if (!conn?.moderator || !conn.moderation) return;
    const gen = this.generation;
    const seen = this.events;
    try {
      const page = await conn.reports({ status: 'open', limit: PAGE });
      if (gen !== this.generation) return;
      if (seen !== this.events) return void this.recount();
      this.queue.page(page.reports, true, page.has_more);
      this.openMore = page.has_more;
      this.counted();
      if (this.sight.on) this.render();
    } catch {
      /* the badge keeps the count it had; the view says why when opened */
    }
  }

  onReport(r: Report): void {
    this.events++;
    if (!this.queue.filed(r)) return;
    this.counted();
    if (this.sight.on && this.tab === 'open') this.render();
  }

  onClosed(id: number): void {
    this.events++;
    this.queue.closed(id);
    this.counted();
    // What was open may be on the closed tab now; that tab refetches
    // when it is next picked.
    if (this.sight.on) this.render();
  }

  private async load(first: boolean): Promise<void> {
    const conn = this.hooks.conn();
    if (!conn) return;
    const gen = this.generation;
    const seen = this.events;
    const tab = this.tab;
    try {
      if (tab === 'open') {
        const before = first ? undefined : this.queue.list().at(-1)?.id;
        const page = await conn.reports({ status: 'open', limit: PAGE, ...(before !== undefined ? { before } : {}) });
        if (gen !== this.generation) return;
        if (first && seen !== this.events) return void this.load(true);
        this.queue.page(page.reports, first, page.has_more);
        this.openMore = page.has_more;
        this.counted();
      } else if (tab === 'closed') {
        const before = first ? undefined : this.closed.at(-1)?.id;
        const page = await conn.reports({ status: 'closed', limit: PAGE, ...(before !== undefined ? { before } : {}) });
        if (gen !== this.generation) return;
        this.closed = first ? page.reports : [...this.closed, ...page.reports];
        this.closedMore = page.has_more;
      } else {
        const before = first ? undefined : this.log.at(-1)?.id;
        const page = await conn.moderationLog({ limit: PAGE, ...(before !== undefined ? { before } : {}) });
        if (gen !== this.generation) return;
        this.log = first ? page.entries : [...this.log, ...page.entries];
        this.logMore = page.has_more;
      }
      this.error = null;
    } catch (e) {
      if (gen !== this.generation) return;
      this.error = problem(e);
    }
    if (tab === this.tab) this.render();
  }

  /** The count moved. The rail is told, and so is the session's own
   *  record of it, which is what a reload starts the badge from. */
  private counted(): void {
    const conn = this.hooks.conn();
    if (conn?.moderation) conn.moderation.open = this.queue.count;
    this.hooks.onCount();
  }

  private pick(tab: Tab): void {
    this.tab = tab;
    this.notice = null;
    this.render();
    void this.load(true);
  }

  private render(): void {
    const tabs = (['open', 'closed', 'log'] as const).map((t) => {
      const label = t === 'open' ? `Open${this.queue.count ? ` (${this.queue.count})` : ''}` : t === 'closed' ? 'Closed' : 'Log';
      const b = h('button', { class: `ghost${this.tab === t ? ' on' : ''}`, type: 'button' }, label);
      b.onclick = () => this.pick(t);
      return b;
    });
    const refresh = h('button', { class: 'ghost', type: 'button', title: 'Ask the server again' }, 'Refresh');
    refresh.onclick = () => void this.load(true);

    const body: (HTMLElement | null)[] = [];
    if (this.tab === 'log') {
      body.push(...this.log.map((a) => this.actEl(a)));
      if (!this.log.length) body.push(h('p', { class: 'muted' }, 'Nothing has been done yet.'));
      if (this.logMore) body.push(this.more());
    } else {
      const list = this.tab === 'open' ? this.queue.list() : this.closed;
      body.push(...list.map((r) => this.reportEl(r)));
      if (!list.length) {
        body.push(h('p', { class: 'muted' }, this.tab === 'open' ? 'No reports are waiting.' : 'No report has been closed.'));
      }
      if (this.tab === 'open' ? this.openMore : this.closedMore) body.push(this.more());
    }

    fill(
      this.el,
      h('header', { class: 'mod-head' }, h('h2', {}, 'Reports'), ...tabs, h('div', { class: 'spacer' }), refresh),
      this.error ? h('p', { class: 'mod-error' }, this.error) : null,
      this.notice ? h('p', { class: 'mod-notice' }, this.notice) : null,
      h('div', { class: 'mod-list' }, ...body),
    );
  }

  private more(): HTMLElement {
    const b = h('button', { class: 'ghost', type: 'button' }, 'Older');
    b.onclick = () => void this.load(false);
    return b;
  }

  private reportEl(r: Report): HTMLElement {
    const t = r.target;
    const when = new Date(r.at * 1000).toLocaleString();
    const parts: (HTMLElement | null)[] = [
      h(
        'div',
        { class: 'mod-report-head' },
        h('span', { class: 'mod-id' }, `#${r.id}`),
        h('strong', {}, reportHeading(r)),
        h('span', { class: 'muted' }, when),
      ),
      h('blockquote', { class: 'mod-reason' }, ...linkify(r.reason)),
    ];

    // What was reported, as far as this page can show it.
    if (t.kind === 'line' && t.line !== undefined) {
      const line = this.hooks.store.conversation(LOBBY)?.lines.find((l) => l.id === t.line);
      parts.push(
        h(
          'div',
          { class: 'mod-evidence' },
          h('span', { class: 'muted' }, `Line ${t.line}: `),
          line ? (line.deleted ? h('em', {}, 'already removed') : `${line.from?.nick ?? ''}: ${line.text}`) : h('em', {}, 'not loaded here'),
        ),
      );
    }
    if (r.evidence !== undefined) {
      parts.push(
        h(
          'div',
          { class: 'mod-evidence' },
          h('span', { class: 'muted' }, r.verified ? 'The message: ' : 'Pasted by the reporter, not verified: '),
          ...linkify(r.evidence),
        ),
      );
    }
    if (t.media !== undefined && r.status === 'open') parts.push(this.imageEl(t.media));
    if (t.article !== undefined) {
      const open = h('a', { href: `#news-${t.article}` }, `Article #${t.article}`);
      open.onclick = (e) => {
        e.preventDefault();
        this.hooks.openArticle(t.article!);
      };
      parts.push(h('div', { class: 'mod-evidence' }, open));
    }

    if (r.closed) {
      const c = r.closed;
      parts.push(
        h(
          'div',
          { class: 'muted' },
          `${outcomeWords(c.outcome)} by ${c.by}, ${new Date(c.at * 1000).toLocaleString()}` +
            (c.of !== undefined ? ` — duplicate of #${c.of}` : '') +
            (c.note ? ` — ${c.note}` : ''),
        ),
      );
    } else {
      parts.push(h('div', { class: 'mod-actions' }, ...this.actions(r)));
    }
    return h('article', { class: `mod-report${r.closed ? ' closed' : ''}` }, ...parts);
  }

  /** A reported image is pinned and granted to moderators while the
   *  report is open, so it can be judged by more than its caption. Asked
   *  for rather than fetched with the list: nobody should have to see it
   *  to scroll past it. */
  private imageEl(handle: string): HTMLElement {
    const box = h('div', { class: 'mod-image' });
    const show = h('button', { class: 'ghost small', type: 'button' }, 'Show the image');
    show.onclick = async () => {
      const conn = this.hooks.conn();
      if (!conn) return;
      show.disabled = true;
      try {
        const blob = await conn.fetchMedia(handle);
        // The type decides what a blob URL does when it is opened, and
        // here nothing else is known about it: only what paints.
        if (!INERT.includes(blob.type)) throw new Error('That is not an image this client will show.');
        const url = URL.createObjectURL(blob);
        this.urls.push(url);
        fill(box, h('img', { class: 'media-img', src: url, alt: 'The reported image' }));
      } catch (e) {
        fill(box, h('span', { class: 'muted' }, e instanceof WireFailure ? 'The image is gone.' : problem(e)));
      }
    };
    box.append(show);
    return box;
  }

  private actions(r: Report): HTMLElement[] {
    const out: HTMLElement[] = [];
    const act = (label: string, fn: () => Promise<string | null>, danger = false) => {
      const b = h('button', { class: `ghost small${danger ? ' danger' : ''}`, type: 'button' }, label);
      b.onclick = async () => {
        b.disabled = true;
        try {
          const said = await fn();
          if (said) {
            this.notice = said;
            this.error = null;
            this.render();
          }
        } catch (e) {
          this.error = problem(e);
          this.render();
        } finally {
          b.disabled = false;
        }
      };
      out.push(b);
    };
    const conn = this.hooks.conn;
    const t = r.target;
    const who = subjectName(t.from);

    if (t.kind === 'line' && t.line !== undefined) {
      act('Redact the line', async () => {
        const a = await reasonFor('Redact this line', `Its words go from every client and from history. ${t.media ? 'The image it carried goes with it. ' : ''}Reports on it close as removed.`, 'Redact', r.reason);
        if (!a) return null;
        await conn()?.redact(t.line!, a);
        return `Line ${t.line} redacted.`;
      }, true);
    }
    if (t.kind === 'media' && t.media !== undefined) {
      act('Revoke the image', async () => {
        const a = await ask({
          title: 'Revoke this image',
          body: 'Its bytes go at once, from chat and from news. Reports on it close as removed.',
          fields: [
            { kind: 'text', name: 'reason', label: 'Reason', required: true, max: 512, value: r.reason.slice(0, 512) },
            { kind: 'check', name: 'block', label: 'Refuse the same image if it is uploaded again', value: true },
          ],
          ok: 'Revoke',
          danger: true,
        });
        if (!a) return null;
        await conn()?.revoke(t.media!, String(a.reason), a.block === true);
        return 'Image revoked.';
      }, true);
    }
    if (t.kind === 'article' && t.article !== undefined) {
      act('Delete the article', async () => {
        const a = await reasonFor('Delete this article', 'It becomes a tombstone; its replies stay where they are. Reports on it close as removed.', 'Delete', r.reason);
        if (!a) return null;
        await conn()?.newsDelete(t.article!, a);
        return `Article #${t.article} deleted.`;
      }, true);
    }
    // A person, or a message's sender: the remedy is what they have been
    // posting. Only an identity can be purged — a login or a fingerprint.
    const person = t.from.login ? { login: t.from.login } : t.from.fingerprint ? { fingerprint: t.from.fingerprint } : null;
    if (person) {
      act(`Purge ${who}…`, async () => {
        const a = await ask({
          title: `Purge ${who}`,
          body: 'Their public lines, images and news articles from the window go, under one record. Reports on them close as removed.',
          fields: [
            { kind: 'choice', name: 'since', label: 'From the last', options: DURATIONS.map(([s, w]) => [String(s), w]), value: '3600' },
            { kind: 'text', name: 'reason', label: 'Reason', required: true, max: 512, value: r.reason.slice(0, 512) },
          ],
          ok: 'Purge',
          danger: true,
        });
        if (!a) return null;
        const done = await conn()?.purge({ ...person, since: Number(a.since), reason: String(a.reason) });
        return done ? `Purged ${who}: ${done.lines} lines, ${done.media} images, ${done.articles} articles.` : null;
      }, true);
    }

    act('Dismiss', async () => {
      const a = await ask({
        title: `Dismiss report #${r.id}`,
        body: 'Nothing is removed. The reporter is told it was dismissed.',
        fields: [{ kind: 'text', name: 'note', label: 'Note, for the record', max: 512 }],
        ok: 'Dismiss',
      });
      if (!a) return null;
      await conn()?.reportClose({ id: r.id, outcome: 'dismissed', ...(a.note ? { note: String(a.note) } : {}) });
      return `Report #${r.id} dismissed.`;
    });
    act('Duplicate…', async () => {
      const a = await ask({
        title: `Report #${r.id} repeats another`,
        fields: [
          { kind: 'text', name: 'of', label: 'The report it duplicates, by number', required: true, placeholder: '17' },
          { kind: 'text', name: 'note', label: 'Note', max: 512 },
        ],
        ok: 'Close as duplicate',
      });
      if (!a) return null;
      const of = Number(String(a.of).replace(/^#/, ''));
      if (!Number.isSafeInteger(of) || of <= 0) throw new Error('A report is named by its number.');
      await conn()?.reportClose({ id: r.id, outcome: 'duplicate', of, ...(a.note ? { note: String(a.note) } : {}) });
      return `Report #${r.id} closed as a duplicate of #${of}.`;
    });
    return out;
  }

  private actEl(a: ModerationAct): HTMLElement {
    return h(
      'article',
      { class: 'mod-act' },
      h(
        'div',
        { class: 'mod-report-head' },
        h('span', { class: 'mod-id' }, `${a.id}`),
        h('strong', {}, actSummary(a)),
        h('span', { class: 'muted' }, new Date(a.at * 1000).toLocaleString()),
      ),
      h('blockquote', { class: 'mod-reason' }, ...linkify(a.reason)),
      a.evidence ? h('div', { class: 'mod-evidence' }, h('span', { class: 'muted' }, 'Removed: '), a.evidence) : null,
    );
  }
}

/** Ask for the one thing every act needs. The report's own reason is
 *  offered as a start, since it is usually the reason. */
async function reasonFor(title: string, body: string, ok: string, suggested = ''): Promise<string | null> {
  const a = await ask({
    title,
    body,
    fields: [{ kind: 'text', name: 'reason', label: 'Reason', required: true, max: 512, value: suggested.slice(0, 512) }],
    ok,
    danger: true,
  });
  return a ? String(a.reason) : null;
}

/** How a closed report reads to whoever filed it. */
export function closedForReporter(id: number, outcome: ReportOutcome): string {
  return outcome === 'removed'
    ? `Your report #${id} was acted on: what you reported has been removed.`
    : outcome === 'duplicate'
      ? `Your report #${id} was closed: someone had already reported the same thing.`
      : `Your report #${id} was reviewed and dismissed.`;
}
