/**
 * Signed messages, hxd-ng's `docs/e2e-messages.md` §3: a private
 * message, a line of public chat and a news article, each signed by the
 * sender device's key and bound to its scope; their detached form and its
 * link form (§5); the order a reader checks them in (§3.5); and the
 * states a client shows them in (§8). Transport-free: what goes in and
 * out is bytes and texts, and where they ride on the wire is the
 * caller's.
 *
 * Every form is checked by turning it back into the whole map, whose
 * signature is the one that verifies: a detached form gets its texts
 * back, and a link form its certificate first. Mirrors
 * `crates/hl-identity/src/message.rs` check for check and in its order,
 * so a reader here refuses what hxd-ng refuses, with the same error.
 */

import {
  CborError,
  cBool,
  cBytes,
  cMap,
  cOptMap,
  cText,
  cUint,
  decodeCanonical,
  encode,
  mapGet,
  mapWithout,
  type CborValue,
} from './cbor.js';
import {
  CAPS,
  DEVICE_CERT_DOMAIN,
  IdentityError,
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  decodeDeviceCert,
  fingerprintFromString,
  fingerprintToString,
  verifyEnvelope,
  type DeviceCert,
} from './identity.js';

export const MESSAGE_DOMAIN = 'hl-identity/message/v1';
export const CHAT_DOMAIN = 'hl-identity/chat/v1';
export const NEWS_DOMAIN = 'hl-identity/news/v1';

/** `S`, the skew allowance (§3.1). */
export const SIGNED_SKEW_SECONDS = 600;
/** A certificate a message carries crosses the network in full (§2). */
export const SIGNED_CERT_MAX_BYTES = 512;
/** The bound the classic wire's `DATA_MESSAGE_SIGNED` shares (§3.1). */
export const SIGNED_DETACHED_MAX_BYTES = 1020;
/** A link form leaves room for other extensions beside a 904 (§5). */
export const SIGNED_LINK_MAX_BYTES = 256;

const textEncoder = new TextEncoder();

function utf8Length(s: string): number {
  return textEncoder.encode(s).length;
}

/** Each CR LF pair, then each lone CR, as one LF (§3.1). Nothing else
 *  changes, Unicode normalization included: a verifier re-checks the
 *  bytes it was given. */
export function canonicalText(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

/** No C0 control but LF and TAB, so no CR: what a reader refuses in a
 *  signed text rather than canonicalize. */
export function isCanonicalText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x0a && c !== 0x09) return false;
  }
  return true;
}

// --- the objects ------------------------------------------------------------

/** What every signed object carries besides its scope and its texts.
 *  `sent` is Unix seconds; `cert` the sender's device certificate.
 *
 *  A fingerprint inside an object (`to`, a parent's `by`) is its 32
 *  bytes, as the map holds it; the wire's string form decodes with
 *  `fingerprintFromString`, and a context's strings are decoded here. A
 *  number parsed from past 2^53 is approximate, and never counts as
 *  equal to anything. */
interface SignedFields {
  id: Uint8Array;
  sent: number;
  cert: Uint8Array;
}

/** A private message (§3.2), bound to its recipient's identity
 *  fingerprint, `to`. `quote` travels in whole maps only. */
export interface SignedPrivateMessage extends SignedFields {
  to: Uint8Array;
  text: string;
  quote?: string;
  auto?: boolean;
}

/** A line of public chat (§3.3), bound to the server key and the room,
 *  0 for the lobby, it is said in. */
export interface SignedChatLine extends SignedFields {
  server: Uint8Array;
  room: number;
  text: string;
  act?: boolean;
}

/** The article a reply answers: its id on the server the reply names,
 *  and when it is signed its own `id` and its signer's fingerprint. */
export interface SignedParent {
  article: number;
  signed?: { id: Uint8Array; by: Uint8Array };
}

/** A news article (§3.4), bound to its server and its category's node
 *  guid. */
export interface SignedArticle extends SignedFields {
  server: Uint8Array;
  category: Uint8Array;
  parent?: SignedParent;
  subject: string;
  body: string;
  mime: 'text/plain' | 'text/markdown';
}

/** Whether a server key an object names is one the scope's server is
 *  known by too, as a followed handover keeps an old key
 *  (`server-key-handover.md` §5.5), at `sent`, when it was signed. */
