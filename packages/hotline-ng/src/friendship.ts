/**
 * Friendship objects, hxd-ng's `docs/proposals/friendship-objects.md`:
 * an offer, the acceptance that answers it, the friendship the two make,
 * the withdrawal that ends friendships between a pair, and the rotation
 * records (`identity-registrar.md` §4.6) a withdrawal's checks follow.
 * Each object is signed by a device key whose certificate it carries
 * (§1), and each check runs the document's steps in its order, a refusal
 * naming the step it failed at. Mirrors `crates/hl-identity/src/
 * friendship.rs` check for check, so a client here refuses what hxd-ng
 * refuses, at the same step and with the same error.
 *
 * Transport-free: bytes in, bytes out. Fingerprints are the 32-byte
 * digests the objects carry; `fingerprintToString` is their display.
 */

import { CborError, cArray, cBytes, cOptMap, cUint, decodeCanonical, encode, mapGet, mapWithout, type CborValue } from './cbor.js';
import { isStrongKey, verifyStrict } from './ed25519.js';
import { CAPS, DEVICE_CERT_DOMAIN, IdentityError, decodeDeviceCert, type DeviceCert } from './identity.js';
import { SIGNED_CERT_MAX_BYTES, SIGNED_SKEW_SECONDS } from './message.js';

export const FRIEND_OFFER_DOMAIN = 'hl-identity/friend-offer/v1';
export const FRIEND_ACCEPT_DOMAIN = 'hl-identity/friend-accept/v1';
export const FRIEND_WITHDRAW_DOMAIN = 'hl-identity/friend-withdraw/v1';
export const FRIEND_PAIR_DOMAIN = 'hl-identity/friend-pair/v1';
export const ROTATE_DOMAIN = 'hl-identity/rotate/v1';

/** The bound on each object, and on each element of a friendship. */
export const FRIEND_OBJECT_MAX_BYTES = 1024;
/** A friendship's array at its longest: its head, and two elements at
 *  the bound behind three-byte heads. Checked before it is decoded. */
export const FRIENDSHIP_MAX_BYTES = 1 + 2 * (3 + FRIEND_OBJECT_MAX_BYTES);
/** How long after its `time` an offer may expire (§2). */
export const FRIEND_OFFER_MAX_LIFETIME_SECONDS = 30 * 24 * 3600;
/** A rotation record's bound (`identity-registrar.md` §4.6). */
export const ROTATION_MAX_BYTES = 512;

const textEncoder = new TextEncoder();
const SKEW = BigInt(SIGNED_SKEW_SECONDS);

/** Why a check refused an object: the step it failed at, and what
 *  failed there. */
export class FriendshipRefused extends Error {
  constructor(
    readonly step: number,
    readonly error: IdentityError | CborError,
  ) {
    super(`step ${step}: ${error.message}`);
    this.name = 'FriendshipRefused';
  }
}

async function at<T>(step: number, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof IdentityError || e instanceof CborError) throw new FriendshipRefused(step, e);
    throw e;
  }
}

/** An offer (§2). Times are approximate past 2^53; the checks read them
 *  exactly. */
export interface FriendOffer {
  /** The offering identity's public key. */
  from: Uint8Array;
  /** The offered identity's fingerprint. */
  to: Uint8Array;
  time: number;
  expires: number;
  id: Uint8Array;
  cert: Uint8Array;
  /** The offer's whole encoding, and its SHA-256, which an acceptance
   *  names it by. */
  raw: Uint8Array;
  hash: Uint8Array;
  /** The SHA-256 of `from`. */
  offerer: Uint8Array;
}

/** An acceptance (§3). */
export interface FriendAcceptance {
  /** The SHA-256 of the offer it answers. */
  offer: Uint8Array;
  from: Uint8Array;
  time: number;
  cert: Uint8Array;
  raw: Uint8Array;
}

