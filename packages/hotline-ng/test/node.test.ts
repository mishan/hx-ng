import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cBytes, cMap, cText, cUint, decodeCanonical, encode, mapGet, mapWithout, type CborValue } from '../src/cbor';
import { verifyStrict } from '../src/ed25519';
import { MemoryServerPinStore, ServerTrust, type ServerPin } from '../src/handover';
import {
  CARD_DOMAIN,
  DEVICE_CERT_DOMAIN,
  LOGIN_PROOF_DOMAIN,
  base64urlToBytes,
  bytesToBase64url,
  hexToBytes,
} from '../src/identity';
import { DeviceError, FilePinStore, ServerKeyError, WRONG_ACCOUNT, identityToken, loadDevice } from '../src/node';

// Read rather than imported: this file is typechecked by
// `tsconfig.lib-node.json`, which has no `resolveJsonModule`.
const vectors = JSON.parse(await readFile(new URL('./identity-vectors.json', import.meta.url), 'utf8'));
const { keys, device_cert: certVector, card: cardVector } = vectors;
const sc = vectors.server_challenge.object;
const issued: number = certVector.fields.issued;
const expires: number = certVector.fields.expires;

const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';

/** Signs as an identity would: production code here signs neither a
 *  certificate nor a card, and the vectors hold only the good ones. */
async function signed(seedHex: string, domain: string, entries: [string, CborValue][]): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    hexToBytes(PKCS8_ED25519_PREFIX + seedHex) as BufferSource,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const body = encode(cMap(entries));
  const message = new Uint8Array([...new TextEncoder().encode(domain), 0, ...body]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message));
  return encode(cMap([...entries, ['sig', cBytes(sig)]]));
}

const tmp: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hotline-ng-node-'));
  tmp.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmp.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A file's content, `null` to leave it out, or a function that puts
 *  something else at its path. */
type Files = Record<string, string | Uint8Array | null | ((path: string) => Promise<unknown>)>;

/** What `hlid init` writes, from hl-identity's own vectors: the seed in
 *  hex with its newline, mode 0600, and the signed certificate and
 *  card. */
async function deviceDir(files: Files = {}): Promise<string> {
  const dir = await tempDir();
  const all: Files = {
    'device.key': `${keys.device.seed_hex}\n`,
    'cert.bin': hexToBytes(certVector.signed_hex),
    'card.bin': hexToBytes(cardVector.signed_hex),
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    const path = join(dir, name);
    if (typeof content === 'function') await content(path);
    else if (content !== null) await writeFile(path, content, { mode: name === 'device.key' ? 0o600 : 0o644 });
  }
  return dir;
}

const during = { now: issued + 60 };