export type ServerAlias = (serverKey: Uint8Array, sent: number) => boolean;

/** Where a public line is shown. `server` is `null` when the reader has
 *  no key for it (a ghost whose row has no `server_key`). */
export interface ChatScope {
  server: Uint8Array | null;
  room: number;
  alias?: ServerAlias;
}

/** Where an article is shown: its server, as `ChatScope`'s, the
 *  category it is listed in and the article it is threaded under. */
export interface ArticleScope {
  server: Uint8Array;
  category: Uint8Array;
  parent: SignedParent | null;
  alias?: ServerAlias;
}

/** A private message's scope: the fingerprint the reader's session
 *  proved, in its string form, or `null` for a session that proved
 *  none. */
export type MessageScope = string | null;

/** Who the server says sent a message (§8). `named` is the fingerprint
 *  it gives, a roster row's or an article's `from.fingerprint`;
 *  `certificate` when nothing names one (a history line, an inbox row,
 *  a ghost's line before user keys cross), so the certificate's is the
 *  name; `unknown` for a sender shown with no identity to check. */
export type SignedSender = { named: string } | 'certificate' | 'unknown';

export interface SignedContext<S> {
  /** When the reader's server received it (`at`), Unix seconds. */
  at: number;
  sender: SignedSender;
  scope: S;
}

/** What a reader was handed. Texts come in the object's order (`text`,
 *  or `subject` and `body`), as received: they are canonicalized here.
 *  A link form's `cert` is the certificate fetched for it, if one was. */
export type SignedForm<X> =
  | { form: 'whole'; bytes: Uint8Array }
  | { form: 'detached'; bytes: Uint8Array; texts: X }
  | { form: 'link'; bytes: Uint8Array; texts: X; cert?: Uint8Array };

/** §8's states for a signed message. `signer` is the fingerprint of the
 *  certificate's identity key, never what a server says; `null` for a
 *  link form whose certificate was not fetched, or was and does not
 *  match. `sentApart` says `sent` is more than S from `at`, so it is
 *  shown as sent at its signed time. */
export type SignedOutcome =
  | { state: 'verified'; signer: string; sentApart: boolean }
  | { state: 'elsewhere'; signer: string; sentApart: boolean }
  | { state: 'unverified'; signer: string | null }
  | { state: 'invalid'; error: Error };

/** An object that passed §3.5's three steps: its map, its certificate
 *  and its signature. Holds the whole map, unknown keys included, so
 *  every form made from it is covered by the same `sig`. */
export interface Signed<T, S> {
  readonly message: T;
  readonly cert: DeviceCert;
  /** SHA-256 of the certificate's identity key. */
  readonly signer: Uint8Array;
  whole(): Uint8Array;
  /** The map without its texts, refused where the form's limits are
   *  tighter than a whole map's (a private message's). */
  detached(): Uint8Array;
  /** The detached form with `cert` replaced by its SHA-256 (§5). */
  link(): Promise<Uint8Array>;
  /** SHA-256 of the map without `sent`, `cert` and `sig`: equal for a
   *  message signed again, different for another (§3.6). */
  contentSha256(): Promise<Uint8Array>;
  /** The sender and the scope (§3.5, §8). */
  check(ctx: SignedContext<S>): SignedOutcome;
}

/** One of the three objects: how it is signed and read. */
export interface SignedKind<T, S, X> {
  readonly domain: string;
  /** Sign with the device's non-extractable key, refusing what a
   *  reader would: a field out of bounds, a certificate that does not
   *  allow messages or is not valid at `sent`, or a key other than the
   *  one the certificate names. Returns the whole map. */
  sign(deviceSignKey: CryptoKey, message: T): Promise<Uint8Array>;
  /** A whole map, received by the reader's server at `at`. */
  parse(whole: Uint8Array, at: number): Promise<Signed<T, S>>;
  parseDetached(bytes: Uint8Array, texts: X, at: number): Promise<Signed<T, S>>;
  /** A link form with the certificate fetched for it, which must hash
   *  to its `cert_sha256` before anything else is looked at: one that
   *  does not is `cert-mismatch`, which a reader treats as one it could
   *  not fetch (§5). */
  parseLink(bytes: Uint8Array, texts: X, cert: Uint8Array, at: number): Promise<Signed<T, S>>;
  /** `contentSha256` of a link form and its texts, from before its
   *  certificate is held. */
  linkContentSha256(bytes: Uint8Array, texts: X): Promise<Uint8Array>;
  /** §3.5 in order, then the sender and the scope: the state a reader
   *  shows the message in. */
  read(form: SignedForm<X>, ctx: SignedContext<S>): Promise<SignedOutcome>;
}

