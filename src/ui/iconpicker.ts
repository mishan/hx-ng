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

/** One device of this person: its label, the server's facts, and
 *  `mine` for this one. */
export interface DeviceRow {
  device: number;
  label?: string;
  facts: string[];
  mine: boolean;
}

/** This person's devices, on a server that groups persons; how to end
 *  one, which for this one is a logout, false where it was not ended
 *  after all; and `watch`, handed the list each time it changes while
 *  the dialog is open, until what it returns is called. */
export interface DevicesChoice {
  list: DeviceRow[];
  end: (device: number) => Promise<boolean>;
  watch: (changed: (list: DeviceRow[]) => void) => () => void;
}

/** The icon picked and, when the picker was given a name to edit, the
 *  name as left in its field. */
export interface Picked {
  icon: number;
  nick?: string;
}

export function pickIcon(current: number, avatar?: AvatarChoice, nick?: string, devices?: DevicesChoice): Promise<Picked | null> {
  return new Promise((resolve) => {
    let chosen = current;

    const grid = h('div', { class: 'icon-grid' });
    const buttons = new Map<number, HTMLButtonElement>();
    for (const id of iconIds()) {
      const b = h(
        'button',
        {
          class: `icon-cell${id === current ? ' on' : ''}`,
          title: `icon ${id}`,
          ariaLabel: `icon ${id}`,
          ariaPressed: String(id === current),
          // One stop in the tab order for the whole grid; arrows move in it.
          tabIndex: id === current ? 0 : -1,
          type: 'button',
        },
        icon(id, 2),
      );
      b.onclick = () => {
        const was = buttons.get(chosen);
        was?.classList.remove('on');
        was?.setAttribute('aria-pressed', 'false');
        chosen = id;
        b.classList.add('on');
        b.setAttribute('aria-pressed', 'true');
        rove(b);
        readout.textContent = `icon ${id}`;
      };
      b.ondblclick = () => done(chosen);
      buttons.set(id, b);
      grid.append(b);
    }

    const rove = (to: HTMLButtonElement): void => {
      for (const b of buttons.values()) b.tabIndex = b === to ? 0 : -1;
    };
    grid.onkeydown = (e) => {
      const shown = [...buttons.values()].filter((b) => !b.hidden);
      const i = shown.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      // The grid wraps to the dialog's width: a row is as many cells as
      // sit level with the first.
      const row = shown.findIndex((b) => b.offsetTop !== shown[0]!.offsetTop);
      const cols = row > 0 ? row : shown.length;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols, Home: -i, End: shown.length }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      const next = shown[Math.max(0, Math.min(shown.length - 1, i + step))]!;
      rove(next);
      next.focus();
    };

    if (!buttons.has(current)) {
      const first = buttons.values().next().value;
      if (first) rove(first);
    }

    const readout = h('span', { class: 'muted', role: 'status' }, `icon ${current}`);
    const search = h('input', {
      type: 'search',
      placeholder: 'icon number…',
      ariaLabel: 'Icon number',
      inputMode: 'numeric',
      spellcheck: false,
    });
    search.oninput = () => {
      const q = search.value.trim();
      for (const [id, b] of buttons) b.hidden = q !== '' && !String(id).startsWith(q);
      const first = [...buttons.values()].find((b) => !b.hidden);
      if (first && [...buttons.values()].every((b) => b.hidden || b.tabIndex < 0)) rove(first);
    };

    const nickInput = nick === undefined
      ? null
      : h('input', { type: 'text', value: nick, placeholder: 'name', ariaLabel: 'Name', spellcheck: false });
    if (nickInput) nickInput.onkeydown = (e) => {
      if (e.key === 'Enter') done(chosen);
    };

    const cancel = h('button', { class: 'ghost', type: 'button' }, 'Cancel');
    const ok = h('button', { class: 'primary', type: 'button' }, nickInput ? 'Save' : 'Use this icon');
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
    const section = devices ? devicesSection(devices, readout, () => done(null), ok) : null;
    // Done with the picture, the icon picked beside it still counts.
    const pictureBtns = avatar ? pictureButtons(avatar, readout, lock, () => done(chosen)) : [];

    const dialog = h(
      'dialog',
      { class: 'picker', ariaLabel: nickInput ? 'Name and icon' : 'Choose an icon' },
      h('header', {}, h('h2', {}, nickInput ? 'Name and icon' : 'Choose an icon'), nickInput, readout, h('div', { class: 'spacer' }), search),
      grid,
      section?.el,
      h('footer', {}, ...pictureBtns, pictureBtns.length ? h('div', { class: 'spacer' }) : null, cancel, ok),
    );
    dialog.addEventListener('cancel', (e) => {
      if (locked) e.preventDefault();
    });
    dialog.addEventListener('close', () => done(null));

    function done(value: number | null): void {
      if (!dialog.isConnected) return;
      section?.stop();
      // `close` first: it is what gives the focus back to the opener.
      dialog.close();
      dialog.remove();
      resolve(value === null ? null : { icon: value, nick: nickInput?.value.trim() });
    }

    document.body.append(dialog);
    dialog.showModal();
    buttons.get(current)?.scrollIntoView({ block: 'center' });
  });
}

