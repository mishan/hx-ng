/**
 * This browser's own record of its device keys — `docs/identity-keys.md`
 * §4's schema, verbatim: one IndexedDB database, `hxd-ng.identity`, one
 * `devices` store keyed by the device signing public key (hex) with a
 * `fingerprint` index, plus a `meta` store holding which device is
 * active.
 *
 * Both device keys are generated non-extractable and stored as
 * `CryptoKey` objects directly — structured clone handles them, and a
 * non-extractable key stored this way can be *used* by the page and
 * never read out of it. That is the whole point of Phase B (§1/§2): an
 * XSS gets use of the key for as long as the page lives, never the key
 * itself.
 *
 * A record with no `cert` is a legal state, not a half-finished one: the
 * keys are generated the first time the identity panel opens, and the
 * certificate arrives later, pasted in from `hlid` (§7.1).
 */

import { bytesToHex } from '@hotline-ng/client';

const DB_NAME = 'hxd-ng.identity';
const DB_VERSION = 1;
const DEVICES_STORE = 'devices';
const META_STORE = 'meta';
const ACTIVE_KEY = 'active';

export interface StoredDevice {
  /** 32 bytes hex; the record's key, known at generation. */
  devicePub: string;
  /** Ed25519 private, non-extractable. */
  deviceSign: CryptoKey;
  /** X25519 private, non-extractable. */
  deviceEnc: CryptoKey;
  /** Kept beside the key it belongs to so enrollment can display it. */
  deviceEncPub: Uint8Array;
  // Absent until a certificate has been pasted (§7.1):
  /** 52-char Crockford base32, the display form; indexed. */
  fingerprint?: string;
  /** Signed CBOR, as pasted. */
  cert?: Uint8Array;
  /** Signed CBOR, as pasted. */
  card?: Uint8Array;
  /** Unix seconds, parsed out of the cert, for the renewal nag. */
  certExpires?: number;
  /** The cert's `name`, for a device list. */
  label?: string;
}

export class UnsupportedAlgorithm extends Error {
  constructor(readonly algorithm: 'Ed25519' | 'X25519') {
    super(
      `this browser's WebCrypto does not support ${algorithm}, which identity needs for the ${
        algorithm === 'Ed25519' ? 'device signing' : 'device encryption'
      } key`,
    );
    this.name = 'UnsupportedAlgorithm';
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DEVICES_STORE)) {
        const store = db.createObjectStore(DEVICES_STORE, { keyPath: 'devicePub' });
        store.createIndex('fingerprint', 'fingerprint', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE); // out-of-line keys: just `{ active: devicePub }`
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the identity database'));
  });
}

function requestResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function withDb<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(storeNames, mode);
    const result = await fn(tx);
    await txDone(tx);
    return result;
  } finally {
    db.close();
  }
}

async function generateNonExtractable(algorithm: 'Ed25519' | 'X25519', usages: KeyUsage[]): Promise<CryptoKeyPair> {
  try {
    return (await crypto.subtle.generateKey({ name: algorithm }, false, usages)) as CryptoKeyPair;
  } catch {
    throw new UnsupportedAlgorithm(algorithm);
  }
}

/** Fresh, unenrolled device keys — not yet stored. */
export async function generateDeviceKeys(): Promise<StoredDevice> {
  const signPair = await generateNonExtractable('Ed25519', ['sign', 'verify']);
  const encPair = await generateNonExtractable('X25519', ['deriveBits']);
  const devicePub = new Uint8Array(await crypto.subtle.exportKey('raw', signPair.publicKey));
  const deviceEncPub = new Uint8Array(await crypto.subtle.exportKey('raw', encPair.publicKey));
  return {
    devicePub: bytesToHex(devicePub),
    deviceSign: signPair.privateKey,
    deviceEnc: encPair.privateKey,
    deviceEncPub,
  };
}

/** The device this browser is currently using, or `null` if it has never
 *  opened the identity panel. */
export async function getActiveDevice(): Promise<StoredDevice | null> {
  return withDb([DEVICES_STORE, META_STORE], 'readonly', async (tx) => {
    const active = await requestResult<string | undefined>(tx.objectStore(META_STORE).get(ACTIVE_KEY));
    if (!active) return null;
    const device = await requestResult<StoredDevice | undefined>(tx.objectStore(DEVICES_STORE).get(active));
    return device ?? null;
  });
}

/** The active device, generating and storing one if this is the first
 *  time. Costs nothing to call repeatedly — the identity panel calls it
 *  every time it opens. */
export async function ensureActiveDevice(): Promise<StoredDevice> {
  const existing = await getActiveDevice();
  if (existing) return existing;
  const device = await generateDeviceKeys();
  await withDb([DEVICES_STORE, META_STORE], 'readwrite', async (tx) => {
    tx.objectStore(DEVICES_STORE).put(device);
    tx.objectStore(META_STORE).put(device.devicePub, ACTIVE_KEY);
  });
  return device;
}

export interface Certification {
  cert: Uint8Array;
  card: Uint8Array;
  fingerprint: string;
  certExpires: number;
  label: string | undefined;
}

/** Record a validated cert+card against the active device (§7.1 step 4
 *  has already run by the time this is called — this function trusts its
 *  caller, the same way `putDevice` would). */
export async function attachCertificate(devicePub: string, c: Certification): Promise<void> {
  await withDb(DEVICES_STORE, 'readwrite', async (tx) => {
    const store = tx.objectStore(DEVICES_STORE);
    const device = await requestResult<StoredDevice | undefined>(store.get(devicePub));
    if (!device) throw new Error('no such device');
    store.put({
      ...device,
      cert: c.cert,
      card: c.card,
      fingerprint: c.fingerprint,
      certExpires: c.certExpires,
      label: c.label,
    });
  });
}

/** Delete the active device record entirely — "forget this device"
 *  (§10). This does **not** end a session an attacker already holds; it
 *  only stops this browser logging in as it again. Say that in the UI. */
export async function forgetActiveDevice(): Promise<void> {
  await withDb([DEVICES_STORE, META_STORE], 'readwrite', async (tx) => {
    const meta = tx.objectStore(META_STORE);
    const active = await requestResult<string | undefined>(meta.get(ACTIVE_KEY));
    if (active) tx.objectStore(DEVICES_STORE).delete(active);
    meta.delete(ACTIVE_KEY);
  });
}
