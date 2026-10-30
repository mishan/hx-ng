/** Friends and message requests (hxd-ng's `docs/hotline-ng.md` §7.5,
 * `docs/instant-messaging.md` §3–§4): this account's roster with each
 * friend's presence, friend requests both ways, this session's own
 * presence, and the message requests strangers sent.
 *
 * Requests are listed whenever the view is brought forward, which makes
 * this a session that understands them; whether the account takes them
 * is a separate switch, asked about before it is turned on, since it
 * lets anyone taking part put a message in front of the user.
 */

import {
  errorText,
  mergeRequests,
  WireFailure,
  type Events,
  type Friend,
  type MessageRequest,
  type PresenceState,
  type RequestAction,
  type RequestsOk,
} from '@hotline-ng/client';

import { FriendBook, friendName, PRESENCE_LABEL } from '../friends';
import type { KeptFriendship, PortableFriends } from '../friendships';
import type { Session } from '../session';
import { ask } from './ask';
import { badge, h } from './dom';
import { Sight } from './sight';

function problem(e: unknown): string {
  return e instanceof WireFailure ? errorText(e.wire) : e instanceof Error ? e.message : String(e);
}

const CLEAR_SPANS: [string, string][] = [
  ['all', 'Everything waiting'],
  ['3600', 'What came in the last hour'],
  ['86400', 'What came in the last day'],
  ['604800', 'What came in the last week'],
];

export interface FriendsHooks {
  conn: () => Session | null;
  /** This identity's portable friendships, where the session was
   *  granted them. */
  portable: () => PortableFriends | null;
  /** Open the conversation with `login`. */
  message: (login: string, name: string) => void;
  /** What the rail counts changed. */
  onCount: () => void;
}

export class FriendsView {
  readonly el = h('section', { class: 'friends-view', hidden: true });
  readonly book = new FriendBook();
  /** Senders whose requests wait, as `requests_changed` or a listing
   *  last said. */
  waiting = 0;
  private listing: RequestsOk | null = null;
  /** Logins an instant message came from under an approval. */
  private approvedBy = new Set<string>();
  /** What this account shows of itself, as the server last said or
   *  this view last set it. */
  private presence: PresenceState = 'online';
  private status = '';
  private takes = false;
  private error: string | null = null;
  private notice: string | null = null;
  /** What is typed or picked in the forms and not yet sent, by
   *  `data-key`, so a redraw for an event does not throw it away. */
  private drafts = new Map<string, string>();
  private errorEl = h('p', { class: 'mod-error', role: 'alert' });
  private noticeEl = h('p', { class: 'mod-notice muted', role: 'status' });
  private generation = 0;
  private sight = new Sight();

  constructor(private hooks: FriendsHooks) {}

  /** Friend requests to answer and senders waiting: the rail's badge. */
  get count(): number {
    return this.book.groups().incoming.length + this.waiting;
  }

  show(open: boolean): void {
    this.el.hidden = !open;
    this.shown(open);
  }

  /** On screen or not, without touching `hidden`. See `NewsView.shown`. */
  shown(on: boolean): void {
    if (this.sight.set(on)) void this.loadRequests();
  }

  reset(): void {
    this.generation++;
    this.el.hidden = true;
    this.sight = new Sight();
    this.book.clear();
    this.listing = null;
    this.approvedBy.clear();
    this.waiting = 0;
    this.presence = 'online';
    this.status = '';
    this.takes = false;
    this.drafts.clear();
    this.error = this.notice = null;
    this.el.replaceChildren();
  }

  noteApproval(login: string): void {
    this.approvedBy.add(login.toLowerCase());
  }

  /** Whether a `msg` by login to them is an instant message, as far as
   *  this session knows: a friend, or an approval either way. */
  mayIm(login: string): boolean {
    const key = login.toLowerCase();
    return this.book.isFriend(login) || this.approvedBy.has(key) || !!this.listing?.approvals.some((a) => a.login.toLowerCase() === key);
  }

  /** The login's or a `sync`'s `messaging` block. */
  onBlock(): void {
    const block = this.hooks.conn()?.messaging;
    // The server's word on the state wins over one picked and not set: a
    // new login, for one, starts `online` and ends `invisible`.
    this.drafts.delete('presence');
    this.presence = block?.state ?? 'online';
    this.status = block?.status_text ?? '';
    this.takes = block?.takes_requests === true;
    if (this.sight.on) this.render();
  }

