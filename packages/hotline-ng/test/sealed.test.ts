import { describe, expect, it } from 'vitest';

import { CborError, cBytes, cText, cUint, decodeCanonical, encode, type CborValue } from '../src/cbor';
import { deriveX25519Secret, hpkeOpen, hpkeSeal, importX25519Secret, x25519PublicKey } from '../src/hpke';
import {
  CAPS,
  DEVICE_CERT_DOMAIN,
  IdentityError,
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  fingerprintFromString,
  hexToBytes,
} from '../src/identity';
import privateMessageMaps, { MESSAGE_DOMAIN, SIGNED_SKEW_SECONDS, signedPrivateMessages, type SignedPrivateMessage } from '../src/message';
import {
  MemorySealedReplay,
  SEALED_DENIABLE_BOX,
  SEALED_DENIABLE_INFO,
  SEALED_HOLD_SECONDS as HOLD,
  SEALED_OVERHEAD,
  SEALED_PAD_SIZES,
  SEALED_SIGNED_BOX,
  SEALED_SIGNED_INFO,
  openSealed,
  pad,
  sealMessage,
  sealMessageTo,
  sealMsgRequest,
  sealPadded,
  sealWithIkm,
  unpad,
  type DeviceKeys,
  type SealedOpening,
  type SealedOutcome,
} from '../src/sealed';

import vectors from './identity-vectors.json';

const V: Record<string, any> = vectors;
const { unsignedPrivateMessage } = privateMessageMaps;
const hex = hexToBytes;
const SKEW = SIGNED_SKEW_SECONDS;
const SIGNER: string = V.keys.identity.fingerprint;
const READER: string = V.keys.other.fingerprint;
const textEncoder = new TextEncoder();

const PKCS8_ED25519_PREFIX = hexToBytes('302e020100300506032b657004220420');

async function importSeed(seedHex: string): Promise<CryptoKey> {
  const pkcs8 = new Uint8Array([...PKCS8_ED25519_PREFIX, ...hexToBytes(seedHex)]);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

/** A device's keys from its seed, as hl-identity derives them, both
 *  non-extractable. */
async function deviceKeys(seedHex: string): Promise<DeviceKeys> {
  const enc = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array([...textEncoder.encode('hl-identity/device-enc/v1'), ...hex(seedHex)])),
  );
  return { sign: await importSeed(seedHex), enc: await importX25519Secret(enc) };
}

/** A map signed under `domain`, `sig` added beside its other keys. */
async function signValue(key: CryptoKey, domain: string, unsigned: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array([...textEncoder.encode(domain), 0, ...unsigned]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, input));
  const value = decodeCanonical(unsigned) as Extract<CborValue, { t: 'map' }>;
  return encode({ t: 'map', v: [...value.v, [cText('sig'), cBytes(sig)]] });
}

/** An error as hl-identity's `Debug` prints it, which is how the vectors
 *  name the one each must fail with. */
function rustName(e: unknown): string {
  const pascal = (k: string) => k.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
  if (e instanceof CborError) return `Cbor(${pascal(e.kind)})`;
  if (!(e instanceof IdentityError)) throw e;
  if (e.kind === 'missing-field' || e.kind === 'bad-field') return `${pascal(e.kind)}("${e.detail}")`;
  if (e.kind === 'unsupported-version') return `UnsupportedVersion(${e.detail})`;
  return pascal(e.kind);
}

/** A state, and the error it carries if it carries one. */
const state = (o: SealedOutcome): [string, string | null] => [o.state, 'error' in o ? rustName(o.error) : null];

// --- hl-identity's vectors ----------------------------------------------------

const S = V.sealed;
const vectorCtx: SealedOpening = { now: S.now, at: S.at, reader: S.recipient.identity_fingerprint, sender: { named: SIGNER } };
const vectorReader = () => deviceKeys(S.recipient.seed_hex);