type Place = 'here' | 'elsewhere' | 'unknown';

interface Spec<T extends SignedFields, S> {
  domain: string;
  textKeys: readonly string[];
  /** Bounds a whole map before it is decoded. */
  wholeMax: number;
  unsigned(m: T): CborValue;
  fromValue(v: CborValue, detached: boolean): T;
  place(m: T, scope: S): Place;
}

// --- field rules ------------------------------------------------------------

const bad = (key: string) => new IdentityError('bad-field', key);

function optField(v: CborValue, key: string, t: CborValue['t']): CborValue | undefined {
  const f = mapGet(v, key);
  if (f !== undefined && f.t !== t) throw bad(key);
  return f;
}

function field(v: CborValue, key: string, t: CborValue['t']): CborValue {
  const f = optField(v, key, t);
  if (f === undefined) throw new IdentityError('missing-field', key);
  return f;
}

const big = (v: CborValue, key: string) => field(v, key, 'uint').v as bigint;

/** Approximate past 2^53, where hl-identity takes any u64: what is
 *  compared or ordered is read with `big`, or held to a safe integer. */
const uint = (v: CborValue, key: string) => Number(big(v, key));

/** Two ids the same, neither one past 2^53, where a number is not
 *  exact. */
const sameId = (a: number, b: number) => a === b && Number.isSafeInteger(a);

function optBytes(v: CborValue, key: string, len?: number): Uint8Array | undefined {
  const b = optField(v, key, 'bytes')?.v as Uint8Array | undefined;
  if (b !== undefined && len !== undefined && b.length !== len) throw bad(key);
  return b;
}

function bytes(v: CborValue, key: string, len?: number): Uint8Array {
  const b = optBytes(v, key, len);
  if (b === undefined) throw new IdentityError('missing-field', key);
  return b;
}

const text = (v: CborValue, key: string) => field(v, key, 'text').v as string;
const optText = (v: CborValue, key: string) => optField(v, key, 'text')?.v as string | undefined;

/** A flag present only when true. */
function onlyTrue(v: CborValue, key: string): boolean {
  const f = optField(v, key, 'bool');
  if (f?.v === false) throw bad(key);
  return f !== undefined;
}

/** A key whose presence would let one object pass for another (§3.1). */
function refuse(v: CborValue, key: string): void {
  if (mapGet(v, key) !== undefined) throw bad(key);
}

/** A nested map holding no keys but `allowed`. */
function exact(v: CborValue, key: string, allowed: readonly string[]): CborValue {
  const f = field(v, key, 'map');
  if (f.t !== 'map' || !f.v.every(([k]) => k.t === 'text' && allowed.includes(k.v))) throw bad(key);
  return f;
}

/** A field of a nested map, any fault in it the nested map's own. */
function inside<R>(key: string, read: () => R): R {
  try {
    return read();
  } catch {
    throw bad(key);
  }
}

/** Canonical and within `min..=max` bytes. */
function checkText(s: string, key: string, min: number, max: number): void {
  const n = utf8Length(s);
  if (!isCanonicalText(s) || n < min || n > max) throw bad(key);
}

