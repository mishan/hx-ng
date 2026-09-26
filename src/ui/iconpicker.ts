/** Pick one of the six hundred icons the sprite sheet holds — or, on a
 * server with avatars, a picture of your own to show in its place.
 *
 * A native `<dialog>` so Escape, the backdrop and focus trapping are the
 * platform's problem rather than ours. */

import { type AvatarLimits, mediaBlockedReason } from '@hotline-ng/client';

import { h } from './dom';
import { icon, iconIds } from './icons';

/** What the picker can do about a picture, when the server has avatars.
 *  The picture goes up from inside the dialog, so a refusal is said
 *  where the file was chosen and the choice can be made again. */
export interface AvatarChoice {
  limits: AvatarLimits;
  /** There is a picture now, so there is one to remove. */
  has: boolean;
  /** Resolve once it is set; throw a readable refusal otherwise. */
  upload: (file: File) => Promise<void>;
  remove: () => Promise<void>;
}

export function pickIcon(current: number, avatar?: AvatarChoice): Promise<number | null> {
  return new Promise((resolve) => {
    let chosen = current;

    const grid = h('div', { class: 'icon-grid' });
    const buttons = new Map<number, HTMLButtonElement>();
    for (const id of iconIds()) {
      const b = h(
        'button',
        { class: `icon-cell${id === current ? ' on' : ''}`, title: `icon ${id}`, type: 'button' },
        icon(id, 2),
      );
      b.onclick = () => {
        buttons.get(chosen)?.classList.remove('on');
        chosen = id;
        b.classList.add('on');
        readout.textContent = `icon ${id}`;
      };
      b.ondblclick = () => done(chosen);
      buttons.set(id, b);
      grid.append(b);
    }

    const readout = h('span', { class: 'muted' }, `icon ${current}`);
    const search = h('input', {
      type: 'search',
      placeholder: 'icon number…',
      inputMode: 'numeric',
      spellcheck: false,
    });
    search.oninput = () => {
      const q = search.value.trim();
      for (const [id, b] of buttons) b.hidden = q !== '' && !String(id).startsWith(q);
    };

    const cancel = h('button', { class: 'ghost', type: 'button' }, 'Cancel');
    const ok = h('button', { class: 'primary', type: 'button' }, 'Use this icon');
    cancel.onclick = () => done(null);
    ok.onclick = () => done(chosen);

    // While a picture is going up the dialog stays: closing it would not
    // stop the upload, and a refusal would have nowhere to be said.
    let locked = false;
    const lock = (on: boolean): void => {
      locked = on;
      cancel.disabled = on;
      ok.disabled = on;
    };
    // Done with the picture, the icon picked beside it still counts.
    const pictureBtns = avatar ? pictureButtons(avatar, readout, lock, () => done(chosen)) : [];

    const dialog = h(
      'dialog',
      { class: 'picker' },
      h('header', {}, h('h2', {}, 'Choose an icon'), readout, h('div', { class: 'spacer' }), search),
      grid,
      h('footer', {}, ...pictureBtns, pictureBtns.length ? h('div', { class: 'spacer' }) : null, cancel, ok),
    );
    dialog.addEventListener('cancel', (e) => {
      if (locked) e.preventDefault();
    });
    dialog.addEventListener('close', () => done(null));

    function done(value: number | null): void {
      if (!dialog.isConnected) return;
      dialog.remove();
      resolve(value);
    }

    document.body.append(dialog);
    dialog.showModal();
    buttons.get(current)?.scrollIntoView({ block: 'center' });
  });
}

/** "Use a picture…" and, with one set, "Remove picture". Each closes the
 *  dialog once the server has agreed, keeping the icon picked; the icon
 *  is what shows wherever the picture cannot. */
function pictureButtons(
  avatar: AvatarChoice,
  readout: HTMLElement,
  lock: (on: boolean) => void,
  close: () => void,
): HTMLElement[] {
  const input = h('input', { type: 'file', accept: avatar.limits.types.join(','), hidden: true });
  const use = h(
    'button',
    { class: 'ghost', type: 'button', title: 'Show a picture of your own in place of your icon' },
    'Use a picture\u2026',
  );
  const remove = h('button', { class: 'ghost', type: 'button', hidden: !avatar.has }, 'Remove picture');
  const busy = (on: boolean): void => {
    use.disabled = on;
    remove.disabled = on;
    lock(on);
  };
  const attempt = async (what: () => Promise<void>): Promise<void> => {
    busy(true);
    try {
      await what();
    } catch (e) {
      readout.textContent = e instanceof Error ? e.message : String(e);
      return;
    } finally {
      busy(false);
    }
    close();
  };
  use.onclick = () => input.click();
  input.onchange = () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const blocked = mediaBlockedReason(file, avatar.limits);
    if (blocked) {
      readout.textContent = blocked;
      return;
    }
    readout.textContent = 'Uploading\u2026';
    void attempt(() => avatar.upload(file));
  };
  remove.onclick = () => void attempt(avatar.remove);
  return [input, use, remove];
}
