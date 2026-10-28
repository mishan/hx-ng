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

import { bytesToHex, type SealedReplay, type ServerPin, type ServerPinStore } from '@hotline-ng/client';

import type { GuidMemory } from '../signing';

const DB_NAME = 'hxd-ng.identity';
const DB_VERSION = 5;
const DEVICES_STORE = 'devices';
const META_STORE = 'meta';
const SERVER_PINS_STORE = 'serverPins';
const NEWS_GUIDS_STORE = 'newsGuids';
const SEALED_STORE = 'sealedReplay';
const SEALED_UNTIL_INDEX = 'until';
const PEERS_STORE = 'peers';
const CONTACTS_STORE = 'contacts';
const ACTIVE_KEY = 'active';
/** The latest time the clock has shown a sealed message's reader. */
const SEALED_LATEST_KEY = 'sealedLatest';
/** The identity this browser has enrolled with before, in `meta` rather
 *  than on the device record: it has to outlive "forget this device", or
 *  the check it exists for is one a user can clear by accident. See
 *  {@link pinnedIdentity}. */
const PINNED_KEY = 'pinnedIdentity';

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
      if (!db.objectStoreNames.contains(SERVER_PINS_STORE)) {
        db.createObjectStore(SERVER_PINS_STORE); // keyed by host
      }
      if (!db.objectStoreNames.contains(NEWS_GUIDS_STORE)) {
        db.createObjectStore(NEWS_GUIDS_STORE); // keyed by `<server key hex>:<guid>`
      }
      // Keyed by `<signer>/<id hex>`, valued by `{ until }` and indexed
      // by it, so a prune reads only what it lets go.
      if (!db.objectStoreNames.contains(SEALED_STORE)) {
        db.createObjectStore(SEALED_STORE).createIndex(SEALED_UNTIL_INDEX, 'until');
      }
      if (!db.objectStoreNames.contains(PEERS_STORE)) {
        db.createObjectStore(PEERS_STORE); // keyed by `peerKey`
      }
      if (!db.objectStoreNames.contains(CONTACTS_STORE)) {
        db.createObjectStore(CONTACTS_STORE); // keyed by fingerprint
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

/** A device by its signing key, active or not; `null` once forgotten. */
export async function getDevice(devicePub: string): Promise<StoredDevice | null> {
  return withDb(DEVICES_STORE, 'readonly', async (tx) => {
    const device = await requestResult<StoredDevice | undefined>(tx.objectStore(DEVICES_STORE).get(devicePub));
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

/**
 * The identity fingerprint this browser has enrolled with before, if
 * any.
 *
 * A hostile mailbox can hand back a bundle for an identity that is not
 * the one the user meant (`identity-enrollment.md` §9, "substitute the
 * answer"). Every signature in it verifies, so nothing in the codec
 * catches it: what catches it is that this browser was Alice's device
 * yesterday and is being told it is Mallory's today. So the fingerprint
 * is remembered, and a change is something the user has to confirm.
 *
 * It lives in `meta` and not on the device record deliberately. It
 * survives "forget this device", because a store that forgets the
 * pin along with the key would let one accidental click turn the check
 * off for good.
 */
export async function pinnedIdentity(): Promise<string | null> {
  return withDb(META_STORE, 'readonly', async (tx) => {
    const fp = await requestResult<string | undefined>(tx.objectStore(META_STORE).get(PINNED_KEY));
    return fp ?? null;
  });
}

export async function pinIdentity(fingerprint: string): Promise<void> {
  await withDb(META_STORE, 'readwrite', async (tx) => {
    tx.objectStore(META_STORE).put(fingerprint, PINNED_KEY);
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

/** The server keys this browser has pinned, per host (hxd-ng's
 *  `server-key-handover.md` §5), for `ServerTrust`. A store of their
 *  own, so forgetting a device does not forget the servers it met. */
export const serverPins: ServerPinStore = {
  get: (host) =>
    withDb(SERVER_PINS_STORE, 'readonly', (tx) =>
      requestResult<ServerPin | undefined>(tx.objectStore(SERVER_PINS_STORE).get(host)),
    ),
  put: (host, pin) =>
    withDb(SERVER_PINS_STORE, 'readwrite', (tx) => {
      tx.objectStore(SERVER_PINS_STORE).put(pin, host);
    }),
};

const guidKey = (server: Uint8Array, guid: string) => `${bytesToHex(server)}:${guid}`;

/** The news category guids each server key gave (`GuidMemory`), an
 *  entry each, so tabs that note different guids at once keep both, and
 *  one that sees a guid on another node than another tab did marks it
 *  shared rather than overwriting it. */
export const newsGuids: GuidMemory = {
  note: (server, guid, node) =>
    withDb(NEWS_GUIDS_STORE, 'readwrite', async (tx) => {
      const store = tx.objectStore(NEWS_GUIDS_STORE);
      const key = guidKey(server, guid);
      const was = await requestResult<number | 'shared' | undefined>(store.get(key));
      const now = was === undefined ? node : was === node ? was : 'shared';
      if (now !== was) store.put(now, key);
      return now;
    }),
  forget: (server) =>
    withDb(NEWS_GUIDS_STORE, 'readwrite', (tx) => {
      // ';' sorts just after ':', so this is every key under the server's.
      tx.objectStore(NEWS_GUIDS_STORE).delete(IDBKeyRange.bound(`${bytesToHex(server)}:`, `${bytesToHex(server)};`));
    }),
};

const sealedKey = (signer: string, id: Uint8Array) => `${signer}/${bytesToHex(id)}`;

/** The sealed messages this browser accepted (hxd-ng's
 *  `docs/e2e-messages.md` §3.10), beside the device keys that opened
 *  them: kept across restarts and shared by every tab, each accept one
 *  transaction, so two tabs handed one box show it once; and `forget`
 *  for one accepted that was then never shown, so it can be again. */
export const sealedReplay: SealedReplay & { forget(signer: string, id: Uint8Array): Promise<void> } = {
  latest: (now) =>
    withDb([SEALED_STORE, META_STORE], 'readwrite', async (tx) => {
      const meta = tx.objectStore(META_STORE);
      const latest = Math.max(now, (await requestResult<number | undefined>(meta.get(SEALED_LATEST_KEY))) ?? 0);
      meta.put(latest, SEALED_LATEST_KEY);
      const store = tx.objectStore(SEALED_STORE);
      const past = await requestResult(store.index(SEALED_UNTIL_INDEX).getAllKeys(IDBKeyRange.upperBound(latest, true)));
      for (const key of past) store.delete(key);
      return latest;
    }),
  accepted: (signer, id) =>
    withDb(SEALED_STORE, 'readonly', async (tx) => {
      return (await requestResult(tx.objectStore(SEALED_STORE).get(sealedKey(signer, id)))) !== undefined;
    }),
  accept: (signer, id, until) =>
    withDb(SEALED_STORE, 'readwrite', async (tx) => {
      const store = tx.objectStore(SEALED_STORE);
      const key = sealedKey(signer, id);
      if ((await requestResult(store.get(key))) !== undefined) return false;
      store.put({ until }, key);
      return true;
    }),
  forget: (signer, id) =>
    withDb(SEALED_STORE, 'readwrite', (tx) => {
      tx.objectStore(SEALED_STORE).delete(sealedKey(signer, id));
    }),
};

/** Someone this browser has had private messages verified, sealed or
 *  deniable from or to on one server, by the fingerprint they were
 *  under (hxd-ng's `docs/e2e-messages.md` §4.4, §8), with the logins and
 *  last nick they were seen as there. Kept here rather than synced: it
 *  is what tells a server that swapped someone's identity, or dropped
 *  it, from the person. */
export interface PeerRecord {
  fingerprint: string;
  /** The server address they were seen on. */
  server: string;
  logins: string[];
  nick: string;
  /** When they were last seen, in milliseconds. */
  at: number;
  /** When the user last accepted this identity in place of another,
   *  which outranks any sighting of one not accepted since. */
  accepted?: number;
  /** A sealed message went to them or came from them. */
  sealed?: true;
  /** Sealed messages to them go deniably, or signed, by the user's
   *  choice for them; absent, as the settings say. */
  deniable?: boolean;
}

/** One record per server and fingerprint. */
export const peerKey = (server: string, fingerprint: string) => `${server} ${fingerprint}`;

/** Two records of one peer as one, so no tab's write loses another's:
 *  the later sighting's nick and deniable choice, every login, the later
 *  times, and sealed once either says so. */
export function mergePeer(was: PeerRecord | undefined, r: PeerRecord): PeerRecord {
  if (!was) return r;
  const [older, newer] = r.at >= was.at ? [was, r] : [r, was];
  const logins = [...was.logins, ...r.logins.filter((l) => !was.logins.some((w) => w.toLowerCase() === l.toLowerCase()))];
  const accepted = Math.max(was.accepted ?? 0, r.accepted ?? 0);
  return {
    ...older,
    ...newer,
    logins,
    ...(was.sealed || r.sealed ? { sealed: true } : {}),
    ...(accepted ? { accepted } : {}),
  };
}

/** The user's word that they compared a fingerprint out of band
 *  (hxd-ng's `docs/e2e-messages.md` §8),
 *  or took that back: per fingerprint and not per server, since it is
 *  the identity key that was compared, whichever server showed it. */
export interface ContactMark {
  fingerprint: string;
  /** When it was last marked compared, in milliseconds, and the name it
   *  was compared as. */
  compared?: number;
  name?: string;
  /** When it was last unmarked. */
  unmarked?: number;
}

/** Two marks of one fingerprint as one: each act at its later time, so
 *  whichever the user did last holds in every tab, and a tab that never
 *  heard of the later one cannot undo it by writing what it holds. */
export function mergeMark(was: ContactMark | undefined, r: ContactMark): ContactMark {
  if (!was) return r;
  const [older, newer] = (r.compared ?? 0) >= (was.compared ?? 0) ? [was, r] : [r, was];
  const unmarked = Math.max(was.unmarked ?? 0, r.unmarked ?? 0);
  return { ...older, ...newer, ...(unmarked ? { unmarked } : {}) };
}

export const peers = {
  all: () => withDb(PEERS_STORE, 'readonly', (tx) => requestResult<PeerRecord[]>(tx.objectStore(PEERS_STORE).getAll())),
  /** `record` merged into the one stored, in one transaction; the
   *  record as it now stands. */
  merge: (record: PeerRecord) =>
    withDb(PEERS_STORE, 'readwrite', async (tx) => {
      const store = tx.objectStore(PEERS_STORE);
      const key = peerKey(record.server, record.fingerprint);
      const merged = mergePeer(await requestResult<PeerRecord | undefined>(store.get(key)), record);
      store.put(merged, key);
      return merged;
    }),
  marks: () => withDb(CONTACTS_STORE, 'readonly', (tx) => requestResult<ContactMark[]>(tx.objectStore(CONTACTS_STORE).getAll())),
  mark: (mark: ContactMark) =>
    withDb(CONTACTS_STORE, 'readwrite', async (tx) => {
      const store = tx.objectStore(CONTACTS_STORE);
      const merged = mergeMark(await requestResult<ContactMark | undefined>(store.get(mark.fingerprint)), mark);
      store.put(merged, mark.fingerprint);
      return merged;
    }),
  /** Every record of `fingerprint`, on every server, and its mark. */
  forget: (fingerprint: string) =>
    withDb([PEERS_STORE, CONTACTS_STORE], 'readwrite', async (tx) => {
      const store = tx.objectStore(PEERS_STORE);
      for (const r of await requestResult<PeerRecord[]>(store.getAll())) {
        if (r.fingerprint === fingerprint) store.delete(peerKey(r.server, r.fingerprint));
      }
      tx.objectStore(CONTACTS_STORE).delete(fingerprint);
    }),
};