/** The fields all three share, and the key only a link form carries. */
function common(v: CborValue): SignedFields {
  refuse(v, 'cert_sha256');
  return { id: bytes(v, 'id', 16), sent: uint(v, 'sent'), cert: bytes(v, 'cert') };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameParent(a: SignedParent | null | undefined, b: SignedParent | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (!sameId(a.article, b.article)) return false;
  if (!a.signed || !b.signed) return !a.signed && !b.signed;
  return sameBytes(a.signed.id, b.signed.id) && sameBytes(a.signed.by, b.signed.by);
}

function sameServer(named: Uint8Array, server: Uint8Array, alias: ServerAlias | undefined, sent: number): boolean {
  return sameBytes(named, server) || (alias?.(named, sent) ?? false);
}

// --- the three specs --------------------------------------------------------

/** A text key of `keyLen` bytes and a text of `max`, encoded. */
function textEntry(keyLen: number, max: number): number {
  const head = (n: number) => (n < 24 ? 1 : n <= 0xff ? 2 : n <= 0xffff ? 3 : 5);
  return head(keyLen) + keyLen + head(max) + max;
}

const privateMessageSpec: Spec<SignedPrivateMessage, MessageScope> = {
  domain: MESSAGE_DOMAIN,
  textKeys: ['text'],
  // The largest plaintext a sealed message is padded to (§3.7).
  wholeMax: 17_103,
  unsigned: (m) =>
    cOptMap([
      ['v', cUint(1)],
      ['id', cBytes(m.id)],
      ['sent', cUint(m.sent)],
      ['to', cBytes(m.to)],
      ['cert', cBytes(m.cert)],
      ['text', cText(canonicalText(m.text))],
      ['quote', m.quote === undefined ? undefined : cText(canonicalText(m.quote))],
      ['auto', m.auto ? cBool(true) : undefined],
    ]),
  fromValue(v, detached) {
    refuse(v, 'in');
    const fields = common(v);
    const quote = optText(v, 'quote');
    if (quote !== undefined) {
      if (detached) throw bad('quote');
      checkText(quote, 'quote', 1, 8192);
    }
    const t = text(v, 'text');
    checkText(t, 'text', 1, detached ? 4096 : 8192);
    const m: SignedPrivateMessage = { ...fields, to: bytes(v, 'to', 32), text: t, auto: onlyTrue(v, 'auto') };
    if (quote !== undefined) m.quote = quote;
    return m;
  },
  place(m, reader) {
    if (reader === null) return 'unknown';
    const fp = fingerprintFromString(reader);
    return fp && sameBytes(fp, m.to) ? 'here' : 'elsewhere';
  },
};

const chatLineSpec: Spec<SignedChatLine, ChatScope> = {
  domain: CHAT_DOMAIN,
  textKeys: ['text'],
  // Its detached form's bound, its text at its longest and the byte a
  // longer map head can take.
  wholeMax: SIGNED_DETACHED_MAX_BYTES + textEntry(4, 4096) + 1,
  unsigned: (m) =>
    cOptMap([
      ['v', cUint(1)],
      ['id', cBytes(m.id)],
      ['sent', cUint(m.sent)],
      [
        'in',
        cMap([
          ['server', cBytes(m.server)],
          ['room', cUint(m.room)],
        ]),
      ],
      ['cert', cBytes(m.cert)],
      ['text', cText(canonicalText(m.text))],
      ['act', m.act ? cBool(true) : undefined],
    ]),
  fromValue(v) {
    refuse(v, 'to');
    const fields = common(v);
    const scope = exact(v, 'in', ['server', 'room']);
    const t = text(v, 'text');
    checkText(t, 'text', 1, 4096);
    return {
      ...fields,
      server: inside('in', () => bytes(scope, 'server', 32)),
      room: inside('in', () => uint(scope, 'room')),
      text: t,
      act: onlyTrue(v, 'act'),
    };
  },
  place(m, scope) {
    if (scope.server === null) return 'unknown';
    return sameServer(m.server, scope.server, scope.alias, m.sent) && sameId(m.room, scope.room) ? 'here' : 'elsewhere';
  },
};

const articleSpec: Spec<SignedArticle, ArticleScope> = {
  domain: NEWS_DOMAIN,
  textKeys: ['subject', 'body'],
  // As a line's, with both its texts.
  wholeMax: SIGNED_DETACHED_MAX_BYTES + textEntry(7, 255) + textEntry(4, 65_535) + 1,
  unsigned: (m) =>
    cOptMap([
      ['v', cUint(1)],
      ['id', cBytes(m.id)],
      ['sent', cUint(m.sent)],
      [
        'in',
        cMap([
          ['server', cBytes(m.server)],
          ['category', cBytes(m.category)],
        ]),
      ],
      [
        'parent',
        m.parent &&
          cOptMap([
            ['article', cUint(m.parent.article)],
            ['id', m.parent.signed && cBytes(m.parent.signed.id)],
            ['by', m.parent.signed && cBytes(m.parent.signed.by)],
          ]),
      ],
      ['cert', cBytes(m.cert)],
      ['subject', cText(canonicalText(m.subject))],
      ['body', cText(canonicalText(m.body))],
      ['mime', cText(m.mime)],
    ]),
  fromValue(v) {
    refuse(v, 'to');
    const fields = common(v);
    const scope = exact(v, 'in', ['server', 'category']);
    let parent: SignedParent | undefined;
    if (mapGet(v, 'parent') !== undefined) {
      const p = exact(v, 'parent', ['article', 'id', 'by']);
      const id = inside('parent', () => optBytes(p, 'id', 16));
      const by = inside('parent', () => optBytes(p, 'by', 32));
      if ((id === undefined) !== (by === undefined)) throw bad('parent');
      parent = { article: inside('parent', () => uint(p, 'article')) };
      if (id && by) parent.signed = { id, by };
    }
    const subject = text(v, 'subject');
    checkText(subject, 'subject', 1, 255);
    if (subject.includes('\n')) throw bad('subject');
    const body = text(v, 'body');
    checkText(body, 'body', 0, 65_535);
    const mime = text(v, 'mime');
    if (mime !== 'text/plain' && mime !== 'text/markdown') throw bad('mime');
    const article: SignedArticle = {
      ...fields,
      server: inside('in', () => bytes(scope, 'server', 32)),
      category: inside('in', () => bytes(scope, 'category', 16)),
      subject,
      body,
      mime,
    };
    if (parent) article.parent = parent;
    return article;
  },
  place(m, scope) {
    const here =
      sameServer(m.server, scope.server, scope.alias, m.sent) &&
      sameBytes(m.category, scope.category) &&
      sameParent(m.parent, scope.parent);
    return here ? 'here' : 'elsewhere';
  },
};

// --- checking ---------------------------------------------------------------

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
}

