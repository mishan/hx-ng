/**
 * `@hotline-ng/client/node`: what a program outside a browser needs that
 * a page keeps elsewhere, and that reads files to get. A device `hlid
 * init` wrote into `$HLID_HOME`, the identity login made with it, and
 * server key pins kept in a file. A subpath of its own so that the main
 * entry imports nothing from `node:`.
 */

import { constants } from 'node:fs';
import { lstat, open, readFile, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { CborError } from './cbor.js';
import { verifyStrict } from './ed25519.js';
import type { FollowedHandover, HandoverWarning, ServerPin, ServerPinStore, ServerTrust } from './handover.js';
import { importX25519Secret, x25519PublicKey } from './hpke.js';
import {
  AuthError,
  CAPS,
  CARD_DOMAIN,
  CARD_MAX_BYTES,
  DEVICE_CERT_DOMAIN,
  DEVICE_CERT_MAX_BYTES,
  IdentityError,
  SERVER_CHALLENGE_SKEW_SECONDS,
  bytesToHex,
  canonicalHost,
  decodeCard,
  decodeDeviceCert,
  fetchChallenge,
  fetchDiscovery,
  hexToBytes,
  postAuth,
  signLoginProof,
  verifyEnvelope,
  WRONG_HOST,
  type Card,
  type Challenge,
  type DeviceCert,
  type IdentityErrorKind,
  type Verified,
} from './identity.js';
import type { DeviceKeys } from './sealed.js';

const textEncoder = new TextEncoder();

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const unixNow = () => Math.floor(Date.now() / 1000);

/** This process's uid, where the platform has one. */
const ownUid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

/** Whether a file's mode says who may reach it. Windows reports group
 *  and other bits that mirror the owner's, whatever its ACLs allow, so
 *  there the ACLs are what protect a key or a pin file. */
const POSIX_MODES = process.platform !== 'win32';

// --- a device hlid wrote ---------------------------------------------------

/** The names `hlid init` writes, and every other `hlid` command reads. */
const DEVICE_KEY = 'device.key';
const CERT_FILE = 'cert.bin';
const CARD_FILE = 'card.bin';

/** RFC 8410's PKCS #8 for a raw Ed25519 seed: this prefix, then the
 *  seed. WebCrypto imports no raw Ed25519 private key. */
const PKCS8_ED25519_PREFIX = Uint8Array.of(
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
);
/** hl-identity's `DeviceKey::from_seed`: the X25519 secret is the
 *  SHA-256 of this and the seed. */
const DEVICE_ENC_DERIVATION = 'hl-identity/device-enc/v1';

/** A device directory as `loadDevice` checked it. */
export interface Device {
  /** Both non-extractable: `sign` the Ed25519 key `cert.device` names,
   *  `enc` the X25519 key `cert.deviceEnc` names, which opens sealed
   *  messages. */
  keys: DeviceKeys;
  cert: DeviceCert;
  card: Card;
}

/** `unsafe` is a file this process should not trust with a key: not a
 *  regular file, or a key file others can reach or another user owns. */
export type DeviceErrorKind = IdentityErrorKind | 'unreadable' | 'unsafe';

/** What `loadDevice` refused, and in which of the directory's files. */
export class DeviceError extends Error {
  constructor(
    readonly file: string,
    readonly kind: DeviceErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${file}: ${message}`, options);
    this.name = 'DeviceError';
  }
}

/** A seed in hex, with room for the whitespace around it. */
const DEVICE_KEY_MAX_BYTES = 128;

/**
 * Read at most `max` bytes of `file`, refusing a symbolic link and
 * anything but a regular file, and opened without blocking so that a
 * FIFO in its place is refused rather than waited on. A `secret` file
 * is refused, too, if group or others have any access to it, or if
 * `owner` is set and another user owns it.
 */
async function readDeviceFile(
  dir: string,
  file: string,
  max: number,
  check: { secret?: boolean; owner?: boolean } = {},
): Promise<Uint8Array> {
  const unsafe = (why: string) => new DeviceError(file, 'unsafe', why);
  const unreadable = (e: unknown) =>
    new DeviceError(file, 'unreadable', e instanceof Error ? e.message : String(e), { cause: e });
  const path = join(dir, file);
  let f: FileHandle;
  try {
    // Without O_NOFOLLOW, as on Windows, a link is looked for first.
    if (constants.O_NOFOLLOW === undefined && (await lstat(path)).isSymbolicLink()) throw unsafe('is a symbolic link');
    f = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if (e instanceof DeviceError) throw e;
    // ELOOP is O_NOFOLLOW's refusal of a link; FreeBSD's is EMLINK.
    const code = (e as { code?: unknown }).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw unsafe('is a symbolic link');
    throw unreadable(e);
  }
  try {
    const st = await f.stat();
    if (!st.isFile()) throw unsafe('is not a regular file');
    if (check.secret && POSIX_MODES && (st.mode & 0o077) !== 0) {
      throw unsafe(`is open to group or others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
    }
    const uid = ownUid();
    if (check.secret && check.owner && uid !== undefined && st.uid !== uid) throw unsafe('is owned by another user');
    const tooLarge = () => new DeviceError(file, 'too-large', `is larger than ${max} bytes`);
    if (st.size > max) throw tooLarge();
    // One byte past `max`, so a file that grew since `stat` is still
    // seen to be too large.
    const buf = new Uint8Array(max + 1);
    let n = 0;
    for (let got = -1; got !== 0 && n < buf.length; n += got) {
      got = (await f.read(buf, n, buf.length - n, n)).bytesRead;
    }
    if (n > max) {
      buf.fill(0);
      throw tooLarge();
    }
    const out = buf.slice(0, n);
    buf.fill(0);
    return out;
  } finally {
    await f.close();
  }
}

