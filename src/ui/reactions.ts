/** A line's reactions as chips under it, and the picker that adds one.
 *
 * A chip is a toggle: pressed where this reader holds the key. Where the
 * line offers no reacting, the chips are drawn all the same, as text.
 * The picker is a native `<dialog>`, as the icon picker is, so Escape and
 * giving the focus back to its opener are the platform's. */

import { emojiName, searchEmoji } from '../emoji';
import { chipLabel, chipWho } from '../reactions';
import type { Line } from '../state';
import { h } from './dom';

/** The chips under `line`, with a refusal said beside them, or `null`
 *  where there is neither. */
export function reactionsEl(line: Line, reactable: boolean, note: string | undefined): HTMLElement | null {
  const keys = line.reactions ?? [];
  if (!keys.length && !note) return null;
  const chips = keys.map((r) => {
    const label = chipLabel(r, emojiName(r.emoji));
    const kids = [h('span', { class: 'reaction-emoji', ariaHidden: 'true' }, r.emoji), h('span', { class: 'reaction-count', ariaHidden: 'true' }, String(r.count))];
    const cls = `reaction${r.mine ? ' mine' : ''}`;
    // Who it stands for shows on hover and on focus alike, which a
    // `title` would not.
    const who = chipWho(r);
    return reactable
      ? h('button', { type: 'button', class: cls, ariaLabel: label, ariaPressed: String(r.mine), dataset: { act: 'reaction', emoji: r.emoji, who } }, ...kids)
      : h('span', { class: cls, role: 'img', ariaLabel: label, dataset: { who } }, ...kids);
  });
  return h(
    'div',
    { class: 'reactions', role: 'group', ariaLabel: 'Reactions' },
    ...chips,
    // Said to a screen reader as it is noted, not as it is drawn.
    note ? h('span', { class: 'reaction-note' }, note) : null,
  );
}

/** Put `line`'s chips where its row has them now, keeping the focus on
 *  the chip it was on, or with that one gone, another, or with none
 *  left, the row's React button. */
export function redrawReactions(row: HTMLElement, line: Line, reactable: boolean, note: string | undefined): void {
  const old = row.querySelector('.reactions');
  const focused = old?.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.emoji : undefined;
  const now = reactionsEl(line, reactable, note);
  if (old && now) old.replaceWith(now);
  else if (old) old.remove();
  else if (now) row.querySelector('.text')?.append(now);
  if (focused === undefined) return;
  const chips = [...(now?.querySelectorAll<HTMLElement>('button[data-emoji]') ?? [])];
  (chips.find((b) => b.dataset.emoji === focused) ?? chips[0] ?? row.querySelector<HTMLElement>('button[data-act="react"]'))?.focus();
}

/**
 * Ask which emoji to react with: the frequent ones first, then the rest,
 * narrowed by what is typed. Enter in the search box takes the first
 * that matches; the arrows move through the grid. `held` are this
 * reader's on the line, marked as such, and `note` says up front what
 * the server's caps leave.
 */
export function pickReaction(o: { held: ReadonlySet<string>; note?: string | null }): Promise<string | null> {
  return new Promise((resolve) => {
    const grid = h('div', { class: 'emoji-grid', role: 'group', ariaLabel: 'Emoji' });
    const status = h('p', { class: 'muted emoji-status', role: 'status' }, o.note ?? '');
    const search = h('input', { type: 'search', placeholder: 'Search emoji…', ariaLabel: 'Search emoji', spellcheck: false });
    let shown: HTMLButtonElement[] = [];

    const rove = (to: HTMLButtonElement | undefined): void => {
      for (const b of shown) b.tabIndex = b === to ? 0 : -1;
    };
    const draw = (): void => {
      shown = searchEmoji(search.value).map((emoji) => {
        const name = emojiName(emoji);
        const mine = o.held.has(emoji);
        const b = h('button', { type: 'button', class: `emoji-cell${mine ? ' on' : ''}`, title: name, ariaLabel: mine ? `${name}, yours` : name }, emoji);
        b.onclick = () => done(emoji);
        return b;
      });
      grid.replaceChildren(...shown);
      rove(shown[0]);
      status.textContent = shown.length ? (o.note ?? '') : 'No emoji match that.';
    };
    search.oninput = draw;
    search.onkeydown = (e) => {
      // A search box would take the first Escape to empty itself; this
      // one is the dialog's, so Escape always closes it.
      if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      } else if (e.key === 'Enter' && shown[0]) {
        e.preventDefault();
        done(shown[0].textContent ?? '');
      } else if (e.key === 'ArrowDown' && shown[0]) {
        e.preventDefault();
        shown[0].focus();
      }
    };
    grid.onkeydown = (e) => {
      const i = shown.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      // The grid wraps to the dialog's width: a row is as many cells as
      // sit level with the first.
      const row = shown.findIndex((b) => b.offsetTop !== shown[0]!.offsetTop);
      const cols = row > 0 ? row : shown.length;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols, Home: -i, End: shown.length }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      // Up from the top row is back to the search box.
      if (e.key === 'ArrowUp' && i < cols) return search.focus();
      const next = shown[Math.max(0, Math.min(shown.length - 1, i + step))]!;
      rove(next);
      next.focus();
    };

    const cancel = h('button', { class: 'ghost', type: 'button' }, 'Cancel');
    cancel.onclick = () => done(null);
    const dialog = h(
      'dialog',
      { class: 'picker emoji-picker', ariaLabel: 'Add a reaction' },
      h('header', {}, h('h2', {}, 'Add a reaction'), h('div', { class: 'spacer' }), search),
      status,
      grid,
      h('footer', {}, cancel),
    );
    dialog.addEventListener('close', () => done(null));

    function done(value: string | null): void {
      if (!dialog.isConnected) return;
      // `close` first: it is what gives the focus back to the opener.
      dialog.close();
      dialog.remove();
      resolve(value);
    }

    draw();
    document.body.append(dialog);
    dialog.showModal();
    search.focus();
  });
}
