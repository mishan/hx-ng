/**
 * Sealed private messages, hxd-ng's `docs/e2e-messages.md` §3.7–§3.11:
 * the whole signed map, padded and sealed to one device's `device_enc`
 * key with HPKE in base mode (§3.8), or the map without its signature,
 * sealed in auth mode under the sender device's own `device_enc` key,
 * which the recipient could have made as well (§3.11); and opening either
 * in §3.9's order, ending in the states a client shows (§8). Mirrors
 * `crates/hl-identity/src/sealed.rs` check for check and in its order.
 *
 * Both of a device's private keys stay `CryptoKey`s, non-extractable as
 * a browser generates them. Freshness is the reader's clock and its
 * replay memory, which outlives any call here, so the caller keeps it
 * behind `SealedReplay`.
 */

import { CborError, decodeCanonical, itemLength } from './cbor.js';
import { HpkeError, hpkeOpen, hpkeSeal, x25519PublicKey, type HpkeSender } from './hpke.js';
import {
  DEVICE_CERT_DOMAIN,
  IdentityError,
  decodeDeviceCert,
  fingerprintFromString,
  fingerprintToString,
  verifyEnvelope,
  type DeviceCert,
} from './identity.js';
import privateMessageMaps, {
  SIGNED_SKEW_SECONDS,
  checkMessageCert,
  signedPrivateMessages,
  type MessageScope,
  type Signed,
  type SignedPrivateMessage,
  type SignedSender,
} from './message.js';

const textEncoder = new TextEncoder();

/** Each form's HPKE `info`, which no other use of a `device_enc` key
 *  shares (§3.8). */
export const SEALED_SIGNED_INFO = 'hl-identity/sealed-message/v1/hpke';
export const SEALED_DENIABLE_INFO = 'hl-identity/sealed-message/v1/hpke-auth';
/** Each form's leading byte, which is its `aad` as well. */
export const SEALED_SIGNED_BOX = 0x01;
export const SEALED_DENIABLE_BOX = 0x02;
/** The sizes a signed box's plaintext is padded to (§3.7); a deniable
 *  box's are 32 bytes less, for the `pkS` it carries in the clear. */
export const SEALED_PAD_SIZES: readonly number[] = [512, 1024, 2048, 4096, 8192, 17_103];
/** What a box adds to its padded plaintext: the leading byte, `enc` and
 *  the AES-GCM tag (§4.3, §9). Both forms come in the same sizes. */
export const SEALED_OVERHEAD = 1 + 32 + 16;
/** `H`, how long a sealed message can be held (§3.10), in seconds. */
export const SEALED_HOLD_SECONDS = 24 * 3600;

const DENIABLE_KEY_BYTES = 32;

/** A device's two non-extractable private keys: `sign` its Ed25519
 *  `device`, `enc` its X25519 `device_enc`. */
export interface DeviceKeys {
  sign: CryptoKey;
  enc: CryptoKey;
}

function padSizes(deniable: boolean): number[] {
  return SEALED_PAD_SIZES.map((size) => size - (deniable ? DENIABLE_KEY_BYTES : 0));
}

/** A map followed by zeros, up to the smallest of its form's sizes it
 *  fits in. */
export function pad(map: Uint8Array, deniable: boolean): Uint8Array {
  const size = padSizes(deniable).find((s) => map.length <= s);
  if (size === undefined) throw new IdentityError('too-large', 'sealed message');
  const padded = new Uint8Array(size);
  padded.set(map);
  return padded;
}

/** The map a padded plaintext holds: exactly one CBOR item from the
 *  start, every byte after it zero, at one of its form's sizes. */
export function unpad(padded: Uint8Array, deniable: boolean): Uint8Array {
  if (!padSizes(deniable).includes(padded.length)) throw new IdentityError('bad-field', 'padding');
  const end = itemLength(padded);
  if (padded.subarray(end).some((b) => b !== 0)) throw new IdentityError('bad-field', 'padding');
  return padded.subarray(0, end);
}

