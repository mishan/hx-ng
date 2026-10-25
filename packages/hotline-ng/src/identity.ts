/**
 * Wire-level identity: the signed objects, the fingerprint, and the HTTP
 * calls that put them on the wire. Two documents in the hxd-ng repo
 * (sibling checkout, not part of this one) split what used to be one:
 * hxd-ng's `docs/hotline-ng-identity.md` §3 defines the signed objects
 * and §5 the identity-specific parts of authentication (the `create`
 * flag, the `outcome`/`account` response fields, linking); hxd-ng's
 * `docs/hotline-ng-auth.md` §5–§7 defines the transport underneath —
 * discovery, the challenge and mTLS bindings, and opening the
 * WebSocket with a token. Lives in this dependency-free package rather
 * than the app, on the same reasoning as `connection.ts` — a second
 * client (a bot, a bridge) gets identity without reimplementing it.
 *
 * What this module does *not* do: hold a device's private keys (that's
 * `src/identity/storage.ts`, because `IndexedDB` and non-extractable
 * `CryptoKey`s are a browser concern, not a wire concern), or build a
 * device certificate or user card — a Phase B client (this repo's own
 * `docs/identity-keys.md`) never signs either; it only decodes ones
 * `hlid` produced, and signs the one thing a device key is for, the
 * login proof.
 *
 * Field names, domains and size limits are checked against hxd-ng's
 * `crates/hl-identity/src/{cert,card,keys,proof}.rs`, not just against
 * the docs' prose.
 */

import { cBytes, cMap, cOptMap, cText, cUint, decodeCanonical, encode, mapGet, mapWithout, type CborValue } from './cbor.js';
import { hasDeceptiveChar } from './names.js';

const textEncoder = new TextEncoder();

export type IdentityErrorKind =
  | 'missing-field'
  | 'bad-field'
  | 'not-a-map'
  | 'unsupported-version'
  | 'bad-signature'
  | 'invalid-key'
  | 'too-large'
  | 'server-error';

export class IdentityError extends Error {
  constructor(
    readonly kind: IdentityErrorKind,
    detail: string,
  ) {
    super(`${kind}: ${detail}`);
    this.name = 'IdentityError';
  }
}

/** A refusal reported by `/identity/auth` itself — `{ error, text }`,
 *  with the HTTP status — or this client's own: of a challenge the
 *  server did not vouch for (`SERVER_CHALLENGE_REFUSED`), or of an
 *  `auth` endpoint on another host than the challenge's (`WRONG_HOST`,
 *  with no status). As opposed to an `IdentityError`, which is this
 *  client finding something wrong with an object it was handed. A
 *  `421`, `wrong_host` or a refused challenge means this is not the
 *  server the proof would be for, and proving it again will not change
 *  that. */
export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// --- bytes, hex, base64url ----------------------------------------------