  onFriends(list: Friend[]): void {
    this.book.replace(list);
    this.changed();
  }

  onFriend(d: Events['friend']): void {
    this.book.apply(d.friend);
    this.changed();
  }

  onFriendRequest(d: Events['friend_request']): void {
    this.book.request(d);
    this.changed();
  }

  onPresence(d: Events['presence']): void {
    if (this.book.presence(d)) this.render();
  }

  onRequestsChanged(d: Events['requests_changed']): void {
    this.waiting = d.count;
    this.hooks.onCount();
    if (this.sight.on) void this.loadRequests();
  }

  /** The keeper changed what it holds. */
  portableChanged(): void {
    if (this.sight.on) this.render();
  }

  private changed(): void {
    this.hooks.onCount();
    if (this.sight.on) this.render();
  }

  private async loadRequests(more?: string): Promise<void> {
    const conn = this.hooks.conn();
    if (!conn?.messaging?.takes_part) return this.render();
    const generation = ++this.generation;
    try {
      const page = await conn.requests(more);
      if (generation !== this.generation) return;
      const had = more ? this.listing : null;
      this.listing = had ? mergeRequests(had, page) : page;
      this.takes = page.takes_requests;
      if (!page.cursor) this.waiting = this.listing.requests.length;
      this.error = null;
      this.hooks.onCount();
    } catch (e) {
      if (generation !== this.generation) return;
      this.error = problem(e);
    }
    this.render();
  }

  /** One act on the server, its refusal said here; true when it went. */
  private async act(what: (conn: Session) => Promise<unknown>, done?: string): Promise<boolean> {
    const conn = this.hooks.conn();
    if (!conn) return false;
    this.error = this.notice = null;
    try {
      await what(conn);
      this.notice = done ?? null;
      this.render();
      return true;
    } catch (e) {
      this.error = problem(e);
      this.render();
      return false;
    }
  }

  private async add(login: string, note: string): Promise<void> {
    let state = '';
    const ok = await this.act(async (conn) => {
      const portable = this.hooks.portable();
      state = (
        portable
          ? await portable.add(login, note || undefined)
          : await conn.friendAdd(login, note || undefined)
      ).state;
    });
    if (!ok) return;
    this.drafts.delete('add-login');
    this.drafts.delete('add-note');
    this.notice = state === 'accepted' ? `You and ${login} are friends now.` : `Asked ${login} to be your friend.`;
    this.render();
  }

  private async rename(f: Friend): Promise<void> {
    const yes = await ask({
      title: `Your name for ${f.login}`,
      body: 'Only you see it. Leave it empty to show their login.',
      fields: [{ kind: 'text', name: 'alias', label: 'Name', value: f.alias ?? '', max: 31 }],
      ok: 'Save',
    });
    if (!yes) return;
    const alias = String(yes.alias).trim();
    await this.act((conn) => conn.friendAlias(f.login, alias || null));
  }

  private async remove(f: Friend, how: 'remove' | 'withdraw' | 'decline'): Promise<void> {
    const portable = this.hooks.portable();
    const everywhere = how === 'remove' && !!portable?.with(f.fingerprint).length;
    if (how === 'remove') {
      const yes = await ask({
        title: `Remove ${friendName(f)}?`,
        body: everywhere
          ? 'The friendship ends for both of you, here and on every other server it was brought to, and what they send you is held from then on.'
          : 'The friendship ends for both of you, and what they send you is held from then on.',
        fields: [],
        ok: 'Remove',
        danger: true,
      });
      if (!yes) return;
    }
    await this.act((conn) =>
      how === 'decline' ? conn.friendRespond(f.login, false) : portable ? portable.remove(f) : conn.friendRemove(f.login),
    );
  }

