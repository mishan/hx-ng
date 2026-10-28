/** The role manager: the server's roles, what each grants and who holds
 * it, and one of them open to change (hxd-ng's `docs/roles.md` §5, §7).
 *
 * Shown inside the account editor, whose head it uses. Listing needs
 * read_users and a change `manage_roles`, which the server also
 * enforces. A role granting a bit
 * this session does not hold is shown read-only, since the server refuses
 * any change to it as `outranked`; so is one held by an account this
 * session may not edit, which only the refusal says.
 */

import { errorText, WireFailure, type Role } from '@hotline-ng/client';

import {
  ACCESS_GROUPS,
  colorHex,
  grantable,
  ROLE_EXTRAS,
  roleDraftOf,
  roleGives,
  roleParams,
  unknownNames,
  type RoleDraft,
} from '../accounts';
import type { Session } from '../session';
import { ask } from './ask';
import { badge, h } from './dom';
import { Sight } from './sight';

function problem(e: unknown): string {
  return e instanceof WireFailure ? errorText(e.wire) : e instanceof Error ? e.message : String(e);
}

type Listed = Role & { holder_count: number };

export class RolesView {
  readonly el = h('div', { class: 'roles-view' });
  private list: Listed[] = [];
  /** The role open in the editor; `null` with a draft is a new one. */
  private open: Role | null = null;
  private holders: string[] = [];
  private draft: RoleDraft | null = null;
  private error: string | null = null;
  private notice: string | null = null;
  private errorEl = h('p', { class: 'mod-error', role: 'alert' });
  private noticeEl = h('p', { class: 'mod-notice muted', role: 'status' });
  /** Roles the server refused as `outranked` though no bit said so. */
  private above = new Set<string>();
  private busy = false;
  private writes = 0;
  private generation = 0;
  /** The list's own count: `roles_changed` follows this session's own
   *  writes, and fetching for it must not drop the write's answer. */
  private listAsked = 0;
  private sight = new Sight();

  /** `fetchList` is the account editor's, which keeps every list
   *  fetched for its own use. */
  constructor(
    private connection: () => Session | null,
    private fetchList: () => Promise<Listed[]>,
  ) {}

  /** For the head: `null` for a session that may not make roles. */
  addButton(): HTMLElement | null {
    if (!this.connection()?.roles?.manage_roles) return null;
    const add = h('button', { class: 'ghost', dataset: { key: 'role-new' } }, 'New role');
    add.onclick = () => {
      this.generation++;
      this.error = this.notice = null;
      this.edit(null);
    };
    return add;
  }

  shown(on: boolean): void {
    if (this.sight.set(on)) void this.load();
  }

  reset(): void {
    this.generation++;
    this.listAsked++;
    this.sight = new Sight();
    this.list = [];
    this.open = this.draft = null;
    this.holders = [];
    this.error = this.notice = null;
    this.above.clear();
    this.writes++;
    this.busy = false;
    this.el.replaceChildren();
  }

  /** A role was made, deleted or shown differently, by anyone. */
  changed(): void {
    if (this.sight.on) void this.load();
  }

  refresh(): void {
    if (this.sight.on) this.render();
  }

  private async load(): Promise<void> {
    const asked = ++this.listAsked;
    try {
      const roles = await this.fetchList();
      if (asked !== this.listAsked) return;
      this.list = roles;
      this.error = null;
    } catch (e) {
      if (asked !== this.listAsked) return;
      this.error = problem(e);
    }
    this.render();
  }

  private async pick(name: string): Promise<void> {
    const conn = this.connection();
    if (!conn) return;
    const generation = ++this.generation;
    this.error = this.notice = null;
    try {
      const { role, holders } = await conn.roleGet(name);
      if (generation !== this.generation) return;
      this.edit(role, holders);
      this.el.querySelector('.accounts-editor')?.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      if (generation !== this.generation) return;
      this.error = problem(e);
      this.render();
    }
  }

  private edit(role: Role | null, holders: string[] = []): void {
    this.open = role;
    this.holders = holders;
    this.draft = roleDraftOf(role);
    this.render();
  }