export function bytesToHex(b: Uint8Array): string {
  return [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new IdentityError('bad-field', 'odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new IdentityError('bad-field', 'not hex');
    out[i] = byte;
  }
  return out;
}

/** WebCrypto's DOM typings want a `Uint8Array<ArrayBuffer>` specifically
 *  — a `Uint8Array` could in principle wrap a `SharedArrayBuffer`, which
 *  none of this module's ever do. A type-level cast, not a copy. */
function bufferSource(b: Uint8Array): BufferSource {
  return b as BufferSource;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Hand-rolled rather than built on `atob`/`btoa`: this module's own
// header says a bot or a bridge — not just a browser — can consume it,
// and `atob`/`btoa` are DOM legacy globals, not part of any JS or
// server-runtime standard; not every non-browser environment has them.
// A lookup table costs less than feature-detecting and falling back.
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64Value(ch: string): number | undefined {
  const i = BASE64URL.indexOf(ch);
  if (i !== -1) return i;
  // Accept standard base64's two different characters too — a paste
  // (`parseEnrollmentPaste`) is more likely to have come from a tool
  // that used them than to have collided with them by chance.
  if (ch === '+') return 62;
  if (ch === '/') return 63;
  return undefined;
}

export function base64urlToBytes(s: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of s.trim()) {
    if (ch === '=') break; // padding, standard or not; nothing after it matters
    const value = base64Value(ch);
    if (value === undefined) throw new IdentityError('bad-field', `not base64url: ${JSON.stringify(ch)}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function bytesToBase64url(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const b0 = b[i]!;
    const b1 = b[i + 1];
    const b2 = b[i + 2];
    out += BASE64URL[b0 >> 2];
    out += BASE64URL[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 !== undefined) out += BASE64URL[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 !== undefined) out += BASE64URL[b2 & 0x3f];
  }
  return out;
}

// --- fingerprint ----------------------------------------------------------

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** `SHA-256(public key)`, lowercase Crockford base32, 52 characters —
 *  the display form `keys.rs`'s `Fingerprint` produces. Bit-packing is
 *  MSB-first, 5 bits per digit, the last digit padded with zero bits;
 *  `acc` is masked back down to its pending bits after every extraction
 *  so it never needs more than 15 bits, which is what lets this use
 *  ordinary (32-bit-safe) bitwise operators instead of `bigint`. */
export function fingerprintToString(digest: Uint8Array): string {
  let acc = 0;
  let nbits = 0;
  let out = '';
  for (const b of digest) {
    acc = (acc << 8) | b;
    nbits += 8;
    while (nbits >= 5) {
      nbits -= 5;
      out += CROCKFORD[(acc >> nbits) & 31];
    }
    acc &= (1 << nbits) - 1;
  }
  if (nbits > 0) out += CROCKFORD[(acc << (5 - nbits)) & 31];
  return out;
}

export async function fingerprintOf(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bufferSource(publicKey)));
  return fingerprintToString(digest);
}

// --- envelope: v + sig, the shape every signed object shares --------------

const VERSION = 1n;

function bigintToSafeNumber(n: bigint, field: string): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new IdentityError('bad-field', field);
  return Number(n);
}

function reqUint(v: CborValue, key: string): number {
  const f = mapGet(v, key);
  if (f === undefined) throw new IdentityError('missing-field', key);
  if (f.t !== 'uint') throw new IdentityError('bad-field', key);
  return bigintToSafeNumber(f.v, key);
}

function optUint(v: CborValue, key: string): number | undefined {
  const f = mapGet(v, key);
  if (f === undefined) return undefined;
  if (f.t !== 'uint') throw new IdentityError('bad-field', key);
  return bigintToSafeNumber(f.v, key);
}

function reqBytesN(v: CborValue, key: string, n: number): Uint8Array {
  const f = mapGet(v, key);
  if (f === undefined) throw new IdentityError('missing-field', key);
  if (f.t !== 'bytes' || f.v.length !== n) throw new IdentityError('bad-field', key);
  return f.v;
}

function reqBytes(v: CborValue, key: string): Uint8Array {
  const f = mapGet(v, key);
  if (f === undefined) throw new IdentityError('missing-field', key);
  if (f.t !== 'bytes') throw new IdentityError('bad-field', key);
  return f.v;
}

function reqText(v: CborValue, key: string): string {
  const f = mapGet(v, key);
  if (f === undefined) throw new IdentityError('missing-field', key);
  if (f.t !== 'text') throw new IdentityError('bad-field', key);
  return f.v;
}

function optText(v: CborValue, key: string): string | undefined {
  const f = mapGet(v, key);
  if (f === undefined) return undefined;
  if (f.t !== 'text') throw new IdentityError('bad-field', key);
  return f.v;
}

/** A display name refused for the same reasons a card's or a
 *  certificate's is: too long, wrapped in space, nothing but space, or
 *  carrying a character that renders as something other than itself. */
function invalidDisplayName(name: string, maxChars: number): boolean {
  const chars = [...name].length;
  return chars > maxChars || name.trim() !== name || name.trim() === '' || hasDeceptiveChar(name);
}

interface Envelope {
  value: CborValue;
  signedBytes: Uint8Array;
  sig: Uint8Array;
}

/** Decode-then-split: canonical CBOR, a map, `v === 1`, a 64-byte `sig`.
 *  Mirrors `signed::Envelope::open` — checks shape only, not the
 *  signature, which the caller verifies against whichever key applies. */
function openEnvelope(bytes: Uint8Array): Envelope {
  const value = decodeCanonical(bytes);
  if (value.t !== 'map') throw new IdentityError('not-a-map', 'not a CBOR map');
  const v = mapGet(value, 'v');
  if (v === undefined) throw new IdentityError('missing-field', 'v');
  if (v.t !== 'uint') throw new IdentityError('bad-field', 'v');
  // `!==`, not `>`: a `v` this reader has never defined is rejected
  // outright rather than read as if it meant something known.
  if (v.v !== VERSION) throw new IdentityError('unsupported-version', String(v.v));
  const sig = reqBytesN(value, 'sig', 64);
  return { value, signedBytes: encode(mapWithout(value, 'sig')), sig };
}

const ED25519_P = 2n ** 255n - 19n;
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

/** The y coordinates of the points of small order, below p, either
 *  sign: the order-4 pair, the neutral element, the order-2 point and
 *  the order-8 points. */
const SMALL_ORDER_Y = new Set([
  0n,
  1n,
  ED25519_P - 1n,
  2707385501144840649318225287225658788936804267575313519463743609750303402022n,
  55188659117513257062467267217118295137698188065244968500265048394206261417927n,
]);

function leUint(b: Uint8Array): bigint {
  return b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
}

/** An encoding hxd-ng's `verify_domain` takes for a key or an R: y in
 *  canonical form (below p) and not a point of small order. The other
 *  non-canonical form, x = 0 under the sign bit, exists only at y = ±1,
 *  which are of small order. Whether the bytes are a point at all is
 *  left to WebCrypto. */
function strongPoint(b: Uint8Array): boolean {
  const y = leUint(b) & ((1n << 255n) - 1n);
  return b.length === 32 && y < ED25519_P && !SMALL_ORDER_Y.has(y);
}

/** Verify a signed object's envelope against `publicKey` under `domain`.
 *  Returns the decoded map on success. The server re-verifies everything
 *  it is handed; this exists for the enrollment paste (this repo's own
 *  `docs/identity-keys.md` §7.1 step 4) so a bad paste is caught locally
 *  rather than at `/identity/auth`. */
export async function verifyEnvelope(bytes: Uint8Array, publicKey: Uint8Array, domain: string): Promise<CborValue> {
  const { value, signedBytes, sig } = openEnvelope(bytes);
  // WebCrypto engines disagree about what verifies. Chromium's and
  // Firefox's accept a small-order key, and the neutral element signs
  // any message with R = itself and S = 0: one fingerprint every holder
  // could sign for. Both accept a small-order R, and Chromium's such a
  // key in its second encoding; Node's refuses them all. So what hxd-ng
  // refuses by its encoding is refused here before any engine sees it,
  // and S at or past L with it, which every engine tested refuses but
  // costs one comparison not to depend on. The equation is left to
  // WebCrypto, cofactorless in each engine tested, as `verify_strict` is.
  if (!strongPoint(publicKey)) throw new IdentityError('invalid-key', domain);
  if (!strongPoint(sig.subarray(0, 32)) || leUint(sig.subarray(32)) >= ED25519_L) {
    throw new IdentityError('bad-signature', domain);
  }
  const key = await crypto.subtle.importKey('raw', bufferSource(publicKey), { name: 'Ed25519' }, false, ['verify']);
  const message = concatBytes(textEncoder.encode(domain), Uint8Array.of(0), signedBytes);
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, bufferSource(sig), bufferSource(message));
  if (!ok) throw new IdentityError('bad-signature', domain);
  return value;
}

// --- device certificate (§3.3) ---------------------------------------------

export const DEVICE_CERT_DOMAIN = 'hl-identity/device-cert/v1';
export const DEVICE_CERT_MAX_BYTES = 4 * 1024;
export const DEVICE_CERT_NAME_MAX_CHARS = 64;
export const RECOMMENDED_LIFETIME_SECONDS = 90 * 24 * 3600;

/** Device capability bits (`cert.rs`'s `caps` module). `WEB` is what a
 *  browser's certificate should carry — never `VOUCH` or `MANAGE`. */
export const CAPS = { LOGIN: 1, MESSAGE: 2, VOUCH: 4, MANAGE: 8, WEB: 1 | 2 } as const;

export interface DeviceCert {
  identity: Uint8Array;
  device: Uint8Array;
  deviceEnc: Uint8Array;
  issued: number;
  expires: number;
  caps: number | undefined;
  name: string | undefined;
  raw: Uint8Array;
}

export function decodeDeviceCert(bytes: Uint8Array): DeviceCert {
  if (bytes.length > DEVICE_CERT_MAX_BYTES) throw new IdentityError('too-large', 'device certificate');
  const { value } = openEnvelope(bytes);
  const name = optText(value, 'name');
  if (name !== undefined && invalidDisplayName(name, DEVICE_CERT_NAME_MAX_CHARS)) {
    throw new IdentityError('bad-field', 'name');
  }
  return {
    identity: reqBytesN(value, 'identity', 32),
    device: reqBytesN(value, 'device', 32),
    deviceEnc: reqBytesN(value, 'device_enc', 32),
    issued: reqUint(value, 'issued'),
    expires: reqUint(value, 'expires'),
    caps: optUint(value, 'caps'),
    name,
    raw: bytes,
  };
}

// --- user card (§3.4) -------------------------------------------------------
//
// A Phase B client never signs a card, never inspects its attestations
// (the server tells the client the resulting `handle` at auth time — see
// `AuthSuccess`), and only ever forwards the exact bytes it was given.
// So only the fields enrollment actually reads (this repo's own
// `docs/identity-keys.md` §7.1 step 4: does this card name the same
// identity as the pasted certificate?) are decoded; everything else is
// unknown-and-ignored, same as the spec allows any reader to treat it.

export const CARD_DOMAIN = 'hl-identity/card/v1';
export const CARD_MAX_BYTES = 16 * 1024;
export const CARD_NAME_MAX_CHARS = 32;

export interface Card {
  identity: Uint8Array;
  updated: number;
  name: string;
  raw: Uint8Array;
}

export function decodeCard(bytes: Uint8Array): Card {
  if (bytes.length > CARD_MAX_BYTES) throw new IdentityError('too-large', 'card');
  const { value } = openEnvelope(bytes);
  const name = reqText(value, 'name');
  if (invalidDisplayName(name, CARD_NAME_MAX_CHARS)) throw new IdentityError('bad-field', 'name');
  return {
    identity: reqBytesN(value, 'identity', 32),
    updated: reqUint(value, 'updated'),
    name,
    raw: bytes,
  };
}

// --- login proof (docs/hotline-ng-identity.md §3.6, table in
// docs/hotline-ng-auth.md §6.2) ------------------------------------------

// Both versions of the proof sign under this one domain; `v`, which the
// signature covers, tells them apart.
export const LOGIN_PROOF_DOMAIN = 'hl-identity/login/v1';
export const SERVER_CHALLENGE_DOMAIN = 'hl-identity/server-challenge/v1';
/** How far past its `expires` a server challenge is still taken, as a
 *  server's default `[identity] clock_skew` allows a proof's `time`. */
export const SERVER_CHALLENGE_SKEW_SECONDS = 300;
export const SERVER_CHALLENGE_REFUSED = 'bad_server_challenge';
export const WRONG_HOST = 'wrong_host';

/**
 * The form a host is signed and compared in (§6.2): `host[:port]` as the
 * WHATWG URL Standard serializes it — lowercase, an IDN as its A-label,
 * IPv6 compressed in brackets, a trailing dot kept — with port 80 or 443
 * dropped whatever the scheme, because a server behind a TLS proxy
 * cannot tell which of the two the client used. `null` for anything
 * that is not an authority alone. Mirrors `proof.rs`'s `canonical_host`,
 * byte for byte, since the server compares the bytes.
 */
export function canonicalHost(authority: string): string | null {
  if (authority === '' || /[/\\?#@]/.test(authority)) return null;
  let url: URL;
  try {
    url = new URL(`http://${authority}/`);
  } catch {
    return null;
  }
  if (url.hostname === '') return null;
  // `http:` already leaves 80 out.
  return url.port === '' || url.port === '443' ? url.hostname : `${url.hostname}:${url.port}`;
}

/** The host a request to `endpoint` goes to — what its `Host` header
 *  says. A page-relative endpoint (`wsToHttp`'s `''`) resolves against
 *  the page, as `fetch` resolves it. */
function addressedHost(endpoint: string): string {
  const base = typeof location !== 'undefined' ? location.href : undefined;
  const host = canonicalHost(new URL(endpoint, base).host);
  if (host === null) throw new IdentityError('bad-field', `${endpoint} names no host`);
  return host;
}

export interface LoginProofFields {
  challenge: Uint8Array;
  serverKey: Uint8Array;
  /** The host `challenge` and `auth` are sent to: `Challenge.host`. */
  host: string;
  device: Uint8Array;
  /** Unix seconds. */
  time: number;
}

/** Build and sign a `v = 2` login proof with the device's
 *  non-extractable signing key. The only signature a Phase B client
 *  ever produces. */
export async function signLoginProof(deviceSignKey: CryptoKey, fields: LoginProofFields): Promise<Uint8Array> {
  const host = canonicalHost(fields.host);
  if (host === null) throw new IdentityError('bad-field', 'host');
  const unsigned: [string, CborValue][] = [
    ['challenge', cBytes(fields.challenge)],
    ['server_key', cBytes(fields.serverKey)],
    ['host', cText(host)],
    ['device', cBytes(fields.device)],
    ['time', cUint(fields.time)],
    ['v', cUint(2)],
  ];
  const body = encode(cMap(unsigned));
  const message = concatBytes(textEncoder.encode(LOGIN_PROOF_DOMAIN), Uint8Array.of(0), body);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, deviceSignKey, bufferSource(message)));
  return encode(cMap([...unsigned, ['sig', cBytes(sig)]]));
}