const isSpace = (b: number) => b === 0x20 || (b >= 0x09 && b <= 0x0d);
const nibble = (b: number) =>
  b >= 0x30 && b <= 0x39 ? b - 0x30 : b >= 0x61 && b <= 0x66 ? b - 0x57 : b >= 0x41 && b <= 0x46 ? b - 0x37 : -1;

/** `device.key`'s seed, parsed from the bytes rather than through a
 *  string, which could not be zeroed after. */
function parseSeed(raw: Uint8Array): Uint8Array | null {
  let start = 0;
  let end = raw.length;
  while (start < end && isSpace(raw[start]!)) start++;
  while (end > start && isSpace(raw[end - 1]!)) end--;
  if (end - start !== 64) return null;
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const hi = nibble(raw[start + 2 * i]!);
    const lo = nibble(raw[start + 2 * i + 1]!);
    if (hi < 0 || lo < 0) {
      seed.fill(0);
      return null;
    }
    seed[i] = (hi << 4) | lo;
  }
  return seed;
}

/** The window hl-identity's `check_window` holds a certificate to,
 *  under a server's default skew: what the server would refuse. */
function checkWindow(cert: DeviceCert, now: number): void {
  if (cert.expires <= cert.issued || cert.issued > now + SERVER_CHALLENGE_SKEW_SECONDS) {
    throw new DeviceError(CERT_FILE, 'not-yet-valid', `valid from ${cert.issued} until ${cert.expires}`);
  }
  if (cert.expires + SERVER_CHALLENGE_SKEW_SECONDS < now) {
    throw new DeviceError(CERT_FILE, 'expired', `expired at ${cert.expires}`);
  }
}

/** Decode and verify a signed object, blaming `file` for what fails. */
async function openSigned<T extends { identity: Uint8Array }>(
  file: string,
  bytes: Uint8Array,
  decode: (b: Uint8Array) => T,
  domain: string,
): Promise<T> {
  try {
    const value = decode(bytes);
    await verifyEnvelope(bytes, value.identity, domain);
    return value;
  } catch (e) {
    if (e instanceof IdentityError) throw new DeviceError(file, e.kind, e.message, { cause: e });
    if (e instanceof CborError) throw new DeviceError(file, 'bad-field', e.message, { cause: e });
    throw e;
  }
}

/**
 * Read and check the device in `dir`, as `hlid init` lays it out:
 * `device.key`, the 32-byte seed in hex; `cert.bin`, the device
 * certificate; `card.bin`, the identity's card. Refused unless the
 * certificate is signed by its identity, certifies both keys the seed
 * derives, is valid at `now` (Unix seconds) and allows login, and the
 * card is signed by the same identity. Every file must be a regular
 * one, and `device.key` open to its owner alone, who must be this
 * process's user unless `owner` is false. The keys are imported
 * non-extractable; the seed and what was derived from it are zeroed.
 */
export async function loadDevice(dir: string, options: { now?: number; owner?: boolean } = {}): Promise<Device> {
  const now = options.now ?? unixNow();
  const raw = await readDeviceFile(dir, DEVICE_KEY, DEVICE_KEY_MAX_BYTES, { secret: true, owner: options.owner ?? true });
  const seed = parseSeed(raw);
  raw.fill(0);
  if (seed === null) throw new DeviceError(DEVICE_KEY, 'bad-field', 'not a 32-byte seed in hex');
  try {
    return await fromSeed(dir, seed, now);
  } finally {
    seed.fill(0);
  }
}

