/** Signed lines, private messages and articles (hxd-ng's
 * `docs/e2e-messages.md` §4.6 to §4.10, §8): whether this session can
 * sign, and the state each one it reads is shown in. No DOM: the
 * transcript and the news view draw what this decides. */

import {
  CAPS,
  SIGNED_CERT_MAX_BYTES,
  aliasCovers,
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  decodeDeviceCert,
  fingerprintFromString,
  fingerprintToString,
  readSignedArticle,
  readSignedChat,
  readSignedMessage,
  signatureDisplay,
  type ArticleScope,
  type ChatScope,
  type ChatStyle,
  type Events,
  type FollowedHandover,
  type HistoryLine,
  type NewsArticle,
  type NewsNode,
  type ServerAlias,
  type SignatureDisplay,
  type SignedArticle,
  type SignedContext,
  type SignedOutcome,
  type SignedParent,
  type SignedSender,
  type Signs,
  type StoredMessage,
  type User,
} from '@hotline-ng/client';

/** Where a user chooses whether to sign (§8). Private chats are never
 *  signed, so they are not one. */
export type SignScope = 'lobby' | 'pm' | 'news';

const SIGN_KEYS: Record<SignScope, string> = {
  lobby: 'hxd-ng.sign.lobby',
  pm: 'hxd-ng.sign.pm',
  news: 'hxd-ng.sign.news',
};

/** Articles are signed unless the user turned it off, as §8 asks. The
 *  lobby and private messages are not unless turned on: a signed line or
 *  message in the clear is evidence anyone can show of what was said
 *  (§1.3), and what §8 asks for private messages is sealing. */
export function readSigning(scope: SignScope): boolean {
  try {
    const v = localStorage.getItem(SIGN_KEYS[scope]);
    return scope === 'news' ? v !== 'off' : v === 'on';
  } catch {
    return scope === 'news';
  }
}

export function writeSigning(scope: SignScope, on: boolean): void {
  try {
    localStorage.setItem(SIGN_KEYS[scope], on ? 'on' : 'off');
  } catch {
    /* storage disabled; the preference lasts this page load */
  }
}

/** What a session proving this certificate says at login (§4.6), or
 *  `undefined` for one whose certificate cannot sign a line. */
export function signsFor(cert: Uint8Array | undefined, lobby: boolean): Signs | undefined {
  if (!cert || cert.length > SIGNED_CERT_MAX_BYTES) return undefined;
  try {
    const caps = decodeDeviceCert(cert).caps;
    if (caps !== undefined && (caps & CAPS.MESSAGE) === 0) return undefined;
  } catch {
    return undefined;
  }
  return lobby ? 'default' : 'able';
}

/** The key this host is pinned to, and the handovers it followed, whose
 *  old keys stay in scope for what was signed before them. */
export interface PinnedKey {
  key: Uint8Array;
  followed: readonly FollowedHandover[];
}

/** How a line, a message or an article is shown, and by whose key when
 *  it has one. */
export interface LineSignature extends SignatureDisplay {
  /** The certificate's fingerprint, which a signed one is named by
   *  (§8); `null` for a link form whose certificate is not held. */
  signer: string | null;
  /** When it was signed, Unix seconds, in the signer's word. */
  sent?: number;
  /** A linked user's home server, by the name its row gives, on every
   *  line checked against a key the row gave rather than the pin. */
  home?: string;
  /** That key is not the one this host is pinned to. */
  foreignKey?: boolean;
  /** Where one signed for elsewhere was signed. */
  signedFor?: string;
  /** Why one that parsed is unverified, where it is not the §8 default
   *  of nothing to check it against. */
  why?: string;
  /** Who a message this client sent signed was signed to. */
  to?: string;
}

export interface LineRead {
  signature: LineSignature | null;
  /** Another copy of a signed one already read here, the same or
   *  another under its id (§3.6): not to be shown. */
  duplicate: boolean;
}

/** What one that could not be read at all is shown as: a signed one as
 *  unverified, and never left out. */
export function unreadable(signed: string | undefined): LineRead {
  const signature: LineSignature = { state: 'unverified', signer: null, sentAtAnotherTime: false, signatureExpected: false };
  return { signature: signed === undefined ? null : signature, duplicate: false };
}

/** How many signed ids are remembered, the newest kept: §3.6's window,
 *  which a session's scrollback fits in. */
const IDS_KEPT = 4096;

function keyOf(b64: string | undefined): Uint8Array | null {
  if (b64 === undefined) return null;
  try {
    return base64urlToBytes(b64);
  } catch {
    return null;
  }
}