/** Whether a box of this leading byte and length could hold a padded
 *  plaintext (§3.7): what a server checks a `sealed` it is handed by
 *  (§4.3), and a reader before anything is opened. */
export function checkSealedLength(form: number, length: number): void {
  if (form !== SEALED_SIGNED_BOX && form !== SEALED_DENIABLE_BOX) {
    throw new IdentityError('unsupported-version', String(form));
  }
  if (!SEALED_PAD_SIZES.some((size) => size + SEALED_OVERHEAD === length)) throw new IdentityError('bad-field', 'padding');
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
}

// --- sealing ----------------------------------------------------------------

/** Sign `message` with `sender` and seal it to the recipient device's
 *  `device_enc` key (§3.8); or, `deniable`, seal it unsigned under
 *  `sender`'s own `device_enc` key, which its certificate must name
 *  (§3.11). Refuses what a reader would: a field out of bounds, or a
 *  certificate that does not allow messages, is not valid at `sent` or
 *  is not `sender`'s; and a recipient key whose X25519 result is all
 *  zeros. */
export function sealMessage(
  message: SignedPrivateMessage,
  sender: DeviceKeys,
  recipient: Uint8Array,
  deniable = false,
): Promise<Uint8Array> {
  return sealWithIkm(message, sender, recipient, deniable);
}

/** To the `device_enc` of `recipient`, a certificate as `device_cert`
 *  answers it (§4.2), once it passes §3.9 step 5's checks at `sent` and
 *  `now` and its identity is the one `message.to` names. hl-identity's
 *  `seal_to` takes a certificate its caller checked; this one is handed
 *  the bytes a server chose, so it checks them itself. */
export async function sealMessageTo(
  message: SignedPrivateMessage,
  sender: DeviceKeys,
  recipientCert: Uint8Array,
  deniable = false,
  now = Math.floor(Date.now() / 1000),
): Promise<Uint8Array> {
  const recipient = await checkMessageCert(recipientCert, BigInt(Math.floor(message.sent)), BigInt(Math.floor(now)));
  if (!sameBytes(await sha256(recipient.identity), message.to)) {
    throw new IdentityError('key-mismatch', 'the certificate is not of the identity `to` names');
  }
  return sealMessage(message, sender, recipient.deviceEnc, deniable);
}

/** `sealMessage` with the ephemeral key derived from `ikm` (RFC 9180
 *  `DeriveKeyPair`), so a test vector's box can be made again byte for
 *  byte. Only the vectors may pass one: one `ikm` used twice to the same
 *  recipient repeats the AES-GCM key and nonce under two plaintexts,
 *  which lets anyone forge a box, and anyone who knows it can open one. */
export async function sealWithIkm(
  message: SignedPrivateMessage,
  sender: DeviceKeys,
  recipient: Uint8Array,
  deniable: boolean,
  ikm?: Uint8Array,
): Promise<Uint8Array> {
  if (!deniable) {
    const plaintext = pad(await signedPrivateMessages.sign(sender.sign, message), false);
    return sealPadded(plaintext, recipient, null, ikm);
  }
  const unsigned = privateMessageMaps.unsignedPrivateMessage(message);
  const sent = BigInt(Math.floor(message.sent));
  const cert = await checkMessageCert(message.cert, sent, sent);
  const pk = await x25519PublicKey(sender.enc);
  if (!sameBytes(cert.deviceEnc, pk)) throw new IdentityError('key-mismatch', 'the certificate names another device_enc');
  return sealPadded(pad(unsigned, true), recipient, { sk: sender.enc, pk }, ikm);
}

/** The box around a padded plaintext: base mode, or auth mode under
 *  `sender`. */