async function fromSeed(dir: string, seed: Uint8Array, now: number): Promise<Device> {
  const certBytes = await readDeviceFile(dir, CERT_FILE, DEVICE_CERT_MAX_BYTES);
  const cert = await openSigned(CERT_FILE, certBytes, decodeDeviceCert, DEVICE_CERT_DOMAIN);

  const pkcs8 = concat(PKCS8_ED25519_PREFIX, seed);
  const sign = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']).finally(() => pkcs8.fill(0));
  // A non-extractable key will not say what its public half is, so it
  // is asked to sign something instead. The probe has no NUL, so it can
  // be no domain-separated object, and its signature goes nowhere.
  const probe = textEncoder.encode('hl-identity device key probe');
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sign, probe));
  if (!(await verifyStrict(cert.device, probe, sig))) {
    throw new DeviceError(DEVICE_KEY, 'key-mismatch', `not the device key ${CERT_FILE} certifies`);
  }
  const encInput = concat(textEncoder.encode(DEVICE_ENC_DERIVATION), seed);
  const encSecret = new Uint8Array(await crypto.subtle.digest('SHA-256', encInput).finally(() => encInput.fill(0)));
  const enc = await importX25519Secret(encSecret).finally(() => encSecret.fill(0));
  if (bytesToHex(await x25519PublicKey(enc)) !== bytesToHex(cert.deviceEnc)) {
    throw new DeviceError(DEVICE_KEY, 'key-mismatch', `derives another device_enc than ${CERT_FILE} certifies`);
  }

  checkWindow(cert, now);
  if (cert.caps !== undefined && (cert.caps & CAPS.LOGIN) === 0) {
    throw new DeviceError(CERT_FILE, 'capability-missing', 'does not allow login');
  }

  const card = await openSigned(CARD_FILE, await readDeviceFile(dir, CARD_FILE, CARD_MAX_BYTES), decodeCard, CARD_DOMAIN);
  if (bytesToHex(card.identity) !== bytesToHex(cert.identity)) {
    throw new DeviceError(CARD_FILE, 'cert-mismatch', `names another identity than ${CERT_FILE}`);
  }
  return { keys: { sign, enc }, cert, card };
}

// --- logging in with it ----------------------------------------------------

/** `identityToken`'s refusal of a login that `/identity/auth` placed in
 *  another account than the one asked for, a guest session included. */
export const WRONG_ACCOUNT = 'wrong_account';

/** A server key `ServerTrust` warned of, with what `accept` takes. The
 *  proof was not sent. */
export class ServerKeyError extends Error {
  constructor(
    readonly host: string,
    readonly warning: HandoverWarning,
    readonly chain: readonly Uint8Array[],
    readonly challenge: Verified<Challenge>,
  ) {
    super(`ServerTrust warns of the server key of ${host}: ${warning.reason}.`);
    this.name = 'ServerKeyError';
  }
}

export interface IdentityTokenOptions {
  /** `AuthRequest.create`; false when `account` is given, since a server
   *  whose `new_accounts` is `create` would otherwise make an account
   *  the identity is then tied to, and refusing the login after that
   *  is too late. */
  create?: boolean;
  /** The account the login must land in, refused as `WRONG_ACCOUNT`
   *  otherwise. */
  account?: string;
  /** Checks the server key before the proof goes out, refusing a
   *  warning as `ServerKeyError`. */
  trust?: ServerTrust;
}

/** An endpoint discovery names, refused unless it is a path on `origin`:
 *  the proof is signed for the host the challenge came from, and a pin
 *  is that host's, so one elsewhere would have this device log in to,
 *  and pin, a server other than the one addressed. */
function endpointOn(origin: string, path: string): string {
  const url = new URL(path, origin);
  if (!path.startsWith('/') || path.startsWith('//') || url.origin !== origin) {
    throw new IdentityError('bad-field', `discovery names an endpoint off ${origin}: ${JSON.stringify(path)}`);
  }
  return url.href;
}

/**
 * Discovery, the challenge, a `v = 2` proof bound to the host, and
 * `/identity/auth`, for the device `loadDevice` read; resolves to the
 * token, so it plugs into `Credentials.identity.getToken` as is.
 * `httpBase` is `wsToHttp` of the server's WebSocket URL, and the
 * endpoints discovery names must be paths on it. Each call
 * fetches discovery again, since `getToken` is asked only when a fresh
 * login is needed.
 */