  private async save(): Promise<void> {
    const conn = this.connection();
    if (!conn || !this.draft || this.busy) return;
    const draft = this.draft;
    const params = roleParams(this.open, draft);
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
      const { role } = existing ? await conn.roleUpdate(params) : await conn.roleCreate(params);
      if (write === this.writes) this.busy = false;
      if (generation !== this.generation) return this.render();
      this.notice = existing ? `Saved ${role.name}.` : `Made ${role.name}.`;
      this.edit(role, this.holders);
      // Counts and grants are the list's, and a change to grants alone
      // tells nobody but the role's holders.
      void this.load();
    } catch (e) {
      if (write === this.writes) this.busy = false;
      if (generation !== this.generation) return this.render();
      if (existing && e instanceof WireFailure && e.wire.code === 'outranked' && !roleGives(existing, draft)) {
        this.above.add(existing.name);
        this.draft = roleDraftOf(existing);
      }
      this.error = problem(e);
      this.render();
    }
  }

  private async remove(): Promise<void> {
    const conn = this.connection();
    const name = this.open?.name;
    if (!conn || !name || this.busy) return;
    const sure = await ask({
      title: `Delete ${name}?`,
      body: 'Every account holding it loses it, and what it gave them.',
      fields: [],
      ok: 'Delete',
      danger: true,
    });
    if (!sure || this.busy || this.open?.name !== name) return;
    const generation = ++this.generation;
    const write = ++this.writes;
    this.error = null;
    this.busy = true;
    this.render();
    try {
      await conn.roleDelete(name);
      if (write === this.writes) this.busy = false;
      if (generation !== this.generation) return this.render();
      this.open = this.draft = null;
      this.notice = `Deleted ${name}.`;
      await this.load();
    } catch (e) {
      if (write === this.writes) this.busy = false;
      if (generation !== this.generation) return this.render();
      if (e instanceof WireFailure && e.wire.code === 'outranked') this.above.add(name);
      this.error = problem(e);
      this.render();
    }
  }

  private render(): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const manage = !!this.connection()?.roles?.manage_roles;
    const rows = this.list.map((r) => {
      const on = this.open?.name === r.name;
      const b = h(
        'button',
        { class: `accounts-row${on ? ' on' : ''}`, dataset: { key: `role:${r.name}` } },
        r.color !== undefined ? h('span', { class: 'role-swatch', style: { background: colorHex(r.color) } }) : null,
        h('span', { class: 'accounts-login' }, r.title),
        badge(r.holder_count, 'holders'),
      );
      if (on) b.setAttribute('aria-current', 'true');
      b.onclick = () => void this.pick(r.name);
      return b;
    });
    const body = h(
      'div',
      { class: 'accounts-body' },
      h('div', { class: 'accounts-list' }, ...rows),
      this.draft ? this.editor(this.draft, manage) : null,
    );
    if (!this.el.firstChild) this.el.append(this.errorEl, this.noticeEl, body);
    else this.el.lastElementChild!.replaceWith(body);
    if (this.errorEl.textContent !== (this.error ?? '')) this.errorEl.textContent = this.error ?? '';
    if (this.noticeEl.textContent !== (this.notice ?? '')) this.noticeEl.textContent = this.notice ?? '';
    if (focused) {
      this.el.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
      if (document.activeElement === document.body) {
        this.el.querySelector<HTMLElement>('.accounts-row')?.focus();
      }
    }
  }

  private editor(draft: RoleDraft, manage: boolean): HTMLElement {
    const mine = this.connection()?.accounts ?? null;
    const role = this.open;
    const bits =
      !!role &&
      (role.access.some((n) => !grantable(mine, n)) || role.raw_bits.some((b) => !mine?.raw_bits.includes(b)));
    const outranked = bits || (!!role && this.above.has(role.name));
    const editable = manage && !outranked;
    const writable = editable && !this.busy;
    const check = (key: string, checked: boolean, label: string, set: (on: boolean) => void, may = true) => {
      const box = h('input', { type: 'checkbox', checked, disabled: !writable || !may, dataset: { key } });
      box.onchange = () => set(box.checked);
      return h('label', { class: 'ask-check' }, box, ` ${label}`);
    };
    const name = role
      ? h('code', {}, role.name)
      : (() => {
          const input = h('input', {
            type: 'text',
            value: draft.name,
            disabled: !writable,
            maxLength: 30,
            autocomplete: 'off',
            dataset: { key: 'role-name' },
          });
          input.oninput = () => (draft.name = input.value);
          return input;
        })();
    const title = h('input', {
      type: 'text',
      value: draft.title,
      disabled: !writable,
      maxLength: 31,
      placeholder: role ? 'unchanged' : 'the name',
      dataset: { key: 'role-title' },
    });
    title.oninput = () => (draft.title = title.value);
    const color = h('input', {
      type: 'color',
      value: colorHex(draft.color ?? 0),
      disabled: !writable,
      dataset: { key: 'role-color' },
    });
    const none = check('role-nocolor', draft.color === null, 'No color', (on) => {
      draft.color = on ? null : parseInt(color.value.slice(1), 16);
    });
    color.oninput = () => {
      draft.color = parseInt(color.value.slice(1), 16);
      none.querySelector('input')!.checked = false;
    };
    const position = h('input', {
      type: 'number',
      step: '1',
      value: String(draft.position),
      disabled: !writable,
      dataset: { key: 'role-position' },
    });
    position.oninput = () => {
      const n = Number(position.value);
      if (position.value.trim() && Number.isInteger(n)) draft.position = n;
    };
    const group = (title: string, bits: [string, string][], set: Set<string>, may: (n: string) => boolean) =>
      h(
        'fieldset',
        { class: 'accounts-group' },
        h('legend', {}, title),
        ...bits.map(([n, label]) =>
          check(
            `grant:${n}`,
            set.has(n),
            label,
            (on) => {
              if (on) set.add(n);
              else set.delete(n);
              this.render();
            },
            may(n),
          ),
        ),
      );
    const save = h(
      'button',
      { type: 'submit', disabled: !editable, dataset: { key: 'role-save' } },
      role ? 'Save' : 'Make role',
    );
    const del =
      role && editable && role.name !== 'everyone'
        ? h('button', { type: 'button', class: 'ghost danger', dataset: { key: 'role-delete' } }, 'Delete')
        : null;
    for (const b of [save, del]) if (b && this.busy) b.setAttribute('aria-disabled', 'true');
    if (del) del.onclick = () => void this.remove();
    const other = role ? [...unknownNames(role), ...role.raw_bits.map(String)] : [];
    const held =
      role?.name === 'everyone'
        ? 'Held by every account, the guest included.'
        : role
          ? this.holders.length
            ? `Held by ${this.holders.join(', ')}.`
            : 'Held by no account.'
          : null;
    return h(
      'form',
      { class: 'accounts-editor', onsubmit: (e: Event) => (e.preventDefault(), void this.save()) },
      bits ? h('p', { class: 'muted' }, 'This role grants privileges you do not hold, so you cannot change it.') : null,
      outranked && !bits
        ? h('p', { class: 'muted' }, 'An account holding this role may do something you may not, so you cannot change it.')
        : null,
      h('label', {}, 'Name ', name),
      h('label', {}, 'Title ', title),
      h('div', { class: 'roles-color' }, h('label', {}, 'Color ', color), none),
      h('label', {}, 'Position ', position),
      check('role-mention', draft.mentionable, 'Mentionable', (on) => (draft.mentionable = on)),
      held ? h('p', { class: 'muted' }, held) : null,
      ...ACCESS_GROUPS.map((g) => group(g.title, g.bits, draft.access, (n) => grantable(mine, n))),
      draft.access.has('read_chat') && !draft.access.has('read_chat_history')
        ? h(
            'p',
            { class: 'muted' },
            'Read chat history still goes with Read chat for a holder whose account does not set it.',
          )
        : null,
      group('Server settings', ROLE_EXTRAS, draft.extra, () => true),
      other.length ? h('p', { class: 'muted' }, `Also grants, kept as they are: ${other.join(', ')}`) : null,
      h('div', { class: 'mod-actions' }, save, del),
    );
  }
}
