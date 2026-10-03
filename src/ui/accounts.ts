/** The account editor: the server's accounts, and one of them open to
 * change (hxd-ng's `docs/account-admin.md` §5).
 *
 * What is offered follows what this session may do, which the server
 * also enforces: listing needs read-users, a new account create-users,
 * a change modify-users, a delete delete-users. A bit this session does
 * not hold is shown and not offered, and an account holding one is shown
 * read-only, since the server refuses either as `outranked`. The server
 * also ranks accounts by settings of their files this client cannot see;
 * an account it refuses for those is shown read-only from then on.
 */

import { errorText, WireFailure, type AccountInfo } from '@hotline-ng/client';

import { ACCESS_GROUPS, draftOf, editParams, grantable, powers, toggle, unknownNames, type Draft } from '../accounts';
import type { Session } from '../session';
import { ask } from './ask';
import { fill, h } from './dom';
import { Sight } from './sight';

function problem(e: unknown): string {
  return e instanceof WireFailure ? errorText(e.wire) : e instanceof Error ? e.message : String(e);
}

/** Said to a screen reader as it appears. */
function announced(el: HTMLElement, role: 'alert' | 'status'): HTMLElement {
  el.setAttribute('role', role);
  return el;
}

const isOutranked = (e: unknown) => e instanceof WireFailure && e.wire.code === 'outranked';

export class AccountsView {
  readonly el = h('section', { class: 'accounts-view', hidden: true });
  private list: { login: string; name: string }[] = [];
  /** The account open in the editor; `null` with a draft is a new one. */
  private open: AccountInfo | null = null;
  private draft: Draft | null = null;
  private error: string | null = null;
  private notice: string | null = null;
  /** Logins the server refused as `outranked` though no bit said so. */
  private above = new Set<string>();
  /** A write under way: one at a time. Its own count rather than
   *  `generation`, which moving to another account bumps: the write
   *  still under way is the one to clear it. */
  private busy = false;
  private writes = 0;
  /** Bumped by every load, pick, write and reset: an answer that lands
   *  after another began is for a view that has moved on. */
  private generation = 0;
  private sight = new Sight();

  constructor(private connection: () => Session | null) {}

  show(open: boolean): void {
    this.el.hidden = !open;
    this.shown(open);
  }

  /** On screen or not, without touching `hidden`. See `NewsView.shown`. */
  shown(on: boolean): void {
    if (this.sight.set(on)) void this.load();
  }

  reset(): void {
    this.generation++;
    this.el.hidden = true;
    this.sight = new Sight();
    this.list = [];
    this.open = null;
    this.draft = null;
    this.error = this.notice = null;
    this.above.clear();
    this.writes++;
    this.busy = false;
    this.el.replaceChildren();
  }

  /** What this session may do changed: draw again with it, and fetch the
   *  list if it may read one now and has none. */
  refresh(): void {
    if (this.sight.on && !this.list.length && powers(this.connection()?.accounts ?? null).read) void this.load();
    else this.render();
  }

  private async load(): Promise<void> {
    const conn = this.connection();
    if (!conn) return;
    const generation = ++this.generation;
    try {
      const list = powers(conn.accounts).read ? (await conn.accountList()).accounts : [];
      if (generation !== this.generation) return;
      this.list = list;
      this.error = null;
    } catch (e) {
      if (generation !== this.generation) return;
      this.error = problem(e);
    }
    this.render();
  }

  private async pick(login: string): Promise<void> {
    const conn = this.connection();
    if (!conn) return;
    const generation = ++this.generation;
    this.error = this.notice = null;
    try {
      const { account } = await conn.accountGet(login);
      if (generation !== this.generation) return;
      this.edit(account);
      this.el.querySelector('.accounts-editor')?.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      if (generation !== this.generation) return;
      this.error = problem(e);
      this.render();
    }
  }

  private edit(account: AccountInfo | null): void {
    this.open = account;
    this.draft = draftOf(account);
    this.render();
  }

