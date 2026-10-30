import { describe, expect, it } from 'vitest';

import { CborError } from '../src/cbor';
import {
  checkFriendOffer,
  checkFriendWithdrawal,
  checkFriendship,
  checkWithdrawalPair,
  cutoffOf,
  friendshipBytes,
  pairHash,
  parseFriendWithdrawal,
  parseRotation,
  signFriendAcceptance,
  signFriendOffer,
  signFriendWithdrawal,
  FriendshipRefused,
  type FriendCutoff,
} from '../src/friendship';
import { IdentityError, bytesToHex, hexToBytes } from '../src/identity';

import vectors from './identity-vectors.json';

const V: Record<string, any> = vectors;
const NOW: number = V.friends.now;
const OBJECTS: Record<string, any> = V.friend_objects;
const hex = hexToBytes;
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
const rows = (list: unknown): Record<string, any>[] => list as Record<string, any>[];

const PKCS8_ED25519_PREFIX = hexToBytes('302e020100300506032b657004220420');

function importSeed(seedHex: string): Promise<CryptoKey> {
  const pkcs8 = new Uint8Array([...PKCS8_ED25519_PREFIX, ...hexToBytes(seedHex)]);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

/** An error as hl-identity's `Debug` prints it, which is how the vectors
 *  name the one each must fail with. A CBOR error's byte is left out. */
function rustName(e: unknown): string {
  const pascal = (k: string) => k.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
  if (e instanceof CborError) return `Cbor(${pascal(e.kind)})`;
  if (!(e instanceof IdentityError)) throw e;
  if (e.kind === 'missing-field' || e.kind === 'bad-field') return `${pascal(e.kind)}("${e.detail}")`;
  if (e.kind === 'unsupported-version') return `UnsupportedVersion(${e.detail})`;
  return pascal(e.kind);
}

const wanted = (error: string) => error.replace(/^Cbor\((\w+)\(\d+\)\)$/, 'Cbor($1)');

/** `accepted`, or the step and the error a check refused at. */
async function outcome(check: Promise<unknown>): Promise<string> {
  try {
    await check;
    return 'accepted';
  } catch (e) {
    if (!(e instanceof FriendshipRefused)) throw e;
    return `${e.step} ${rustName(e.error)}`;
  }
}

const expected = (c: Record<string, any>) => (c.expect === 'accepted' ? 'accepted' : `${c.expect} ${wanted(c.error)}`);

/** The bytes a case names: a friendship's array, or an object's whole
 *  encoding. */
const bytesOf = (name: string) => hex(OBJECTS[name].array_hex ?? OBJECTS[name].signed_hex);

function check(object: string, raw: Uint8Array, now: number, held: FriendCutoff[], pair: [Uint8Array, Uint8Array], rotations: any[]) {
  if (object === 'offer') return checkFriendOffer(raw, now, held);
  if (object === 'friendship') return checkFriendship(raw, now, held);
  return checkFriendWithdrawal(raw, now, pair, rotations);
}

describe('friendship objects (hl-identity vectors)', () => {
  const signed = Object.entries(OBJECTS).filter(([, o]) => ['offer', 'acceptance', 'withdrawal'].includes(o.object));

  it.each(signed)('signs %s to the bytes hl-identity signs', async (_, o) => {
    const key = await importSeed(V.keys[o.signer].seed_hex);
    const f = o.fields;
    const common = { from: hex(f.from), time: f.time, cert: hex(f.cert) };
    let bytes: Uint8Array;
    if (o.object === 'offer') {
      bytes = await signFriendOffer(key, { ...common, to: hex(f.to), expires: f.expires, id: hex(f.id) });
    } else if (o.object === 'acceptance') {
      let offer: any;
      for (const x of Object.values(OBJECTS)) if (x.object === 'offer' && bytesToHex(await sha256(hex(x.signed_hex))) === f.offer) offer = x;
      expect(offer, 'the offer it names').toBeDefined();
      bytes = await signFriendAcceptance(key, { ...common, offer: hex(offer.signed_hex) });
    } else {
      bytes = await signFriendWithdrawal(key, {
        ...common,
        pair: hex(f.pair),
        ...(f.party ? { party: hex(f.party) } : {}),
        before: f.before,
      });
    }
    expect(bytesToHex(bytes)).toBe(o.signed_hex);
  });

  it.each(Object.entries(OBJECTS).filter(([, o]) => o.object === 'friendship'))('builds %s and names it by its hash', async (_, o) => {
    const array = friendshipBytes(hex(OBJECTS[o.offer].signed_hex), hex(OBJECTS[o.acceptance].signed_hex));
    expect(bytesToHex(array)).toBe(o.array_hex);
    expect(bytesToHex((await checkFriendship(array, NOW)).hash)).toBe(o.hash_hex);
  });

  it.each(rows(V.friend_pairs))('hashes the pair with $name', async (p) => {
    expect(bytesToHex(await pairHash(hex(p.offerer_fingerprint_hex), hex(p.offeree_fingerprint_hex)))).toBe(p.pair_hex);
  });

  it.each(rows(V.friend_rejects))('refuses $name', async (r) => {
    const raw = hex(r.hex);
    const run = r.object === 'offer' ? checkFriendOffer(raw, NOW) : r.object === 'friendship' ? checkFriendship(raw, NOW) : parseFriendWithdrawal(raw, NOW);
    expect(await outcome(run)).toBe(`${r.step} ${wanted(r.error)}`);
  });

  it.each(rows(V.friend_reads))('reads $name', async (c) => {
    const now: number = c.now ?? NOW;
    const pair = [hex(c.pair[0]), hex(c.pair[1])] as [Uint8Array, Uint8Array];
    const rotations = await Promise.all((c.rotations as string[]).map((n) => parseRotation(hex(V[n].signed_hex))));
    const held = await Promise.all(
      (c.withdrawals as string[]).map(async (n) => cutoffOf(await checkFriendWithdrawal(bytesOf(n), now, pair))),
    );
    expect(await outcome(check(c.object, bytesOf(c.vector), now, held, pair, rotations))).toBe(expected(c));
  });

  it.each(rows(V.friend_cert_window))('checks a certificate $name', async (c) => {
    expect(await outcome(checkFriendOffer(hex(c.signed_hex), NOW))).toBe(expected(c));
  });
});

describe('friendship signing and keeping', () => {
  const offerFields = () => {
    const f = OBJECTS.offer.fields;
    return { from: hex(f.from), to: hex(f.to), time: f.time, expires: f.expires, id: hex(f.id), cert: hex(f.cert) };
  };

  it('refuses to sign what a checker would refuse', async () => {
    const device = await importSeed(V.keys.device.seed_hex);
    const other = await importSeed(V.keys.other_device.seed_hex);
    const self = await sha256(offerFields().from);
    const w = OBJECTS.withdrawal_by_offerer.fields;
    const wf = { from: hex(w.from), pair: hex(w.pair), before: w.before, time: w.time, cert: hex(w.cert) };
    const cases: [string, () => Promise<unknown>, string][] = [
      ['an offer to a short fingerprint', () => signFriendOffer(device, { ...offerFields(), to: self.subarray(1) }), 'BadField("to")'],
      ['an offer with a short id', () => signFriendOffer(device, { ...offerFields(), id: new Uint8Array(15) }), 'BadField("id")'],
      ['a withdrawal of a short pair', () => signFriendWithdrawal(device, { ...wf, pair: wf.pair.subarray(1) }), 'BadField("pair")'],
      ['a withdrawal naming a short party', () => signFriendWithdrawal(device, { ...wf, party: self.subarray(1) }), 'BadField("party")'],
      ['another device key', () => signFriendOffer(other, offerFields()), 'KeyMismatch'],
      ['an offer to itself', () => signFriendOffer(device, { ...offerFields(), to: self }), 'BadField("to")'],
      ['an offer past 30 days', () => signFriendOffer(device, { ...offerFields(), expires: offerFields().time + 30 * 86400 + 1 }), 'BadField("expires")'],
      [
        'a withdrawal whose before is after its time',
        () => signFriendWithdrawal(device, { from: hex(w.from), pair: hex(w.pair), before: w.time + 1, time: w.time, cert: hex(w.cert) }),
        'BadField("before")',
      ],
    ];
    for (const [name, signing, error] of cases) expect(await signing().then(() => 'signed', rustName), name).toBe(error);
  });

  it("leaves out a party that is the signer's own", async () => {
    const device = await importSeed(V.keys.device.seed_hex);
    const w = OBJECTS.withdrawal_by_offerer.fields;
    const own = await sha256(hex(w.from));
    const fields = { from: hex(w.from), pair: hex(w.pair), party: own, before: w.before, time: w.time, cert: hex(w.cert) };
    expect(bytesToHex(await signFriendWithdrawal(device, fields))).toBe(OBJECTS.withdrawal_by_offerer.signed_hex);
  });

  it('keeps a withdrawal that ends nothing until its pair passes', async () => {
    const [a, b] = rows(V.friend_reads)[0]!.pair.map(hex) as [Uint8Array, Uint8Array];
    const kept = await parseFriendWithdrawal(bytesOf('withdrawal_by_offerer'), NOW);
    expect(await outcome(checkWithdrawalPair(kept, [a, hex('00'.repeat(32))]))).toBe('3 KeyMismatch');
    const cutoff = await checkWithdrawalPair(kept, [b, a]);
    expect(await outcome(checkFriendship(bytesOf('friendship'), NOW, [cutoff]))).toBe('6 Withdrawn');
    expect(await outcome(checkFriendship(bytesOf('friendship_again'), NOW, [cutoff]))).toBe('accepted');
  });
});
