/** This device's preferences, in one place rather than a row of
 * switches in the title bar.
 *
 * Everything here belongs to the browser, not the account: it lives in
 * `localStorage`, and of it a server hears only whether lines are signed
 * by default. So a change takes effect as it is made, and there is
 * nothing to save or cancel — the dialog has a Done and not an OK. A
 * native `<dialog>`, as the icon picker is, so Escape and focus are the
 * platform's.
 */

import type { PmSigning } from '../signing';
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
  signLobby: boolean;
  setSignLobby(on: boolean): void;
  sealPms: boolean;
  setSealPms(on: boolean): void;
  signPms: PmSigning;
  setSignPms(choice: PmSigning): void;
  signNews: boolean;
  setSignNews(on: boolean): void;
  openDebug(): void;
}

const PM_SIGNING: [PmSigning, string, string][] = [
  ['sealed', 'When sealed', 'A sealed message is signed, so whoever you write to can show anyone that you sent it. One in the clear is not.'],
  ['always', 'Always', 'In the clear too, so the server cannot change one or write one in your name, and anyone it reaches can show what you said.'],
  ['never', 'Never', 'A sealed message is sealed deniably: whoever you write to knows it is from you and can prove it to nobody.'],
];

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

  const pmDetail = (choice: PmSigning) => PM_SIGNING.find(([value]) => value === choice)![2];
  const pmSaid = h('span', { class: 'setting-detail' }, pmDetail(s.signPms));
  const pmSigning = PM_SIGNING.map(([value, label]) => {
    const input = h('input', { type: 'radio', name: 'sign-pm', value, checked: value === s.signPms });
    input.onchange = () => {
      s.setSignPms(value);
      pmSaid.textContent = pmDetail(value);
    };
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
  // `close()` rather than removing the dialog outright, so the browser
  // gives the focus back to whatever opened it.
  debug.onclick = () => {
    dialog.close();
    s.openDebug();
  };
  const ok = h('button', { class: 'primary', type: 'button' }, 'Done');
  ok.onclick = () => dialog.close();

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
        toggle(
          'Sign my lines in the lobby',
          'With an identity login, sign each line with this device, so a server cannot change it or write one in your name. It can still drop a line or strip its signature, and an image is not covered. A signed line is proof anyone can show of what you said.',
          s.signLobby,
          (on) => s.setSignLobby(on),
        ),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Private messages'),
        toggle(
          'Seal my private messages',
          'With an identity login, seal each one to the device of someone who can open it, so no server can read it. A message with an image, or to someone who cannot open one, goes in the clear, and you are asked first if they could before.',
          s.sealPms,
          (on) => s.setSealPms(on),
        ),
        h('div', { class: 'setting-toggle' }, h('span', {}, h('span', { class: 'setting-label' }, 'Sign my private messages'), pmSaid)),
        h('div', { class: 'setting-choices', role: 'radiogroup', ariaLabel: 'Sign my private messages' }, ...pmSigning),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'News'),
        toggle(
          'Sign my news articles',
          'With an identity login, sign each article and reply you post, so it stays provably yours wherever it is read. Its images are not covered.',
          s.signNews,
          (on) => s.setSignNews(on),
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
