/**
 * A server key pinned per host, and the handovers that carry the pin to
 * a successor (hxd-ng's `docs/server-key-handover.md` §5), decided as
 * hl-identity's `handover.rs` decides them. The functions only decide;
 * `ServerTrust` applies what they decide to a store the caller supplies.
 * Nothing here reads a clock or the network: the chain is discovery's
 * `serverHandovers`, the challenge is one `verifyServerChallenge` has
 * passed for the host, and `now` is the caller's.
 */

import { bytesToHex, parseHandover, type Handover, type ServerChallenge, type Verified } from './identity.js';

/** The most handovers a server keeps and a client follows (§4). */
export const MAX_HANDOVER_CHAIN = 16;
/** S, the skew allowance (`e2e-messages.md` §3.1). */
export const HANDOVER_SKEW_SECONDS = 600;

function same(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a === undefined || b === undefined ? a === b : bytesToHex(a) === bytesToHex(b);
}

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
}

/** What a `next` commits to: the SHA-256 of the key that follows. */
export function handoverCommitment(key: Uint8Array): Promise<Uint8Array> {
  return sha256(key);
}

/** A handover a client followed or took at a first pin: its fork record
 *  (§5.4) and the alias it gives (§5.5). */
export interface FollowedHandover {
  old: Uint8Array;
  /** SHA-256 of the handover's bytes as served. */
  sha256: Uint8Array;
  time: number;
  next: Uint8Array | undefined;
}

/** §5.5: whether a line or article whose `in.server` is `server`, sent
 *  at `sent`, is in scope under this alias. */
export function aliasCovers(alias: FollowedHandover, server: Uint8Array, sent: number): boolean {
  return same(alias.old, server) && sent <= alias.time + HANDOVER_SKEW_SECONDS;
}

/** §5.2: whether a challenge under the pinned key, committing to `seen`,
 *  passes without a warning. A commitment seen where none is remembered
 *  is not adopted, so the caller keeps remembering none. */
export function sameCommitment(remembered: Uint8Array | undefined, seen: Uint8Array | undefined): boolean {
  return remembered === undefined || same(remembered, seen);
}

/** What a client remembers of a host (§5). */
export interface PinnedServerKey {
  key: Uint8Array;
  commitment: Uint8Array | undefined;
  followed: readonly FollowedHandover[];
  /** The hashes of conflicting handovers whose fork warning the user
   *  accepted, which do not warn again (§5.4). */
  dismissed: readonly Uint8Array[];
}

/** Why a served chain cannot be followed, as `handover.rs`'s `Broken`
 *  names it. `not-served` is a pinned key older than those kept, or one
 *  never handed over; `link` includes a handover after one with no
 *  `next`. */
export type HandoverBroken =
  | 'too-long'
  | 'not-served'
  | 'commitment'
  | 'bad'
  | 'link'
  | 'time'
  | 'repeated-key'
  | 'server-key'
  | 'next';

export type HandoverWarning =
  /** A served handover conflicts with a record (§5.4); `sha256` is what
   *  the client dismisses if the user accepts. */
  | { reason: 'fork'; sha256: Uint8Array }
  /** The same key with another commitment than the remembered one, or
   *  none (§5.2). */
  | { reason: 'recommitted' }
  /** The key changed and the served chain does not carry the pin to it
   *  (§5.3). `error` is a `bad` handover's parse or verify failure. */
  | { reason: 'chain'; broken: HandoverBroken; error?: unknown };

export type ServerKeyVerdict =
  | { verdict: 'keep' }
  /** Move the pin to `key` without a warning, remember `commitment`, and
   *  add `followed` to the fork records and aliases (§5.3). */
  | { verdict: 'follow'; key: Uint8Array; commitment: Uint8Array | undefined; followed: FollowedHandover[] }
  | { verdict: 'warn'; warning: HandoverWarning };

/** What these checks read of a server challenge, which must be one
 *  `verifyServerChallenge` or `fetchChallenge` returned: a pin moves to
 *  its key. */
export type ChallengeKey = Verified<Pick<ServerChallenge, 'serverKey' | 'next'>>;

type Served = { sha256: Uint8Array } & (
  | { ok: true; h: Handover; newCommitment: Uint8Array }
  | { ok: false; error: unknown }
);

class Broken {
  constructor(
    readonly broken: HandoverBroken,
    readonly error?: unknown,
  ) {}
}

/** `undefined` for a list longer than §4 allows, which is never
 *  verified, so that its length costs nothing: it forks nothing, gives
 *  no aliases and cannot be followed. */
async function serve(chain: readonly Uint8Array[]): Promise<Served[] | undefined> {
  if (chain.length > MAX_HANDOVER_CHAIN) return undefined;
  return Promise.all(
    chain.map(async (bytes): Promise<Served> => {
      const digest = await sha256(bytes);
      try {
        const h = await parseHandover(bytes);
        return { sha256: digest, ok: true, h, newCommitment: await sha256(h.new) };
      } catch (error) {
        return { sha256: digest, ok: false, error };
      }
    }),
  );
}