const sameKey = (a: Uint8Array, b: Uint8Array | null) => b !== null && bytesToHex(a) === bytesToHex(b);

/** The start of a key the server gave, to say which one it is. */
const keyWords = (key: Uint8Array) => `the server whose key begins ${bytesToBase64url(key).slice(0, 16)}`;

function signatureOf(outcome: SignedOutcome, sent: number | undefined): LineSignature {
  const signer = 'signer' in outcome ? outcome.signer : null;
  return { ...signatureDisplay(outcome), signer, ...(sent !== undefined ? { sent } : {}) };
}

/**
 * What a reader remembers within one session: who it saw sign, whose
 * unsigned ones are marked, and each signed one it read by its signer
 * and id (§3.6). They are read one at a time, in the order they are
 * handed over, so what one teaches holds for the next.
 */
class SignedMemory {
  /** Fingerprints seen signing here. */
  protected signing = new Set<string>();
  /** Each signed one read, by signer (or a link form's certificate
   *  hash) and id: the server's id for the copy that was kept, which a
   *  refetched page carries again, and what it said. */
  private ids = new Map<string, { id: number | undefined; content: string }>();
  private queue: Promise<unknown> = Promise.resolve();

  protected serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Whether a signed one was read here before, under `key`: not the
   *  same one again unless the server's id and the content are too. */
  protected seen(key: string, id: number | undefined, content: string): boolean {
    const was = this.ids.get(key);
    if (was) return id === undefined || was.id !== id || was.content !== content;
    this.ids.set(key, { id, content });
    if (this.ids.size > IDS_KEPT) this.ids.delete(this.ids.keys().next().value!);
    return false;
  }
}

/** The key `seen` remembers a read by, or `null` for one that names no
 *  signer and no link form. */
function memoryKey(signer: string | null, id: Uint8Array | undefined, link?: { id: Uint8Array; certSha256: Uint8Array }): string | null {
  if (signer && id) return `${signer} ${bytesToHex(id)}`;
  return link ? `cert ${bytesToHex(link.certSha256)} ${bytesToHex(link.id)}` : null;
}

/** A pin's handovers, as a scope's alias. */
function aliasOf(pinned: PinnedKey): ServerAlias {
  return (key, sent) => pinned.followed.some((f) => aliasCovers(f, key, sent));
}

/**
 * Reads the lobby's lines against this host's pinned key, or for a
 * linked server's user against the key their row gives. A line from
 * anyone with no key to check it against is unverified, never verified
 * on the server's word.
 */
export class LineReader extends SignedMemory {
  constructor(private pinned: PinnedKey | null) {
    super();
  }

  /** The host's key as checked again, for the lines read from now on. */
  repin(pinned: PinnedKey | null): void {
    this.pinned = pinned;
  }

  private scope(remote: { server_key?: string } | undefined): ChatScope {
    if (remote) return { server: keyOf(remote.server_key), room: 0 };
    const pinned = this.pinned;
    if (!pinned) return { server: null, room: 0 };
    return { server: pinned.key, room: 0, alias: aliasOf(pinned) };
  }

  /** A `chat` event, with the sender's roster row as it stood. A line
   *  the event or the row says is a linked user's is read as one. */
  live(line: Events['chat'], row: User | undefined): Promise<LineRead> {
    const remote = row?.remote ?? line.from.remote;
    const fingerprint = row?.identity?.fingerprint;
    // A ghost's row names no fingerprint until user keys cross, and
    // then the certificate's is the name (§8).
    const sender: SignedSender = fingerprint ? { named: fingerprint } : remote ? 'certificate' : 'unknown';
    return this.serially(() =>
      this.read(line, { at: line.at, sender, scope: this.scope(remote) }, remote && (remote.server || 'a linked server'), {
        rowSigns: row?.identity?.signs === true,
        seenSigning: fingerprint !== undefined && this.signing.has(fingerprint),
      }),
    );
  }

  /** A `history` line, which names no uid: its certificate is the name. */
  history(line: HistoryLine): Promise<LineRead> {
    const remote = line.from.remote;
    return this.serially(() =>
      this.read(line, { at: line.at, sender: 'certificate', scope: this.scope(remote) }, remote && 'a linked server', {}),
    );
  }