  /** With this client's own acceptance where the request carries an
   *  offer and the session may sign one. */
  private async accept(f: Friend): Promise<void> {
    const portable = this.hooks.portable();
    // Asked after any rotation the entry shows is followed, so a fetch
    // still in flight cannot skip the question.
    const old = portable && f.offer ? await portable.rotation(f) : undefined;
    if (old) {
      const yes = await ask({
        title: `Accept ${friendName(f)}'s new key?`,
        body:
          `Their identity key has rotated from ${old.slice(0, 8)}… to ${f.fingerprint!.slice(0, 8)}…, and they offer your friendship under it. ` +
          'Both keys signed the rotation; that the old key had committed to this new one is the server\'s word, which this device ' +
          'cannot check. Accept only if you expected them to change keys.',
        fields: [],
        ok: 'Accept',
      });
      if (!yes) return;
    }
    const move = old ? { from: old, to: f.fingerprint! } : undefined;
    await this.act((conn) => (portable && f.offer ? portable.accept(f, move) : conn.friendRespond(f.login, true)));
  }

  /** Turned on, the user picks who comes along before anything is
   *  presented, since presenting is what tells the server. */
  private async bring(on: boolean): Promise<void> {
    const portable = this.hooks.portable();
    if (!portable) return;
    let leftOut: string[] = [];
    if (on) {
      const friends = [...new Set(portable.book.friendships.filter((k) => portable.adopted(k) && !portable.movedTo(k.friend)).map((k) => k.friend))];
      const yes = await ask({
        title: 'Bring your portable friends here?',
        body:
          'The friends ticked here are shown to this server, each one it can find, and become friends here once they bring you too. ' +
          'This server then knows who you are friends with.',
        fields: friends.map((fp) => ({ kind: 'check' as const, name: fp, label: this.portableName(fp), value: !portable.choice.leftOut.includes(fp) })),
        ok: 'Bring them',
      });
      if (!yes) return;
      leftOut = friends.filter((fp) => !yes[fp]);
    }
    await this.act(
      () => portable.setBring(on, leftOut),
      on ? 'Your portable friends are brought here.' : 'Your portable friends are no longer brought here.',
    );
  }

  /** A portable friend by the login a server last showed them under, or
   *  their key. */
  private portableName(fp: string): string {
    const logins = this.hooks.portable()?.with(fp).find((k) => Object.keys(k.logins).length)?.logins;
    return (logins && Object.values(logins)[0]) ?? `${fp.slice(0, 8)}…`;
  }

  private async leaveOut(friend: string, out: boolean, login?: string): Promise<void> {
    const portable = this.hooks.portable();
    if (!portable) return;
    if (out) {
      const yes = await ask({
        title: 'Leave this friend out here?',
        body: 'Your friendship stays on the other servers. Here it ends, if it stands, and is not brought again.',
        fields: [],
        ok: 'Leave out',
      });
      if (!yes) return;
    }
    await this.act(() => portable.leaveOut(friend, out, login));
  }

  private async confirm(k: KeptFriendship, keep: boolean): Promise<void> {
    const portable = this.hooks.portable();
    if (!portable) return;
    if (!keep) {
      const yes = await ask({
        title: 'Not yours?',
        body: 'The friendship is withdrawn, on this server and on every other this device reaches, as a removal by you would be.',
        fields: [],
        ok: 'Withdraw it',
        danger: true,
      });
      if (!yes) return;
    }
    await this.act(() => portable.confirm(k.hash, keep));
  }

  /** Only what changed, so another session's status is not written over
   *  with this one's. */
  private async setPresence(state: PresenceState, status: string): Promise<void> {
    const params = {
      ...(state !== this.presence ? { state } : {}),
      ...(status !== this.status ? { status_text: status || null } : {}),
    };
    if (!Object.keys(params).length) return;
    if (await this.act((conn) => conn.setPresence(params), 'Your presence is set.')) {
      this.presence = state;
      this.status = status;
      this.drafts.delete('presence');
      this.drafts.delete('status');
      this.render();
    }
  }

  private async setTakes(on: boolean): Promise<void> {
    if (on) {
      const yes = await ask({
        title: 'Take message requests?',
        body:
          'Anyone on this server who takes part in messaging, and whom you have not blocked, can then send you a few text messages ' +
          'without being your friend. They wait here, nothing notifies you of them, and nobody learns whether you read them ' +
          'until you approve, reply or add them. You can turn this off again at any time.',
        fields: [],
        ok: 'Take requests',
      });
      if (!yes) return;
    }
    if (await this.act((conn) => conn.setPresence({ takes_requests: on }), on ? 'You take message requests now.' : 'You take no message requests now.')) {
      this.takes = on;
      this.render();
    }
  }

