import { beforeEach, describe, expect, it } from 'vitest';

import { fingerprintOf } from '@hotline-ng/client';

import {
  attachCertificate,
  ensureActiveDevice,
  forgetActiveDevice,
  getActiveDevice,
  newsGuids,
  peers,
  sealedReplay,
  serverPins,
} from '../src/identity/storage';
import { installFakeIndexedDB } from './fake-idb';

beforeEach(() => {
  installFakeIndexedDB();
});

describe('ensureActiveDevice', () => {
  it('generates non-extractable keys the first time, and reuses them after', async () => {
    const first = await ensureActiveDevice();
    expect(first.deviceSign.extractable).toBe(false);
    expect(first.deviceEnc.extractable).toBe(false);
    expect(first.deviceSign.type).toBe('private');
    expect(first.deviceEncPub).toHaveLength(32);
    expect(first.cert).toBeUndefined(); // a legal state: keys with no cert yet

    const second = await ensureActiveDevice();
    expect(second.devicePub).toBe(first.devicePub);
  });

  it('is visible to getActiveDevice once generated', async () => {
    expect(await getActiveDevice()).toBeNull();
    const device = await ensureActiveDevice();
    const active = await getActiveDevice();
    expect(active?.devicePub).toBe(device.devicePub);
  });
});

describe('attachCertificate', () => {
  it('records the cert, card and fingerprint against the active device', async () => {
    const device = await ensureActiveDevice();
    const fingerprint = await fingerprintOf(new Uint8Array(32).fill(7));
    const cert = new Uint8Array([1, 2, 3]);
    const card = new Uint8Array([4, 5, 6]);
    await attachCertificate(device.devicePub, {
      cert,
      card,
      fingerprint,
      certExpires: 1_800_000_000,
      label: 'Firefox on the laptop',
    });

    const active = await getActiveDevice();
    expect(active?.cert).toEqual(cert);
    expect(active?.card).toEqual(card);
    expect(active?.fingerprint).toBe(fingerprint);
    expect(active?.certExpires).toBe(1_800_000_000);
    expect(active?.label).toBe('Firefox on the laptop');
    // The keys survive attaching a certificate — it's the same record,
    // not a replacement.
    expect(active?.deviceSign).toBe(device.deviceSign);
  });
});

describe('forgetActiveDevice', () => {
  it('removes the record so the next call generates a fresh one', async () => {
    const first = await ensureActiveDevice();
    await forgetActiveDevice();
    expect(await getActiveDevice()).toBeNull();

    const second = await ensureActiveDevice();
    expect(second.devicePub).not.toBe(first.devicePub);
  });
});

describe('serverPins', () => {
  it('keeps a pin per host, in a database a v1 browser upgrades with its device kept', async () => {
    // The v1 schema, and a device in it, as a browser that predates the
    // pins left them.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('hxd-ng.identity', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('devices', { keyPath: 'devicePub' }).createIndex('fingerprint', 'fingerprint');
        req.result.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
    });
    const tx = db.transaction(['devices', 'meta'], 'readwrite');
    await new Promise((resolve) => (tx.objectStore('devices').put({ devicePub: 'ab' }).onsuccess = resolve));
    await new Promise((resolve) => (tx.objectStore('meta').put('ab', 'active').onsuccess = resolve));
    db.close();

    const pin = { key: new Uint8Array(32).fill(1), commitment: undefined, followed: [], dismissed: [] };
    await serverPins.put('hl.example:5700', pin);
    expect(await serverPins.get('hl.example:5700')).toEqual(pin);
    expect(await serverPins.get('other.example')).toBeUndefined();
    expect((await getActiveDevice())?.devicePub).toBe('ab');
  });
});

describe('newsGuids', () => {
  it('upgrades a v2 database with its pins kept, and keeps each guid a server key gave apart', async () => {
    // The v2 schema, and a pin in it, as a browser that predates this
    // store left them.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('hxd-ng.identity', 2);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('devices', { keyPath: 'devicePub' }).createIndex('fingerprint', 'fingerprint');
        req.result.createObjectStore('meta');
        req.result.createObjectStore('serverPins');
      };
      req.onsuccess = () => resolve(req.result);
    });
    const pin = { key: new Uint8Array(32).fill(1), commitment: undefined, followed: [], dismissed: [] };
    const tx = db.transaction(['serverPins'], 'readwrite');
    await new Promise((resolve) => (tx.objectStore('serverPins').put(pin, 'hl.example').onsuccess = resolve));
    db.close();

    const [here, there] = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
    const cases: [string, () => Promise<unknown>, unknown][] = [
      ['a guid first given', () => newsGuids.note(here, 'g1', 4), 4],
      ['given to the same node again', () => newsGuids.note(here, 'g1', 4), 4],
      ['another guid, beside it', () => newsGuids.note(here, 'g2', 5), 5],
      ['the first given to another node', () => newsGuids.note(here, 'g1', 6), 'shared'],
      ['and to its first node again', () => newsGuids.note(here, 'g1', 4), 'shared'],
      ['the same guid from another server key', () => newsGuids.note(there, 'g1', 6), 6],
      ['after that key is forgotten', () => newsGuids.forget(here).then(() => newsGuids.note(here, 'g1', 6)), 6],
      ['the other key, untouched', () => newsGuids.note(there, 'g1', 6), 6],
    ];
    for (const [name, run, want] of cases) expect(await run(), name).toBe(want);
    expect(await serverPins.get('hl.example')).toEqual(pin);
  });
});

