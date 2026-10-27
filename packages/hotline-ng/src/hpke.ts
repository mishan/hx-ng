/**
 * HPKE (RFC 9180), single-shot, in the one suite a sealed message uses
 * (hxd-ng's `docs/e2e-messages.md` §3.8): DHKEM(X25519, HKDF-SHA256),
 * HKDF-SHA256 and AES-256-GCM, in base and auth mode, with no PSK.
 *
 * Everything runs in WebCrypto, so a recipient's or a sender's X25519
 * key is a `CryptoKey` that may be non-extractable: its public key is
 * found by agreeing it with the base point rather than by exporting it.
 * HKDF is built on HMAC-SHA256, because WebCrypto's HKDF always runs
 * Extract and Expand together and HPKE's labeled schedule needs them
 * apart; an empty salt is HashLen zero bytes, which RFC 5869 makes the
 * same and WebCrypto's HMAC, unlike an empty key, accepts.
 */

const textEncoder = new TextEncoder();

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0002;
const MODE_BASE = 0x00;
const MODE_AUTH = 0x02;
const N_SECRET = 32;
const N_KEY = 32;
const N_NONCE = 12;

const i2osp2 = (n: number) => [n >> 8, n & 0xff];
const KEM_SUITE = new Uint8Array([...textEncoder.encode('KEM'), ...i2osp2(KEM_ID)]);
const HPKE_SUITE = new Uint8Array([...textEncoder.encode('HPKE'), ...i2osp2(KEM_ID), ...i2osp2(KDF_ID), ...i2osp2(AEAD_ID)]);
const HPKE_V1 = textEncoder.encode('HPKE-v1');
const BASE_POINT = new Uint8Array(32);
BASE_POINT[0] = 9;
/** RFC 8410's PKCS #8 wrapping of a 32-byte X25519 private key, the one
 *  import form WebCrypto takes for one. */
const PKCS8_X25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

/** A box that cannot be made or opened: a key whose X25519 result is
 *  all zeros (RFC 9180 §7.1.4), or a ciphertext that does not open. */
export class HpkeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HpkeError';
  }
}

const buf = (b: Uint8Array) => b as BufferSource;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', buf(key.length ? key : new Uint8Array(N_SECRET)), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, buf(data)));
}

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Promise<Uint8Array> {
  return hmac(salt, concat(HPKE_V1, suite, textEncoder.encode(label), ikm));
}

async function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Promise<Uint8Array> {
  const labeled = concat(new Uint8Array(i2osp2(length)), HPKE_V1, suite, textEncoder.encode(label), info);
  let block: Uint8Array = new Uint8Array(0);
  const out: Uint8Array[] = [];
  for (let i = 1; out.length * N_SECRET < length; i++) {
    block = await hmac(prk, concat(block, labeled, new Uint8Array([i])));
    out.push(block);
  }
  return concat(...out).slice(0, length);
}

async function importPublic(pk: Uint8Array): Promise<CryptoKey> {
  if (pk.length !== 32) throw new HpkeError('an X25519 public key is 32 bytes');
  try {
    return await crypto.subtle.importKey('raw', buf(pk), { name: 'X25519' }, true, []);
  } catch {
    throw new HpkeError('not an X25519 public key');
  }
}

/** X25519, refusing an all-zero result whether or not the runtime does
 *  (WebCrypto's specification has it throw; not every runtime has). With
 *  a private key that is one, only the peer's point can fail it, and
 *  runtimes differ in how they say so. */
async function dh(sk: CryptoKey, pk: Uint8Array): Promise<Uint8Array> {
  const peer = await importPublic(pk);
  let out: Uint8Array;
  try {
    out = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, sk, 256));
  } catch {
    throw new HpkeError('X25519 failed on the peer key');
  }
  if (out.every((b) => b === 0)) throw new HpkeError('X25519 result is all zeros');
  return out;
}

/** The public key of an X25519 private key, extractable or not. Not
 *  through `dh`: the base point is never a bad peer, so a failure here is
 *  our own key's, and is thrown as the runtime says it. */