export async function identityToken(httpBase: string, device: Device, options: IdentityTokenOptions = {}): Promise<string> {
  // A long-running process outlives its certificate: say so, rather
  // than leave it to the server's `bad_cert`.
  checkWindow(device.cert, unixNow());
  const origin = new URL(httpBase).origin;
  const host = canonicalHost(new URL(origin).host);
  const discovery = await fetchDiscovery(origin);
  const di = discovery.identity;
  if (!di.enabled) throw new IdentityError('server-error', `${origin} does not run the identity endpoints`);
  const auth = endpointOn(origin, di.endpoints.auth);
  const challenge = await fetchChallenge(endpointOn(origin, di.endpoints.challenge));
  if (challenge.host !== host) {
    throw new AuthError(WRONG_HOST, `The challenge was vouched for ${challenge.host}, not ${host}.`);
  }
  if (options.trust) {
    const r = await options.trust.check(challenge.host, discovery.serverHandovers, challenge, unixNow());
    if (r.outcome === 'warn') throw new ServerKeyError(challenge.host, r.warning, discovery.serverHandovers, challenge);
  }
  const proof = await signLoginProof(device.keys.sign, {
    challenge: challenge.challenge,
    serverKey: challenge.serverKey,
    host: challenge.host,
    device: device.cert.device,
    time: unixNow(),
  });
  const create = options.create ?? (options.account !== undefined ? false : undefined);
  const success = await postAuth(auth, {
    card: device.card.raw,
    deviceCert: device.cert.raw,
    proof,
    host: challenge.host,
    ...(create !== undefined ? { create } : {}),
  });
  if (options.account !== undefined && success.account !== options.account) {
    throw new AuthError(
      WRONG_ACCOUNT,
      `The login was placed in ${success.account === null ? 'no account' : `account ${success.account}`}, not ${options.account}.`,
    );
  }
  return success.token;
}

// --- server key pins in a file ---------------------------------------------

const PIN_FILE_VERSION = 1;

function encodePin(p: ServerPin): unknown {
  return {
    key: bytesToHex(p.key),
    ...(p.commitment ? { commitment: bytesToHex(p.commitment) } : {}),
    followed: p.followed.map((f) => ({
      old: bytesToHex(f.old),
      sha256: bytesToHex(f.sha256),
      time: f.time,
      ...(f.next ? { next: bytesToHex(f.next) } : {}),
    })),
    dismissed: p.dismissed.map(bytesToHex),
  };
}

function decodePin(raw: any): ServerPin {
  const bytes32 = (v: unknown, what: string): Uint8Array => {
    if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw new Error(`${what} is not 32 bytes of hex`);
    return hexToBytes(v);
  };
  const opt = (v: unknown, what: string) => (v === undefined ? undefined : bytes32(v, what));
  if (typeof raw !== 'object' || raw === null) throw new Error('a pin is not an object');
  if (!Array.isArray(raw.followed)) throw new Error('followed is not a list');
  if (!Array.isArray(raw.dismissed)) throw new Error('dismissed is not a list');
  const followed = raw.followed.map((f: any): FollowedHandover => {
    if (typeof f !== 'object' || f === null || !Number.isSafeInteger(f.time)) throw new Error('a followed handover has no time');
    return { old: bytes32(f.old, 'old'), sha256: bytes32(f.sha256, 'sha256'), time: f.time, next: opt(f.next, 'next') };
  });
  return {
    key: bytes32(raw.key, 'key'),
    commitment: opt(raw.commitment, 'commitment'),
    followed,
    dismissed: raw.dismissed.map((d: unknown) => bytes32(d, 'dismissed')),
  };
}

/** How old a pin file's lock must be to be taken as left by a writer
 *  that died holding it, and how long one is waited for. A write holds
 *  it for milliseconds, so the first is generous; the second is longer
 *  than it, so a put meeting a dead writer's lock outlasts it and takes
 *  it over rather than failing. */
const PIN_LOCK_STALE_MS = 10_000;
const PIN_LOCK_WAIT_MS = 15_000;

/**
 * A `ServerPinStore` in one JSON file, for a program that must not meet
 * every server for the first time again at each restart. Each write
 * replaces the file whole, by renaming over it a temporary file in the
 * same directory, created mode 0600. A missing file holds no pins; one
 * that does not parse is refused, on reading and on writing alike,
 * rather than read as empty and its pins forgotten.
 *
 * The directory must exist, and it and the file must be this user's
 * and writable by nobody else, or anyone who could write them could
 * pin a key of their choosing; either is refused otherwise. On Windows
 * only the file's being a regular one is checked, and its ACLs are
 * what protect it. A write
 * reads, changes and replaces the file under `<path>.lock`, created
 * exclusively beside it, so stores in several processes do not lose
 * each other's pins. A lock older than `PIN_LOCK_STALE_MS` is taken
 * as abandoned and removed, which is simple rather than airtight: two
 * writers that find the same abandoned lock at once can both proceed.
 */
