/** This device's preferences, in one place rather than a row of
 * switches in the title bar.
 *
 * Everything here belongs to the browser, not the account: it lives in
 * `localStorage` and nothing about it goes over the wire. So a change
 * takes effect as it is made, and there is nothing to save or cancel —
 * the dialog has a Done and not an OK. A native `<dialog>`, as the icon
 * picker is, so Escape and focus are the platform's.
 */

import { h } from './dom';

export type Theme = 'auto' | 'dark' | 'light';

/** What the dialog reads when it opens and writes as it is changed. The
 *  app owns every one of these; the dialog only draws them. */
export interface Settings {
  theme: Theme;
  setTheme(t: Theme): void;
  markdown: boolean;
  setMarkdown(on: boolean): void;
  selfView: boolean;
  setSelfView(on: boolean): void;
  openDebug(): void;
}

const THEMES: [Theme, string][] = [
  ['auto', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

export function openSettings(s: Settings): void {
  const themes = THEMES.map(([value, label]) => {
    const input = h('input', { type: 'radio', name: 'theme', value, checked: value === s.theme });
    input.onchange = () => s.setTheme(value);
    return h('label', { class: 'setting-choice' }, input, h('span', {}, label));
  });

  const toggle = (label: string, detail: string, on: boolean, set: (on: boolean) => void) => {
    const input = h('input', { type: 'checkbox', checked: on });
    input.onchange = () => set(input.checked);
    return h(
      'label',
      { class: 'setting-toggle' },
      h('span', {}, h('span', { class: 'setting-label' }, label), h('span', { class: 'setting-detail' }, detail)),
      input,
    );
  };

  const debug = h('button', { class: 'ghost', type: 'button' }, 'Open the debug drawer');
  debug.onclick = () => {
    done();
    s.openDebug();
  };
  const ok = h('button', { class: 'primary', type: 'button' }, 'Done');
  ok.onclick = () => done();

  const dialog = h(
    'dialog',
    { class: 'picker settings', ariaLabel: 'Settings' },
    h('header', {}, h('h2', {}, 'Settings')),
    h(
      'div',
      { class: 'settings-body' },
      h('fieldset', {}, h('legend', {}, 'Theme'), h('div', { class: 'setting-choices' }, ...themes)),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Chat'),
        toggle(
          'Render markdown',
          'Draw **bold**, `code` and the rest. Off shows chat exactly as typed; what you send is the same either way.',
          s.markdown,
          (on) => s.setMarkdown(on),
        ),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Video'),
        toggle(
          'Show my own camera',
          'A preview of what you are sending, while you are sending it.',
          s.selfView,
          (on) => s.setSelfView(on),
        ),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Troubleshooting'),
        h(
          'div',
          { class: 'setting-row' },
          debug,
          h('span', { class: 'setting-detail' }, 'The wire trace and session state. Also ⇧⌘D, or the status dot.'),
        ),
      ),
    ),
    h('footer', {}, ok),
  );
  dialog.addEventListener('close', () => done());

  function done(): void {
    if (dialog.isConnected) dialog.remove();
  }

  document.body.append(dialog);
  dialog.showModal();
  ok.focus();
}