/** §5.4. A handover that does not verify names no `old` worth believing,
 *  so it forks nothing. */
function forks(
  served: readonly Served[],
  followed: readonly FollowedHandover[],
  dismissed: readonly Uint8Array[],
): HandoverWarning | null {
  for (const s of served) {
    if (!s.ok || dismissed.some((d) => same(d, s.sha256))) continue;
    if (followed.some((f) => same(f.old, s.h.old) && !same(f.sha256, s.sha256))) {
      return { reason: 'fork', sha256: s.sha256 };
    }
  }
  return null;
}

/** §5.3's checks over `chain`, the served handovers from the pinned key
 *  on, but the first `new`'s commitment, which is the caller's. Throws
 *  `Broken`. */
function walk(chain: readonly Served[], challenge: ChallengeKey, now: number): FollowedHandover[] {
  const keys: Uint8Array[] = [];
  const followed: FollowedHandover[] = [];
  let prev: Handover | undefined;
  for (const s of chain) {
    if (!s.ok) throw new Broken('bad', s.error);
    const h = s.h;
    if (prev === undefined) keys.push(h.old);
    else if (!same(h.old, prev.new) || prev.next === undefined || !same(prev.next, s.newCommitment)) {
      throw new Broken('link');
    } else if (h.time <= prev.time) throw new Broken('time');
    if (h.time > now + HANDOVER_SKEW_SECONDS) throw new Broken('time');
    if (keys.some((k) => same(k, h.new))) throw new Broken('repeated-key');
    keys.push(h.new);
    followed.push({ old: h.old, sha256: s.sha256, time: h.time, next: h.next });
    prev = h;
  }
  if (prev !== undefined) {
    if (!same(prev.new, challenge.serverKey)) throw new Broken('server-key');
    if (!same(prev.next, challenge.next)) throw new Broken('next');
  }
  return followed;
}

/** A first pin (§5.1): the aliases `chain` gives, to become the client's
 *  records, none if it fails. The client pins `challenge`'s key and
 *  remembers its `next`. */
export async function pinServerKey(
  chain: readonly Uint8Array[],
  challenge: ChallengeKey,
  now: number,
): Promise<FollowedHandover[]> {
  const served = await serve(chain);
  if (served === undefined) return [];
  try {
    return walk(served, challenge, now);
  } catch (e) {
    if (e instanceof Broken) return [];
    throw e;
  }
}

/** A pin again after the user accepted a warning (§5.1, §5.3): only the
 *  fork check, since it takes no aliases. A key given up at an earlier
 *  warning would otherwise come back as an alias through a handover
 *  signed by whoever holds it now. */
export async function repinServerKey(
  chain: readonly Uint8Array[],
  followed: readonly FollowedHandover[],
  dismissed: readonly Uint8Array[],
): Promise<HandoverWarning | null> {
  return forks((await serve(chain)) ?? [], followed, dismissed);
}

/** Every later fetch of discovery (§5.2–§5.4). */
export async function checkServerKey(
  pinned: PinnedServerKey,
  chain: readonly Uint8Array[],
  challenge: ChallengeKey,
  now: number,
): Promise<ServerKeyVerdict> {
  const served = await serve(chain);
  const fork = forks(served ?? [], pinned.followed, pinned.dismissed);
  if (fork !== null) return { verdict: 'warn', warning: fork };
  if (same(challenge.serverKey, pinned.key)) {
    if (sameCommitment(pinned.commitment, challenge.next)) return { verdict: 'keep' };
    return { verdict: 'warn', warning: { reason: 'recommitted' } };
  }
  try {
    if (served === undefined) throw new Broken('too-long');
    const from = served.findIndex((s) => s.ok && same(s.h.old, pinned.key));
    const first = served[from];
    if (first === undefined || !first.ok) throw new Broken('not-served');
    if (pinned.commitment === undefined || !same(pinned.commitment, first.newCommitment)) {
      throw new Broken('commitment');
    }
    if (pinned.followed.some((f) => f.time >= first.h.time)) throw new Broken('time');
    const followed = walk(served.slice(from), challenge, now).filter(
      (f) => !pinned.followed.some((r) => same(r.old, f.old)),
    );
    return { verdict: 'follow', key: challenge.serverKey, commitment: challenge.next, followed };
  } catch (e) {
    if (!(e instanceof Broken)) throw e;
    const error = e.error === undefined ? {} : { error: e.error };
    return { verdict: 'warn', warning: { reason: 'chain', broken: e.broken, ...error } };
  }
}

// --- remembering it --------------------------------------------------------

