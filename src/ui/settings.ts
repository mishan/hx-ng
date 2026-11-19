/** This device's preferences, in one place rather than a row of
 * switches in the title bar.
 *
 * Nearly everything here belongs to the browser, not the account: it
 * lives in `localStorage`, and of it a server hears only whether lines
 * are signed by default. So a change takes effect as it is made, and
 * there is nothing to save or cancel — the dialog has a Done and not an
 * OK. Pronouns are the exception, the account's on the server it is
 * connected to, and have a Save of their own. A
 * native `<dialog>`, as the icon picker is, so Escape and focus are the
 * platform's.
 */

import type { LabelWrite } from '../devices';
import { PRONOUN_SUGGESTIONS, pronounsProblem } from '../pronouns';
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
  /** What it is once the server has had its say. */
  setSignLobby(on: boolean): Promise<boolean>;
  sealPms: boolean;
  setSealPms(on: boolean): void;
  signPms: PmSigning;
  setSignPms(choice: PmSigning): void;
  signNews: boolean;
  setSignNews(on: boolean): void;
  /** This device's label on the server it is connected to, the one set
   *  or '' for none, and the user agent's it goes by then; null where
   *  that connection shows no devices. */
  deviceLabel: { set: string; otherwise: string } | null;
  setDeviceLabel(label: string): LabelWrite;
  /** The account's pronouns on the server it is connected to, '' for
   *  none; null where that server shows none. */
  pronouns: string | null;
  /** Ask the server; what it refused, in words, or null once taken. */
  setPronouns(value: string | null): Promise<string | null>;
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

const LABEL_WRITE: Record<LabelWrite, string> = {
  saved: '',
  invalid: 'Up to 32 characters, with no space at either end and no invisible or control characters. The last one that fit is kept.',
  unstored: 'This browser would not keep it, so the next login goes by the name it had before.',
};

function deviceLabelField(label: { set: string; otherwise: string }, set: (label: string) => LabelWrite): HTMLElement {
  const input = h('input', { type: 'text', value: label.set, placeholder: label.otherwise, spellcheck: false });
  // As it is typed, so Escape or Done with the field still focused keep it.
  input.oninput = () => {
    input.setCustomValidity(LABEL_WRITE[set(input.value)]);
    input.reportValidity();
  };
  return h(
    'fieldset',
    {},
    h('legend', {}, 'This device'),
    h(
      'label',
      { class: 'setting-toggle' },
      h(
        'span',
        {},
        h('span', { class: 'setting-label' }, 'Device name'),
        h(
          'span',
          { class: 'setting-detail' },
          'What your other devices, and moderators, are shown this one as on this server, beside what the server knows of it. Empty uses the browser\'s name. Takes effect the next time you log in (not on a reload).',
        ),
      ),
      input,
    ),
  );
}

function pronounsField(now: string, set: (value: string | null) => Promise<string | null>): HTMLElement {
  const detail = h(
    'span',
    { class: 'setting-detail', id: 'pronouns-detail' },
    'Shown beside your name to everyone on this server, on every device you use, exactly as you type them. Leave it empty for none.',
  );
  const said = h('p', { class: 'setting-detail pronouns-said', id: 'pronouns-said', role: 'status' });
  const input = h('input', {
    type: 'text',
    id: 'pronouns-input',
    value: now,
    placeholder: 'e.g. she/her',
    spellcheck: false,
    autocomplete: 'off',
  });
  input.setAttribute('aria-describedby', 'pronouns-detail pronouns-said');
  const save = h('button', { class: 'ghost', type: 'button' }, 'Save');
  const check = (): string | null => {
    const problem = pronounsProblem(input.value);
    input.setAttribute('aria-invalid', String(problem !== null));
    // A live region: written only when what it says changes, so a
    // screen reader is not read the same words at every keystroke.
    if (said.textContent !== (problem ?? '')) said.textContent = problem ?? '';
    return problem;
  };
  input.oninput = () => void check();
  let saving = false;
  const commit = async () => {
    if (saving) return;
    if (check() !== null) return input.focus();
    const value = input.value === '' ? null : input.value;
    saving = save.disabled = true;
    said.textContent = 'Saving…';
    try {
      said.textContent = (await set(value)) ?? (value === null ? 'Cleared.' : 'Saved.');
    } finally {
      saving = save.disabled = false;
    }
  };
  save.onclick = () => void commit();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    }
  };
  const picks = PRONOUN_SUGGESTIONS.map((p) => {
    const b = h('button', { class: 'ghost', type: 'button', title: `Fill in ${p}` }, p);
    b.onclick = () => {
      input.value = p;
      check();
      input.focus();
    };
    return b;
  });
  return h(
    'fieldset',
    {},
    h('legend', {}, 'Pronouns'),
    h(
      'div',
      { class: 'pronouns-setting' },
      h('label', { class: 'setting-label', htmlFor: 'pronouns-input' }, 'Your pronouns'),
      detail,
      h('div', { class: 'setting-row' }, input, save),
      h('div', { class: 'setting-row', role: 'group', ariaLabel: 'Suggestions' }, ...picks),
      said,
    ),
  );
}

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

  const toggle = (label: string, detail: string, on: boolean, set: (on: boolean) => void | Promise<boolean>) => {
    const input = h('input', { type: 'checkbox', checked: on });
    input.onchange = () => {
      const now = set(input.checked);
      if (now) void now.then((kept) => (input.checked = kept));
    };
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
          'With an identity login, sign each line with this device, so a server cannot change it or write one in your name. It can still drop a line or strip its signature, and an image is not covered. A signed line is proof anyone can show of what you said. While this is on, a line that cannot be signed is not sent unsigned without asking.',
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
      s.pronouns !== null ? pronounsField(s.pronouns, (value) => s.setPronouns(value)) : null,
      s.deviceLabel ? deviceLabelField(s.deviceLabel, (label) => s.setDeviceLabel(label)) : null,
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
        h('p', { class: 'setting-detail' }, `Build ${__BUILD__.id} (${__BUILD__.date})`),
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