// --- enrollment (hxd-ng's docs/identity-enrollment.md §4, §5.4) ----------
//
// The two objects a browser being enrolled through a mailbox handles: it
// signs a request saying which keys it wants certified, and it opens a
// bundle saying what it got. Both are also what the paste path carries
// once `hlid cert --bundle` writes one, which is the point of them
// living here rather than in the mailbox client — the browser has one
// verifier for "a certificate arrived", however it arrived.

export const ENROLL_REQUEST_DOMAIN = 'hl-identity/enroll-request/v1';
export const ENROLL_REQUEST_MAX_BYTES = 8 * 1024;
export const BUNDLE_MAX_BYTES = DEVICE_CERT_MAX_BYTES + CARD_MAX_BYTES + 256;

/** The holder's QR-code secret (§5.6), 16 bytes. Not a key: it is read
 *  off a screen by a camera, folded into the request as `pair`, and
 *  never sent to the mailbox. */
export const PAIRING_SECRET_BYTES = 16;

export interface EnrollRequestFields {
  /** This browser's Ed25519 public key — the key that signs the request. */
  device: Uint8Array;
  /** This browser's X25519 public key. */
  deviceEnc: Uint8Array;
  /** A label for this device. The holder may edit it. */
  name?: string;
  /** Capability bits asked for; omit to leave it to the holder. */
  caps?: number;
  /** Lifetime in days asked for; omit to leave it to the holder. */
  days?: number;
  /** Unix seconds. A holder outside its skew tolerance calls it a replay. */
  time: number;
  /** The current certificate, for a renewal (§8). */
  prev?: Uint8Array;
  /** `pairTag(...)`, when this browser was opened by scanning a QR code. */
  pair?: Uint8Array;
}