export async function sealPadded(
  plaintext: Uint8Array,
  recipient: Uint8Array,
  sender: HpkeSender | null,
  ikm?: Uint8Array,
): Promise<Uint8Array> {
  const form = sender ? SEALED_DENIABLE_BOX : SEALED_SIGNED_BOX;
  const info = textEncoder.encode(sender ? SEALED_DENIABLE_INFO : SEALED_SIGNED_INFO);
  let boxed: { enc: Uint8Array; ct: Uint8Array };
  try {
    boxed = await hpkeSeal(recipient, info, new Uint8Array([form]), plaintext, sender, ikm);
  } catch (e) {
    if (e instanceof HpkeError) throw new IdentityError('invalid-key', 'device_enc');
    throw e;
  }
  const out = new Uint8Array(1 + (sender ? DENIABLE_KEY_BYTES : 0) + boxed.enc.length + boxed.ct.length);
  out[0] = form;
  if (sender) out.set(sender.pk, 1);
  out.set(boxed.enc, sender ? 1 + DENIABLE_KEY_BYTES : 1);
  out.set(boxed.ct, out.length - boxed.ct.length);
  return out;
}

// --- opening ----------------------------------------------------------------

/** What a reader knows about a box it was handed. Times are Unix
 *  seconds. */
export interface SealedOpening {
  /** The reader's own clock. */
  now: number;
  /** When the reader's server received it (`at`): for display and the
   *  certificate's window, never for freshness (§3.10). */
  at: number;
  /** The fingerprint the reader's session proved, which `to` must name. */
  reader: string;
  /** The fingerprint the sender is shown with (§3.9): `named` with the
   *  event's `from.fingerprint` when the roster shows it for the
   *  sender's uid or shows nobody there, and with the roster's when it
   *  shows another; `unknown` when it shows the uid with none, or the
   *  event names none. `certificate` opens the box as from its
   *  certificate's identity, checked against nothing: never for a live
   *  `msg`, whose sender the server names. */
  sender: SignedSender;
}

/** The sealed messages a device has accepted (§3.10), which the caller
 *  keeps: stored with the device key, across restarts, and shared by
 *  every session using it. Signers are fingerprints' string form. */
export interface SealedReplay {
  /** Records `now` as a time the reader's clock has shown, and returns
   *  the latest it has shown, which the memory is pruned by: so a clock
   *  set back neither empties it nor reopens the window. */
  latest(now: number): number | Promise<number>;
  /** Whether `(signer, id)` was accepted. */
  accepted(signer: string, id: Uint8Array): boolean | Promise<boolean>;
  /** Records `(signer, id)` as accepted until `until`, in one atomic
   *  insert-if-absent, written before the message is shown: `false` if
   *  it was there already. */
  accept(signer: string, id: Uint8Array, until: number): boolean | Promise<boolean>;
}

/** A `SealedReplay` that lasts as long as the object: for a process
 *  that holds its device key no longer, and for tests. */
export class MemorySealedReplay implements SealedReplay {
  private latestSeen = 0;
  private readonly until = new Map<string, number>();

  latest(now: number): number {
    this.latestSeen = Math.max(this.latestSeen, now);
    for (const [key, until] of this.until) if (until < this.latestSeen) this.until.delete(key);
    return this.latestSeen;
  }

  accepted(signer: string, id: Uint8Array): boolean {
    return this.until.has(replayKey(signer, id));
  }

  accept(signer: string, id: Uint8Array, until: number): boolean {
    const key = replayKey(signer, id);
    if (this.until.has(key)) return false;
    this.until.set(key, until);
    return true;
  }
}

const replayKey = (signer: string, id: Uint8Array) => `${signer}/${[...id].join(',')}`;

/** A box's form: signed (0x01) or deniable (0x02). */
export type SealedForm = 'signed' | 'deniable';

/** §8's states for a sealed message. `signer` is the fingerprint of the
 *  certificate's identity, never what a server says; `sentApart` says
 *  `sent` is more than S from `at`, so it is shown as sent at its signed
 *  time. */