function withEntry(v: CborValue, key: string, value: CborValue): CborValue {
  if (v.t !== 'map') throw new IdentityError('not-a-map', 'not a CBOR map');
  return { t: 'map', v: [...v.v, [cText(key), value]] };
}

const SKEW = BigInt(SIGNED_SKEW_SECONDS);

/** Seconds as the exact integer a window is checked at. */
const seconds = (t: number) => BigInt(Math.floor(t));

/** `verifyEnvelope`, with a key WebCrypto refuses to import, one that
 *  is not a point, refused as hl-identity refuses it. */
async function verifySignature(signed: Uint8Array, key: Uint8Array, domain: string): Promise<void> {
  try {
    await verifyEnvelope(signed, key, domain);
  } catch (e) {
    if (e instanceof Error && e.name === 'DataError') throw new IdentityError('invalid-key', domain);
    throw e;
  }
}

/** §3.5 step 2: a certificate its identity signed, at most
 *  `SIGNED_CERT_MAX_BYTES`, that allows messages and is valid at `sent`
 *  and at `at`. Its times and caps are read from its map, exactly. */
async function checkCert(raw: Uint8Array, sent: bigint, at: bigint): Promise<DeviceCert> {
  if (raw.length > SIGNED_CERT_MAX_BYTES) throw bad('cert');
  const cert = decodeDeviceCert(raw);
  await verifySignature(raw, cert.identity, DEVICE_CERT_DOMAIN);
  const value = decodeCanonical(raw);
  const caps = mapGet(value, 'caps') === undefined ? undefined : big(value, 'caps');
  const message = BigInt(CAPS.MESSAGE);
  if (caps !== undefined && (caps & message) !== message) throw new IdentityError('capability-missing', 'message');
  const [issued, expires] = [big(value, 'issued'), big(value, 'expires')];
  for (const t of [sent, at]) {
    if (expires <= issued || issued > t + SKEW) throw new IdentityError('not-yet-valid', 'device certificate');
    if (expires + SKEW < t) throw new IdentityError('expired', 'device certificate');
  }
  return cert;
}

/** The shape every signed object shares, checked before its fields as
 *  `signed::Envelope` checks it. */