  private async answer(login: string, action: RequestAction): Promise<void> {
    const done = { approve: `${login} may message you now.`, delete: `Deleted ${login}'s request.`, end: `${login} may no longer message you.` };
    if (!(await this.act((conn) => conn.requestAnswer(login, action), done[action]))) return;
    if (action === 'end') this.approvedBy.delete(login.toLowerCase());
    void this.loadRequests();
  }

  private async clear(): Promise<void> {
    const yes = await ask({
      title: 'Clear requests?',
      body: 'Every friend request is declined and every message request deleted, and their senders are held from asking again for a while. Friends and approvals stay as they are.',
      fields: [{ kind: 'choice', name: 'span', label: 'Clear', options: CLEAR_SPANS, value: 'all' }],
      ok: 'Clear',
      danger: true,
    });
    if (!yes) return;
    const span = String(yes.span);
    const since = span === 'all' ? undefined : Math.floor(Date.now() / 1000) - Number(span);
    let said = '';
    const ok = await this.act(async (conn) => {
      const { declined, deleted } = await conn.requestsClear(since === undefined ? {} : { since });
      said = `Declined ${declined} friend ${declined === 1 ? 'request' : 'requests'} and deleted ${deleted} message ${deleted === 1 ? 'request' : 'requests'}.`;
    });
    if (!ok) return;
    this.notice = said;
    void this.loadRequests();
  }