describe('loadDevice', () => {
  it('loads what hlid init writes, with the keys the certificate names', async () => {
    const device = await loadDevice(await deviceDir(), during);
    expect(device.cert.raw).toEqual(hexToBytes(certVector.signed_hex));
    expect(device.card.name).toBe(cardVector.fields.name);
    expect(device.keys.sign.extractable).toBe(false);
    expect(device.keys.enc.extractable).toBe(false);
    const message = new TextEncoder().encode('checked against the certificate');
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, device.keys.sign, message));
    expect(await verifyStrict(hexToBytes(keys.device.public_hex), message, sig)).toBe(true);
  });

  const certWith = (over: { caps?: number; deviceEnc?: string; expires?: number }) =>
    signed(keys.identity.seed_hex, DEVICE_CERT_DOMAIN, [
      ['v', cUint(1)],
      ['identity', cBytes(hexToBytes(keys.identity.public_hex))],
      ['device', cBytes(hexToBytes(keys.device.public_hex))],
      ['device_enc', cBytes(hexToBytes(over.deviceEnc ?? keys.device.public_enc_hex))],
      ['issued', cUint(issued)],
      ['expires', cUint(over.expires ?? expires)],
      ...(over.caps !== undefined ? [['caps', cUint(over.caps)] as [string, CborValue]] : []),
    ]);
  const otherCard = () =>
    signed(keys.other.seed_hex, CARD_DOMAIN, [
      ['v', cUint(1)],
      ['identity', cBytes(hexToBytes(keys.other.public_hex))],
      ['name', cText('Mallory')],
      ['updated', cUint(issued)],
    ]);
  it.each([
    ['issued', issued - 300],
    ['expires', expires + 300],
  ])('takes a certificate within the server skew of %s', async (_, now) => {
    await expect(loadDevice(await deviceDir(), { now })).resolves.toMatchObject({ card: { name: cardVector.fields.name } });
  });

  const badSig = () => {
    const b = hexToBytes(certVector.signed_hex);
    b[b.length - 1] ^= 1;
    return b;
  };

  it.each<[string, () => Files | Promise<Files>, number, string, string]>([
    ['a missing card', () => ({ 'card.bin': null }), during.now, 'card.bin', 'unreadable'],
    ['a seed that is not hex', () => ({ 'device.key': 'not a seed\n' }), during.now, 'device.key', 'bad-field'],
    ['a short seed', () => ({ 'device.key': `${keys.device.seed_hex.slice(2)}\n` }), during.now, 'device.key', 'bad-field'],
    ['the key of another device', () => ({ 'device.key': keys.other.seed_hex }), during.now, 'device.key', 'key-mismatch'],
    ['a certificate whose signature fails', () => ({ 'cert.bin': badSig() }), during.now, 'cert.bin', 'bad-signature'],
    ['a certificate that is not CBOR', () => ({ 'cert.bin': Uint8Array.of(0xff) }), during.now, 'cert.bin', 'bad-field'],
    ['a certificate for another device_enc', async () => ({ 'cert.bin': await certWith({ deviceEnc: keys.other.public_hex }) }), during.now, 'device.key', 'key-mismatch'],
    ['a certificate expired past the skew', () => ({}), expires + 301, 'cert.bin', 'expired'],
    ['a certificate not valid within the skew', () => ({}), issued - 301, 'cert.bin', 'not-yet-valid'],
    ['a certificate that expires as it is issued', async () => ({ 'cert.bin': await certWith({ expires: issued }) }), issued, 'cert.bin', 'not-yet-valid'],
    ['a certificate without login', async () => ({ 'cert.bin': await certWith({ caps: 2 }) }), during.now, 'cert.bin', 'capability-missing'],
    ['a card of another identity', async () => ({ 'card.bin': await otherCard() }), during.now, 'card.bin', 'cert-mismatch'],
    ['a key file group or others can read', () => ({ 'device.key': (p) => writeFile(p, keys.device.seed_hex).then(() => chmod(p, 0o644)) }), during.now, 'device.key', 'unsafe'],
    ['a key file that is a symbolic link', () => ({ 'device.key': (p) => writeFile(`${p}.real`, keys.device.seed_hex, { mode: 0o600 }).then(() => symlink(`${p}.real`, p)) }), during.now, 'device.key', 'unsafe'],
    ['a key file that is a FIFO', () => ({ 'device.key': async (p) => execFileSync('mkfifo', ['-m', '600', p]) }), during.now, 'device.key', 'unsafe'],
    ['a certificate that is a directory', () => ({ 'cert.bin': (p) => mkdir(p) }), during.now, 'cert.bin', 'unsafe'],
    ['a key file too large for a seed', () => ({ 'device.key': `${keys.device.seed_hex}${' '.repeat(100)}` }), during.now, 'device.key', 'too-large'],
    ['a certificate past its size limit', () => ({ 'cert.bin': new Uint8Array(4 * 1024 + 1) }), during.now, 'cert.bin', 'too-large'],
    ['a card past its size limit', () => ({ 'card.bin': new Uint8Array(16 * 1024 + 1) }), during.now, 'card.bin', 'too-large'],
  ])('refuses %s', async (_, files, now, file, kind) => {
    const failure = await loadDevice(await deviceDir(await files()), { now }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DeviceError);
    expect(failure).toMatchObject({ file, kind });
  });
});