/** Each device of this person, with an End for it, kept to the list as
 *  it changes. Ending this one closes the dialog, its session gone;
 *  another's row goes, the focus to the next End, or the heading, or
 *  `last`, and the status line says so. */
function devicesSection(
  devices: DevicesChoice,
  readout: HTMLElement,
  close: () => void,
  last: HTMLElement,
): { el: HTMLElement; stop: () => void } {
  const heading = h('h3', { tabIndex: -1 }, 'Your devices');
  const list = h('ul', {});
  type Row = { li: HTMLElement; name: HTMLElement; facts: HTMLElement; end: HTMLButtonElement; row: DeviceRow };
  const rows = new Map<number, Row>();

  const named = (d: DeviceRow) => d.label ?? 'Unnamed device';
  const add = (d: DeviceRow): Row => {
    const name = h('span', { class: 'device-name' });
    const facts = h('span', { class: 'device-facts muted', id: `device-facts-${d.device}` });
    const end = h('button', { class: 'ghost', type: 'button' }, 'End');
    end.setAttribute('aria-describedby', facts.id);
    const li = h('li', { class: 'device' }, name, facts, end);
    const kept: Row = { li, name, facts, end, row: d };
    end.onclick = () => void ending(kept);
    rows.set(d.device, kept);
    list.append(li);
    return kept;
  };
  const show = (r: Row, d: DeviceRow) => {
    r.row = d;
    r.li.classList.toggle('mine', d.mine);
    r.name.replaceChildren(named(d), ...(d.mine ? [h('span', { class: 'muted' }, ' (this device)')] : []));
    r.facts.textContent = d.facts.join(' \u00b7 ');
    r.end.ariaLabel = d.mine ? `End this device (${named(d)})` : `End ${named(d)}`;
  };
  // The focus goes on from a row that goes while it is in it, or whose
  // End was pressed, which disabling it while it worked may have blurred.
  const gone = (device: number, pressed = false) => {
    const r = rows.get(device);
    if (!r) return;
    const next = [...rows.values()][[...rows.keys()].indexOf(device) + 1];
    const focused = pressed || r.li.contains(document.activeElement);
    r.li.remove();
    rows.delete(device);
    if (focused) (next?.end ?? (rows.size ? heading : last)).focus();
  };
  const ending = async (r: Row) => {
    r.end.disabled = true;
    let ended: boolean;
    try {
      ended = await devices.end(r.row.device);
    } catch (e) {
      readout.textContent = e instanceof Error ? e.message : String(e);
      ended = false;
    }
    r.end.disabled = false;
    if (!ended) return;
    if (r.row.mine) return close();
    readout.textContent = `Ended ${named(r.row)}`;
    gone(r.row.device, true);
  };
  const update = (now: DeviceRow[]) => {
    for (const device of [...rows.keys()]) if (!now.some((d) => d.device === device)) gone(device);
    for (const d of now) show(rows.get(d.device) ?? add(d), d);
  };

  update(devices.list);
  const stop = devices.watch(update);
  return { el: h('section', { class: 'devices', ariaLabel: 'Your devices' }, heading, list), stop };
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