/** A friendship (§3), both halves checked. */
export interface Friendship {
  offer: FriendOffer;
  acceptance: FriendAcceptance;
  /** The array's bytes, and their SHA-256, the friendship hash. */
  raw: Uint8Array;
  hash: Uint8Array;
  /** The pair hash of its two fingerprints. */
  pair: Uint8Array;
}

/** A withdrawal (§4) as signed and read. What ends friendships is a
 *  `FriendCutoff`, which only a whole check gives. */
export interface FriendWithdrawal {
  from: Uint8Array;
  pair: Uint8Array;
  /** As written: absent means `from`'s own fingerprint. */
  party: Uint8Array | undefined;
  /** `party`, or the SHA-256 of `from`. */
  effectiveParty: Uint8Array;
  before: number;
  time: number;
  cert: Uint8Array;
  raw: Uint8Array;
}

declare const kept: unique symbol;
declare const held: unique symbol;
/** A withdrawal that passed the steps that need no pair, kept until one
 *  it names is known; it ends nothing until `checkWithdrawalPair`. */
export type KeptWithdrawal = FriendWithdrawal & { readonly [kept]: true };
/** A withdrawal checked whole, whose cutoff a checker holds. */
export type HeldWithdrawal = FriendWithdrawal & { readonly [held]: true };

/** What a withdrawal ends, apart from who signed it: what a client keeps
 *  of one, to sign afresh for each server (portable-friends.md §5.1). */
export interface FriendCutoff {
  pair: Uint8Array;
  party: Uint8Array;
  before: number;
}

/** A rotation record (`identity-registrar.md` §4.6), both signatures
 *  checked, with the fingerprints a chain is followed by. */
export interface IdentityRotation {
  identity: Uint8Array;
  successor: Uint8Array;
  identityFingerprint: Uint8Array;
  successorFingerprint: Uint8Array;
  time: number;
  raw: Uint8Array;
}

// --- bytes and fields --------------------------------------------------------

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

function field(v: CborValue, key: string, t: CborValue['t']): CborValue | undefined {
  const f = mapGet(v, key);
  if (f !== undefined && f.t !== t) throw new IdentityError('bad-field', key);
  return f;
}

function big(v: CborValue, key: string): bigint {
  const f = field(v, key, 'uint');
  if (f === undefined) throw new IdentityError('missing-field', key);
  return f.v as bigint;
}

function optBytes(v: CborValue, key: string, len?: number): Uint8Array | undefined {
  const b = field(v, key, 'bytes')?.v as Uint8Array | undefined;
  if (b !== undefined && len !== undefined && b.length !== len) throw new IdentityError('bad-field', key);
  return b;
}

function bytes(v: CborValue, key: string, len?: number): Uint8Array {
  const b = optBytes(v, key, len);
  if (b === undefined) throw new IdentityError('missing-field', key);
  return b;
}

/** Canonical, a map, `v = 1` and a 64-byte `sig`, as `signed::Envelope`
 *  opens one, after the size bound. */
function open(raw: Uint8Array, max: number, acked = false): CborValue {
  if (raw.length > max) throw new IdentityError('too-large', 'friendship object');
  const value = decodeCanonical(raw);
  if (value.t !== 'map') throw new IdentityError('not-a-map', 'not a CBOR map');
  const v = big(value, 'v');
  if (v !== 1n) throw new IdentityError('unsupported-version', String(v));
  bytes(value, 'sig', 64);
  if (acked) bytes(value, 'ack', 64);
  return value;
}

/** `verify_domain`: a strong key, and a strict signature over the domain,
 *  a NUL and `body`. */
async function verifyDomain(key: Uint8Array, domain: string, body: Uint8Array, sig: Uint8Array): Promise<void> {
  if (!isStrongKey(key)) throw new IdentityError('invalid-key', domain);
  const message = new Uint8Array([...textEncoder.encode(domain), 0, ...body]);
  if (!(await verifyStrict(key, message, sig))) throw new IdentityError('bad-signature', domain);
}