function checkEnvelope(v: CborValue): void {
  if (v.t !== 'map') throw new IdentityError('not-a-map', 'not a CBOR map');
  const version = big(v, 'v');
  if (version !== 1n) throw new IdentityError('unsupported-version', String(version));
  bytes(v, 'sig', 64);
}

/** A link form's map and the hash it names its certificate by. */
function linkValue(raw: Uint8Array): { value: CborValue; hash: Uint8Array } {
  if (raw.length > SIGNED_LINK_MAX_BYTES) throw new IdentityError('too-large', 'link form');
  const value = decodeCanonical(raw);
  if (value.t !== 'map') throw new IdentityError('not-a-map', 'not a CBOR map');
  if (mapGet(value, 'cert') !== undefined) throw bad('cert');
  return { value, hash: bytes(value, 'cert_sha256', 32) };
}

function withTexts(value: CborValue, keys: readonly string[], texts: readonly string[]): CborValue {
  return keys.reduce((v, key, i) => withEntry(v, key, cText(canonicalText(texts[i]!))), value);
}

class SignedImpl<T extends SignedFields, S> implements Signed<T, S> {
  constructor(
    private readonly spec: Spec<T, S>,
    readonly message: T,
    readonly cert: DeviceCert,
    readonly signer: Uint8Array,
    private readonly value: CborValue,
  ) {}

  whole(): Uint8Array {
    return encode(this.value);
  }

  detached(): Uint8Array {
    this.spec.fromValue(this.value, true);
    const out = encode(this.detachedValue());
    if (out.length > SIGNED_DETACHED_MAX_BYTES) throw new IdentityError('too-large', 'detached form');
    return out;
  }

  async link(): Promise<Uint8Array> {
    this.detached();
    const hash = await sha256(this.message.cert);
    const out = encode(withEntry(mapWithout(this.detachedValue(), 'cert'), 'cert_sha256', cBytes(hash)));
    if (out.length > SIGNED_LINK_MAX_BYTES) throw new IdentityError('too-large', 'link form');
    return out;
  }

  contentSha256(): Promise<Uint8Array> {
    return sha256(encode(['sent', 'cert', 'sig'].reduce(mapWithout, this.value)));
  }

  /** A signer other than the one the server names outweighs the scope;
   *  a scope shown to differ outweighs having nothing to check the rest
   *  against. */
  check(ctx: SignedContext<S>): SignedOutcome {
    if (typeof ctx.sender === 'object') {
      const named = fingerprintFromString(ctx.sender.named);
      if (!named || !sameBytes(named, this.signer)) {
        return { state: 'invalid', error: new IdentityError('key-mismatch', 'the server names another signer') };
      }
    }
    const signer = fingerprintToString(this.signer);
    const apart = big(this.value, 'sent') - seconds(ctx.at);
    const sentApart = apart > SKEW || -apart > SKEW;
    const place = this.spec.place(this.message, ctx.scope);
    if (place === 'elsewhere') return { state: 'elsewhere', signer, sentApart };
    if (place === 'unknown' || ctx.sender === 'unknown') return { state: 'unverified', signer };
    return { state: 'verified', signer, sentApart };
  }

  private detachedValue(): CborValue {
    return this.spec.textKeys.reduce(mapWithout, this.value);
  }
}

class Kind<T extends SignedFields, S, X extends readonly string[]> implements SignedKind<T, S, X> {
  constructor(private readonly spec: Spec<T, S>) {}

  get domain(): string {
    return this.spec.domain;
  }

