/** Contacts: who this browser remembers by fingerprint (hxd-ng's
 * `docs/e2e-messages.md` §8), where and as whom each was seen, and the
 * fingerprints to compare out of band, with the user's word that they
 * did. A native `<dialog>`, as Settings is, so Escape and focus are the
 * platform's; everything here is this browser's, so a change holds as it
 * is made.
 */

import { contactList, contactName, contactOf, groupFingerprint, sharedName, type Contact } from '../contacts';
import type { PeerMemory } from '../sealing';
import { ask } from './ask';
import { fill, h } from './dom';

export interface ContactsHooks {
  memory: PeerMemory;
  /** This user's own fingerprint, to compare against theirs. */
  self: string | null;
  /** Something marked or forgotten, for what names it to redraw. */
  changed(): void;
}

/** All contacts, or with `only`, the one to compare with someone the
 *  server shows under that fingerprint now, beside this user's own. */
export function openContacts(hooks: ContactsHooks, only?: { fingerprint: string; nick: string }): void {
  const { memory } = hooks;
  const said = h('p', { class: 'contacts-said', role: 'status' });
  const list = h('div', { class: 'contacts-list' });

  /** The user's own name for it, or its key: never a server's nick. */
  const nameOf = (c: Contact) => contactName(c) ?? `the key ${c.fingerprint.slice(0, 16)}`;

  const draw = (focus?: { fingerprint: string; act: string }) => {
    const contacts = only ? [contactOf(memory, only.fingerprint)] : contactList(memory);
    fill(
      list,
      ...(contacts.length ? contacts.map(card) : [h('p', { class: 'muted' }, 'Nobody yet. Whoever you exchange signed or sealed private messages with is remembered here.')]),
    );
    if (focus) list.querySelector<HTMLElement>(`[data-fp="${CSS.escape(focus.fingerprint)}"] [data-act="${focus.act}"]`)?.focus();
  };

  const act = async (c: Contact, what: 'mark' | 'unmark' | 'forget') => {
    const name = nameOf(c);
    if (what === 'mark') {
      const yes = await ask({
        title: 'Mark as compared?',
        body:
          'Only once you have checked it with them outside this server, in person or on a call where you know it is them: ' +
          'they read their fingerprint from their own device, and every group matches the one here. ' +
          'What they sign is then named by the name you give here, and you are told prominently if they ever show up under another fingerprint.',
        fields: [{ kind: 'text', name: 'name', label: 'Your name for them', value: only?.nick ?? c.seen[0]?.nick ?? '', required: true, max: 64 }],
        ok: 'Mark as compared',
      });
      if (!yes) return;
      const given = String(yes.name);
      const other = sharedName(memory, c.fingerprint, given);
      if (other) {
        const still = await ask({
          title: `Another key is ${given} already`,
          body: `You compared the key ${other.slice(0, 16)} and named it ${given} too. Both will show their keys beside the name; another name keeps them apart at a glance.`,
          fields: [],
          ok: 'Use the name anyway',
        });
        if (!still) return;
      }
      await memory.setCompared(c.fingerprint, given);
      said.textContent = `${given} is marked as compared.`;
    } else if (what === 'unmark') {
      await memory.setCompared(c.fingerprint, null);
      said.textContent = `${name} is no longer marked as compared.`;
    } else {
      const yes = await ask({
        title: `Forget ${name}?`,
        body:
          'Everything remembered of this fingerprint goes, on every server: the names and logins it was seen under, whether you sealed to it, ' +
          'your deniable choice and whether you compared it. A message under it is then from someone new, and nothing warns if it changes.',
        fields: [],
        ok: 'Forget',
        danger: true,
      });
      if (!yes) return;
      await memory.forget(c.fingerprint);
      said.textContent = `${name} is forgotten.`;
    }
    hooks.changed();
    draw(what === 'forget' ? undefined : { fingerprint: c.fingerprint, act: what === 'mark' ? 'unmark' : 'mark' });
    if (what === 'forget') ok.focus();
  };

  function card(c: Contact): HTMLElement {
    const button = (what: 'mark' | 'unmark' | 'forget', label: string, danger = false) => {
      const b = h('button', { type: 'button', class: danger ? 'ghost danger' : 'ghost', dataset: { act: what } }, label);
      b.onclick = () => void act(c, what);
      return b;
    };
    const seen = c.seen.map((r) =>
      h(
        'li',
        {},
        `"${r.nick}"${r.logins.length ? `, login ${r.logins.join(', ')}` : ''}, on ${r.server}, last seen ${new Date(r.at).toLocaleString()}`,
        r.sealed ? ', sealed to' : '',
        r.deniable === true ? ', deniable by your choice' : r.deniable === false ? ', signed by your choice' : '',
      ),
    );
    return h(
      'section',
      { class: 'contact', dataset: { fp: c.fingerprint } },
      h(
        'h3',
        {},
        contactName(c) ?? h('code', {}, c.fingerprint.slice(0, 16)),
        ' ',
        c.compared ? h('span', { class: 'sig sig-compared' }, 'compared') : h('span', { class: 'sig sig-uncompared' }, 'not compared'),
      ),
      h('p', { class: 'setting-detail' }, only ? 'Their fingerprint' : 'Fingerprint'),
      h('code', { class: 'contact-fp' }, groupFingerprint(c.fingerprint)),
      c.compared && c.mark?.compared
        ? h('p', { class: 'setting-detail' }, `You compared it ${new Date(c.mark.compared).toLocaleString()}, and named them ${c.mark.name ?? 'nothing'}.`)
        : null,
      ...(seen.length
        ? [h('p', { class: 'setting-detail' }, "Seen as, in the servers' words:"), h('ul', { class: 'contact-seen setting-detail' }, ...seen)]
        : [h('p', { class: 'setting-detail' }, 'Not seen in a private message yet.')]),
      h(
        'div',
        { class: 'setting-row' },
        c.compared ? button('unmark', 'Unmark') : button('mark', 'Mark as compared'),
        c.seen.length || c.mark ? button('forget', 'Forget contact', true) : null,
      ),
    );
  }

  const ok = h('button', { class: 'primary', type: 'button' }, 'Done');
  ok.onclick = () => dialog.close();
  const title = only ? `Compare fingerprints with ${only.nick}` : 'Contacts';
  const dialog = h(
    'dialog',
    { class: 'picker settings contacts', ariaLabel: title },
    h('header', {}, h('h2', {}, title)),
    h(
      'div',
      { class: 'settings-body' },
      h(
        'p',
        { class: 'setting-detail' },
        'A server can show anyone under any key. Comparing fingerprints out of band, in person or on a call, is how you know a key is theirs.',
      ),
      hooks.self
        ? h('section', { class: 'contact' }, h('p', { class: 'setting-detail' }, 'Your fingerprint'), h('code', { class: 'contact-fp' }, groupFingerprint(hooks.self)))
        : h('p', { class: 'setting-detail' }, 'You have no identity on this device, so there is no fingerprint of yours to compare.'),
      list,
      said,
    ),
    h('footer', {}, ok),
  );
  dialog.addEventListener('close', () => dialog.remove());

  draw();
  document.body.append(dialog);
  dialog.showModal();
  ok.focus();
}