const signedBody = (value: CborValue) => encode(mapWithout(value, 'sig'));

/** A `time` no later than `now + S`. */
function notAhead(time: bigint, now: number): void {
  if (time > BigInt(Math.floor(now)) + SKEW) throw new IdentityError('clock-skew', 'friendship object');
}

interface CertAt {
  cert: DeviceCert;
  value: CborValue;
}

/** §1's certificate: at most 512 bytes, for `from`, allowing messages,
 *  and valid at `time`. Its signature is the next step's. */
function certAt(raw: Uint8Array, from: Uint8Array, time: bigint): CertAt {
  if (raw.length > SIGNED_CERT_MAX_BYTES) throw new IdentityError('bad-field', 'cert');
  const cert = decodeDeviceCert(raw);
  const value = decodeCanonical(raw);
  if (!sameBytes(cert.identity, from)) throw new IdentityError('key-mismatch', 'the certificate is for another identity');
  const caps = mapGet(value, 'caps') === undefined ? undefined : big(value, 'caps');
  const message = BigInt(CAPS.MESSAGE);
  if (caps !== undefined && (caps & message) !== message) throw new IdentityError('capability-missing', 'message');
  const [issued, expires] = [big(value, 'issued'), big(value, 'expires')];
  if (expires <= issued || issued > time + SKEW) throw new IdentityError('not-yet-valid', 'device certificate');
  if (expires + SKEW < time) throw new IdentityError('expired', 'device certificate');
  return { cert, value };
}

/** The identity key's signature on the certificate, then its device
 *  key's on the object. */
async function verify({ cert, value: certValue }: CertAt, value: CborValue, domain: string): Promise<void> {
  await verifyDomain(cert.identity, DEVICE_CERT_DOMAIN, signedBody(certValue), bytes(certValue, 'sig'));
  await verifyDomain(cert.device, domain, signedBody(value), bytes(value, 'sig'));
}

// --- the pair ---------------------------------------------------------------

/** The pair hash (§4): SHA-256 of the domain, a NUL, and the lesser and
 *  the greater of the two fingerprints, however they are given. */
export function pairHash(a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(new Uint8Array([...textEncoder.encode(FRIEND_PAIR_DOMAIN), 0, ...lo, ...hi]));
}

/** Whether `c` ends a half by `party`, dated `time`, of a friendship
 *  between the pair `pair` hashes to. A half dated exactly `before`
 *  stands. */
export function cutoffEnds(c: FriendCutoff, pair: Uint8Array, party: Uint8Array, time: number): boolean {
  return sameBytes(c.pair, pair) && sameBytes(c.party, party) && time < c.before;
}

/** Whether `c` ends this offer: a friendship made from it would have a
 *  half by the offerer that `c` ends. One by the offeree does not, since
 *  an acceptance signed after it postdates its cutoff. */
export async function offerEndedBy(o: FriendOffer, c: FriendCutoff): Promise<boolean> {
  return cutoffEnds(c, await pairHash(o.offerer, o.to), o.offerer, o.time);
}

/** Whether `c` ends this friendship: its half by `c`'s party is dated
 *  before `c`'s `before`. */
export function friendshipEndedBy(f: Friendship, c: FriendCutoff): boolean {
  return cutoffEnds(c, f.pair, f.offer.offerer, f.offer.time) || cutoffEnds(c, f.pair, f.offer.to, f.acceptance.time);
}

/** What a withdrawal that passed its whole check ends. */
export function cutoffOf(w: HeldWithdrawal): FriendCutoff {
  return { pair: w.pair, party: w.effectiveParty, before: w.before };
}

// --- offer ------------------------------------------------------------------

interface Read<T> {
  object: T;
  value: CborValue;
}