/**
 * Build and sign an enrollment request with the device's
 * non-extractable signing key.
 *
 * Nothing here decides anything. `caps`, `days` and `name` are requests
 * in the ordinary English sense: what a device gets is the holder's
 * policy intersected with what it asked for (§6), and no field in this
 * object can widen that. Asking for `MANAGE` gets a prompt that shows
 * the ask and shows it refused.
 */
export async function signEnrollRequest(
  deviceSignKey: CryptoKey,
  fields: EnrollRequestFields,
): Promise<Uint8Array> {
  if (fields.name !== undefined && invalidDisplayName(fields.name, DEVICE_CERT_NAME_MAX_CHARS)) {
    throw new IdentityError('bad-field', 'name');
  }
  // The encoder sorts map keys, so this order is for reading, not for
  // the wire.
  const unsigned: [string, CborValue | undefined][] = [
    ['v', cUint(1)],
    ['device', cBytes(fields.device)],
    ['device_enc', cBytes(fields.deviceEnc)],
    ['name', fields.name === undefined ? undefined : cText(fields.name)],
    ['caps', fields.caps === undefined ? undefined : cUint(fields.caps)],
    ['days', fields.days === undefined ? undefined : cUint(fields.days)],
    ['time', cUint(fields.time)],
    ['prev', fields.prev === undefined ? undefined : cBytes(fields.prev)],
    ['pair', fields.pair === undefined ? undefined : cBytes(fields.pair)],
  ];
  const body = encode(cOptMap(unsigned));
  const message = concatBytes(textEncoder.encode(ENROLL_REQUEST_DOMAIN), Uint8Array.of(0), body);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, deviceSignKey, bufferSource(message)));
  const signed = encode(cOptMap([...unsigned, ['sig', cBytes(sig)]]));
  if (signed.length > ENROLL_REQUEST_MAX_BYTES) throw new IdentityError('too-large', 'enrollment request');
  return signed;
}