  private async save(): Promise<void> {
    const conn = this.connection();
    if (!conn || !this.draft || this.busy) return;
    const params = editParams(this.open, this.draft);
    if (!params) {
      this.notice = 'Nothing has changed.';
      return this.render();
    }
    const generation = ++this.generation;
    const write = ++this.writes;
    const existing = this.open;
    this.error = this.notice = null;
    this.busy = true;
    this.render();
    try {
      // The reply is the account as it now reads, so a session that may
      // make accounts and not read them needs no read to show it.
      const { account } = existing ? await conn.accountUpdate(params) : await conn.accountCreate(params);
      if (write === this.writes) this.busy = false;
      if (generation !== this.generation) return this.render();
      this.notice = existing ? `Saved ${account.login}.` : `Made ${account.login}.`;
      this.list = this.list.map((a) => (a.login === account.login ? { login: a.login, name: account.name } : a));
      this.edit(account);
      if (!existing) void this.load();
    } catch (e) {
      if (write === this.writes) this.busy = false;
      if (generation !== this.generation) return this.render();
      if (existing && isOutranked(e)) {
        this.above.add(existing.login);
        // Shown as it is, not as it was asked to be.
        this.draft = draftOf(existing);
      }
      this.error = problem(e);
      this.render();
    }
  }

  private async remove(): Promise<void> {
    const conn = this.connection();
    const login = this.open?.login;
    if (!conn || !login || this.busy) return;
    const sure = await ask({
      title: `Delete ${login}?`,
      body: 'Anyone logged in as it is disconnected, and it cannot log in again.',
      fields: [],
      ok: 'Delete',
      danger: true,
    });
    if (!sure || this.busy || this.open?.login !== login) return;
    const generation = ++this.generation;
    const write = ++this.writes;
    this.error = null;
    this.busy = true;
    this.render();
    try {
      await conn.accountDelete(login);
      if (write === this.writes) this.busy = false;
      if (generation !== this.generation) return this.render();
      this.open = this.draft = null;
      this.notice = `Deleted ${login}.`;
      await this.load();
    } catch (e) {
      if (write === this.writes) this.busy = false;
      if (generation !== this.generation) return this.render();
      if (isOutranked(e)) this.above.add(login);
      this.error = problem(e);
      this.render();
    }
  }