async function readOffer(raw: Uint8Array): Promise<Read<FriendOffer>> {
  const value = open(raw, FRIEND_OBJECT_MAX_BYTES);
  const from = bytes(value, 'from', 32);
  const to = bytes(value, 'to', 32);
  const [time, expires] = [big(value, 'time'), big(value, 'expires')];
  const id = bytes(value, 'id', 16);
  const cert = bytes(value, 'cert');
  if (expires <= time || expires > time + BigInt(FRIEND_OFFER_MAX_LIFETIME_SECONDS)) {
    throw new IdentityError('bad-field', 'expires');
  }
  const offerer = await sha256(from);
  if (sameBytes(to, offerer)) throw new IdentityError('bad-field', 'to');
  const object = { from, to, time: Number(time), expires: Number(expires), id, cert, raw, hash: await sha256(raw), offerer };
  return { object, value };
}

/** A lone offer, as a server takes it and as a client checks one it is
 *  sent: §3's step 1 without the array, then steps 3 to 6, against the
 *  cutoffs the checker holds. Nothing here compares `expires` with
 *  `now`: that is the caller's (a client accepts an offer only while its
 *  clock is at most `expires`). */
export async function checkFriendOffer(raw: Uint8Array, now: number, held: readonly FriendCutoff[] = []): Promise<FriendOffer> {
  const { object: offer, value } = await at(1, () => readOffer(raw));
  await at(3, () => notAhead(big(value, 'time'), now));
  const cert = await at(4, () => certAt(offer.cert, offer.from, big(value, 'time')));
  await at(5, () => verify(cert, value, FRIEND_OFFER_DOMAIN));
  for (const c of held) {
    if (await offerEndedBy(offer, c)) throw new FriendshipRefused(6, new IdentityError('withdrawn', 'friend offer'));
  }
  return offer;
}

// --- acceptance and friendship ------------------------------------------------

function readAcceptance(raw: Uint8Array): Read<FriendAcceptance> {
  const value = open(raw, FRIEND_OBJECT_MAX_BYTES);
  const object = {
    offer: bytes(value, 'offer', 32),
    from: bytes(value, 'from', 32),
    time: Number(big(value, 'time')),
    cert: bytes(value, 'cert'),
    raw,
  };
  return { object, value };
}

/** The array a friendship is carried as: the offer's bytes, then the
 *  acceptance's. */
export function friendshipBytes(offer: Uint8Array, acceptance: Uint8Array): Uint8Array {
  return encode(cArray([cBytes(offer), cBytes(acceptance)]));
}

/** The array's two byte strings, and nothing else in their place. */
function split(raw: Uint8Array): [Uint8Array, Uint8Array] {
  if (raw.length > FRIENDSHIP_MAX_BYTES) throw new IdentityError('too-large', 'friendship');
  const v = decodeCanonical(raw);
  if (v.t !== 'array' || v.v.length !== 2 || v.v[0]!.t !== 'bytes' || v.v[1]!.t !== 'bytes') {
    throw new IdentityError('bad-field', 'friendship');
  }
  return [v.v[0]!.v, v.v[1]!.v];
}

/** §3's six steps, in order, against the cutoffs the checker holds. */
export async function checkFriendship(raw: Uint8Array, now: number, held: readonly FriendCutoff[] = []): Promise<Friendship> {
  const [o, a] = await at(1, async () => {
    const [offerBytes, acceptBytes] = split(raw);
    return [await readOffer(offerBytes), readAcceptance(acceptBytes)] as const;
  });
  const [offer, acceptance] = [o.object, a.object];
  await at(2, async () => {
    if (!sameBytes(acceptance.offer, offer.hash)) throw new IdentityError('bad-field', 'offer');
    if (!sameBytes(await sha256(acceptance.from), offer.to) || sameBytes(acceptance.from, offer.from)) {
      throw new IdentityError('key-mismatch', 'the acceptance is not by the offer\'s `to`');
    }
  });
  const [offerTime, acceptTime] = [big(o.value, 'time'), big(a.value, 'time')];
  await at(3, () => {
    notAhead(offerTime, now);
    notAhead(acceptTime, now);
    if (acceptTime < offerTime || acceptTime > big(o.value, 'expires')) throw new IdentityError('bad-field', 'time');
  });
  const [offerCert, acceptCert] = await at(4, () => [
    certAt(offer.cert, offer.from, offerTime),
    certAt(acceptance.cert, acceptance.from, acceptTime),
  ]);
  await at(5, async () => {
    await verify(offerCert, o.value, FRIEND_OFFER_DOMAIN);
    await verify(acceptCert, a.value, FRIEND_ACCEPT_DOMAIN);
  });
  const friendship = { offer, acceptance, raw, hash: await sha256(raw), pair: await pairHash(offer.offerer, offer.to) };
  if (held.some((c) => friendshipEndedBy(friendship, c))) {
    throw new FriendshipRefused(6, new IdentityError('withdrawn', 'friendship'));
  }
  return friendship;
}

