/**
 * `@hotline-ng/client/node`: what a program outside a browser needs that
 * a page keeps elsewhere, and that reads files to get. A device `hlid
 * init` wrote into `$HLID_HOME`, the identity login made with it, and
 * server key pins kept in a file. A subpath of its own so that the main
 * entry imports nothing from `node:`.
 */

import { open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { CborError } from './cbor.js';
import { verifyStrict } from './ed25519.js';
import type { FollowedHandover, HandoverWarning, ServerPin, ServerPinStore, ServerTrust } from './handover.js';
import { importX25519Secret, x25519PublicKey } from './hpke.js';
import {
  AuthError,
  CAPS,
  CARD_DOMAIN,
  DEVICE_CERT_DOMAIN,
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

export type DeviceErrorKind = IdentityErrorKind | 'unreadable';

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

async function readDeviceFile(dir: string, file: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(join(dir, file)));
  } catch (e) {
    throw new DeviceError(file, 'unreadable', e instanceof Error ? e.message : String(e), { cause: e });
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
 * card is signed by the same identity. The keys are imported
 * non-extractable; the seed is not kept.
 */
export async function loadDevice(dir: string, options: { now?: number } = {}): Promise<Device> {
  const now = options.now ?? unixNow();
  const seedHex = new TextDecoder().decode(await readDeviceFile(dir, DEVICE_KEY)).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new DeviceError(DEVICE_KEY, 'bad-field', 'not a 32-byte seed in hex');
  const seed = hexToBytes(seedHex);

  const cert = await openSigned(CERT_FILE, await readDeviceFile(dir, CERT_FILE), decodeDeviceCert, DEVICE_CERT_DOMAIN);

  const sign = await crypto.subtle.importKey('pkcs8', concat(PKCS8_ED25519_PREFIX, seed), { name: 'Ed25519' }, false, [
    'sign',
  ]);
  // A non-extractable key will not say what its public half is, so it
  // is asked to sign something instead. The probe has no NUL, so it can
  // be no domain-separated object, and its signature goes nowhere.
  const probe = textEncoder.encode('hl-identity device key probe');
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sign, probe));
  if (!(await verifyStrict(cert.device, probe, sig))) {
    throw new DeviceError(DEVICE_KEY, 'key-mismatch', `not the device key ${CERT_FILE} certifies`);
  }
  const encSecret = new Uint8Array(
    await crypto.subtle.digest('SHA-256', concat(textEncoder.encode(DEVICE_ENC_DERIVATION), seed)),
  );
  const enc = await importX25519Secret(encSecret);
  if (bytesToHex(await x25519PublicKey(enc)) !== bytesToHex(cert.deviceEnc)) {
    throw new DeviceError(DEVICE_KEY, 'key-mismatch', `derives another device_enc than ${CERT_FILE} certifies`);
  }

  // The window hl-identity's `check_window` holds a certificate to,
  // under a server's default skew: what the server would refuse.
  if (cert.expires <= cert.issued || cert.issued > now + SERVER_CHALLENGE_SKEW_SECONDS) {
    throw new DeviceError(CERT_FILE, 'not-yet-valid', `valid from ${cert.issued} until ${cert.expires}`);
  }
  if (cert.expires + SERVER_CHALLENGE_SKEW_SECONDS < now) {
    throw new DeviceError(CERT_FILE, 'expired', `expired at ${cert.expires}`);
  }
  if (cert.caps !== undefined && (cert.caps & CAPS.LOGIN) === 0) {
    throw new DeviceError(CERT_FILE, 'capability-missing', 'does not allow login');
  }

  const card = await openSigned(CARD_FILE, await readDeviceFile(dir, CARD_FILE), decodeCard, CARD_DOMAIN);
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

/**
 * A `ServerPinStore` in one JSON file, for a program that must not meet
 * every server for the first time again at each restart. Each write
 * replaces the file whole, by renaming over it a temporary file in the
 * same directory, created mode 0600. A missing file holds no pins; one
 * that does not parse is refused, on reading and on writing alike,
 * rather than read as empty and its pins forgotten. Writes through one
 * store run one at a time; two stores, or two processes, on one file
 * would lose each other's.
 */
export class FilePinStore implements ServerPinStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  async get(host: string): Promise<ServerPin | undefined> {
    return (await this.read()).get(host);
  }

  put(host: string, pin: ServerPin): Promise<void> {
    const run = this.writes.then(async () => {
      const pins = await this.read();
      pins.set(host, pin);
      await this.write(pins);
    });
    this.writes = run.catch(() => undefined);
    return run;
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
