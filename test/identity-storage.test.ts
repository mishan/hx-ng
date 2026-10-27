import { beforeEach, describe, expect, it } from 'vitest';

import { fingerprintOf } from '@hotline-ng/client';

import {
  attachCertificate,
  ensureActiveDevice,
  forgetActiveDevice,
  getActiveDevice,
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

    const pin = { key: new Uint8Array(32).fill(1), commitment: undefined, followed: [], dismissed: [] };
    await serverPins.put('hl.example:5700', pin);
    expect(await serverPins.get('hl.example:5700')).toEqual(pin);
    expect(await serverPins.get('other.example')).toBeUndefined();
    expect((await getActiveDevice())?.devicePub).toBe('ab');
  });
});