  private async read(
    line: { text: string; style: ChatStyle; signed?: string; id?: number },
    ctx: SignedContext<ChatScope>,
    home: string | undefined,
    expected: { rowSigns?: boolean; seenSigning?: boolean },
  ): Promise<LineRead> {
    if (line.signed === undefined) {
      // A line of an image alone has no text to sign (§3.3), so none
      // was expected.
      const shown = signatureDisplay(null, line.text === '' ? {} : expected);
      return { signature: shown.signatureExpected ? { ...shown, signer: null } : null, duplicate: false };
    }
    const { outcome, line: signed, link } = await readSignedChat(line.signed, line.text, line.style === 'action', ctx);
    if (outcome.state === 'verified') this.signing.add(outcome.signer);
    const signature = signatureOf(outcome, signed?.sent);
    const key = memoryKey(signature.signer, signed?.id, link);
    const content = signed ? `${bytesToHex(signed.server)} ${signed.room} ${signed.act} ${signed.text}` : `${line.style} ${line.text}`;
    const duplicate = key !== null && this.seen(key, line.id, content);
    if (home !== undefined) {
      signature.home = home;
      const pinned = this.pinned?.key ?? null;
      signature.foreignKey = ctx.scope.server === null || pinned === null || !sameKey(ctx.scope.server, pinned);
    }
    if (outcome.state === 'elsewhere' && signed) {
      const where = [];
      if (!sameKey(signed.server, ctx.scope.server)) where.push(keyWords(signed.server));
      if (signed.room !== ctx.scope.room) where.push(`room ${signed.room}`);
      signature.signedFor = where.join(', ') || 'another scope';
    }
    return { signature, duplicate };
  }
}

const SIGNER_CHARS = 16;

/**
 * Reads private messages, live and stored, against the fingerprint this
 * session proved (§3.2, §4.9): `to` must be it, and a session that
 * proved none has nothing to check `to` against, so every signed
 * message it reads is unverified.
 */
export class MessageReader extends SignedMemory {
  constructor(private proved: string | null) {
    super();
  }

  /** The fingerprint the session proved, for what is read from now on:
   *  a login after a resume failed may prove another, or none. */
  prove(proved: string | null): void {
    this.proved = proved;
  }

  /** A `msg` event, with the sender's roster row as it stood: a local
   *  row names its fingerprint, a linked user's row its home's word for
   *  it or nothing, and a message whose sender has no session now is
   *  named by its certificate, as a stored row is. */
  live(m: Events['msg'], row: User | undefined): Promise<LineRead> {
    const fingerprint = row?.identity?.fingerprint;
    const sender: SignedSender = fingerprint ? { named: fingerprint } : m.from.uid === 0 || row?.remote ? 'certificate' : 'unknown';
    return this.serially(() => this.read(m, sender, fingerprint));
  }

  /** An `inbox` row, which names no uid or fingerprint: its certificate
   *  is the name (§4.9). */
  stored(m: StoredMessage): Promise<LineRead> {
    return this.serially(() => this.read(m, 'certificate', undefined));
  }

  private async read(
    m: { text: string; at: number; signed?: string; id?: number },
    sender: SignedSender,
    fingerprint: string | undefined,
  ): Promise<LineRead> {
    if (m.signed === undefined) {
      const shown = signatureDisplay(null, { seenSigning: fingerprint !== undefined && this.signing.has(fingerprint) });
      return { signature: shown.signatureExpected ? { ...shown, signer: null } : null, duplicate: false };
    }
    const { outcome, message, link } = await readSignedMessage(m.signed, m.text, { at: m.at, sender, scope: this.proved });
    if (outcome.state === 'verified') this.signing.add(outcome.signer);
    const signature = signatureOf(outcome, message?.sent);
    const key = memoryKey(signature.signer, message?.id, link);
    const content = message ? `${bytesToHex(message.to)} ${message.auto} ${message.text}` : m.text;
    const duplicate = key !== null && this.seen(key, m.id, content);
    if (outcome.state === 'elsewhere' && message) {
      signature.signedFor = `someone else, whose fingerprint begins ${fingerprintToString(message.to).slice(0, SIGNER_CHARS)}`;
    }
    if (outcome.state === 'unverified' && message && this.proved === null) {
      signature.why = 'this session proved no identity to check who it was signed to';
    }
    return { signature, duplicate };
  }
}

export interface ArticleRead extends LineRead {
  /** The article as signed, for one that parsed: what to draw. */
  article: SignedArticle | null;
}

/** What a reply's parent is known to be, as its `parent` must name it. */
type ParentSeen = { signed: SignedParent['signed'] } | 'unknown';

