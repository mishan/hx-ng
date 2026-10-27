import { describe, expect, it } from 'vitest';

import { cBytes, cMap, cUint, encode } from '../src/cbor';
import {
  MemoryServerPinStore,
  ServerTrust,
  aliasCovers,
  checkServerKey,
  pinServerKey,
  repinServerKey,
  type FollowedHandover,
  type HandoverWarning,
} from '../src/handover';
import {
  bytesToBase64url,
  bytesToHex,
  decodeServerChallenge,
  hexToBytes,
  parseHandover,
  SERVER_HANDOVER_DOMAIN,
  verifyEnvelope,
  verifyServerChallenge,
  type ServerChallenge,
  type Verified,
} from '../src/identity';

import v from './server-handover-vectors.json';

// hl-identity's `tests/server_handover.rs` generates these and checks
// them against the Rust; this runs the same cases against this library.

interface Signed {
  signer: string;
  domain: string;
  signed_hex: string;
  fields: Record<string, unknown>;
}

const keys = v.keys as Record<string, { seed_hex: string; public_hex: string }>;
const handovers = v.handovers as Record<string, Signed>;
const challenges = v.challenges as Record<string, Signed>;

const keyOf = (name: string) => hexToBytes(keys[name]!.public_hex);
const handoverBytes = (name: string) => hexToBytes(handovers[name]!.signed_hex);
const challengeBytes = (name: string) => hexToBytes(challenges[name]!.signed_hex);
const hex = (b: Uint8Array | undefined) => (b === undefined ? null : bytesToHex(b));
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));

async function record(name: string): Promise<FollowedHandover> {
  const bytes = handoverBytes(name);
  const h = await parseHandover(bytes);
  return { old: h.old, sha256: await sha256(bytes), time: h.time, next: h.next };
}

async function nameOf(digest: Uint8Array): Promise<string> {
  for (const name of Object.keys(handovers)) {
    if (bytesToHex(await sha256(handoverBytes(name))) === bytesToHex(digest)) return name;
  }
  throw new Error('a handover not in the file');
}

/** Names, each record checked whole against the one the file's bytes
 *  give. */
async function names(got: FollowedHandover[]): Promise<string[]> {
  const out = [];
  for (const f of got) {
    const name = await nameOf(f.sha256);
    expect(f).toEqual(await record(name));
    out.push(name);
  }
  return out;
}

function keyName(key: Uint8Array): string {
  return Object.keys(keys).find((name) => keys[name]!.public_hex === bytesToHex(key))!;
}

/** Rust's `Debug` form of an error, as the file names it, to what this
 *  library throws: `BadField("new")` is an `IdentityError` of kind
 *  `bad-field` about `new`, `Cbor(NotCanonical)` a `CborError`. */
function thrown(rust: string): Record<string, string> {
  const [, name, arg] = /^(\w+)(?:\((.*)\))?$/.exec(rust)!;
  const kebab = (s: string) => s.replace(/(?<!^)[A-Z]/g, (c) => `-${c}`).toLowerCase();
  if (name === 'Cbor') return { name: 'CborError', kind: kebab(arg!) };
  const kind = kebab(name!);
  return { name: 'IdentityError', kind, ...(arg === undefined ? {} : { message: `${kind}: ${arg.replace(/"/g, '')}` }) };
}

type Case = (typeof v.client)[number];

/** What a case decided, in the file's form, so that `expect` is
 *  compared whole. */
async function decide(c: Case): Promise<unknown> {
  const chain = c.chain.map(handoverBytes);
  const bytes = challengeBytes(c.challenge);
  const sc = decodeServerChallenge(bytes);
  let challenge: Verified<ServerChallenge>;
  try {
    challenge = await verifyServerChallenge(bytesToBase64url(bytes), { ...sc, host: c.host }, v.now);
  } catch {
    return { outcome: 'warn' };
  }
  const followed = await Promise.all(c.followed.map(record));
  const dismissed = await Promise.all(c.dismissed.map((n) => sha256(handoverBytes(n))));
  const warned = async (w: HandoverWarning) =>
    w.reason === 'fork' ? { outcome: 'warn', handover: await nameOf(w.sha256) } : { outcome: 'warn' };
  const pinned = async (aliases: FollowedHandover[]) => ({
    outcome: 'pin',
    commitment: hex(challenge.next),
    aliases: await names(aliases),
  });
  if (c.kind === 'pin') return pinned(await pinServerKey(chain, challenge, v.now));
  if (c.kind === 'repin') {
    const w = await repinServerKey(chain, followed, dismissed);
    return w === null ? pinned([]) : warned(w);
  }
  const verdict = await checkServerKey(
    { key: keyOf(c.pinned!), commitment: c.commitment ? hexToBytes(c.commitment) : undefined, followed, dismissed },
    chain,
    challenge,
    v.now,
  );
  switch (verdict.verdict) {
    case 'keep':
      return { outcome: 'keep' };
    case 'follow':
      return {
        outcome: 'follow',
        key: keyName(verdict.key),
        commitment: hex(verdict.commitment),
        followed: await names(verdict.followed),
      };
    case 'warn':
      return warned(verdict.warning);
  }
}