export async function x25519PublicKey(sk: CryptoKey): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', buf(BASE_POINT), { name: 'X25519' }, true, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: base }, sk, 256));
}

/** An X25519 private key, non-extractable, from its 32 bytes. */
export function importX25519Secret(sk: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', buf(concat(PKCS8_X25519_PREFIX, sk)), { name: 'X25519' }, false, ['deriveBits']);
}

/** `DeriveKeyPair`'s private key (RFC 9180 §7.1.3), which X25519
 *  clamps as it uses it. */
export async function deriveX25519Secret(ikm: Uint8Array): Promise<Uint8Array> {
  const prk = await labeledExtract(KEM_SUITE, new Uint8Array(0), 'dkp_prk', ikm);
  return labeledExpand(KEM_SUITE, prk, 'sk', new Uint8Array(0), N_SECRET);
}

async function extractAndExpand(dhs: Uint8Array, kemContext: Uint8Array): Promise<Uint8Array> {
  const prk = await labeledExtract(KEM_SUITE, new Uint8Array(0), 'eae_prk', dhs);
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', kemContext, N_SECRET);
}

/** A sender's static key in auth mode, and its public key. */
export interface HpkeSender {
  sk: CryptoKey;
  pk: Uint8Array;
}

/** The AEAD key and nonce of a context's one message, sequence 0. */
async function keySchedule(mode: number, sharedSecret: Uint8Array, info: Uint8Array): Promise<{ key: CryptoKey; nonce: Uint8Array }> {
  const empty = new Uint8Array(0);
  const pskIdHash = await labeledExtract(HPKE_SUITE, empty, 'psk_id_hash', empty);
  const infoHash = await labeledExtract(HPKE_SUITE, empty, 'info_hash', info);
  const context = concat(new Uint8Array([mode]), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE, sharedSecret, 'secret', empty);
  const raw = await labeledExpand(HPKE_SUITE, secret, 'key', context, N_KEY);
  const nonce = await labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, N_NONCE);
  const key = await crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { key, nonce };
}

/** `SealBase`, or `SealAuth` under `sender`, to `pkR`, with the
 *  ephemeral key derived from `ikmE`: 32 random bytes, unless a test
 *  vector fixes them. */
export async function hpkeSeal(
  pkR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  sender: HpkeSender | null,
  ikmE: Uint8Array = crypto.getRandomValues(new Uint8Array(N_SECRET)),
): Promise<{ enc: Uint8Array; ct: Uint8Array }> {
  const skE = await importX25519Secret(await deriveX25519Secret(ikmE));
  const enc = await x25519PublicKey(skE);
  let dhs = await dh(skE, pkR);
  let kemContext = concat(enc, pkR);
  if (sender) {
    dhs = concat(dhs, await dh(sender.sk, pkR));
    kemContext = concat(kemContext, sender.pk);
  }
  const { key, nonce } = await keySchedule(sender ? MODE_AUTH : MODE_BASE, await extractAndExpand(dhs, kemContext), info);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad) }, key, buf(plaintext)));
  return { enc, ct };
}

/** `OpenBase`, or `OpenAuth` from `pkS`, with the recipient's key. */
export async function hpkeOpen(
  enc: Uint8Array,
  skR: CryptoKey,
  info: Uint8Array,
  aad: Uint8Array,
  ct: Uint8Array,
  pkS: Uint8Array | null,
): Promise<Uint8Array> {
  const pkR = await x25519PublicKey(skR);
  let dhs = await dh(skR, enc);
  let kemContext = concat(enc, pkR);
  if (pkS) {
    dhs = concat(dhs, await dh(skR, pkS));
    kemContext = concat(kemContext, pkS);
  }
  const { key, nonce } = await keySchedule(pkS ? MODE_AUTH : MODE_BASE, await extractAndExpand(dhs, kemContext), info);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad) }, key, buf(ct)));
  } catch (e) {
    if (e instanceof Error && e.name === 'OperationError') throw new HpkeError('the ciphertext does not open');
    throw e;
  }
}