/**
 * `HMAC-SHA-256(pairing secret, device public key)` — §4's `pair`.
 *
 * Keyed by the secret from the QR code and computed over this device's
 * key, so it binds one device to one scan. This side only ever
 * *produces* it; the holder is what checks it, and a mailbox that never
 * saw the secret cannot mint one for a key of its own — which is what
 * makes the scanned path safe without asking a human to compare
 * fingerprints (§5.6).
 */
export async function pairTag(secret: Uint8Array, device: Uint8Array): Promise<Uint8Array> {
  if (secret.length !== PAIRING_SECRET_BYTES) throw new IdentityError('bad-field', 'pairing secret');
  const key = await crypto.subtle.importKey('raw', bufferSource(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign({ name: 'HMAC' }, key, bufferSource(device)));
}

/** A certificate and the card of the identity that signed it (§5.4).
 *  The raw encodings, because what a bundle is for is being checked and
 *  stored, and re-encoding either half to keep it would be a chance to
 *  change it. */
export interface Bundle {
  cert: Uint8Array;
  card: Uint8Array;
}

/** Structure only: canonical CBOR, `v === 1`, two byte strings. Neither
 *  member is decoded — `openBundle` is what does that. */
export function decodeBundle(bytes: Uint8Array): Bundle {
  if (bytes.length > BUNDLE_MAX_BYTES) throw new IdentityError('too-large', 'bundle');
  const value = decodeCanonical(bytes);
  if (value.t !== 'map') throw new IdentityError('not-a-map', 'not a CBOR map');
  const v = mapGet(value, 'v');
  if (v === undefined) throw new IdentityError('missing-field', 'v');
  if (v.t !== 'uint') throw new IdentityError('bad-field', 'v');
  if (v.v !== VERSION) throw new IdentityError('unsupported-version', String(v.v));
  return { cert: reqBytes(value, 'cert'), card: reqBytes(value, 'card') };
}

/**
 * Decode both members, verify both signatures, and check the one thing
 * that makes them a bundle rather than two files: that the card belongs
 * to the identity the certificate names.
 *
 * That check is not a formality. A hostile mailbox can hand back a real
 * certificate and somebody else's real card, so that every signature
 * verifies and the name shown next to the fingerprint is a lie (§9,
 * "substitute the answer").
 *
 * What is deliberately not checked here is the device: only the caller
 * knows which keys this browser holds. Nor is expiry, which needs a
 * clock the caller has.
 */
export async function openBundle(bytes: Uint8Array): Promise<{ cert: DeviceCert; card: Card }> {
  const b = decodeBundle(bytes);
  const cert = decodeDeviceCert(b.cert);
  const card = decodeCard(b.card);
  await verifyEnvelope(b.cert, cert.identity, DEVICE_CERT_DOMAIN);
  await verifyEnvelope(b.card, card.identity, CARD_DOMAIN);
  if (bytesToHex(cert.identity) !== bytesToHex(card.identity)) {
    throw new IdentityError('bad-field', 'the certificate and the card name different identities');
  }
  return { cert, card };
}

// --- HTTP: discovery, challenge, auth (hxd-ng's docs/hotline-ng-auth.md
// §5 discovery, §6.2 challenge binding; docs/hotline-ng-identity.md §4
// layers the profile's own discovery fields on top) ----------------------

/**
 * `ws(s)://host:port/...` → the base every identity HTTP call is built
 * on. Two different answers, and the difference matters:
 *
 * - Same hostname as the page: `''`, so `${base}/identity/challenge`
 *   is a *page-relative* path. That's deliberate, not an oversight —
 *   the identity endpoints are served by the same listener as the ng
 *   WebSocket (`hotline-ng-auth.md` §2), which is almost never the
 *   page's own origin (it's a different port, `config.ts`'s
 *   `fromOrigin()`), so a same-hostname target is "the ordinary case
 *   of the client sitting in front of its own server" (README.md) —
 *   reached in production through the same reverse proxy that serves
 *   the page, and in `npm run dev` through `vite.config.ts`'s
 *   `server.proxy`, which exists for exactly this. An absolute
 *   cross-origin URL here would just be refused by the browser, since
 *   nothing in `crates/` sends CORS headers.
 * - A different hostname: the ws-derived absolute origin, for a
 *   genuinely different server (`allowCustomServer`) — cross-origin,
 *   and it needs the server's own CORS headers
 *   (`docs/identity-keys.md` §9); this client does not add any.
 *
 * Outside a browser (no `location` — a bot or a bridge), always
 * absolute: there is no page origin to be relative to, and no proxy
 * to lean on.
 */
export function wsToHttp(wsUrl: string): string {
  const u = new URL(wsUrl);
  if (typeof location !== 'undefined' && location.hostname === u.hostname) return '';
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  return `${u.protocol}//${u.host}`;
}

export interface DiscoveryIdentityEnabled {
  enabled: true;
  bindings: string[];
  newAccounts: 'deny' | 'guest' | 'create';
  association: string;
  minAttestationAge: number;
  trustedRegistrars: string[];
  endpoints: {
    challenge: string;
    auth: string;
    card: string;
    link: string;
    unlink: string;
    /** Absent when this server hosts no enrollment mailbox
     *  (`identity-enrollment.md` §3). */
    enroll?: string;
  };
  /** Where a web client for this server lives, if the operator said
   *  (§3). The holder puts it in the QR code so a phone camera opens the
   *  right client with the code already filled in (§5.6). */
  web?: string;
}

export type DiscoveryIdentity = DiscoveryIdentityEnabled | { enabled: false };

export interface Discovery {
  v: number;
  name: string;
  serverKey: string | null;
  /** The WebSocket paths, as URL references against the discovery URL
   *  (hxd-ng's `docs/hotline-ng-auth.md` §5). `trtp` without `ws` is a
   *  classic server behind a relay: the classic protocol, in binary
   *  frames, with `htxf` for its transfers. */
  ng: { ws?: string; trtp?: string; htxf?: string };
  identity: DiscoveryIdentity;
}

export async function fetchDiscovery(httpBase: string): Promise<Discovery> {
  const res = await fetch(`${httpBase}/.well-known/hotline`, { cache: 'no-cache' });
  if (!res.ok) throw new IdentityError('server-error', `discovery: HTTP ${res.status}`);
  const raw = (await res.json()) as any;
  const ri = raw.identity ?? { enabled: false };
  const identity: DiscoveryIdentity = ri.enabled
    ? {
        enabled: true,
        bindings: ri.bindings ?? [],
        newAccounts: ri.new_accounts ?? 'deny',
        association: ri.association ?? 'server',
        minAttestationAge: ri.min_attestation_age ?? 0,
        trustedRegistrars: ri.trusted_registrars ?? [],
        endpoints: ri.endpoints,
        // Spread rather than `web: ri.web ?? undefined`, which would set
        // the property to `undefined` and make "absent" indistinguishable
        // from "present and empty" for a caller testing `'web' in …`.
        // Absence is the whole meaning of the field.
        ...(typeof ri.web === 'string' ? { web: ri.web } : {}),
      }
    : { enabled: false };
  return { v: raw.v, name: raw.name, serverKey: raw.server_key ?? null, ng: raw.ng, identity };
}

export interface Challenge {
  challenge: Uint8Array;
  serverKey: Uint8Array;
  /** The host the challenge was fetched from and vouched for, which the
   *  proof names and `auth` must be sent to. */
  host: string;
  expiresIn: number;
}

export interface ServerChallenge {
  challenge: Uint8Array;
  serverKey: Uint8Array;
  host: string;
  /** Unix seconds. */
  expires: number;
}

/** Shape only, `host` in canonical form included; the signature is
 *  `verifyServerChallenge`'s. */
export function decodeServerChallenge(bytes: Uint8Array): ServerChallenge {
  const { value } = openEnvelope(bytes);
  const host = reqText(value, 'host');
  if (canonicalHost(host) !== host) throw new IdentityError('bad-field', 'host');
  return {
    challenge: reqBytesN(value, 'challenge', 32),
    serverKey: reqBytesN(value, 'server_key', 32),
    host,
    expires: reqUint(value, 'expires'),
  };
}

/**
 * The client's half of §6.2 step 1, before anything is signed, given
 * the reply's `server_challenge` as it arrived: the server key's
 * signature over the challenge, that key and the challenge
 * the reply carried, the host this client addressed, and not expired.
 * Without it a server that publishes another's key could hand on that
 * server's challenge and spend the proof there (hxd-ng's
 * `docs/hotline-ng-auth-rationale.md` §5). Every failure, a missing
 * `server_challenge` included, is the same refusal: there is no `v = 1`
 * to fall back to, or a relaying server need only strip it.
 */
export async function verifyServerChallenge(
  serverChallenge: unknown,
  given: { challenge: Uint8Array; serverKey: Uint8Array; host: string },
  now: number,
): Promise<void> {
  const refuse = (why: string) =>
    new AuthError(SERVER_CHALLENGE_REFUSED, `The server at ${given.host} did not vouch for its challenge (${why}).`);
  if (serverChallenge === undefined || serverChallenge === null) {
    throw refuse(`none in the reply: ${given.host} is not among its [identity] hosts, or it predates them`);
  }
  let sc: ServerChallenge;
  try {
    if (typeof serverChallenge !== 'string') throw new IdentityError('bad-field', 'server_challenge');
    const bytes = base64urlToBytes(serverChallenge);
    sc = decodeServerChallenge(bytes);
    await verifyEnvelope(bytes, sc.serverKey, SERVER_CHALLENGE_DOMAIN);
  } catch (e) {
    throw refuse(e instanceof Error ? e.message : String(e));
  }
  if (bytesToHex(sc.challenge) !== bytesToHex(given.challenge) || bytesToHex(sc.serverKey) !== bytesToHex(given.serverKey)) {
    throw refuse('signed for another challenge or key than the reply gave');
  }
  if (sc.host !== given.host) throw refuse(`signed for ${sc.host}`);
  if (sc.expires + SERVER_CHALLENGE_SKEW_SECONDS < now) throw refuse('expired');
}

export async function fetchChallenge(endpoint: string): Promise<Challenge> {
  const host = addressedHost(endpoint);
  const res = await fetch(endpoint, { method: 'POST' });
  if (!res.ok) throw new IdentityError('server-error', `challenge: HTTP ${res.status}`);
  const raw = (await res.json()) as { challenge: string; server_key: string; expires_in: number; server_challenge?: unknown };
  const challenge = {
    challenge: base64urlToBytes(raw.challenge),
    serverKey: base64urlToBytes(raw.server_key),
    host,
    expiresIn: raw.expires_in,
  };
  await verifyServerChallenge(raw.server_challenge, challenge, Math.floor(Date.now() / 1000));
  return challenge;
}

export interface AuthRequest {
  card: Uint8Array;
  deviceCert: Uint8Array;
  proof: Uint8Array;
  /** The host the proof names, `Challenge.host`. `auth` must go where
   *  `challenge` went (§6.2), so an endpoint elsewhere is refused before
   *  the proof is sent: discovery's endpoints are not checked to be
   *  paths, and one that sent `challenge` to another server would have
   *  this client hand it a proof for this one. */
  host: string;
  /** The hop *behind* this client, per hxd-ng's `docs/hotline-ng-auth.md`
   *  §6.2 — absent means the default, `local`. Only a tunnel forwarding
   *  over a non-loopback hop should ever say `cleartext`; hx-ng is
   *  always the endpoint, so it never sends this field at all. */
  downstream?: 'local' | 'cleartext';
  /** Suppress account creation on this call (hxd-ng's
   *  `docs/hotline-ng-identity.md` §5.3, §8.1). A client about to link
   *  an existing account, or one that wants to stay a guest, sends
   *  `false`; omitting it accepts whatever `new_accounts` does. */
  create?: boolean;
  login?: string;
  password?: string;
}

export interface AuthSuccess {
  token: string;
  expiresIn: number;
  fingerprint: string;
  handle: string | null;
  age: number;
  outcome: string;
  account: string | null;
}

export async function postAuth(endpoint: string, req: AuthRequest): Promise<AuthSuccess> {
  const host = addressedHost(endpoint);
  if (host !== req.host) {
    throw new AuthError(WRONG_HOST, `The challenge came from ${req.host}, and auth would go to ${host}.`);
  }
  const body: Record<string, unknown> = {
    card: bytesToBase64url(req.card),
    device_cert: bytesToBase64url(req.deviceCert),
    proof: bytesToBase64url(req.proof),
  };
  if (req.downstream !== undefined) body.downstream = req.downstream;
  if (req.create !== undefined) body.create = req.create;
  if (req.login !== undefined) body.login = req.login;
  if (req.password !== undefined) body.password = req.password;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Parsed by hand rather than `res.json()`: a failure here is exactly
  // the case a proxy or an unhandled path answers with an HTML error
  // page, or nothing at all, and that has to reach the caller as an
  // `AuthError` naming the HTTP status — not a bare `SyntaxError`
  // pointing at a JSON parser several frames from the actual problem.
  const text = await res.text();
  let raw: any;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new AuthError('server_error', `HTTP ${res.status}: ${text.slice(0, 200) || '(empty body)'}`, res.status);
  }
  if (!res.ok || raw.error) {
    throw new AuthError(raw.error ?? 'server_error', raw.text || raw.error || `HTTP ${res.status}`, res.status);
  }
  return {
    token: raw.token,
    expiresIn: raw.expires_in,
    fingerprint: raw.fingerprint,
    handle: raw.handle ?? null,
    age: raw.age ?? 0,
    outcome: raw.outcome,
    account: raw.account ?? null,
  };
}