describe('sealedReplay', () => {
  it('upgrades a v3 database with what it held kept, and accepts each box once until the clock passes its hold', async () => {
    // The v3 schema, and a device, a pin and a guid in it, as a browser
    // that predates this store left them.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('hxd-ng.identity', 3);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('devices', { keyPath: 'devicePub' }).createIndex('fingerprint', 'fingerprint');
        req.result.createObjectStore('meta');
        req.result.createObjectStore('serverPins');
        req.result.createObjectStore('newsGuids');
      };
      req.onsuccess = () => resolve(req.result);
    });
    const pin = { key: new Uint8Array(32).fill(1), commitment: undefined, followed: [], dismissed: [] };
    const tx = db.transaction(['devices', 'meta', 'serverPins', 'newsGuids'], 'readwrite');
    await new Promise((resolve) => (tx.objectStore('devices').put({ devicePub: 'ab' }).onsuccess = resolve));
    await new Promise((resolve) => (tx.objectStore('meta').put('ab', 'active').onsuccess = resolve));
    await new Promise((resolve) => (tx.objectStore('serverPins').put(pin, 'hl.example').onsuccess = resolve));
    await new Promise((resolve) => (tx.objectStore('newsGuids').put(4, `${'01'.repeat(32)}:g1`).onsuccess = resolve));
    db.close();

    const [id, other] = [new Uint8Array(16).fill(1), new Uint8Array(16).fill(2)];
    const cases: [string, () => unknown, unknown][] = [
      ['the clock as first shown', () => sealedReplay.latest(1000), 1000],
      ['a box not yet accepted', () => sealedReplay.accepted('alice', id), false],
      ['accepted', () => sealedReplay.accept('alice', id, 2000), true],
      ['and so held', () => sealedReplay.accepted('alice', id), true],
      ['accepted again', () => sealedReplay.accept('alice', id, 2000), false],
      ['another signer under its id', () => sealedReplay.accept('bob', id, 1500), true],
      ['another id', () => sealedReplay.accept('alice', other, 3000), true],
      ['forgotten, never shown', () => sealedReplay.forget('alice', other), undefined],
      ['and so accepted anew', () => sealedReplay.accept('alice', other, 3000), true],
      ['a clock set back', () => sealedReplay.latest(500), 1000],
      ['still held', () => sealedReplay.accepted('bob', id), true],
      ['the clock past one hold', () => sealedReplay.latest(1600), 1600],
      ['that one let go', () => sealedReplay.accepted('bob', id), false],
      ['the rest still held', () => sealedReplay.accepted('alice', id), true],
    ];
    for (const [name, run, want] of cases) expect(await run(), name).toBe(want);
    expect(await serverPins.get('hl.example')).toEqual(pin);
    expect(await newsGuids.note(new Uint8Array(32).fill(1), 'g1', 4)).toBe(4);
    expect((await getActiveDevice())?.devicePub).toBe('ab');
  });
});

describe('peers', () => {
  it('upgrades a v4 database with its devices and peers kept, and keeps a mark beside them', async () => {
    // The v4 schema, and a device and a peer in it, as a browser that
    // predates contacts left them.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('hxd-ng.identity', 4);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('devices', { keyPath: 'devicePub' }).createIndex('fingerprint', 'fingerprint');
        req.result.createObjectStore('meta');
        req.result.createObjectStore('serverPins');
        req.result.createObjectStore('newsGuids');
        req.result.createObjectStore('sealedReplay').createIndex('until', 'until');
        req.result.createObjectStore('peers');
      };
      req.onsuccess = () => resolve(req.result);
    });
    const alice = { fingerprint: 'F'.repeat(52), server: 'wss://hl.example', logins: ['alice'], nick: 'Alice', at: 1000, sealed: true as const };
    const tx = db.transaction(['devices', 'meta', 'peers'], 'readwrite');
    await new Promise((resolve) => (tx.objectStore('devices').put({ devicePub: 'ab' }).onsuccess = resolve));
    await new Promise((resolve) => (tx.objectStore('meta').put('ab', 'active').onsuccess = resolve));
    await new Promise((resolve) => (tx.objectStore('peers').put(alice, `wss://hl.example ${alice.fingerprint}`).onsuccess = resolve));
    db.close();

    expect(await peers.marks()).toEqual([]);
    const mark = { fingerprint: alice.fingerprint, compared: 2000, name: 'Alice' };
    expect(await peers.mark(mark)).toEqual(mark);
    expect(await peers.marks()).toEqual([mark]);
    expect(await peers.all()).toEqual([alice]);
    expect((await getActiveDevice())?.devicePub).toBe('ab');
  });
});