// --- withdrawal -------------------------------------------------------------

async function readWithdrawal(raw: Uint8Array, now: number): Promise<Read<FriendWithdrawal>> {
  const { object, value } = await at(1, async () => {
    const value = open(raw, FRIEND_OBJECT_MAX_BYTES);
    const from = bytes(value, 'from', 32);
    const pair = bytes(value, 'pair', 32);
    const party = optBytes(value, 'party', 32);
    const [before, time] = [big(value, 'before'), big(value, 'time')];
    const cert = bytes(value, 'cert');
    const own = await sha256(from);
    if (party && sameBytes(party, own)) throw new IdentityError('bad-field', 'party');
    const object = { from, pair, party, effectiveParty: party ?? own, before: Number(before), time: Number(time), cert, raw };
    return { object, value };
  });
  await at(2, () => {
    if (big(value, 'before') > big(value, 'time')) throw new IdentityError('bad-field', 'before');
    notAhead(big(value, 'time'), now);
  });
  return { object, value };
}

async function verifyWithdrawal({ object: w, value }: Read<FriendWithdrawal>): Promise<void> {
  const cert = await at(5, () => certAt(w.cert, w.from, big(value, 'time')));
  await at(6, () => verify(cert, value, FRIEND_WITHDRAW_DOMAIN));
}

/** Steps 1, 2, 5 and 6, which need nothing but the withdrawal: what a
 *  checker holding no pair that `pair` matches may keep one on. It ends
 *  nothing until `checkWithdrawalPair` passes too. */
export async function parseFriendWithdrawal(raw: Uint8Array, now: number): Promise<KeptWithdrawal> {
  const read = await readWithdrawal(raw, now);
  await verifyWithdrawal(read);
  return read.object as KeptWithdrawal;
}

/** All six steps, in order, against the pair's two fingerprints and the
 *  rotations the checker has applied, each already checked. */
export async function checkFriendWithdrawal(
  raw: Uint8Array,
  now: number,
  pair: readonly [Uint8Array, Uint8Array],
  rotations: readonly IdentityRotation[] = [],
): Promise<HeldWithdrawal> {
  const read = await readWithdrawal(raw, now);
  await pairRules(read.object, pair, rotations);
  await verifyWithdrawal(read);
  return read.object as HeldWithdrawal;
}

/** Steps 3 and 4, the rest of the check of one `parseFriendWithdrawal`
 *  kept, once a pair it names is known. */
export async function checkWithdrawalPair(
  w: KeptWithdrawal,
  pair: readonly [Uint8Array, Uint8Array],
  rotations: readonly IdentityRotation[] = [],
): Promise<FriendCutoff> {
  await pairRules(w, pair, rotations);
  return cutoffOf(w as FriendWithdrawal as HeldWithdrawal);
}

