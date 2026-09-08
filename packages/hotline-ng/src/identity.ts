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

import { cBytes, cMap, cUint, decodeCanonical, encode, mapGet, mapWithout, type CborValue } from './cbor';
import { hasDeceptiveChar } from './names';

const textEncoder = new TextEncoder();

export type IdentityErrorKind =
  | 'missing-field'
  | 'bad-field'
  | 'not-a-map'
  | 'unsupported-version'
  | 'bad-signature'
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

/** A refusal reported by `/identity/auth` itself — `{ error, text }` —
 *  as opposed to an `IdentityError`, which is this client finding
 *  something wrong before or after that call. */
export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
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

export function base64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64url(b: Uint8Array): string {
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

/** Verify a signed object's envelope against `publicKey` under `domain`.
 *  Returns the decoded map on success. The server re-verifies everything
 *  it is handed; this exists for the enrolment paste (this repo's own
 *  `docs/identity-keys.md` §7.1 step 4) so a bad paste is caught locally
 *  rather than at `/identity/auth`. */
export async function verifyEnvelope(bytes: Uint8Array, publicKey: Uint8Array, domain: string): Promise<CborValue> {
  const { value, signedBytes, sig } = openEnvelope(bytes);
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
// So only the fields enrolment actually reads (this repo's own
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

export const LOGIN_PROOF_DOMAIN = 'hl-identity/login/v1';

export interface LoginProofFields {
  challenge: Uint8Array;
  serverKey: Uint8Array;
  device: Uint8Array;
  /** Unix seconds. */
  time: number;
}

/** Build and sign a login proof with the device's non-extractable
 *  signing key. The only signature a Phase B client ever produces. */
export async function signLoginProof(deviceSignKey: CryptoKey, fields: LoginProofFields): Promise<Uint8Array> {
  const unsigned: [string, CborValue][] = [
    ['challenge', cBytes(fields.challenge)],
    ['server_key', cBytes(fields.serverKey)],
    ['device', cBytes(fields.device)],
    ['time', cUint(fields.time)],
    ['v', cUint(1)],
  ];
  const body = encode(cMap(unsigned));
  const message = concatBytes(textEncoder.encode(LOGIN_PROOF_DOMAIN), Uint8Array.of(0), body);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, deviceSignKey, bufferSource(message)));
  return encode(cMap([...unsigned, ['sig', cBytes(sig)]]));
}

// --- HTTP: discovery, challenge, auth (hxd-ng's docs/hotline-ng-auth.md
// §5 discovery, §6.2 challenge binding; docs/hotline-ng-identity.md §4
// layers the profile's own discovery fields on top) ----------------------

/** `ws(s)://host:port/...` → `http(s)://host:port` — every identity HTTP
 *  call is addressed from the connect URL, not the page's own origin, so
 *  a custom server (not just the vite-proxied default) is reached
 *  directly. Cross-origin, that needs server-side CORS (this repo's own
 *  `docs/identity-keys.md` §9); this client does not add any. */
export function wsToHttp(wsUrl: string): string {
  const u = new URL(wsUrl);
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
  endpoints: { challenge: string; auth: string; card: string; link: string; unlink: string };
}

export type DiscoveryIdentity = DiscoveryIdentityEnabled | { enabled: false };

export interface Discovery {
  v: number;
  name: string;
  serverKey: string | null;
  ng: { ws: string; trtp?: string };
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
      }
    : { enabled: false };
  return { v: raw.v, name: raw.name, serverKey: raw.server_key ?? null, ng: raw.ng, identity };
}

export interface Challenge {
  challenge: Uint8Array;
  serverKey: Uint8Array;
  expiresIn: number;
}

export async function fetchChallenge(endpoint: string): Promise<Challenge> {
  const res = await fetch(endpoint, { method: 'POST' });
  if (!res.ok) throw new IdentityError('server-error', `challenge: HTTP ${res.status}`);
  const raw = (await res.json()) as { challenge: string; server_key: string; expires_in: number };
  return {
    challenge: base64urlToBytes(raw.challenge),
    serverKey: base64urlToBytes(raw.server_key),
    expiresIn: raw.expires_in,
  };
}

export interface AuthRequest {
  card: Uint8Array;
  deviceCert: Uint8Array;
  proof: Uint8Array;
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
  const raw = (await res.json()) as any;
  if (!res.ok || raw.error) {
    throw new AuthError(raw.error ?? 'server_error', raw.text || raw.error || `HTTP ${res.status}`);
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
