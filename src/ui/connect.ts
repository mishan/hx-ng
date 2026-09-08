/** The connect screen.
 *
 * Everything but the password is remembered, because a Hotline user goes
 * back to the same couple of servers for years. The password is not
 * remembered anywhere, ever — it is a plaintext-equivalent secret on this
 * protocol, and a client that stashes it in localStorage has quietly
 * made every other tab's XSS bug into a credential leak.
 *
 * Where the *first* server address comes from is `../config.ts`: a file
 * next to the built client rather than a constant compiled into it.
 */

import { fetchDiscovery, wsToHttp, type Credentials } from '@hotline-ng/client';

import type { AppConfig } from '../config';
import { serverFromUrl } from '../config';
import { getActiveDevice } from '../identity/storage';
import { planIdentityLogin } from '../identity/login';
import { h, type Props } from './dom';
import { icon, DEFAULT_ICON } from './icons';
import { pickIcon } from './iconpicker';

export interface Details {
  url: string;
  login: string;
  password: string;
  nick: string;
  icon: number;
  /** Set instead of `login`/`password` for an identity login. */
  identity?: Credentials['identity'];
}

const KEY = 'hxd-ng.connect';
/** Per-server answers to the create-account-or-guest question (hxd-ng's
 *  `docs/hotline-ng-identity.md` §5.3), kept separate from `KEY` because
 *  it survives independently of "what this browser last typed" and is
 *  keyed by server rather than being the one remembered form. */
const IDENTITY_CREATE_KEY = 'hxd-ng.connect.identity-create';

export function remembered(config: AppConfig): Details {
  const fallback: Details = {
    url: config.defaultServer,
    login: '',
    password: '',
    nick: '',
    icon: DEFAULT_ICON,
  };
  let details = fallback;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Details>;
      details = { ...fallback, ...saved, password: '' };
    }
  } catch {
    /* storage disabled; the form simply starts from the config's default */
  }
  // A deployment that names one server means it: a stale address in this
  // browser's storage should not outlive the config that replaced it.
  if (!config.allowCustomServer) details.url = config.defaultServer;
  // The URL wins over both — it is the "try this one" escape hatch, and
  // it should not overwrite what the browser remembers.
  return { ...details, url: serverFromUrl() ?? details.url };
}

function remember(d: Details): void {
  try {
    // `identity` carries a function (`getToken`) and `JSON.stringify`
    // simply drops function-valued properties, so leaving it in costs
    // nothing — but naming it out is what the `password` precedent here
    // is for, and it reads better than relying on that.
    const { password: _password, identity: _identity, ...rest } = d;
    localStorage.setItem(KEY, JSON.stringify(rest));
  } catch {
    /* storage disabled; the form simply starts from its defaults */
  }
}

function identityCreateChoices(): Record<string, boolean> {
  // A null-prototype object, and only boolean values copied in one at a
  // time: `url` is whatever the server field holds, and a plain `{}`
  // would let a value of `__proto__` (or a read of `constructor` /
  // `toString`) reach through to `Object.prototype` instead of behaving
  // like the plain string-keyed map this is meant to be.
  const out: Record<string, boolean> = Object.create(null);
  try {
    const raw = localStorage.getItem(IDENTITY_CREATE_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'boolean') out[k] = v;
      }
    }
  } catch {
    /* storage disabled, or not valid JSON; start from empty */
  }
  return out;
}

function rememberIdentityCreateChoice(url: string, makeAccount: boolean): void {
  try {
    const all = identityCreateChoices();
    all[url] = makeAccount;
    localStorage.setItem(IDENTITY_CREATE_KEY, JSON.stringify(all));
  } catch {
    /* storage disabled; the question is simply asked again next time */
  }
}

/**
 * The create-account-or-guest question, asked inline and only where
 * discovery says it matters: a never-seen identity on a `new_accounts =
 * create` server either gets a guest session or an invented account
 * (hxd-ng's `docs/hotline-ng-identity.md` §5.3), and the client must
 * not send its first auth without knowing which. Linking an existing
 * account is deliberately not offered here — it happens with `hlid
 * link` (the identity panel's second command), because a
 * web-capability certificate cannot write a link itself
 * (`docs/hotline-ng-identity.md` §8.2, same document).
 */
function askCreateChoice(container: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    const makeBtn = h('button', { class: 'ghost', type: 'button' }, 'Create an account for me');
    const guestBtn = h('button', { class: 'ghost', type: 'button' }, 'Stay a guest');
    const box = h(
      'div',
      { class: 'identity-create-choice' },
      h(
        'p',
        { class: 'muted' },
        'This server will make a new account for your identity unless you say otherwise. Already linked an existing account with hlid link? That takes effect either way.',
      ),
      h('div', { class: 'button-row' }, makeBtn, guestBtn),
    );
    container.append(box);
    const finish = (v: boolean) => {
      box.remove();
      resolve(v);
    };
    makeBtn.onclick = () => finish(true);
    guestBtn.onclick = () => finish(false);
  });
}