async function pairRules(w: FriendWithdrawal, [a, b]: readonly [Uint8Array, Uint8Array], rotations: readonly IdentityRotation[]): Promise<void> {
  await at(3, async () => {
    if (!sameBytes(w.pair, await pairHash(a, b))) throw new IdentityError('key-mismatch', 'the withdrawal is for another pair');
  });
  await at(4, async () => {
    // A chain ends only at a key with no rotation away from it, so a key
    // the checker has seen rotated away from is refused wherever it sits
    // in the chain: what it signs after the rotation may be a thief's.
    const from = await sha256(w.from);
    const ends = [rotationChainEnd(a, rotations), rotationChainEnd(b, rotations)];
    if (!ends.some((e) => e !== null && sameBytes(e, from))) {
      throw new IdentityError('key-mismatch', 'the withdrawal is from outside the pair');
    }
    const party = w.effectiveParty;
    if (!sameBytes(party, a) && !sameBytes(party, b)) throw new IdentityError('bad-field', 'party');
    if (rotations.some((r) => sameBytes(r.identityFingerprint, party) && w.before > r.time)) {
      throw new IdentityError('bad-field', 'before');
    }
  });
}

// --- rotation ---------------------------------------------------------------

/** A rotation record, signed by the predecessor (`sig`) and acknowledged
 *  by the successor (`ack`, under the domain with `/ack`), both over the
 *  map without either. */
export async function parseRotation(raw: Uint8Array): Promise<IdentityRotation> {
  const value = open(raw, ROTATION_MAX_BYTES, true);
  const identity = bytes(value, 'identity', 32);
  const successor = bytes(value, 'successor', 32);
  const time = Number(big(value, 'time'));
  if (sameBytes(identity, successor)) throw new IdentityError('bad-field', 'successor');
  const body = encode(mapWithout(mapWithout(value, 'sig'), 'ack'));
  await verifyDomain(identity, ROTATE_DOMAIN, body, bytes(value, 'sig'));
  await verifyDomain(successor, `${ROTATE_DOMAIN}/ack`, body, bytes(value, 'ack'));
  return { identity, successor, identityFingerprint: await sha256(identity), successorFingerprint: await sha256(successor), time, raw };
}

/** The last key of the chain of rotations from `start`, a fingerprint,
 *  or `null` where the rotations fork or loop, so that no one key ends
 *  it: the key that takes `start`'s place in every check made after
 *  applying them (portable-friends.md §4.4). */
export function rotationChainEnd(start: Uint8Array, rotations: readonly IdentityRotation[]): Uint8Array | null {
  let key = start;
  for (let i = 0; i <= rotations.length; i++) {
    const next = rotations.filter((r) => sameBytes(r.identityFingerprint, key)).map((r) => r.successorFingerprint);
    if (next.length === 0) return key;
    if (!next.every((s) => sameBytes(s, next[0]!))) return null;
    key = next[0]!;
  }
  return null;
}

// --- signing ----------------------------------------------------------------

/** Each field its length, in the order a reader reads them, as
 *  hl-identity reads the unsigned map before it signs. */
function lengths(fields: [string, Uint8Array | undefined, number][]): void {
  for (const [key, b, len] of fields) if (b !== undefined && b.length !== len) throw new IdentityError('bad-field', key);
}

async function seal(
  deviceSignKey: CryptoKey,
  domain: string,
  entries: [string, CborValue | undefined][],
  from: Uint8Array,
  cert: Uint8Array,
  time: number,
): Promise<Uint8Array> {
  const checked = certAt(cert, from, BigInt(time));
  await verifyDomain(checked.cert.identity, DEVICE_CERT_DOMAIN, signedBody(checked.value), bytes(checked.value, 'sig'));
  const unsigned = encode(cOptMap(entries));
  const input = new Uint8Array([...textEncoder.encode(domain), 0, ...unsigned]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, deviceSignKey, input as BufferSource));
  const whole = encode(cOptMap([...entries, ['sig', cBytes(sig)]]));
  // A key that cannot be exported cannot be compared with the
  // certificate's, so the signature is checked against it instead.
  try {
    await verifyDomain(checked.cert.device, domain, unsigned, sig);
  } catch {
    throw new IdentityError('key-mismatch', 'the certificate names another device key');
  }
  if (whole.length > FRIEND_OBJECT_MAX_BYTES) throw new IdentityError('too-large', 'friendship object');
  return whole;
}