export type SealedOutcome =
  /** A signed box that passed every step: shown as from its signer. */
  | { state: 'verified'; form: 'signed'; message: Signed<SignedPrivateMessage, MessageScope>; signer: string; sentApart: boolean }
  /** A deniable box that passed every step that applies: shown as from
   *  the certificate's identity, and as one its recipient could not
   *  prove to anyone. `senderEnc` is the `pkS` it opened under, which is
   *  the certificate's `device_enc`. */
  | {
      state: 'deniable';
      form: 'deniable';
      message: SignedPrivateMessage;
      cert: DeviceCert;
      signer: string;
      senderEnc: Uint8Array;
      sentApart: boolean;
    }
  /** Valid, from a uid the roster shows with no fingerprint. Its text is
   *  hidden until the user reveals it on purpose, and it is not
   *  recorded. `whole` is a signed box's map, which a report carries
   *  (§4.12); `null` for a deniable one. */
  | { state: 'unverified'; form: SealedForm; message: SignedPrivateMessage; signer: string; whole: Uint8Array | null }
  /** Failed step 5 or 6: its text hidden until the user reveals it on
   *  purpose, never shown as from that user, and not recorded. Anyone
   *  who holds the recipient's certificate can seal one. */
  | { state: 'invalid'; form: SealedForm; message: SignedPrivateMessage; error: Error }
  /** Stale, or accepted already (steps 3, 4 and 7): not shown at all. */
  | { state: 'dropped'; error: Error }
  /** Failed step 1 or 2: shown as a message that could not be opened. */
  | { state: 'unopened'; error: Error };

/** §3.9 in order, and §3.11 for a deniable box, with the reader's
 *  `device_enc` key. */
export async function openSealed(
  sealed: Uint8Array,
  reader: CryptoKey,
  ctx: SealedOpening,
  memory: SealedReplay,
): Promise<SealedOutcome> {
  // Whole seconds, as hl-identity reads them, so the edges fall alike.
  ctx = { ...ctx, now: Math.floor(ctx.now), at: Math.floor(ctx.at) };
  let opened: { message: SignedPrivateMessage; whole: Uint8Array | null; pkS: Uint8Array | null };
  try {
    const { padded, pkS } = await unbox(sealed, reader);
    opened = { ...readMap(padded, pkS !== null, ctx.reader), pkS };
  } catch (error) {
    if (!(error instanceof IdentityError) && !(error instanceof CborError)) throw error;
    return { state: 'unopened', error };
  }
  const { message, whole, pkS } = opened;
  const form: SealedForm = pkS ? 'deniable' : 'signed';
  const latest = await memory.latest(ctx.now);
  if (!fresh(message.sent, ctx.now, latest)) {
    return { state: 'dropped', error: new IdentityError('clock-skew', 'sent') };
  }
  const claimed = await claimedSigner(message.cert);
  if (claimed !== null && (await memory.accepted(claimed, message.id))) return dropped();
  let checked: { cert: DeviceCert; signed: Signed<SignedPrivateMessage, MessageScope> | null };
  try {
    checked = await verify(message, whole, pkS, ctx);
  } catch (error) {
    if (!(error instanceof IdentityError) && !(error instanceof CborError)) throw error;
    return { state: 'invalid', form, message, error };
  }
  const signer = fingerprintToString(await sha256(checked.cert.identity));
  if (ctx.sender === 'unknown') return { state: 'unverified', form, message, signer, whole };
  if (!(await memory.accept(signer, message.id, message.sent + SEALED_HOLD_SECONDS + SIGNED_SKEW_SECONDS))) return dropped();
  const sentApart = Math.abs(message.sent - ctx.at) > SIGNED_SKEW_SECONDS;
  if (checked.signed) return { state: 'verified', form: 'signed', message: checked.signed, signer, sentApart };
  return { state: 'deniable', form: 'deniable', message, cert: checked.cert, signer, senderEnc: Uint8Array.from(pkS!), sentApart };
}

const dropped = (): SealedOutcome => ({ state: 'dropped', error: new IdentityError('replayed', 'sealed message') });