describe('identityToken', () => {
  const base = 'http://hl.example:5700';
  const serverKey = hexToBytes(sc.fields.server_key);
  let authed: Record<string, unknown>[];
  let endpoints: { challenge: string; auth: string };

  /** A server as far as discovery, the challenge and auth go: auth
   *  checks the proof the way a server does, against the device the
   *  certificate it was sent names. */
  async function serve(url: string, init?: RequestInit): Promise<Response> {
    const path = new URL(url).pathname;
    if (path === '/.well-known/hotline') {
      return Response.json({
        v: 1,
        name: 'test',
        server_key: bytesToBase64url(serverKey),
        ng: { ws: '/ng' },
        identity: { enabled: true, endpoints },
      });
    }
    if (path === '/identity/challenge') {
      return Response.json({
        challenge: bytesToBase64url(hexToBytes(sc.fields.challenge)),
        server_key: bytesToBase64url(serverKey),
        expires_in: 60,
        server_challenge: bytesToBase64url(hexToBytes(sc.signed_hex)),
      });
    }
    const body = JSON.parse(String(init?.body));
    authed.push(body);
    const proof = decodeCanonical(base64urlToBytes(body.proof));
    const sig = mapGet(proof, 'sig');
    const signedBytes = new Uint8Array([...new TextEncoder().encode(LOGIN_PROOF_DOMAIN), 0, ...encode(mapWithout(proof, 'sig'))]);
    const ok =
      sig?.t === 'bytes' &&
      (await verifyStrict(hexToBytes(keys.device.public_hex), signedBytes, sig.v)) &&
      body.device_cert === bytesToBase64url(hexToBytes(certVector.signed_hex)) &&
      body.card === bytesToBase64url(hexToBytes(cardVector.signed_hex)) &&
      JSON.stringify(mapGet(proof, 'host')) === JSON.stringify(cText(sc.fields.host));
    if (!ok) return Response.json({ error: 'bad_proof', text: 'no' }, { status: 401 });
    return Response.json({ token: 'tok', expires_in: 60, fingerprint: keys.identity.fingerprint, outcome: 'existing', account: 'alice' });
  }

  beforeEach(() => {
    authed = [];
    endpoints = { challenge: '/identity/challenge', auth: '/identity/auth' };
    vi.stubGlobal('fetch', vi.fn(serve));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(sc.fields.expires * 1000);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('logs in with a loaded device and pins the server key on the way', async () => {
    const store = new MemoryServerPinStore();
    const device = await loadDevice(await deviceDir());
    expect(await identityToken(base, device, { account: 'alice', trust: new ServerTrust(store) })).toBe('tok');
    expect((await store.get(sc.fields.host))?.key).toEqual(serverKey);
    expect(authed[0]?.create).toBe(false);
  });

  it.each([
    ['challenge', 'http://evil.example/identity/challenge'],
    ['challenge', '//evil.example/identity/challenge'],
    ['challenge', 'identity/challenge'],
    ['auth', 'http://hl.example:8443/identity/auth'],
  ] as const)('refuses a %s endpoint off the server, %s, pinning nothing', async (which, path) => {
    endpoints[which] = path;
    const store = new MemoryServerPinStore();
    const device = await loadDevice(await deviceDir());
    await expect(identityToken(base, device, { trust: new ServerTrust(store) })).rejects.toThrow('off');
    expect(await store.get(sc.fields.host)).toBeUndefined();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([`${base}/.well-known/hotline`]);
  });

  it('refuses to prove a certificate that expired since it was loaded, before any request', async () => {
    const device = await loadDevice(await deviceDir());
    vi.setSystemTime((expires + 301) * 1000);
    await expect(identityToken(base, device)).rejects.toMatchObject({ file: 'cert.bin', kind: 'expired' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a login placed in another account', async () => {
    const device = await loadDevice(await deviceDir());
    await expect(identityToken(base, device, { account: 'bob' })).rejects.toMatchObject({ code: WRONG_ACCOUNT });
  });

  it('sends no proof to a server whose key changed without a handover', async () => {
    const store = new MemoryServerPinStore();
    await store.put(sc.fields.host, { key: hexToBytes(keys.other.public_hex), commitment: undefined, followed: [], dismissed: [] });
    const device = await loadDevice(await deviceDir());
    const failure = await identityToken(base, device, { trust: new ServerTrust(store) }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ServerKeyError);
    expect(authed).toEqual([]);
  });
});

describe('FilePinStore', () => {
  const bytes = (n: number) => new Uint8Array(32).fill(n);
  const pin: ServerPin = {
    key: bytes(1),
    commitment: bytes(2),
    followed: [
      { old: bytes(3), sha256: bytes(4), time: 1757116800, next: bytes(5) },
      { old: bytes(6), sha256: bytes(7), time: 1757116900, next: undefined },
    ],
    dismissed: [bytes(8)],
  };
  const bare: ServerPin = { key: bytes(9), commitment: undefined, followed: [], dismissed: [] };

  it('keeps pins across stores, in a 0600 file and nothing beside it', async () => {
    const dir = await tempDir();
    const path = join(dir, 'pins.json');
    const store = new FilePinStore(path);
    expect(await store.get('hl.example')).toBeUndefined();
    await Promise.all([store.put('hl.example', pin), store.put('other.example:5700', bare)]);
    const again = new FilePinStore(path);
    expect(await again.get('hl.example')).toEqual(pin);
    expect(await again.get('other.example:5700')).toEqual(bare);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['pins.json']);
  });

  it('keeps every pin that stores on one file write at once, and takes over an abandoned lock', async () => {
    const dir = await tempDir();
    const path = join(dir, 'pins.json');
    await writeFile(`${path}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    const store = new FilePinStore(path);
    await store.put('first.example', pin);
    const hosts = Array.from({ length: 8 }, (_, i) => `h${i}.example`);
    await Promise.all(hosts.map((h) => new FilePinStore(path).put(h, bare)));
    expect(await store.get('first.example')).toEqual(pin);
    for (const h of hosts) expect(await store.get(h)).toEqual(bare);
    expect(await readdir(dir)).toEqual(['pins.json']);
  });

  it.each<[string, (dir: string, path: string) => Promise<unknown>]>([
    ['a directory others can write', (dir) => chmod(dir, 0o777)],
    ['a pin file others can write', (_, path) => writeFile(path, JSON.stringify({ v: 1, pins: {} }), { mode: 0o666 }).then(() => chmod(path, 0o666))],
    ['a pin file that is a symbolic link', (dir, path) => writeFile(join(dir, 'real.json'), JSON.stringify({ v: 1, pins: {} })).then(() => symlink(join(dir, 'real.json'), path))],
  ])('refuses %s', async (_, place) => {
    const dir = await tempDir();
    const path = join(dir, 'pins.json');
    await place(dir, path);
    const store = new FilePinStore(path);
    await expect(store.get('h')).rejects.toThrow('cannot be trusted');
    await expect(store.put('h', bare)).rejects.toThrow('cannot be trusted');
  });

  it('refuses a pin file in a directory that does not exist', async () => {
    const store = new FilePinStore(join(await tempDir(), 'missing', 'pins.json'));
    await expect(store.put('h', bare)).rejects.toThrow('ENOENT');
  });

  it.each([
    ['not JSON', '{'],
    ['another version', JSON.stringify({ v: 2, pins: {} })],
    ['a key that is not hex', JSON.stringify({ v: 1, pins: { h: { key: 'zz', followed: [], dismissed: [] } } })],
    ['a followed handover with no time', JSON.stringify({ v: 1, pins: { h: { key: '01'.repeat(32), followed: [{ old: '01'.repeat(32), sha256: '01'.repeat(32) }], dismissed: [] } } })],
  ])('refuses a file holding %s, and leaves it as it was', async (_, text) => {
    const dir = await tempDir();
    const path = join(dir, 'pins.json');
    await writeFile(path, text);
    const store = new FilePinStore(path);
    await expect(store.get('h')).rejects.toThrow(path);
    await expect(store.put('h', bare)).rejects.toThrow(path);
    expect(await readFile(path, 'utf8')).toBe(text);
    await unlink(path);
    await store.put('h', bare);
    expect(await store.get('h')).toEqual(bare);
  });
});