describe('server handover vectors', () => {
  it('parses every handover to its fields, and refuses one not signed by its old', async () => {
    for (const [name, e] of Object.entries(handovers)) {
      const bytes = handoverBytes(name);
      if (e.signer !== keyName(hexToBytes(e.fields.old as string))) {
        await expect(parseHandover(bytes), name).rejects.toMatchObject(thrown('BadSignature'));
        continue;
      }
      const h = await parseHandover(bytes);
      expect({ ...h, old: hex(h.old), new: hex(h.new), next: hex(h.next) }, name).toEqual({
        old: e.fields.old,
        new: e.fields.new,
        next: e.fields.next ?? null,
        time: e.fields.time,
      });
    }
  });

  it('decodes and verifies every challenge, `next` included', async () => {
    for (const [name, e] of Object.entries(challenges)) {
      const bytes = challengeBytes(name);
      await verifyEnvelope(bytes, keyOf(e.signer), e.domain);
      const sc = decodeServerChallenge(bytes);
      expect([hex(sc.serverKey), sc.expires, hex(sc.next)], name).toEqual([
        e.fields.server_key,
        e.fields.expires,
        e.fields.next ?? null,
      ]);
    }
  });

  it.each(v.handover_rejects)('refuses a handover: $name', async (r) => {
    await expect(parseHandover(hexToBytes(r.hex))).rejects.toMatchObject(thrown(r.error));
  });

  it.each(v.challenge_rejects)('refuses a challenge: $name', (r) => {
    expect(() => decodeServerChallenge(hexToBytes(r.hex))).toThrow(expect.objectContaining(thrown(r.error)));
  });

  // A warning's `reason` names the check of hl-identity that failed, and
  // binds nothing (`server-key-handover.md` §10).
  it.each(v.client)('$kind: $name', async (c) => {
    const { reason: _, ...expected } = c.expect as { reason?: string };
    expect(await decide(c)).toEqual(expected);
  });

  it.each(v.scope)('alias scope: $name', async (c) => {
    expect(aliasCovers(await record(c.alias), keyOf(c.server), c.sent)).toBe(c.expect);
  });
});

/** The vector's challenge `name`, verified for the file's host. */
async function verified(name: string) {
  const bytes = challengeBytes(name);
  return verifyServerChallenge(bytesToBase64url(bytes), { ...decodeServerChallenge(bytes), host: v.host }, v.now);
}

describe('a handover whose time is past what a double holds', () => {
  it('still verifies, and forks against a record from its old', async () => {
    // RFC 8410's PKCS8 for a raw Ed25519 seed: a fixed prefix, then it.
    const pkcs8 = hexToBytes(`302e020100300506032b657004220420${keys.server!.seed_hex}`);
    const key = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'Ed25519' }, false, ['sign']);
    const unsigned: [string, ReturnType<typeof cUint>][] = [
      ['v', cUint(1)],
      ['old', cBytes(keyOf('server'))],
      ['new', cBytes(keyOf('k1'))],
      ['next', cBytes(hexToBytes(challenges.c1!.fields.next as string))],
      ['time', cUint(2n ** 60n)],
    ];
    const message = new Uint8Array([...new TextEncoder().encode(SERVER_HANDOVER_DOMAIN), 0, ...encode(cMap(unsigned))]);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message));
    const late = encode(cMap([...unsigned, ['sig', cBytes(sig)]]));

    expect((await parseHandover(late)).time).toBe(Number.MAX_SAFE_INTEGER);
    const pinned = {
      key: keyOf('k1'),
      commitment: hexToBytes(challenges.c1!.fields.next as string),
      followed: [await record('h0_1')],
      dismissed: [],
    };
    const verdict = await checkServerKey(
      pinned,
      [late],
      await verified('c1'),
      v.now,
    );
    expect(verdict).toEqual({ verdict: 'warn', warning: { reason: 'fork', sha256: await sha256(late) } });
  });
});

describe('ServerTrust', () => {
  const challenge = verified;
  const host = v.host;
  const two = ['h0_1', 'h1_2'].map(handoverBytes);

  it('pins, follows, keeps what the user accepts, and answers for its aliases', async () => {
    const store = new MemoryServerPinStore();
    const trust = new ServerTrust(store);

    expect(await trust.check(host, [handoverBytes('h0_1')], await challenge('c1'), v.now)).toEqual({
      outcome: 'pin',
      aliases: [await record('h0_1')],
    });
    expect(await trust.check(host, two, await challenge('c2'), v.now)).toEqual({
      outcome: 'follow',
      followed: [await record('h1_2')],
    });
    expect(await trust.check(host, two, await challenge('c2'), v.now)).toEqual({ outcome: 'keep' });

    const recommitted = await trust.check(host, two, await challenge('c2_stray'), v.now);
    expect(recommitted).toEqual({ outcome: 'warn', warning: { reason: 'recommitted' } });
    if (recommitted.outcome !== 'warn') return;
    expect(await trust.accept(host, recommitted.warning, two, await challenge('c2_stray'), v.now)).toEqual({
      outcome: 'pin',
      aliases: [],
    });
    expect(await trust.check(host, two, await challenge('c2_stray'), v.now)).toEqual({ outcome: 'keep' });

    const forked = [handoverBytes('h0_stray')];
    const fork = await trust.check(host, forked, await challenge('c2_stray'), v.now);
    expect(fork).toEqual({ outcome: 'warn', warning: { reason: 'fork', sha256: await sha256(forked[0]!) } });
    if (fork.outcome !== 'warn') return;
    expect(await trust.accept(host, fork.warning, forked, await challenge('c2_stray'), v.now)).toEqual({
      outcome: 'pin',
      aliases: [],
    });
    expect(await trust.check(host, forked, await challenge('c2_stray'), v.now)).toEqual({ outcome: 'keep' });

    const t1 = (await record('h0_1')).time;
    expect(await trust.covers(host, keyOf('server'), t1 + v.skew)).toBe(true);
    expect(await trust.covers(host, keyOf('server'), t1 + v.skew + 1)).toBe(false);
    expect(await trust.covers(host, keyOf('k2'), t1)).toBe(false);
    expect(await trust.covers('other.example', keyOf('server'), t1)).toBe(false);
  });
});