const openFailed = () => new IdentityError('open-failed', 'sealed message');

/** Step 1: the padded plaintext, and for a deniable box the `pkS` it
 *  opened under. */
async function unbox(sealed: Uint8Array, reader: CryptoKey): Promise<{ padded: Uint8Array; pkS: Uint8Array | null }> {
  const form = sealed[0];
  if (form === undefined) throw openFailed();
  checkSealedLength(form, sealed.length);
  const deniable = form === SEALED_DENIABLE_BOX;
  const pkS = deniable ? sealed.subarray(1, 1 + DENIABLE_KEY_BYTES) : null;
  const rest = sealed.subarray(deniable ? 1 + DENIABLE_KEY_BYTES : 1);
  const info = textEncoder.encode(deniable ? SEALED_DENIABLE_INFO : SEALED_SIGNED_INFO);
  try {
    const padded = await hpkeOpen(rest.subarray(0, 32), reader, info, new Uint8Array([form]), rest.subarray(32), pkS);
    return { padded, pkS };
  } catch (e) {
    if (e instanceof HpkeError) throw openFailed();
    throw e;
  }
}

/** Step 2: the padding, then a deterministic map of §3.2's fields with
 *  `v = 1`, holding `sig` exactly when the box is signed, sent to the
 *  reader. */
function readMap(
  padded: Uint8Array,
  deniable: boolean,
  reader: string,
): { message: SignedPrivateMessage; whole: Uint8Array | null } {
  const whole = unpad(padded, deniable);
  const message = privateMessageMaps.sealedPrivateMessage(decodeCanonical(whole), deniable);
  const fp = fingerprintFromString(reader);
  if (!fp || !sameBytes(message.to, fp)) throw new IdentityError('bad-field', 'to');
  return { message, whole: deniable ? null : Uint8Array.from(whole) };
}

/** Step 3 (§3.10): `sent` no earlier than `H` before the later of `now`
 *  and the latest time the clock has shown, and no later than `S` after
 *  `now`. */
function fresh(sent: number, now: number, latest: number): boolean {
  return sent >= Math.max(now, latest) - SEALED_HOLD_SECONDS && sent <= now + SIGNED_SKEW_SECONDS;
}

/** Step 4's signer, read from `cert` as its identity signed it and
 *  before the rest of step 5 checks it; `null` for one that does not
 *  parse, which goes on to fail step 5. */
async function claimedSigner(cert: Uint8Array): Promise<string | null> {
  try {
    const { identity } = decodeDeviceCert(cert);
    await verifyEnvelope(cert, identity, DEVICE_CERT_DOMAIN);
    return fingerprintToString(await sha256(identity));
  } catch {
    return null;
  }
}

/** Steps 5 and 6: the certificate as §3.5 checks it, valid now as well,
 *  its identity the one the sender is shown with and, in a deniable box,
 *  its `device_enc` the `pkS` the box opened under; then the signature. */
async function verify(
  message: SignedPrivateMessage,
  whole: Uint8Array | null,
  pkS: Uint8Array | null,
  ctx: SealedOpening,
): Promise<{ cert: DeviceCert; signed: Signed<SignedPrivateMessage, MessageScope> | null }> {
  const cert = await checkMessageCert(message.cert, BigInt(Math.floor(message.sent)), BigInt(ctx.at), BigInt(ctx.now));
  if (typeof ctx.sender === 'object') {
    const named = fingerprintFromString(ctx.sender.named);
    if (!named || !sameBytes(named, await sha256(cert.identity))) {
      throw new IdentityError('key-mismatch', 'the sender is shown as another identity');
    }
  }
  if (pkS && !sameBytes(pkS, cert.deviceEnc)) throw new IdentityError('key-mismatch', 'the certificate names another device_enc');
  // A signed box's map is parsed again for its signature, whose checks
  // before it have passed already.
  return { cert, signed: whole ? await signedPrivateMessages.parse(whole, ctx.at) : null };
}