  async sign(deviceSignKey: CryptoKey, message: T): Promise<Uint8Array> {
    const unsigned = this.spec.unsigned(message);
    this.spec.fromValue(unsigned, false);
    const cert = await checkCert(message.cert, seconds(message.sent), seconds(message.sent));
    const signedBytes = encode(unsigned);
    const input = new Uint8Array([...textEncoder.encode(this.spec.domain), 0, ...signedBytes]);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, deviceSignKey, input));
    const whole = encode(withEntry(unsigned, 'sig', cBytes(sig)));
    // A CryptoKey that cannot be exported cannot be compared with the
    // certificate's key, so the signature is checked against it instead.
    try {
      await verifySignature(whole, cert.device, this.spec.domain);
    } catch (e) {
      if (e instanceof IdentityError && e.kind === 'bad-signature') {
        throw new IdentityError('key-mismatch', 'the certificate names another device key');
      }
      throw e;
    }
    return whole;
  }

  async parse(whole: Uint8Array, at: number): Promise<Signed<T, S>> {
    if (whole.length > this.spec.wholeMax) throw new IdentityError('too-large', 'signed message');
    return this.verify(decodeCanonical(whole), false, at);
  }

  async parseDetached(raw: Uint8Array, texts: X, at: number): Promise<Signed<T, S>> {
    if (raw.length > SIGNED_DETACHED_MAX_BYTES) throw new IdentityError('too-large', 'detached form');
    return this.reassemble(decodeCanonical(raw), texts, at);
  }

  async parseLink(raw: Uint8Array, texts: X, cert: Uint8Array, at: number): Promise<Signed<T, S>> {
    const { value, hash } = linkValue(raw);
    if (!sameBytes(await sha256(cert), hash)) throw new IdentityError('cert-mismatch', 'cert_sha256');
    return this.reassemble(withEntry(mapWithout(value, 'cert_sha256'), 'cert', cBytes(cert)), texts, at);
  }

  async linkContentSha256(raw: Uint8Array, texts: X): Promise<Uint8Array> {
    const content = ['cert_sha256', 'sent', 'sig'].reduce(mapWithout, linkValue(raw).value);
    return sha256(encode(withTexts(content, this.spec.textKeys, texts)));
  }

  async read(form: SignedForm<X>, ctx: SignedContext<S>): Promise<SignedOutcome> {
    let signed: Signed<T, S>;
    try {
      if (form.form === 'whole') {
        signed = await this.parse(form.bytes, ctx.at);
      } else if (form.form === 'detached') {
        signed = await this.parseDetached(form.bytes, form.texts, ctx.at);
      } else if (form.cert === undefined) {
        linkValue(form.bytes);
        return { state: 'unverified', signer: null };
      } else {
        signed = await this.parseLink(form.bytes, form.texts, form.cert, ctx.at);
      }
    } catch (error) {
      if (!(error instanceof IdentityError) && !(error instanceof CborError)) throw error;
      if (error instanceof IdentityError && error.kind === 'cert-mismatch') return { state: 'unverified', signer: null };
      return { state: 'invalid', error };
    }
    return signed.check(ctx);
  }

  private async reassemble(value: CborValue, texts: X, at: number): Promise<Signed<T, S>> {
    if (value.t !== 'map') throw new IdentityError('not-a-map', 'not a CBOR map');
    for (const key of this.spec.textKeys) refuse(value, key);
    return this.verify(withTexts(value, this.spec.textKeys, texts), true, at);
  }

  private async verify(value: CborValue, detached: boolean, at: number): Promise<Signed<T, S>> {
    checkEnvelope(value);
    const message = this.spec.fromValue(value, detached);
    const cert = await checkCert(message.cert, big(value, 'sent'), seconds(at));
    await verifySignature(encode(value), cert.device, this.spec.domain);
    return new SignedImpl(this.spec, message, cert, await sha256(cert.identity), value);
  }
}

export const signedPrivateMessages: SignedKind<SignedPrivateMessage, MessageScope, readonly [text: string]> = new Kind(
  privateMessageSpec,
);
export const signedChatLines: SignedKind<SignedChatLine, ChatScope, readonly [text: string]> = new Kind(chatLineSpec);
export const signedArticles: SignedKind<SignedArticle, ArticleScope, readonly [subject: string, body: string]> = new Kind(
  articleSpec,
);

// --- on the wire (§4.7) -----------------------------------------------------

/** A line ready to send: `chat`'s `text`, canonical, and the `guid` and
 *  `signed` that go beside it. */
export interface SignedChatRequest {
  text: string;
  guid: string;
  signed: string;
}

/** Sign a line for `chat`. Its random `id` is the request's `guid`,
 *  hyphenated as the server echoes it, so a retry sends this request
 *  again, unchanged. */