export class FilePinStore implements ServerPinStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  async get(host: string): Promise<ServerPin | undefined> {
    await this.checkPlace();
    return (await this.read()).get(host);
  }

  put(host: string, pin: ServerPin): Promise<void> {
    const run = this.writes.then(async () => {
      await this.checkPlace();
      await this.locked(async () => {
        const pins = await this.read();
        pins.set(host, pin);
        await this.write(pins);
      });
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async locked(fn: () => Promise<void>): Promise<void> {
    const lock = `${this.path}.lock`;
    // Released only while it still holds this token, so a writer whose
    // lock was taken over as stale does not release its successor's.
    const token = crypto.randomUUID();
    const deadline = Date.now() + PIN_LOCK_WAIT_MS;
    for (;;) {
      try {
        const h = await open(lock, 'wx', 0o600);
        try {
          await h.writeFile(token);
        } finally {
          await h.close();
        }
        break;
      } catch (e) {
        if ((e as { code?: unknown }).code !== 'EEXIST') throw e;
      }
      const held = await stat(lock).then(
        (st) => Date.now() - st.mtimeMs,
        () => 0,
      );
      if (held > PIN_LOCK_STALE_MS) {
        await unlink(lock).catch(() => undefined);
      } else if (Date.now() > deadline) {
        throw new Error(`${lock} has been held for longer than ${PIN_LOCK_WAIT_MS} ms`);
      } else {
        await sleep(20);
      }
    }
    try {
      await fn();
    } finally {
      if ((await readFile(lock, 'utf8').catch(() => '')) === token) await unlink(lock).catch(() => undefined);
    }
  }

  /** Refuses a directory or file that another user owns, or that group
   *  or others can write. */
  private async checkPlace(): Promise<void> {
    const uid = ownUid();
    const refuse = (what: string, why: string) => new Error(`${what} ${why}, so the pins in it cannot be trusted`);
    const dir = dirname(this.path);
    const d = await stat(dir);
    if (!d.isDirectory()) throw refuse(dir, 'is not a directory');
    if (POSIX_MODES && (d.mode & 0o022) !== 0) throw refuse(dir, 'is writable by group or others');
    if (uid !== undefined && d.uid !== uid) throw refuse(dir, 'is owned by another user');
    const f = await lstat(this.path).catch((e: { code?: unknown }) => {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    });
    if (f === undefined) return;
    if (!f.isFile()) throw refuse(this.path, 'is not a regular file');
    if (POSIX_MODES && (f.mode & 0o022) !== 0) throw refuse(this.path, 'is writable by group or others');
    if (uid !== undefined && f.uid !== uid) throw refuse(this.path, 'is owned by another user');
  }

  private async read(): Promise<Map<string, ServerPin>> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as { code?: unknown }).code === 'ENOENT') return new Map();
      throw e;
    }
    try {
      const raw = JSON.parse(text);
      if (raw?.v !== PIN_FILE_VERSION) throw new Error(`version ${String(raw?.v)}`);
      if (typeof raw.pins !== 'object' || raw.pins === null) throw new Error('no pins');
      return new Map(Object.entries(raw.pins).map(([host, pin]) => [host, decodePin(pin)]));
    } catch (e) {
      throw new Error(`${this.path} is not a pin file this store can read, and is left as it is: ${(e as Error).message}`, {
        cause: e,
      });
    }
  }

  private async write(pins: Map<string, ServerPin>): Promise<void> {
    const pinned = Object.fromEntries([...pins].map(([host, pin]) => [host, encodePin(pin)]));
    const text = `${JSON.stringify({ v: PIN_FILE_VERSION, pins: pinned }, null, 2)}\n`;
    const tmp = join(dirname(this.path), `.${basename(this.path)}.${crypto.randomUUID()}.tmp`);
    try {
      const f = await open(tmp, 'wx', 0o600);
      try {
        await f.writeFile(text);
        await f.sync();
      } finally {
        await f.close();
      }
      await rename(tmp, this.path);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    // The rename is durable once the directory is: on Linux, by syncing
    // it; elsewhere a directory may not open, or sync, at all.
    try {
      const d = await open(dirname(this.path), 'r');
      try {
        await d.sync();
      } finally {
        await d.close();
      }
    } catch {}
  }
}