describe('sealed vectors', () => {
  const f = V.private_message.fields;
  const message: SignedPrivateMessage = { id: hex(f.id), sent: f.sent, to: hex(f.to), cert: hex(f.cert), text: f.text, auto: false };

  it.each([
    ['sealed_message', false],
    ['deniable_box', true],
  ] as const)('%s seals again, holds its padded plaintext and opens', async (name, deniable) => {
    const e = V[name];
    const bytes = hex(e.sealed_hex);
    const sender = await deviceKeys(V.keys.device.seed_hex);
    const again = await sealWithIkm(message, sender, hex(S.recipient.public_enc_hex), deniable, hex(e.ikm_e_hex));
    expect(bytesToHex(again)).toBe(e.sealed_hex);
    expect(bytesToHex(await deriveX25519Secret(hex(e.ikm_e_hex)))).toBe(e.ephemeral_secret_hex);

    const plaintext = hex(deniable ? V.private_message.unsigned_hex : V.private_message.signed_hex);
    if (deniable) {
      expect(e.plaintext_hex).toBe(V.private_message.unsigned_hex);
      expect(bytesToHex(bytes.subarray(1, 33))).toBe(V.keys.device.public_enc_hex);
    }
    expect(bytesToHex(pad(plaintext, deniable))).toBe(e.padded_hex);
    const rest = bytes.subarray(deniable ? 33 : 1);
    expect(bytesToHex(rest.subarray(0, 32))).toBe(e.enc_hex);
    expect(bytes.length).toBe(e.padded_hex.length / 2 + (deniable ? 32 : 0) + SEALED_OVERHEAD);
    const reader = await vectorReader();
    const info = textEncoder.encode(deniable ? SEALED_DENIABLE_INFO : SEALED_SIGNED_INFO);
    const pkS = deniable ? hex(V.keys.device.public_enc_hex) : null;
    const padded = await hpkeOpen(rest.subarray(0, 32), reader.enc, info, bytes.subarray(0, 1), rest.subarray(32), pkS);
    expect(bytesToHex(padded)).toBe(e.padded_hex);

    const opened = await openSealed(bytes, reader.enc, vectorCtx, new MemorySealedReplay());
    if (deniable) {
      expect(opened).toMatchObject({ state: 'deniable', message, signer: SIGNER, senderEnc: pkS, sentApart: false });
    } else {
      expect(opened.state).toBe('verified');
      expect(opened.state === 'verified' && bytesToHex(opened.message.whole())).toBe(V.private_message.signed_hex);
    }
  });

  it('names the info strings and H this module uses', () => {
    expect([S.signed_info, S.deniable_info, S.hold]).toEqual([SEALED_SIGNED_INFO, SEALED_DENIABLE_INFO, HOLD]);
  });

  it.each(V.sealed_rejects as Record<string, string>[])('$name', async (r) => {
    const got = await openSealed(hex(r.hex!), (await vectorReader()).enc, vectorCtx, new MemorySealedReplay());
    expect(state(got)).toEqual([r.expect, r.error]);
  });

  const padded = (V.message_rejects as Record<string, string>[]).filter((r) => r.object === 'padded_plaintext');
  it.each(padded)('$name', (r) => {
    let error: unknown;
    try {
      unpad(hex(r.hex!), r.form === 'deniable');
    } catch (e) {
      error = e;
    }
    expect(rustName(error)).toBe(r.error);
  });
});

// --- round trips, after sealed.rs's own tests ----------------------------------

const SENT = 1_700_000_000;
const IKM = new Uint8Array(32).fill(0xe1);

interface CertFields {
  identity?: { seed_hex: string; public_hex: string };
  device?: Uint8Array;
  deviceEnc?: Uint8Array;
  issued?: number;
  expires?: number;
  caps?: number;
  future?: Uint8Array;
}