  private render(): void {
    if (!this.sight.on && this.el.hidden) return;
    const active = document.activeElement as HTMLElement | null;
    const focused = active?.dataset?.key;
    const caret = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
    const conn = this.hooks.conn();
    const head = h('div', { class: 'mod-head' }, h('h2', {}, 'Friends'));
    const body = h('div', { class: 'mod-list friends-body' });
    if (!conn?.messaging?.takes_part) {
      body.append(h('p', { class: 'muted' }, 'This account does not take part in messaging on this server.'));
    } else {
      body.append(this.presenceForm(), this.addForm(), ...this.roster(), ...this.requestsPart());
    }
    this.el.replaceChildren(head, this.errorEl, this.noticeEl, body);
    if (this.errorEl.textContent !== (this.error ?? '')) this.errorEl.textContent = this.error ?? '';
    if (this.noticeEl.textContent !== (this.notice ?? '')) this.noticeEl.textContent = this.notice ?? '';
    const back = focused ? this.el.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`) : null;
    back?.focus();
    if (caret && back instanceof HTMLInputElement) back.setSelectionRange(caret[0] ?? null, caret[1] ?? null);
  }

  /** A form's input or select, drawn with its draft and keeping it. */
  private kept<T extends HTMLInputElement | HTMLSelectElement>(el: T, value: string): T {
    const key = el.dataset.key!;
    el.value = this.drafts.get(key) ?? value;
    el.oninput = () => this.drafts.set(key, el.value);
    return el;
  }

  private presenceForm(): HTMLElement {
    const state = this.kept(
      h(
        'select',
        { ariaLabel: 'Your presence', dataset: { key: 'presence' } },
        ...(['online', 'away', 'busy', 'invisible'] as const).map((s) => h('option', { value: s }, PRESENCE_LABEL[s])),
      ),
      this.presence,
    );
    const status = this.kept(h('input', { type: 'text', placeholder: 'Status, for your friends', maxLength: 255, dataset: { key: 'status' } }), this.status);
    const set = h('button', { class: 'ghost', type: 'submit', dataset: { key: 'presence-set' } }, 'Set');
    const form = h('form', { class: 'friends-form' }, state, status, set);
    form.onsubmit = (e) => {
      e.preventDefault();
      void this.setPresence(state.value as PresenceState, status.value.trim());
    };
    return form;
  }

  private addForm(): HTMLElement {
    const login = this.kept(h('input', { type: 'text', placeholder: 'Login', required: true, maxLength: 31, ariaLabel: 'Login to add', dataset: { key: 'add-login' } }), '');
    const note = this.kept(h('input', { type: 'text', placeholder: 'A note, if you like', ariaLabel: 'Note', dataset: { key: 'add-note' } }), '');
    const add = h('button', { class: 'ghost', type: 'submit', dataset: { key: 'add' } }, 'Add friend');
    const form = h('form', { class: 'friends-form' }, login, note, add);
    form.onsubmit = (e) => {
      e.preventDefault();
      const who = login.value.trim();
      if (who) void this.add(who, note.value.trim());
    };
    return form;
  }

  private button(label: string, key: string, onclick: () => void, danger = false): HTMLElement {
    const b = h('button', { class: danger ? 'ghost danger' : 'ghost', dataset: { key } }, label);
    b.onclick = onclick;
    return b;
  }

  private roster(): HTMLElement[] {
    const { incoming, friends, outgoing, blocked } = this.book.groups();
    const section = (title: string, rows: HTMLElement[]) =>
      rows.length ? h('div', { class: 'friends-group' }, h('h3', {}, title), ...rows) : null;
    const row = (f: Friend, ...rest: (HTMLElement | null)[]) =>
      h('div', { class: 'friends-row', dataset: { login: f.login } }, h('span', { class: 'friends-name', title: f.login }, friendName(f)), ...rest);
    const out = [
      section(
        'Asking to be your friend',
        incoming.map((f) =>
          row(
            f,
            f.note ? h('span', { class: 'muted friends-note' }, f.note) : null,
            this.button('Accept', `accept:${f.login}`, () => void this.accept(f)),
            this.button('Decline', `decline:${f.login}`, () => void this.remove(f, 'decline')),
          ),
        ),
      ),
      section(
        'Friends',
        friends.map((f) => {
          const presence = f.presence ?? 'offline';
          const keeper = this.hooks.portable();
          const portable = keeper?.with(f.fingerprint).some((k) => keeper.adopted(k));
          return row(
            f,
            portable ? h('span', { class: 'muted friends-note', title: f.fingerprint }, 'portable') : null,
            h('span', { class: `friends-presence p-${presence}` }, PRESENCE_LABEL[presence]),
            f.status_text ? h('span', { class: 'muted friends-note' }, f.status_text) : null,
            f.offer ? this.button('Make portable', `upgrade:${f.login}`, () => void this.accept(f)) : null,
            this.button('Message', `msg:${f.login}`, () => this.hooks.message(f.login, friendName(f))),
            this.button('Rename', `alias:${f.login}`, () => void this.rename(f)),
            portable ? this.button('Leave out here', `here:${f.login}`, () => void this.leaveOut(f.fingerprint!, true, f.login)) : null,
            this.button('Remove', `remove:${f.login}`, () => void this.remove(f, 'remove'), true),
          );
        }),
      ),
      section(
        'Waiting for an answer',
        outgoing.map((f) => row(f, this.button('Withdraw', `withdraw:${f.login}`, () => void this.remove(f, 'withdraw')))),
      ),
      section(
        'Blocked',
        blocked.map((f) => row(f, this.button('Unblock', `unblock:${f.login}`, () => void this.act((c) => c.unblock({ login: f.login }))))),
      ),
    ];
    out.push(this.portablePart(friends));
    if (!out.some(Boolean)) return [h('p', { class: 'muted' }, 'No friends yet. Add someone by their login.')];
    return out.filter((el): el is HTMLDivElement => !!el);
  }

  /** Where this server stands with the user's portable friendships: the
   *  choice to bring them, each friend not a friend here and whether
   *  they are left out, and what another of the user's devices made. */
  private portablePart(here: Friend[]): HTMLDivElement | null {
    const portable = this.hooks.portable();
    if (!portable) return null;
    const { bring, leftOut } = portable.choice;
    const held = portable.book.friendships;
    const name = (fp: string) => this.portableName(fp);
    const elsewhere = [
      ...new Set(
        held.filter((k) => portable.adopted(k) && !portable.movedTo(k.friend) && !here.some((f) => f.fingerprint === k.friend)).map((k) => k.friend),
      ),
    ];
    const rows = elsewhere.map((fp) => {
      const out = leftOut.includes(fp);
      return h(
        'div',
        { class: 'friends-row' },
        h('span', { class: 'friends-name', title: fp }, name(fp)),
        h('span', { class: 'muted friends-note' }, out ? 'left out here' : bring ? 'not here yet' : ''),
        bring ? this.button(out ? 'Bring here' : 'Leave out', `leave:${fp}`, () => void this.leaveOut(fp, !out)) : null,
      );
    });
    // Grouped by the device that signed them, so a user asks themselves
    // once per device rather than once per friend (§6).
    const devices = new Map<string, KeptFriendship[]>();
    for (const k of held) if (!portable.adopted(k)) devices.set(k.device, [...(devices.get(k.device) ?? []), k]);
    const confirm = [...devices.values()].flatMap((group) => [
      h('p', { class: 'muted' }, `Made on ${group[0]!.deviceName ?? 'a device other than this one'}. Keep the ones you recognize.`),
      ...group.map((k) =>
        h(
          'div',
          { class: 'friends-row' },
          h('span', { class: 'friends-name', title: k.friend }, name(k.friend)),
          h('span', { class: 'muted friends-note' }, new Date(k.signedAt * 1000).toLocaleDateString()),
          this.button('Keep', `keep:${k.hash}`, () => void this.confirm(k, true)),
          this.button('Not mine', `drop:${k.hash}`, () => void this.confirm(k, false), true),
        ),
      ),
    ]);
    return h(
      'div',
      { class: 'friends-group' },
      h('h3', {}, 'Portable friends'),
      h(
        'p',
        { class: 'muted' },
        bring ? 'Your portable friends are brought to this server. ' : 'Your portable friends are not brought to this server. ',
        this.button(bring ? 'Stop bringing them' : 'Bring them here…', 'bring', () => void this.bring(!bring)),
      ),
      ...rows,
      ...confirm,
    );
  }

  private requestsPart(): HTMLElement[] {
    const listing = this.listing;
    const takes = this.takes
      ? 'You take message requests from people who are not your friends.'
      : 'You take no message requests from people who are not your friends.';
    const head = h(
      'div',
      { class: 'friends-group' },
      h('h3', {}, 'Message requests', this.waiting ? badge(this.waiting, 'waiting') : null),
      h(
        'p',
        { class: 'muted' },
        takes,
        ' ',
        this.takes
          ? this.button('Stop taking requests', 'takes-off', () => void this.setTakes(false))
          : this.button('Take requests…', 'takes-on', () => void this.setTakes(true)),
      ),
      listing?.dropped
        ? h('p', { class: 'muted' }, `${listing.dropped} ${listing.dropped === 1 ? 'request was' : 'requests were'} dropped since you last looked, past what this server keeps.`)
        : null,
    );
    if (!listing) return [head];
    const sender = (r: MessageRequest) =>
      h(
        'div',
        { class: 'friends-request' },
        h('div', { class: 'friends-row' }, h('span', { class: 'friends-name' }, r.login),
          this.button('Approve', `approve:${r.login}`, () => void this.answer(r.login, 'approve')),
          this.button('Delete', `delete:${r.login}`, () => void this.answer(r.login, 'delete'), true),
        ),
        ...r.messages.map((m) =>
          h('p', { class: 'friends-message' }, h('span', { class: 'time' }, new Date(m.at * 1000).toLocaleString()), ' ', m.text),
        ),
      );
    const approvals = listing.approvals.map((a) =>
      h('div', { class: 'friends-row' }, h('span', { class: 'friends-name' }, a.login), this.button('End', `end:${a.login}`, () => void this.answer(a.login, 'end'))),
    );
    const more = listing.cursor
      ? this.button('More', 'requests-more', () => void this.loadRequests(listing.cursor))
      : null;
    const clear = listing.requests.length || this.book.groups().incoming.length
      ? this.button('Clear requests…', 'requests-clear', () => void this.clear(), true)
      : null;
    return [
      head,
      ...(listing.requests.length ? listing.requests.map(sender) : [h('p', { class: 'muted' }, 'No message requests are waiting.')]),
      ...(more ? [more] : []),
      ...(clear ? [clear] : []),
      ...(approvals.length ? [h('div', { class: 'friends-group' }, h('h3', {}, 'Approved to message you'), ...approvals)] : []),
    ];
  }
}