export function connectScreen(
  config: AppConfig,
  onConnect: (d: Details) => Promise<void>,
  onIdentityKeys: () => void,
): HTMLElement {
  const saved = remembered(config);
  let chosenIcon = saved.icon;

  const suggestions = [...new Set([config.defaultServer, ...config.servers])].filter(Boolean);
  const list = h('datalist', { id: 'server-suggestions' }, ...suggestions.map((s) => h('option', { value: s })));

  const url = field('Server', 'url', saved.url, { placeholder: config.defaultServer });
  // `list` is a live element reference as a property and a document id
  // as an attribute; only the attribute form is settable.
  if (suggestions.length > 1) url.input.setAttribute('list', 'server-suggestions');
  url.row.hidden = !config.allowCustomServer;
  const login = field('Account', 'text', saved.login, { placeholder: 'guest', autocomplete: 'username' });
  const password = field('Password', 'password', '', { autocomplete: 'current-password' });
  const nick = field('Nickname', 'text', saved.nick, { placeholder: 'as the account is named' });

  const iconArt = h('span', { class: 'icon-cell-fixed' }, icon(chosenIcon, 2));
  const iconBtn = h('button', { class: 'icon-button', type: 'button' }, iconArt, h('span', { class: 'muted' }, `#${chosenIcon}`));
  iconBtn.onclick = () => {
    void pickIcon(chosenIcon).then((id) => {
      if (id === null) return;
      chosenIcon = id;
      iconArt.replaceChildren(icon(id, 2));
      iconBtn.lastElementChild!.textContent = `#${id}`;
    });
  };

  const error = h('p', { class: 'error', hidden: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Connect');
  const identityKeysLink = h('button', { class: 'ghost', type: 'button' }, 'Identity keys…');
  identityKeysLink.onclick = onIdentityKeys;
  const identityBtn = h('button', { class: 'ghost', type: 'button' }, 'Log in with identity');
  const identityChooser = h('div', {});

  const form = h(
    'form',
    { class: 'connect-card' },
    h('h1', {}, config.title),
    h('p', { class: 'muted' }, 'A web client for the Hotline-ng wire.'),
    list,
    url.row,
    login.row,
    password.row,
    nick.row,
    h('label', { class: 'row' }, h('span', {}, 'Icon'), iconBtn),
    error,
    h('div', { class: 'button-row' }, submit, identityBtn),
    identityChooser,
    h('p', {}, identityKeysLink),
  );

  // Always shown rather than hidden pending an async `getActiveDevice()`
  // check: enrolling happens from the Identity panel this same screen
  // can open, so a check made once at mount would go stale the moment
  // someone enrols without a reload. The click handler below re-checks
  // fresh every time and reports "not enrolled yet" as the ordinary
  // error it is.
  identityBtn.onclick = () => {
    void (async () => {
      const targetUrl = url.input.value.trim() || config.defaultServer;
      if (!targetUrl) return;
      error.hidden = true;
      identityBtn.disabled = true;
      identityBtn.textContent = 'Connecting…';
      try {
        const device = await getActiveDevice();
        if (!device?.cert || !device.card) throw new Error('This browser has no enrolled device yet.');

        const discovery = await fetchDiscovery(wsToHttp(targetUrl));
        const remembered = identityCreateChoices()[targetUrl];
        let create: boolean | undefined;
        if (discovery.identity.enabled && discovery.identity.newAccounts === 'create' && remembered === undefined) {
          const makeAccount = await askCreateChoice(identityChooser);
          rememberIdentityCreateChoice(targetUrl, makeAccount);
          create = makeAccount ? undefined : false;
        } else if (remembered !== undefined) {
          create = remembered ? undefined : false;
        } else {
          create = false;
        }

        const plan = await planIdentityLogin(targetUrl, device, create);
        const details: Details = {
          url: targetUrl,
          login: '',
          password: '',
          nick: nick.input.value.trim(),
          icon: chosenIcon,
          identity: plan.identity,
        };
        remember(details);
        await onConnect(details);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
        error.hidden = false;
      } finally {
        identityBtn.disabled = false;
        identityBtn.textContent = 'Log in with identity';
      }
    })();
  };

  form.onsubmit = (e) => {
    e.preventDefault();
    const details: Details = {
      url: url.input.value.trim() || config.defaultServer,
      login: login.input.value.trim(),
      password: password.input.value,
      nick: nick.input.value.trim(),
      icon: chosenIcon,
    };
    if (!details.url) return;
    remember(details);
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Connecting…';
    onConnect(details)
      .catch((err: Error) => {
        error.textContent = err.message;
        error.hidden = false;
      })
      .finally(() => {
        submit.disabled = false;
        submit.textContent = 'Connect';
      });
  };

  queueMicrotask(() => (saved.login ? password.input : login.input).focus());
  return h('div', { class: 'connect' }, form);
}

function field(
  label: string,
  type: string,
  value: string,
  extra: Props<'input'> = {},
): { row: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { type, value, spellcheck: false, ...extra });
  return { row: h('label', { class: 'row' }, h('span', {}, label), input), input };
}