async function certFor(c: CertFields = {}): Promise<Uint8Array> {
  const identity = c.identity ?? V.keys.identity;
  const entries: [string, CborValue][] = [
    ['v', cUint(1)],
    ['identity', cBytes(hex(identity.public_hex))],
    ['device', cBytes(c.device ?? hex(V.keys.device.public_hex))],
    ['device_enc', cBytes(c.deviceEnc ?? hex(V.keys.device.public_enc_hex))],
    ['issued', cUint(c.issued ?? SENT - 2 * HOLD)],
    ['expires', cUint(c.expires ?? SENT + 2 * HOLD)],
    ['caps', cUint(c.caps ?? CAPS.WEB)],
  ];
  if (c.future) entries.push(['future', cBytes(c.future)]);
  const unsigned = encode({ t: 'map', v: entries.map(([k, v]) => [cText(k), v] as const) });
  return signValue(await importSeed(identity.seed_hex), DEVICE_CERT_DOMAIN, unsigned);
}

interface World {
  dev: DeviceKeys;
  cert: Uint8Array;
  reader: DeviceKeys;
  readerEnc: Uint8Array;
  stranger: DeviceKeys;
  pm: SignedPrivateMessage;
}

async function world(): Promise<World> {
  const cert = await certFor();
  const reader = await vectorReader();
  return {
    dev: await deviceKeys(V.keys.device.seed_hex),
    cert,
    reader,
    readerEnc: hex(S.recipient.public_enc_hex),
    stranger: await deviceKeys('03'.repeat(32)),
    pm: { id: new Uint8Array(16).fill(8), sent: SENT, to: fingerprintFromString(READER)!, cert, text: 'A private word.', auto: false },
  };
}

const ctx = (o: Partial<SealedOpening> = {}): SealedOpening => ({
  now: SENT + 30,
  at: SENT + 30,
  reader: READER,
  sender: { named: SIGNER },
  ...o,
});

const sealed = (w: World, m: SignedPrivateMessage, deniable: boolean) => sealWithIkm(m, w.dev, w.readerEnc, deniable, IKM);

/** The box around a plaintext a sender would never pad, in either form. */
async function boxed(w: World, plaintext: Uint8Array, sender: DeviceKeys | null): Promise<Uint8Array> {
  const s = sender && { sk: sender.enc, pk: await x25519PublicKey(sender.enc) };
  return sealPadded(plaintext, w.readerEnc, s, IKM);
}

/** A memory that keeps what it was made to accept. */
class Recorder extends MemorySealedReplay {
  readonly recorded: string[] = [];

  override accept(signer: string, id: Uint8Array, until: number): boolean {
    const added = super.accept(signer, id, until);
    if (added) this.recorded.push(signer);
    return added;
  }
}

const open = async (w: World, bytes: Uint8Array, c = ctx(), memory = new MemorySealedReplay()) =>
  openSealed(bytes, w.reader.enc, c, memory);

