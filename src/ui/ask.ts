/** A small form in a dialog: the reason a report or a moderation act
 * has to carry, and the one or two choices that go with it.
 *
 * `prompt()` would do for one line of text, and nothing else: a ban
 * needs a length, a revocation a switch, and both need saying what is
 * about to happen above the box rather than inside it. A native
 * `<dialog>`, as the icon picker is, so Escape and focus are the
 * platform's.
 */

import { h } from './dom';

export type Field =
  | { kind: 'text' | 'textarea'; name: string; label: string; value?: string; required?: boolean; max?: number; placeholder?: string }
  | { kind: 'check'; name: string; label: string; value?: boolean }
  | { kind: 'choice'; name: string; label: string; options: [string, string][]; value?: string };

export interface Ask {
  title: string;
  /** What is about to happen, said before anything is typed. */
  body?: string;
  fields: Field[];
  /** The button that does it. */
  ok: string;
  danger?: boolean;
}

export type Answer = Record<string, string | boolean>;

/** Ask, and resolve with what was filled in, or `null` if it was not. */
export function ask(q: Ask): Promise<Answer | null> {
  return new Promise((resolve) => {
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
    const rows = q.fields.map((f) => {
      let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (f.kind === 'check') {
        input = h('input', { type: 'checkbox', checked: f.value ?? false });
        inputs.set(f.name, input);
        return h('label', { class: 'ask-check' }, input, ` ${f.label}`);
      }
      if (f.kind === 'choice') {
        input = h(
          'select',
          {},
          ...f.options.map(([value, label]) => h('option', { value, selected: value === f.value }, label)),
        );
      } else {
        const props = {
          value: f.value ?? '',
          required: f.required ?? false,
          placeholder: f.placeholder ?? '',
          ...(f.max !== undefined ? { maxLength: f.max } : {}),
        };
        input = f.kind === 'textarea' ? h('textarea', { ...props, rows: 3 }) : h('input', { ...props, type: 'text' });
      }
      inputs.set(f.name, input);
      return h('label', { class: 'ask-field' }, h('span', {}, f.label), input);
    });

    const cancel = h('button', { class: 'ghost', type: 'button' }, 'Cancel');
    const ok = h('button', { class: q.danger ? 'primary danger' : 'primary', type: 'submit' }, q.ok);
    cancel.onclick = () => done(null);

    const form = h(
      'form',
      { method: 'dialog' },
      h('header', {}, h('h2', {}, q.title)),
      h('div', { class: 'ask-body' }, q.body ? h('p', {}, q.body) : null, ...rows),
      h('footer', {}, cancel, ok),
    );
    form.onsubmit = (e) => {
      e.preventDefault();
      // `required` is the browser's to enforce, but a field of spaces
      // passes it and is not a reason.
      for (const f of q.fields) {
        const input = inputs.get(f.name)!;
        if (f.kind !== 'check' && f.kind !== 'choice' && f.required && !input.value.trim()) {
          input.focus();
          return;
        }
      }
      const out: Answer = {};
      for (const f of q.fields) {
        const input = inputs.get(f.name)!;
        out[f.name] = f.kind === 'check' ? (input as HTMLInputElement).checked : input.value.trim();
      }
      done(out);
    };

    const dialog = h('dialog', { class: 'picker ask' }, form);
    dialog.addEventListener('close', () => done(null));

    function done(value: Answer | null): void {
      if (!dialog.isConnected) return;
      dialog.remove();
      resolve(value);
    }

    document.body.append(dialog);
    dialog.showModal();
    [...inputs.values()][0]?.focus();
  });
}

/** Pick one of a few things to do, or none. The same dialog, as a list
 *  of buttons: the menu a roster row opens, which has to work on a
 *  phone as well as under a pointer. */
export function choose<K extends string>(title: string, options: [K, string, boolean?][]): Promise<K | null> {
  return new Promise((resolve) => {
    const buttons = options.map(([key, label, danger]) => {
      const b = h('button', { class: danger ? 'ghost danger' : 'ghost', type: 'button' }, label);
      b.onclick = () => done(key);
      return b;
    });
    const cancel = h('button', { class: 'ghost', type: 'button' }, 'Cancel');
    cancel.onclick = () => done(null);
    const dialog = h(
      'dialog',
      { class: 'picker ask' },
      h('header', {}, h('h2', {}, title)),
      h('div', { class: 'ask-body ask-choices' }, ...buttons),
      h('footer', {}, cancel),
    );
    dialog.addEventListener('close', () => done(null));

    function done(value: K | null): void {
      if (!dialog.isConnected) return;
      dialog.remove();
      resolve(value);
    }

    document.body.append(dialog);
    dialog.showModal();
    buttons[0]?.focus();
  });
}