/** Each category guid a server gave, by the node it gave it to, kept
 *  per server key across sessions: a server that gives a guid to
 *  another node later is caught as surely as one that gives it to two
 *  at once. */
export interface GuidMemory {
  /** That `server` gave `guid` to `node`; answers who holds it now, the
   *  node or, once two nodes were given it, `shared`. */
  note(server: Uint8Array, guid: string, node: number): Promise<number | 'shared'>;
  /** Everything noted for `server`, whose pin was replaced. */
  forget(server: Uint8Array): Promise<void>;
}

/** A `GuidMemory` that lasts as long as it is held. */
export function heldGuids(): GuidMemory {
  const held = new Map<string, number | 'shared'>();
  return {
    note: async (server, guid, node) => {
      const key = `${bytesToHex(server)}:${guid}`;
      const was = held.get(key);
      const now = was === undefined || was === node ? node : 'shared';
      held.set(key, now);
      return now;
    },
    forget: async (server) => {
      for (const k of [...held.keys()]) if (k.startsWith(`${bytesToHex(server)}:`)) held.delete(k);
    },
  };
}

/**
 * Reads articles against this host's pinned key, the guid of the
 * category they are listed in and the article they are threaded under
 * (§3.4, §4.10). A reply is read after its parent, as a thread lists
 * them, so the parent's signature is known when the reply names it; a
 * parent not read, deleted, or whose signature fails leaves the reply
 * unverified rather than verified on its own word.
 */
export class ArticleReader extends SignedMemory {
  /** Each category guid seen, by the node that gave it: a guid two
   *  nodes give is no scope at all. */
  private guids = new Map<string, number | 'shared'>();
  /** What has been noted in `memory`, in order. */
  private noted: Promise<unknown> = Promise.resolve();
  private parents = new Map<number, ParentSeen>();

  constructor(
    private pinned: PinnedKey | null,
    private memory: GuidMemory = heldGuids(),
  ) {
    super();
  }

  repin(pinned: PinnedKey | null): void {
    this.pinned = pinned;
  }

  /** Nodes as a listing gives them, nested ones included. */
  nodes(list: readonly NewsNode[]): void {
    for (const n of list) {
      if (n.guid !== undefined) {
        const guid = n.guid;
        const was = this.guids.get(guid);
        this.guids.set(guid, was === undefined || was === n.id ? n.id : 'shared');
        if (this.guids.size > IDS_KEPT) this.guids.delete(this.guids.keys().next().value!);
        const server = this.pinned?.key;
        if (server) {
          this.noted = this.noted
            .then(() => this.memory.note(server, guid, n.id))
            .then((held) => held === n.id || this.guids.set(guid, 'shared'))
            .catch(() => undefined);
        }
      }
      if (n.children) this.nodes(n.children);
    }
  }

  /** The guid an article in `category` is signed into, or why it has
   *  none: the server gave none, or gave it to another node as well, in
   *  this session or an earlier one under the same key. */
  async categoryKey(category: NewsNode): Promise<{ guid: Uint8Array } | { why: string }> {
    this.nodes([category]);
    await this.noted;
    const guid = keyOf(category.guid);
    if (category.guid === undefined || guid?.length !== 16) return { why: 'this server gave the category no guid' };
    if (this.guids.get(category.guid) !== category.id) return { why: 'this server gave its guid to more than one category' };
    return { guid };
  }

  read(a: NewsArticle, category: NewsNode): Promise<ArticleRead> {
    return this.serially(() => this.readOne(a, category));
  }