describe('sealing and opening', () => {
  it('opens each form once as what was sealed', async () => {
    const w = await world();
    const signed = await signedPrivateMessages.sign(w.dev.sign, w.pm);
    for (const deniable of [false, true]) {
      const bytes = await sealMessage(w.pm, w.dev, w.readerEnc, deniable);
      expect(bytes.length).toBe(SEALED_PAD_SIZES[0]! + SEALED_OVERHEAD);
      expect(bytesToHex(await sealMessage(w.pm, w.dev, w.readerEnc, deniable))).not.toBe(bytesToHex(bytes));
      const memory = new MemorySealedReplay();
      const opened = await open(w, bytes, ctx(), memory);
      if (deniable) {
        expect(opened).toMatchObject({ state: 'deniable', message: w.pm, signer: SIGNER, sentApart: false });
      } else {
        expect(opened).toMatchObject({ state: 'verified', signer: SIGNER, sentApart: false });
        expect(opened.state === 'verified' && opened.message.whole()).toEqual(signed);
      }
      expect(state(await open(w, bytes, ctx(), memory))).toEqual(['dropped', 'Replayed']);
      expect(await open(w, bytes, ctx({ sender: 'unknown' }))).toMatchObject({
        state: 'unverified',
        signer: SIGNER,
        whole: deniable ? null : signed,
      });
    }
  });

  it("makes a msg's box and the hash of the key it was sealed to, to the identity it names", async () => {
    const w = await world();
    const recipient = await certFor({ identity: V.keys.other, deviceEnc: w.readerEnc });
    const key = bytesToBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', w.readerEnc as BufferSource)));
    for (const deniable of [false, true]) {
      const req = await sealMsgRequest(w.dev, { cert: w.cert, to: w.pm.to, text: 'one\r\ntwo' }, recipient, deniable, SENT);
      expect(req.cert).toBe(key);
      const opened = await open(w, base64urlToBytes(req.sealed));
      expect(opened.state).toBe(deniable ? 'deniable' : 'verified');
      const text = opened.state === 'verified' ? opened.message.message.text : opened.state === 'deniable' ? opened.message.text : null;
      expect(text).toBe('one\ntwo');
    }
    const elsewhere = sealMsgRequest(w.dev, { cert: w.cert, to: fingerprintFromString(SIGNER)!, text: 'hi' }, recipient, false, SENT);
    await expect(elsewhere).rejects.toMatchObject({ kind: 'key-mismatch' });
  });

  it('fills the largest box with the largest message, in either form', async () => {
    const w = await world();
    const short = await certFor({ future: new Uint8Array(0) });
    const cert = await certFor({ future: new Uint8Array(512 - short.length - 2) });
    expect(cert.length).toBe(512);
    const largest = { ...w.pm, cert, text: 'x'.repeat(8192), quote: 'q'.repeat(8192), auto: true };
    for (const deniable of [false, true]) {
      const bytes = await sealed(w, largest, deniable);
      expect(bytes.length).toBe(SEALED_PAD_SIZES.at(-1)! + SEALED_OVERHEAD);
      expect((await open(w, bytes)).state).toBe(deniable ? 'deniable' : 'verified');
    }
  });

  it('refuses to seal what a reader would refuse', async () => {
    const w = await world();
    const recipientCert = (c: CertFields = {}) =>
      certFor({ identity: V.keys.other, deviceEnc: w.readerEnc, issued: SENT, expires: SENT + 1000, ...c });
    const sealTo = async (cert: Uint8Array, deniable = false) => sealMessageTo(w.pm, w.dev, cert, deniable, SENT + 30);
    expect((await open(w, await sealTo(await recipientCert()))).state).toBe('verified');
    // The recipient's identity and a server's own device_enc, under a
    // signature nobody made.
    const genuine = decodeCanonical(await recipientCert({ deviceEnc: hex(V.keys.device.public_enc_hex) }));
    const forgedCert = encode({
      t: 'map',
      v: (genuine as Extract<CborValue, { t: 'map' }>).v.map(([k, v]) =>
        k.t === 'text' && k.v === 'sig' ? ([k, cBytes(new Uint8Array(64))] as const) : ([k, v] as const),
      ),
    });
    const zero = new Uint8Array(32);
    const cases: [string, () => Promise<unknown>, string][] = [
      ['to a certificate of another identity', async () => sealTo(await recipientCert({ identity: V.keys.identity }), true), 'KeyMismatch'],
      ['to a certificate without bit 1', async () => sealTo(await recipientCert({ caps: CAPS.LOGIN })), 'CapabilityMissing'],
      [
        'to a certificate its identity did not sign',
        async () => sealTo(await recipientCert({ identity: { seed_hex: V.keys.identity.seed_hex, public_hex: V.keys.other.public_hex } })),
        'BadSignature',
      ],
      ['to a certificate whose signature is forged', () => sealTo(forgedCert, true), 'BadSignature'],
      ['to a certificate expired now', async () => sealTo(await recipientCert({ issued: SENT - 1000, expires: SENT + 30 - SKEW - 1 })), 'Expired'],
      ['to a certificate past 512 bytes', async () => sealTo(await recipientCert({ future: new Uint8Array(512) })), 'BadField("cert")'],
      ['signed by another device', () => sealMessage(w.pm, w.stranger, w.readerEnc), 'KeyMismatch'],
      ["deniable under another device's key", () => sealMessage(w.pm, w.stranger, w.readerEnc, true), 'KeyMismatch'],
      ['deniable, empty text', () => sealMessage({ ...w.pm, text: '' }, w.dev, w.readerEnc, true), 'BadField("text")'],
      ['a recipient key of small order', () => sealMessage(w.pm, w.dev, zero), 'InvalidKey'],
      ['deniable to a recipient key of small order', () => sealMessage(w.pm, w.dev, zero, true), 'InvalidKey'],
    ];
    for (const [name, run, want] of cases) {
      expect(await run().then(() => 'sealed', rustName), name).toBe(want);
    }
  });

  it('shows what fails to open or to read as unopened', async () => {
    const w = await world();
    const signed = await sealed(w, w.pm, false);
    const deniable = await sealed(w, w.pm, true);
    const devEnc = hex(V.keys.device.public_enc_hex);
    const signedMap = await signedPrivateMessages.sign(w.dev.sign, w.pm);
    const unsignedMap = unsignedPrivateMessage(w.pm);
    const toAnother = { ...w.pm, to: fingerprintFromString(SIGNER)! };
    const flipped = Uint8Array.from(signed);
    flipped[flipped.length - 1] = flipped.at(-1)! ^ 1;
    const swapped = Uint8Array.from(deniable);
    swapped.set(await x25519PublicKey((await deviceKeys('09'.repeat(32))).enc), 1);
    const zeroEnc = Uint8Array.from(signed);
    zeroEnc.fill(0, 1, 33);
    const baseAsDeniable = await (async () => {
      const { enc, ct } = await hpkeSeal(
        w.readerEnc,
        textEncoder.encode(SEALED_DENIABLE_INFO),
        new Uint8Array([SEALED_DENIABLE_BOX]),
        pad(unsignedMap, true),
        null,
        IKM,
      );
      return new Uint8Array([SEALED_DENIABLE_BOX, ...devEnc, ...enc, ...ct]);
    })();
    const nonzeroPadding = pad(signedMap, false);
    nonzeroPadding[nonzeroPadding.length - 1] = 1;
    const cases: [string, Uint8Array, string][] = [
      ['nothing', new Uint8Array(0), 'OpenFailed'],
      ['another leading byte', new Uint8Array([3, ...signed.subarray(1)]), 'UnsupportedVersion(3)'],
      ['a ciphertext altered', flipped, 'OpenFailed'],
      ['an ephemeral key of small order', zeroEnc, 'OpenFailed'],
      ['a deniable box with another pkS', swapped, 'OpenFailed'],
      ['a box of no size', signed.subarray(0, signed.length - 1), 'BadField("padding")'],
      ['a deniable box relabeled as a signed one', new Uint8Array([SEALED_SIGNED_BOX, ...deniable.subarray(33)]), 'BadField("padding")'],
      ['a signed box relabeled as a deniable one', new Uint8Array([SEALED_DENIABLE_BOX, ...devEnc, ...signed.subarray(1)]), 'BadField("padding")'],
      ['0x02 sealed in base mode', baseAsDeniable, 'OpenFailed'],
      ['a signed box sealed to another identity', await sealed(w, toAnother, false), 'BadField("to")'],
      ['a deniable box sealed to another identity', await sealed(w, toAnother, true), 'BadField("to")'],
      ['a deniable plaintext carrying sig', await boxed(w, pad(signedMap, true), w.dev), 'BadField("sig")'],
      ['a signed plaintext without sig', await boxed(w, pad(unsignedMap, false), null), 'MissingField("sig")'],
      ["a deniable plaintext at a signed box's size", await boxed(w, pad(unsignedMap, false), w.dev), 'BadField("padding")'],
      ['a nonzero padding byte', await boxed(w, nonzeroPadding, null), 'BadField("padding")'],
    ];
    for (const [name, bytes, want] of cases) {
      expect(state(await open(w, bytes)), name).toEqual(['unopened', want]);
    }
    const elsewhere = await openSealed(signed, w.dev.enc, ctx(), new MemorySealedReplay());
    expect(state(elsewhere)).toEqual(['unopened', 'OpenFailed']);
  });

  it('checks the sender and the certificate, and records no failure', async () => {
    const w = await world();
    const short = await certFor({ issued: SENT - 100, expires: SENT + 100 });
    const loginOnly = { ...w.pm, cert: await certFor({ issued: SENT - 100, expires: SENT + 100_000, caps: CAPS.LOGIN }) };
    const unsignedMap = unsignedPrivateMessage(w.pm);
    const forged = await signValue(w.stranger.sign, MESSAGE_DOMAIN, unsignedMap);
    const named = (fp: string) => ctx({ sender: { named: fp } });
    const cases: [string, Uint8Array, SealedOpening, [string, string | null]][] = [
      ['a certificate expired now', await sealed(w, { ...w.pm, cert: short }, false), ctx({ now: SENT + 100 + SKEW + 1 }), ['invalid', 'Expired']],
      [
        'a certificate without bit 1',
        await boxed(w, pad(await signValue(w.dev.sign, MESSAGE_DOMAIN, unsignedPrivateMessage(loginOnly)), false), null),
        ctx(),
        ['invalid', 'CapabilityMissing'],
      ],
      ['a signature by another device', await boxed(w, pad(forged, false), null), ctx(), ['invalid', 'BadSignature']],
      [
        'a deniable box whose certificate names another device_enc',
        await boxed(w, pad(unsignedMap, true), w.stranger),
        ctx(),
        ['invalid', 'KeyMismatch'],
      ],
      ['a sender shown with another fingerprint', await sealed(w, w.pm, false), named(READER), ['invalid', 'KeyMismatch']],
      ['a deniable box from a sender shown with another fingerprint', await sealed(w, w.pm, true), named(READER), ['invalid', 'KeyMismatch']],
      ['a sender shown with none', await sealed(w, w.pm, false), ctx({ sender: 'unknown' }), ['unverified', null]],
      ['a deniable box from a sender shown with none', await sealed(w, w.pm, true), ctx({ sender: 'unknown' }), ['unverified', null]],
    ];
    for (const [name, bytes, c, want] of cases) {
      const memory = new Recorder();
      expect(state(await open(w, bytes, c, memory)), name).toEqual(want);
      expect(memory.recorded, `${name}: recorded`).toEqual([]);
    }
  });

  it('drops a stale or replayed box before its certificate is judged', async () => {
    const w = await world();
    const now = SENT + 30;
    const at = (sent: number) => sealed(w, { ...w.pm, sent }, false);
    const clock = (latest: number) => {
      const m = new MemorySealedReplay();
      m.latest(latest);
      return m;
    };
    const cases: [string, Uint8Array, MemorySealedReplay, string][] = [
      ['sent H ago', await at(now - HOLD), clock(0), 'verified'],
      ['sent H and a second ago', await at(now - HOLD - 1), clock(0), 'dropped'],
      ['sent S ahead', await at(now + SKEW), clock(0), 'verified'],
      ['sent S and a second ahead', await at(now + SKEW + 1), clock(0), 'dropped'],
      ['a clock set back keeps the window it had', await at(now - HOLD + 60), clock(now + 120), 'dropped'],
    ];
    for (const [name, bytes, memory, want] of cases) {
      expect((await open(w, bytes, ctx(), memory)).state, name).toBe(want);
    }

    // Accepted once, then replayed after its certificate expired: the
    // replay is dropped rather than shown as invalid, until it is too old
    // to be fresh.
    const short = await certFor({ issued: SENT - 100, expires: SENT + 100 });
    const bytes = await sealed(w, { ...w.pm, cert: short }, false);
    const memory = new MemorySealedReplay();
    expect((await open(w, bytes, ctx(), memory)).state).toBe('verified');
    for (const [later, want] of [
      [SENT + 100 + SKEW + 1, 'Replayed'],
      [SENT + HOLD + 1, 'ClockSkew'],
    ] as const) {
      expect(state(await open(w, bytes, ctx({ now: later }), memory)), String(later)).toEqual(['dropped', want]);
    }
  });
});