export async function signChatRequest(
  deviceSignKey: CryptoKey,
  line: Omit<SignedChatLine, 'id' | 'sent'>,
  sent = Math.floor(Date.now() / 1000),
): Promise<SignedChatRequest> {
  const id = crypto.getRandomValues(new Uint8Array(16));
  const text = canonicalText(line.text);
  const whole = await signedChatLines.sign(deviceSignKey, { ...line, id, sent, text });
  const detached = (await signedChatLines.parse(whole, sent)).detached();
  const hex = bytesToHex(id);
  const guid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { text, guid, signed: bytesToBase64url(detached) };
}

/** What a reader makes of a line's `signed`: its state, and for one
 *  that parsed, the line as signed, whose `id`, `sent` and `act` are
 *  the signer's word rather than the server's. */
export interface SignedChatRead {
  outcome: SignedOutcome;
  line: SignedChatLine | null;
  /** A link form's id and the hash it names its certificate by, which
   *  tell it apart before the certificate is held. */
  link?: { id: Uint8Array; certSha256: Uint8Array };
}

/** Read a `chat` event's or a history line's `signed` beside its text
 *  and whether it came as an action, which its `act` must say (§4.7):
 *  its detached form, or its link form, which names `cert_sha256` in
 *  place of `cert` and is unverified until its certificate is held. A
 *  check this runtime cannot make is unverified, never thrown. */
export async function readSignedChat(
  signed: string,
  text: string,
  act: boolean,
  ctx: SignedContext<ChatScope>,
): Promise<SignedChatRead> {
  const invalid = (error: Error): SignedChatRead => ({ outcome: { state: 'invalid', error }, line: null });
  let bytes: Uint8Array;
  let value: CborValue | undefined;
  try {
    bytes = base64urlToBytes(signed);
  } catch (error) {
    return invalid(error as Error);
  }
  try {
    value = decodeCanonical(bytes);
  } catch {
    // Refused below, as a detached form.
  }
  try {
    const hash = value && mapGet(value, 'cert_sha256');
    if (value && hash) {
      const outcome = await signedChatLines.read({ form: 'link', bytes, texts: [text] }, ctx);
      const id = mapGet(value, 'id');
      if (outcome.state === 'invalid' || hash.t !== 'bytes' || id?.t !== 'bytes') return { outcome, line: null };
      if ((mapGet(value, 'act')?.v === true) !== act) return invalid(new IdentityError('bad-field', 'act'));
      return { outcome, line: null, link: { id: id.v, certSha256: hash.v } };
    }
    const parsed = await signedChatLines.parseDetached(bytes, [text], ctx.at);
    if (parsed.message.act !== act) return invalid(new IdentityError('bad-field', 'act'));
    return { outcome: parsed.check(ctx), line: parsed.message };
  } catch (error) {
    if (error instanceof IdentityError || error instanceof CborError) return invalid(error);
    return { outcome: { state: 'unverified', signer: null }, line: null };
  }
}

// --- §8 ---------------------------------------------------------------------

/** §8's states a line, a message or an article is shown in, but the two
 *  only a sealed box has (deniable, unopened). */
export type SignatureState = SignedOutcome['state'] | 'unsigned';

/** Why a signature was expected on a line that came without one. */
export interface SignatureExpectation {
  /** The client has seen the sender's fingerprint sign in this scope. */
  seenSigning?: boolean;
  /** The sender's roster row says `signs` (§4.6). */
  rowSigns?: boolean;
  /** The room requires signing (§4.8). */
  roomRequiresSigning?: boolean;
}

/** A state and the marks §8 puts on top of it: sent at another time,
 *  on a valid one whose `sent` is more than S from `at`; and signature
 *  expected, on an unsigned one, a warning that a signature may have
 *  been removed. */
export interface SignatureDisplay {
  state: SignatureState;
  sentAtAnotherTime: boolean;
  signatureExpected: boolean;
}

/** What to show for a read, or for `null`, a line that came unsigned. */
export function signatureDisplay(outcome: SignedOutcome | null, expected: SignatureExpectation = {}): SignatureDisplay {
  if (outcome === null) {
    const signatureExpected = !!(expected.seenSigning || expected.rowSigns || expected.roomRequiresSigning);
    return { state: 'unsigned', sentAtAnotherTime: false, signatureExpected };
  }
  const sentAtAnotherTime = (outcome.state === 'verified' || outcome.state === 'elsewhere') && outcome.sentApart;
  return { state: outcome.state, sentAtAnotherTime, signatureExpected: false };
}