  private render(): void {
    // Drawn afresh each time, so whatever had the focus gets it back.
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const conn = this.connection();
    const may = powers(conn?.accounts ?? null);
    const add = h('button', { class: 'ghost', disabled: !may.create, dataset: { key: 'new' } }, 'New account');
    add.onclick = () => {
      this.generation++;
      this.error = this.notice = null;
      this.edit(null);
    };
    const rows = this.list.map((a) => {
      const on = this.open?.login === a.login;
      const b = h(
        'button',
        { class: `accounts-row${on ? ' on' : ''}`, dataset: { key: `row:${a.login}` } },
        h('span', { class: 'accounts-login' }, a.login),
        a.name !== a.login ? h('span', { class: 'muted' }, a.name) : null,
      );
      if (on) b.setAttribute('aria-current', 'true');
      b.onclick = () => void this.pick(a.login);
      return b;
    });
    fill(
      this.el,
      h('div', { class: 'mod-head' }, h('h2', {}, 'Accounts'), add),
      this.error ? announced(h('p', { class: 'mod-error' }, this.error), 'alert') : null,
      this.notice ? announced(h('p', { class: 'mod-notice muted' }, this.notice), 'status') : null,
      h(
        'div',
        { class: 'accounts-body' },
        may.read ? h('nav', { class: 'accounts-list' }, ...rows) : null,
        this.draft ? this.editor(this.draft) : null,
      ),
    );
    if (focused) this.el.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  private editor(draft: Draft): HTMLElement {
    const mine = this.connection()?.accounts ?? null;
    const may = powers(mine);
    const account = this.open;
    // The server refuses any change to an account that may do something
    // this session may not, so it is shown as it is and not offered.
    const bits =
      !!account &&
      (account.access.some((n) => !grantable(mine, n)) || account.raw_bits.some((b) => !mine?.raw_bits.includes(b)));
    const settings = !!account && this.above.has(account.login);
    const outranked = bits || settings;
    const writable = (account ? may.modify && !outranked : may.create) && !this.busy;
    const text = (key: string, value: string, set: (v: string) => void, props: Record<string, unknown> = {}) => {
      const input = h('input', { type: 'text', value, disabled: !writable, dataset: { key }, ...props });
      input.oninput = () => set(input.value);
      return input;
    };
    const login = account
      ? h('code', {}, account.login)
      : text('login', draft.login, (v) => (draft.login = v), { maxLength: 31, autocomplete: 'off' });
    const password = text('password', draft.password, (v) => (draft.password = v), {
      type: 'password',
      maxLength: 31,
      autocomplete: 'new-password',
      placeholder: account ? (account.password ? 'unchanged' : 'none set') : 'none',
    });
    password.disabled ||= draft.clearPassword;
    const clear = account?.password
      ? (() => {
          const box = h('input', {
            type: 'checkbox',
            checked: draft.clearPassword,
            disabled: !writable,
            dataset: { key: 'clear' },
          });
          // One or the other: a password typed and then removed is not
          // what anybody meant.
          box.onchange = () => {
            draft.clearPassword = box.checked;
            password.disabled = box.checked;
            if (box.checked) password.value = draft.password = '';
          };
          return h('label', { class: 'ask-check' }, box, ' Remove the password');
        })()
      : null;
    const group = (title: string, bits: [string, string][]) =>
      h(
        'fieldset',
        { class: 'accounts-group' },
        h('legend', {}, title),
        ...bits.map(([name, label]) => {
          const yours = grantable(mine, name);
          const box = h('input', {
            type: 'checkbox',
            checked: draft.access.has(name),
            disabled: !writable || !yours,
            dataset: { key: `bit:${name}` },
          });
          box.onchange = () => {
            toggle(draft, name, box.checked);
            this.render();
          };
          return h(
            'label',
            { class: 'ask-check', title: yours ? name : `${name}: you do not hold this, so you cannot give it` },
            box,
            ` ${label}`,
          );
        }),
      );
    const other = account ? unknownNames(account) : [];
    const save = h('button', { type: 'submit', disabled: !writable }, account ? 'Save' : 'Make account');
    const del =
      account && may.delete && !outranked
        ? h('button', { type: 'button', class: 'ghost danger', disabled: this.busy }, 'Delete')
        : null;
    if (del) del.onclick = () => void this.remove();
    return h(
      'form',
      { class: 'accounts-editor', onsubmit: (e: Event) => (e.preventDefault(), void this.save()) },
      bits ? h('p', { class: 'muted' }, 'This account holds privileges you do not, so you cannot change it.') : null,
      settings && !bits
        ? h(
            'p',
            { class: 'muted' },
            'The server ranks this account above yours by settings in its file that only the operator can see or change, so you cannot change it.',
          )
        : null,
      h('label', {}, 'Login ', login),
      h(
        'label',
        {},
        'Name ',
        text('name', draft.name, (v) => (draft.name = v), { maxLength: 31, placeholder: account ? '' : 'the login' }),
      ),
      h('label', {}, 'Password ', password),
      clear,
      account?.identity ? h('p', { class: 'muted' }, 'Linked to an identity key.') : null,
      ...ACCESS_GROUPS.map((g) => group(g.title, g.bits)),
      other.length || account?.raw_bits.length
        ? h('p', { class: 'muted' }, `Also holds, kept as they are: ${[...other, ...(account?.raw_bits ?? []).map(String)].join(', ')}`)
        : null,
      h('div', { class: 'mod-actions' }, save, del),
    );
  }
}