  private async readOne(a: NewsArticle, category: NewsNode): Promise<ArticleRead> {
    const fingerprint = a.from.fingerprint;
    if (a.signed === undefined) {
      // A deleted article has lost its signature with its body, so what
      // it was signed as is not known.
      this.remember(a.id, a.deleted ? 'unknown' : { signed: undefined });
      const shown = signatureDisplay(null, { seenSigning: fingerprint !== undefined && this.signing.has(fingerprint) });
      return { signature: shown.signatureExpected ? { ...shown, signer: null } : null, duplicate: false, article: null };
    }
    const inCategory = await this.categoryKey(category);
    const guid = 'guid' in inCategory ? inCategory.guid : null;
    const pinned = this.pinned;
    const parentSeen = a.parent === null ? null : (this.parents.get(a.parent) ?? 'unknown');
    const ctx = (parent: SignedParent | null): SignedContext<ArticleScope> => ({
      at: a.at,
      sender: fingerprint ? { named: fingerprint } : 'unknown',
      scope: {
        server: pinned?.key ?? new Uint8Array(32),
        category: guid ?? new Uint8Array(16),
        parent,
        ...(pinned ? { alias: aliasOf(pinned) } : {}),
      },
    });
    const shown = (parent: SignedParent | null) => readSignedArticle(a.signed!, a, ctx(parent));
    const parentOf = (seen: ParentSeen | null): SignedParent | null =>
      seen === null || seen === 'unknown' ? null : { article: a.parent!, ...(seen.signed ? { signed: seen.signed } : {}) };
    let used = parentOf(parentSeen);
    let { outcome, message } = await shown(used);
    let why: string | undefined;
    const claimed = message?.parent;
    if (parentSeen === 'unknown' && claimed && claimed.article === a.parent && outcome.state !== 'invalid') {
      // Nothing to hold the reply's own word for its parent to: read it
      // by that word, and never as verified.
      used = claimed;
      ({ outcome, message } = await shown(used));
      if (outcome.state === 'verified') {
        outcome = { state: 'unverified', signer: outcome.signer };
        why = 'the article it answers could not be checked';
      }
    }
    // Signed for another server is so whatever the category: only what
    // is signed for this one needs a guid to be held to.
    const otherServer = !!pinned && !!message && !sameKey(message.server, pinned.key) && !aliasOf(pinned)(message.server, message.sent);
    if ((!pinned || (!guid && !otherServer)) && (outcome.state === 'verified' || outcome.state === 'elsewhere')) {
      outcome = { state: 'unverified', signer: outcome.signer };
      why = !pinned ? "this server's key is not pinned" : 'why' in inCategory ? inCategory.why : undefined;
    }
    if (outcome.state === 'verified') this.signing.add(outcome.signer);
    const signature = signatureOf(outcome, message?.sent);
    if (why) signature.why = why;
    const by = signature.signer === null ? null : fingerprintFromString(signature.signer);
    this.remember(a.id, message && by && outcome.state !== 'invalid' ? { signed: { id: message.id, by } } : 'unknown');
    const key = memoryKey(signature.signer, message?.id);
    const content = message
      ? [bytesToHex(message.server), bytesToHex(message.category), message.parent?.article, message.mime, message.subject, message.body].join(' ')
      : '';
    const duplicate = key !== null && this.seen(key, a.id, content);
    if (outcome.state === 'elsewhere' && message) {
      const scope = ctx(used).scope;
      const where = [];
      if (otherServer) where.push(keyWords(message.server));
      if (guid && !sameKey(message.category, scope.category)) where.push('another category');
      const named = message.parent;
      if (named?.article !== (a.parent ?? undefined)) {
        where.push(named ? `a reply to article ${named.article}` : 'a thread of its own');
      } else if (named?.signed && !used?.signed) {
        where.push(`a reply to article ${named.article} as signed, which is shown here without a signature`);
      } else if (!named?.signed && used?.signed) {
        where.push(`a reply to article ${named!.article} before it was signed`);
      } else if (where.length === 0) {
        where.push(`a reply to another article than the one numbered ${a.parent} here`);
      }
      signature.signedFor = where.join(', ');
    }
    return { signature, duplicate, article: message };
  }

  /** What a reply to article `id` names as its parent: its signed id
   *  and signer when it is signed. `null` while that is not known, and a
   *  reply cannot then be signed. */
  replyParent(id: number): SignedParent | null {
    const seen = this.parents.get(id);
    if (seen === undefined || seen === 'unknown') return null;
    return { article: id, ...(seen.signed ? { signed: seen.signed } : {}) };
  }

  private remember(id: number, seen: ParentSeen): void {
    this.parents.set(id, seen);
    if (this.parents.size > IDS_KEPT) this.parents.delete(this.parents.keys().next().value!);
  }
}

const DEVICE_KEY = 'hxd-ng.signing-devices';

function devices(): Record<string, string> {
  try {
    return (JSON.parse(sessionStorage.getItem(DEVICE_KEY) ?? '{}') as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

/** Which device the session for `url` proved, kept with the tab as its
 *  session is, so a resume after a reload signs with that device and no
 *  other. `null` forgets it. */
export function rememberSigningDevice(url: string, devicePub: string | null): void {
  const all = devices();
  if (devicePub === null) delete all[url];
  else all[url] = devicePub;
  try {
    sessionStorage.setItem(DEVICE_KEY, JSON.stringify(all));
  } catch {
    /* storage disabled; a reload signs nothing */
  }
}

export function signingDeviceFor(url: string): string | null {
  return devices()[url] ?? null;
}