export interface FriendOfferFields {
  /** This identity's public key, the certificate's `identity`. */
  from: Uint8Array;
  /** The fingerprint offered. */
  to: Uint8Array;
  time: number;
  expires: number;
  /** Random unless given. */
  id?: Uint8Array;
  cert: Uint8Array;
}

/** Sign an offer, refusing what a checker would refuse without a clock. */
export async function signFriendOffer(deviceSignKey: CryptoKey, f: FriendOfferFields): Promise<Uint8Array> {
  const id = f.id ?? crypto.getRandomValues(new Uint8Array(16));
  lengths([['from', f.from, 32], ['to', f.to, 32], ['id', id, 16]]);
  const entries: [string, CborValue][] = [
    ['v', cUint(1)],
    ['from', cBytes(f.from)],
    ['to', cBytes(f.to)],
    ['time', cUint(f.time)],
    ['expires', cUint(f.expires)],
    ['id', cBytes(id)],
    ['cert', cBytes(f.cert)],
  ];
  if (f.expires <= f.time || f.expires > f.time + FRIEND_OFFER_MAX_LIFETIME_SECONDS) throw new IdentityError('bad-field', 'expires');
  if (sameBytes(f.to, await sha256(f.from))) throw new IdentityError('bad-field', 'to');
  return seal(deviceSignKey, FRIEND_OFFER_DOMAIN, entries, f.from, f.cert, f.time);
}

export interface FriendAcceptanceFields {
  /** The offer's bytes, as it came. */
  offer: Uint8Array;
  from: Uint8Array;
  time: number;
  cert: Uint8Array;
}

/** Sign an acceptance of `offer`. What it is checked against, the offer,
 *  is `checkFriendship`'s. */
export async function signFriendAcceptance(deviceSignKey: CryptoKey, f: FriendAcceptanceFields): Promise<Uint8Array> {
  lengths([['from', f.from, 32]]);
  const entries: [string, CborValue][] = [
    ['v', cUint(1)],
    ['offer', cBytes(await sha256(f.offer))],
    ['from', cBytes(f.from)],
    ['time', cUint(f.time)],
    ['cert', cBytes(f.cert)],
  ];
  return seal(deviceSignKey, FRIEND_ACCEPT_DOMAIN, entries, f.from, f.cert, f.time);
}

export interface FriendWithdrawalFields {
  from: Uint8Array;
  pair: Uint8Array;
  /** Left out where it would be `from`'s own fingerprint. */
  party?: Uint8Array;
  before: number;
  time: number;
  cert: Uint8Array;
}

/** Sign a withdrawal, refusing what a checker would refuse without a
 *  clock or a pair. `party` equal to `from`'s fingerprint is left out,
 *  so that each withdrawal has one encoding. */
export async function signFriendWithdrawal(deviceSignKey: CryptoKey, f: FriendWithdrawalFields): Promise<Uint8Array> {
  lengths([['from', f.from, 32], ['pair', f.pair, 32], ['party', f.party, 32]]);
  const party = f.party && !sameBytes(f.party, await sha256(f.from)) ? f.party : undefined;
  const entries: [string, CborValue | undefined][] = [
    ['v', cUint(1)],
    ['from', cBytes(f.from)],
    ['pair', cBytes(f.pair)],
    ['party', party && cBytes(party)],
    ['before', cUint(f.before)],
    ['time', cUint(f.time)],
    ['cert', cBytes(f.cert)],
  ];
  if (f.before > f.time) throw new IdentityError('bad-field', 'before');
  return seal(deviceSignKey, FRIEND_WITHDRAW_DOMAIN, entries, f.from, f.cert, f.time);
}