/** What a client keeps of a host, durably (§5). */
export interface ServerPin {
  key: Uint8Array;
  commitment: Uint8Array | undefined;
  /** Fork records (§5.4), which are the aliases too (§5.5). */
  followed: FollowedHandover[];
  dismissed: Uint8Array[];
}

/** Where `ServerTrust` keeps its pins, keyed by the canonical host the
 *  challenge was verified for. A browser's should be on disk, as
 *  `identity-threat-model.md` asks of anchors. */
export interface ServerPinStore {
  get(host: string): Promise<ServerPin | undefined>;
  put(host: string, pin: ServerPin): Promise<void>;
}

/** For Node, tests, and a client that has nowhere durable to keep pins. */
export class MemoryServerPinStore implements ServerPinStore {
  private readonly pins = new Map<string, ServerPin>();

  async get(host: string): Promise<ServerPin | undefined> {
    return this.pins.get(host);
  }

  async put(host: string, pin: ServerPin): Promise<void> {
    this.pins.set(host, pin);
  }
}

export type ServerTrustOutcome =
  /** Pinned, at first contact or again after a warning was accepted,
   *  taking `aliases`. */
  | { outcome: 'pin'; aliases: FollowedHandover[] }
  | { outcome: 'keep' }
  /** The pin moved without a warning, keeping `followed` as aliases. */
  | { outcome: 'follow'; followed: FollowedHandover[] }
  /** Nothing was stored; `accept` is the user accepting it. */
  | { outcome: 'warn'; warning: HandoverWarning };

/**
 * The pins of §5 over a `ServerPinStore`. `chain` is discovery's
 * `serverHandovers` and `challenge` the one fetched for `host` on the
 * same connection. Each host's calls run one at a time, so a page
 * keeps one `ServerTrust`; a store shared between pages must make each
 * host's read and write atomic itself.
 */
export class ServerTrust {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly store: ServerPinStore) {}

  private serialize<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(host) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    this.queues.set(host, tail);
    void tail.then(() => this.queues.get(host) === tail && this.queues.delete(host));
    return run;
  }

  private async firstPin(
    host: string,
    chain: readonly Uint8Array[],
    challenge: ChallengeKey,
    now: number,
  ): Promise<ServerTrustOutcome> {
    const aliases = await pinServerKey(chain, challenge, now);
    await this.store.put(host, { key: challenge.serverKey, commitment: challenge.next, followed: aliases, dismissed: [] });
    return { outcome: 'pin', aliases };
  }

  /** On each connection: a first pin, or the check of a later one. */
  check(host: string, chain: readonly Uint8Array[], challenge: ChallengeKey, now: number): Promise<ServerTrustOutcome> {
    return this.serialize<ServerTrustOutcome>(host, async () => {
      const pin = await this.store.get(host);
      if (pin === undefined) return this.firstPin(host, chain, challenge, now);
      const v = await checkServerKey(pin, chain, challenge, now);
      if (v.verdict === 'warn') return { outcome: 'warn', warning: v.warning };
      if (v.verdict === 'keep') return { outcome: 'keep' };
      await this.store.put(host, { ...pin, key: v.key, commitment: v.commitment, followed: [...pin.followed, ...v.followed] });
      return { outcome: 'follow', followed: v.followed };
    });
  }

  /**
   * The user accepted `warning`, which `check` or `accept` gave for the
   * same `chain` and `challenge`: pin `challenge`'s key again, keeping
   * the records and taking no aliases (§5.3), and for a fork remember
   * its handover so as not to warn of it again (§5.4). A chain that
   * forks against a record warns in turn, and pins nothing.
   */
  accept(
    host: string,
    warning: HandoverWarning,
    chain: readonly Uint8Array[],
    challenge: ChallengeKey,
    now: number,
  ): Promise<ServerTrustOutcome> {
    return this.serialize<ServerTrustOutcome>(host, async () => {
      let pin = await this.store.get(host);
      if (pin === undefined) return this.firstPin(host, chain, challenge, now);
      if (warning.reason === 'fork') {
        // Kept even if another fork warns below, or accepting that one
        // would warn of this one again.
        pin = { ...pin, dismissed: [...pin.dismissed, warning.sha256] };
        await this.store.put(host, pin);
      }
      const fork = await repinServerKey(chain, pin.followed, pin.dismissed);
      if (fork !== null) return { outcome: 'warn', warning: fork };
      await this.store.put(host, { ...pin, key: challenge.serverKey, commitment: challenge.next });
      return { outcome: 'pin', aliases: [] };
    });
  }

  /** Whether a line or article whose `in.server` is `server`, sent at
   *  `sent`, is in scope under one of `host`'s aliases (§5.5). The
   *  current key is not an alias, and is the caller's to compare. */
  async covers(host: string, server: Uint8Array, sent: number): Promise<boolean> {
    const pin = await this.store.get(host);
    return pin?.followed.some((f) => aliasCovers(f, server, sent)) ?? false;
  }
}
