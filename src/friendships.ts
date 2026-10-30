/**
 * Portable friendships as this client keeps them (hxd-ng's
 * `docs/proposals/portable-friends.md` §5): each friendship this
 * identity holds, the offers this device made and is waiting on, the
 * cutoffs of the withdrawals it knows, signed afresh for each server it
 * owes one, and per server whether the user brings their friends there,
 * who they leave out, and what was presented. Kept per identity, so a
 * second identity in this browser sees none of the first's.
 *
 * What happens on a server, in the order §7.5 asks: withdrawals before
 * the roster is read, then what the roster names by hash fetched,
 * checked and adopted, then friendships presented where the user chose.
 * No DOM; the store and the connection are handed in.
 */

import {
  base64urlToBytes,
  bytesToBase64url,
  checkFriendOffer,
  checkFriendWithdrawal,
  checkFriendship,
  cutoffOf,
  decodeDeviceCert,
  fingerprintFromString,
  fingerprintToString,
  friendshipBytes,
  pairHash,
  parseRotation,
  rotationChainEnd,
  signFriendAcceptance,
  signFriendOffer,
  signFriendWithdrawal,
  FRIENDSHIPS_PER_REQUEST,
  SIGNED_SKEW_SECONDS,
  WireFailure,
  type Connection,
  type Friend,
  type FriendCutoff,
  type FriendStateOk,
  type Friendship,
} from '@hotline-ng/client';

/** One friendship this identity holds, with what the checks need of it
 *  kept beside its bytes so a cutoff is weighed without reading it
 *  again. Fingerprints and hashes are their wire forms. */
export interface KeptFriendship {
  hash: string;
  raw: string;
  /** The other party. */
  friend: string;
  pair: string;
  offerer: string;
  offerTime: number;
  acceptTime: number;
  /** The devices that hold it as the user's: the one that signed our
   *  half, or one whose user confirmed it. Any other device asks first
   *  (§5.1, §6). */
  adoptedBy: string[];
  /** The device that signed our half, and its name and time, for that
   *  question. */
  device: string;
  deviceName?: string;
  signedAt: number;
  /** Servers it was presented on, and those whose roster showed it
   *  active. */
  presented: string[];
  seen: string[];
  /** Servers it is presented on whatever the choice: those it was
   *  presented on, so that one ended there without a withdrawal comes
   *  back (§5.1), and for a successor's, those the one it moved from
   *  was (§10). */
  bringTo: string[];
  /** The friend's login on each server it was seen on. */
  logins: Record<string, string>;
}

/** An offer this device made, waiting for its acceptance. */
export interface KeptOffer {
  raw: string;
  to: string;
  server: string;
  login: string;
  expires: number;
}

/** A withdrawal's cutoff, and the servers still owed it signed afresh. */
export interface KeptCutoff {
  pair: string;
  party: string;
  before: number;
  owed: string[];
}

/** A friend's rotation from one key to another, as a server served its
 *  records and this client checked their signatures (§7.5). */
export interface KeptMove {
  from: string;
  to: string;
  records: string[];
}

export interface ServerChoice {
  /** The user brings their portable friends here, as chosen on `device`;
   *  another device asks again. */
  bring: boolean;
  device?: string;
  /** Friends, by fingerprint, left out here. */
  leftOut: string[];
  /** Friendships this server answered `withdrawn` with no withdrawal: a
   *  removal of its own, so they are not presented here again. */
  refused: string[];
}

export interface FriendshipBook {
  friendships: KeptFriendship[];
  offers: KeptOffer[];
  cutoffs: KeptCutoff[];
  moves: KeptMove[];
  servers: Record<string, ServerChoice>;
}

export const emptyBook = (): FriendshipBook => ({ friendships: [], offers: [], cutoffs: [], moves: [], servers: {} });

/** Where books are kept, one per identity fingerprint. `update` applies
 *  `fn` to the book as stored, in one transaction, so two tabs never
 *  write over each other's change. */
export interface BookStore {
  load(identity: string): Promise<FriendshipBook>;
  update(identity: string, fn: (book: FriendshipBook) => void): Promise<FriendshipBook>;
}

export class MemoryBookStore implements BookStore {
  private books = new Map<string, string>();

  async load(identity: string): Promise<FriendshipBook> {
    const json = this.books.get(identity);
    return json ? (JSON.parse(json) as FriendshipBook) : emptyBook();
  }

  async update(identity: string, fn: (book: FriendshipBook) => void): Promise<FriendshipBook> {
    const book = await this.load(identity);
    fn(book);
    this.books.set(identity, JSON.stringify(book));
    return book;
  }
}

export type KeeperConn = Pick<
  Connection,
  'friendshipsPresent' | 'friendshipsFetch' | 'friendAdd' | 'friendRespond' | 'friendRemove' | 'findUser' | 'block'
>;

export interface KeeperDeps {
  conn: KeeperConn;
  /** The server, as the connect form names it. */
  server: string;
  signer: { key: CryptoKey; cert: Uint8Array };
  store: BookStore;
  /** Something the user should hear. */
  say: (text: string) => void;
  /** Unix seconds; this device's own clock, never a server's. */
  now?: () => number;
}

/** How long an offer this client makes stays open. */
export const OFFER_LIFETIME_SECONDS = 7 * 86400;

const b64 = bytesToBase64url;
const unb64 = base64urlToBytes;
const S = SIGNED_SKEW_SECONDS;

async function fingerprintOfKey(key: Uint8Array): Promise<string> {
  return fingerprintToString(new Uint8Array(await crypto.subtle.digest('SHA-256', key as BufferSource)));
}

const code = (e: unknown): string | null => (e instanceof WireFailure ? e.wire.code : null);
const addTo = (list: string[], x: string) => (list.includes(x) ? list : [...list, x]);
const without = (list: string[], x: string) => list.filter((y) => y !== x);
const chunks = <T>(list: T[]): T[][] =>
  Array.from({ length: Math.ceil(list.length / FRIENDSHIPS_PER_REQUEST) }, (_, i) =>
    list.slice(i * FRIENDSHIPS_PER_REQUEST, (i + 1) * FRIENDSHIPS_PER_REQUEST),
  );

/** Whether `c` ends `k`: its half by `c`'s party, one of the pair,
 *  predates `before`. */
function ends(c: KeptCutoff, k: KeptFriendship): boolean {
  return c.pair === k.pair && (c.party === k.offerer ? k.offerTime : k.acceptTime) < c.before;
}

export class PortableFriends {
  private queue: Promise<unknown> = Promise.resolve();
  private clockSaid = false;

  private constructor(
    private d: KeeperDeps,
    private identity: Uint8Array,
    /** This device's signing key, as `adoptedBy` names it. */
    private device: string,
    /** This identity's fingerprint. */
    readonly self: string,
    private b: FriendshipBook,
  ) {}

  /** A keeper for the identity `signer`'s certificate is for. */
  static async open(d: KeeperDeps): Promise<PortableFriends> {
    const cert = decodeDeviceCert(d.signer.cert);
    const self = await fingerprintOfKey(cert.identity);
    return new PortableFriends(d, cert.identity, b64(cert.device), self, await d.store.load(self));
  }

  get book(): FriendshipBook {
    return this.b;
  }

  /** This server's choice, as this device made it. */
  get choice(): ServerChoice {
    const c = this.b.servers[this.d.server];
    return c ? { ...c, bring: c.bring && c.device === this.device } : { bring: false, leftOut: [], refused: [] };
  }

  /** Whether this device holds `k` as the user's. */
  adopted(k: KeptFriendship): boolean {
    return k.adoptedBy.includes(this.device);
  }

  /** The friendships held with `friend`, adopted or waiting. */
  with(friend: string | undefined): KeptFriendship[] {
    return friend ? this.b.friendships.filter((k) => k.friend === friend) : [];
  }

  /** The new key of a friend who rotated away from `friend`. */
  movedTo(friend: string): string | undefined {
    return this.b.moves.find((m) => m.from === friend)?.to;
  }

  /** The friend's old key where `fingerprint` is the new one a checked
   *  rotation moved them to: their upgrade offer is accepted only once
   *  the user confirms it (§7.5). */
  rotatedFrom(fingerprint: string | undefined): string | undefined {
    return this.b.moves.find((m) => m.to === fingerprint)?.from;
  }

  private now(): number {
    return Math.floor((this.d.now ?? (() => Date.now() / 1000))());
  }

  /** One act at a time, each on the book as the last left it. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async update(fn: (book: FriendshipBook) => void): Promise<void> {
    this.b = await this.d.store.update(this.self, fn);
  }

  private stale(): void {
    if (this.clockSaid) return;
    this.clockSaid = true;
    this.d.say("This device's clock is more than ten minutes off the server's, so friendships cannot be signed here. Set the clock right.");
  }

  private cutoffs(): FriendCutoff[] {
    return this.b.cutoffs.map((c) => ({ pair: unb64(c.pair), party: fingerprintFromString(c.party)!, before: c.before }));
  }

  /** Whether a cutoff for the pair is still ahead of this clock: no half
   *  for it is signed until it is not (the objects, §4). */
  private cutOff(pair: string): boolean {
    return this.b.cutoffs.some((c) => c.pair === pair && c.before >= this.now());
  }

  private async pairWith(friend: string): Promise<string> {
    return b64(await pairHash(fingerprintFromString(this.self)!, fingerprintFromString(friend)!));
  }

  private async keep(f: Friendship, adopted: boolean, presented: boolean, login?: string, bringTo: string[] = []): Promise<void> {
    const server = this.d.server;
    const offerer = fingerprintToString(f.offer.offerer);
    const ours = offerer === this.self ? f.offer : f.acceptance;
    const cert = decodeDeviceCert(ours.cert);
    const k: KeptFriendship = {
      hash: b64(f.hash),
      raw: b64(f.raw),
      friend: offerer === this.self ? fingerprintToString(f.offer.to) : offerer,
      pair: b64(f.pair),
      offerer,
      offerTime: f.offer.time,
      acceptTime: f.acceptance.time,
      adoptedBy: [],
      device: b64(cert.device),
      ...(cert.name !== undefined ? { deviceName: cert.name } : {}),
      signedAt: ours.time,
      presented: [],
      seen: [],
      bringTo,
      logins: {},
    };
    await this.update((b) => {
      const had = b.friendships.find((x) => x.hash === k.hash);
      const into = had ?? k;
      if (!had) b.friendships.push(k);
      if (adopted) into.adoptedBy = addTo(into.adoptedBy, this.device);
      if (presented) {
        into.presented = addTo(into.presented, server);
        into.bringTo = addTo(into.bringTo, server);
      }
      into.seen = addTo(into.seen, server);
      if (login) into.logins[server] = login;
    });
  }

  // --- at login -------------------------------------------------------------

  /** The withdrawals this server is owed, each signed afresh: what
   *  `beforeFriends` sends, before the roster is read. */
  presentWithdrawals(): Promise<void> {
    return this.run(async () => {
      // Another tab may have cut a friendship since this one last looked.
      this.b = await this.d.store.load(this.self);
      const now = this.now();
      // A cutoff copied from a server whose clock ran ahead waits until
      // this one has caught up with it.
      const due = this.b.cutoffs.filter((c) => c.owed.includes(this.d.server) && c.before <= now);
      // One withdrawal for a pair to a request.
      const rounds: KeptCutoff[][] = [];
      for (const c of due) {
        const round = rounds.find((r) => r.length < FRIENDSHIPS_PER_REQUEST && !r.some((x) => x.pair === c.pair));
        if (round) round.push(c);
        else rounds.push([c]);
      }
      for (const round of rounds) {
        const signed = await Promise.all(round.map((c) => this.signWithdrawal(c.pair, c.party, c.before, now)));
        const ok = await this.d.conn.friendshipsPresent({ withdrawals: signed.map(b64) });
        const settled = new Set<KeptCutoff>();
        ok.withdrawals.forEach((r, i) => {
          if (r.result === 'stale') this.stale();
          else if (r.result === 'ok' || r.result === 'bad_signature') settled.add(round[i]!);
        });
        await this.update((b) => {
          for (const c of b.cutoffs) {
            if ([...settled].some((s) => s.pair === c.pair && s.party === c.party)) c.owed = c.owed.filter((s) => s !== this.d.server);
          }
        });
      }
    });
  }

  private signWithdrawal(pair: string, party: string, before: number, time: number): Promise<Uint8Array> {
    return signFriendWithdrawal(this.d.signer.key, {
      from: this.identity,
      pair: unb64(pair),
      party: fingerprintFromString(party)!,
      before,
      time,
      cert: this.d.signer.cert,
    });
  }

  /** The roster as `friends` answered it: what it names that this
   *  client does not hold fetched, what went missing presented again,
   *  rotations followed, local edges offered an upgrade, and the rest
   *  presented where the user chose to. */
  onRoster(friends: Friend[]): Promise<void> {
    return this.run(async () => {
      const server = this.d.server;
      const accepted = friends.filter((f) => f.state === 'accepted');
      const shown = new Set(accepted.flatMap((f) => f.friendships ?? []));
      const now = this.now();
      // An offer past its expiry and the skew can no longer be adopted;
      // and an edge seen active here and now gone ended here without a
      // withdrawal while this client was away (§5.1): present it again.
      await this.update((b) => {
        b.offers = b.offers.filter((o) => now <= o.expires + S);
        for (const k of b.friendships) {
          // A friend who rotated keeps their login, under a new key.
          const here = accepted.find((f) => f.fingerprint === k.friend) ?? accepted.find((f) => f.login === k.logins[server]);
          if (here) k.logins[server] = here.login;
          // An entry's first hash is this account's own presentation.
          if (here?.friendships?.[0] === k.hash) {
            k.presented = addTo(k.presented, server);
            k.bringTo = addTo(k.bringTo, server);
          }
          if (shown.has(k.hash)) k.seen = addTo(k.seen, server);
          else if (k.seen.includes(server) && !here) {
            k.seen = without(k.seen, server);
            k.presented = without(k.presented, server);
          }
        }
      });
      await this.entries(accepted);
      await this.upgrade(accepted);
      await this.present();
    });
  }

  /** What accepted entries say: friendships to fetch, a rotation to
   *  follow, and an old key to retire where the move is complete. */
  private async entries(accepted: Friend[]): Promise<void> {
    await this.learn(accepted);
    await this.followRotations(accepted);
    await this.retire(accepted);
  }

  /** A `friend` event. */
  onFriend(f: Friend): Promise<void> {
    return this.run(async () => {
      if (f.state === 'accepted') {
        await this.entries([f]);
        await this.present();
        return;
      }
      if (f.state !== 'removed') return;
      const held = this.b.friendships.filter((k) => k.friend === f.fingerprint || k.logins[this.d.server] === f.login);
      if (!held.length) return;
      if (f.withdraw) {
        await this.withdrawn(f.withdraw, [...new Set(held.map((k) => k.friend))]);
        return;
      }
      // Ended here alone: an account went, a device's revocation was
      // applied, or a removal carried no withdrawal. Presented again,
      // since what this device holds is still the user's.
      await this.update((b) => {
        for (const k of b.friendships) {
          if (held.some((h) => h.hash === k.hash)) {
            k.presented = without(k.presented, this.d.server);
            k.seen = without(k.seen, this.d.server);
          }
        }
      });
      await this.present();
    });
  }

  /** Fetch and check what the entries name that this client does not
   *  hold, and adopt what this device signed (§5.1). */
  private async learn(entries: Friend[]): Promise<void> {
    const held = new Set(this.b.friendships.map((k) => k.hash));
    const login = new Map<string, string>();
    const own = new Set(entries.flatMap((f) => f.friendships?.slice(0, 1) ?? []));
    for (const f of entries) for (const h of f.friendships ?? []) if (!held.has(h)) login.set(h, f.login);
    for (const hashes of chunks([...login.keys()])) {
      const ok = await this.d.conn.friendshipsFetch({ hashes });
      for (const { hash, friendship } of ok.friendships) {
        if (!friendship) continue;
        let f: Friendship;
        try {
          f = await checkFriendship(unb64(friendship), this.now(), this.cutoffs());
        } catch {
          continue;
        }
        if (b64(f.hash) !== hash) continue;
        const adopted = this.adoptable(f);
        if (adopted === null) continue;
        await this.keep(f, adopted, own.has(hash), login.get(hash));
      }
    }
  }

  /** True where this device signed our half and may adopt it at once,
   *  false where another device did and the user is to confirm it, and
   *  `null` where it is not ours to keep. */
  private adoptable(f: Friendship): boolean | null {
    const self = this.self;
    const offering = fingerprintToString(f.offer.offerer) === self;
    if (!offering && fingerprintToString(f.offer.to) !== self) return null;
    const ours = offering ? f.offer : f.acceptance;
    if (b64(decodeDeviceCert(ours.cert).device) !== this.device) return false;
    if (!offering) return true;
    // An offer comes back adopted only if this device holds it and sees
    // the acceptance in time by its own clock (the objects, §3).
    const raw = b64(f.offer.raw);
    const mine = this.b.offers.find((o) => o.raw === raw);
    return mine !== undefined && this.now() <= f.offer.expires + S ? true : null;
  }

  /** A friend's entry under a key other than the one a friendship holds
   *  is a rotation (§10): its records are fetched and both signatures of
   *  each checked here. The commitment this client cannot check is the
   *  server's word, so the successor's upgrade offer waits for the
   *  user's. */
  private async followRotations(accepted: Friend[]): Promise<void> {
    const oldKey = (f: Friend) => this.b.friendships.find((k) => k.logins[this.d.server] === f.login && k.friend !== f.fingerprint)?.friend;
    const moved = accepted.filter((f) => {
      const old = f.fingerprint && oldKey(f);
      return old && !this.b.moves.some((m) => m.from === old && m.to === f.fingerprint);
    });
    if (!moved.length) return;
    const ok = await this.d.conn.friendshipsFetch({ fingerprints: moved.map((f) => f.fingerprint!) });
    for (const { fingerprint, records } of ok.rotations) {
      const f = moved.find((m) => m.fingerprint === fingerprint);
      const old = f && oldKey(f);
      if (!old || !records.length) continue;
      try {
        const chain = await Promise.all(records.map((r) => parseRotation(unb64(r))));
        const end = rotationChainEnd(fingerprintFromString(old)!, chain);
        if (!end || fingerprintToString(end) !== fingerprint) continue;
      } catch {
        continue;
      }
      await this.update((b) => void b.moves.push({ from: old, to: fingerprint, records }));
      this.d.say(
        `${f.login}'s identity key has rotated to a new one, on this server's word. When they offer your friendship under it, ` +
          'Friends asks you before accepting.',
      );
    }
  }

  /** Withdraw a moved friend's old pair on this server once its entry
   *  carries only the new friendship, presented by both parties, so the
   *  edge stands (§10); the old friendship goes once no server has it. */
  private async retire(accepted: Friend[]): Promise<void> {
    const server = this.d.server;
    for (const m of this.b.moves) {
      const entry = accepted.find((f) => f.fingerprint === m.to);
      const hashes = entry?.friendships ?? [];
      const moved = hashes.length > 0 && hashes.every((h) => this.with(m.to).some((k) => k.hash === h && this.adopted(k)));
      const old = this.with(m.from).filter((k) => k.presented.includes(server) || k.seen.includes(server));
      if (!moved || !old.length) continue;
      const now = this.now();
      const w = await this.signWithdrawal(await this.pairWith(m.from), this.self, now, now);
      const result = (await this.d.conn.friendshipsPresent({ withdrawals: [b64(w)] })).withdrawals[0]?.result;
      if (result === 'stale') this.stale();
      if (result !== 'ok' && result !== 'bad_signature') continue;
      await this.update((b) => {
        for (const k of b.friendships) {
          if (k.friend !== m.from) continue;
          k.presented = without(k.presented, server);
          k.seen = without(k.seen, server);
          k.bringTo = without(k.bringTo, server);
        }
        b.friendships = b.friendships.filter((k) => k.friend !== m.from || k.presented.length || k.seen.length);
      });
    }
  }

  /** A local edge between two linked accounts, on a server the user
   *  brings friends to, is offered an upgrade (§4.1). */
  private async upgrade(accepted: Friend[]): Promise<void> {
    if (!this.choice.bring) return;
    for (const f of accepted) {
      if (!f.fingerprint || f.friendships?.length || f.offer || this.choice.leftOut.includes(f.fingerprint)) continue;
      // Only a friend who rotated offers under their new key (§10).
      if (this.b.friendships.some((k) => k.logins[this.d.server] === f.login && k.friend !== f.fingerprint)) continue;
      if (this.with(f.fingerprint).some((k) => this.adopted(k))) continue;
      if (this.b.offers.some((o) => o.to === f.fingerprint && o.server === this.d.server)) continue;
      try {
        await this.offer(f.login, f.fingerprint, undefined);
      } catch (e) {
        if (code(e) === 'stale') this.stale();
        if (code(e) === 'rate_limited') return;
      }
    }
  }

  /** Present the adopted friendships not yet presented here, one for
   *  each friend found here: every one where the user brings friends
   *  here, and elsewhere those already brought here before. */
  private async present(): Promise<void> {
    const choice = this.choice;
    const server = this.d.server;
    const latest = new Map<string, KeptFriendship>();
    for (const k of this.b.friendships) {
      if (!this.adopted(k) || choice.leftOut.includes(k.friend) || choice.refused.includes(k.hash)) continue;
      if (this.movedTo(k.friend) || (!choice.bring && !k.bringTo.includes(server))) continue;
      const had = latest.get(k.friend);
      if (!had || k.signedAt > had.signedAt) latest.set(k.friend, k);
    }
    const due: KeptFriendship[] = [];
    for (const k of latest.values()) {
      if (k.presented.includes(server)) continue;
      try {
        await this.d.conn.findUser({ fingerprint: k.friend });
        due.push(k);
      } catch (e) {
        // Not here, or not to be found: tried again at a later login.
        if (code(e) !== 'no_such_user') break;
      }
    }
    for (const round of chunks(due)) {
      let ok: Awaited<ReturnType<KeeperConn['friendshipsPresent']>>;
      try {
        ok = await this.d.conn.friendshipsPresent({ friendships: round.map((k) => k.raw) });
      } catch (e) {
        if (code(e) === 'rate_limited') return;
        throw e;
      }
      for (const [i, r] of ok.friendships.entries()) {
        const k = round[i]!;
        if (r.result === 'ok') {
          await this.update((b) => {
            const into = b.friendships.find((x) => x.hash === k.hash);
            if (!into) return;
            into.presented = addTo(into.presented, server);
            into.bringTo = addTo(into.bringTo, server);
          });
        } else if (r.result === 'bad_signature') {
          await this.update((b) => {
            b.friendships = b.friendships.filter((x) => x.hash !== k.hash);
          });
        } else if (r.result === 'withdrawn') {
          if (r.withdraw) await this.withdrawn(r.withdraw, [k.friend]);
          else {
            await this.update((b) => {
              const c = (b.servers[server] ??= { bring: false, leftOut: [], refused: [] });
              c.refused = addTo(c.refused, k.hash);
            });
          }
        }
      }
    }
  }

  /** A withdrawal a server handed over, ending friendships with one of
   *  `friends`, a friend's keys before and after a rotation: checked
   *  whole against the rotations this client followed, its cutoff kept,
   *  what it ends dropped, and owed to every other server one of those
   *  was presented on (§5.3). §5.3 also has a client spread none a
   *  revoked device signed; this client learns of no revocations, so
   *  that check is not made. */
  private async withdrawn(withdraw: string, friends: string[]): Promise<void> {
    for (const friend of friends) {
      let c: FriendCutoff;
      try {
        const rotations = await Promise.all(
          this.b.moves.filter((m) => m.from === friend).flatMap((m) => m.records.map((r) => parseRotation(unb64(r)))),
        );
        const pair = [fingerprintFromString(this.self)!, fingerprintFromString(friend)!] as const;
        c = cutoffOf(await checkFriendWithdrawal(unb64(withdraw), this.now(), pair, rotations));
      } catch {
        continue;
      }
      await this.cut({ pair: b64(c.pair), party: fingerprintToString(c.party), before: c.before, owed: [] }, false);
      return;
    }
  }

  /** Keep `c`, drop what it ends, or with `all` every friendship of its
   *  pair, and owe it to the servers they were presented on but this
   *  one. */
  private async cut(c: KeptCutoff, all: boolean): Promise<void> {
    await this.update((b) => {
      const gone = b.friendships.filter((k) => (all ? k.pair === c.pair : ends(c, k)));
      const owed = new Set([...c.owed, ...gone.flatMap((k) => [...k.presented, ...k.seen])]);
      owed.delete(this.d.server);
      const had = b.cutoffs.find((x) => x.pair === c.pair && x.party === c.party);
      if (had) {
        had.before = Math.max(had.before, c.before);
        had.owed = [...new Set([...had.owed, ...owed])];
      } else {
        b.cutoffs.push({ ...c, owed: [...owed] });
      }
      b.friendships = b.friendships.filter((k) => !gone.includes(k));
    });
  }

  // --- the user's acts ------------------------------------------------------

  private async offer(login: string, to: string, note: string | undefined): Promise<FriendStateOk> {
    const now = this.now();
    if (this.cutOff(await this.pairWith(to))) throw new Error('A withdrawal of a friendship with them is too recent to make another yet.');
    const raw = await signFriendOffer(this.d.signer.key, {
      from: this.identity,
      to: fingerprintFromString(to)!,
      time: now,
      expires: now + OFFER_LIFETIME_SECONDS,
      cert: this.d.signer.cert,
    });
    const ok = await this.d.conn.friendAdd(login, note, b64(raw));
    await this.update((b) => {
      b.offers.push({ raw: b64(raw), to, server: this.d.server, login, expires: now + OFFER_LIFETIME_SECONDS });
    });
    return ok;
  }

  /** Ask `login` for friendship: with an offer to the identity the
   *  server shows their account links, and as a plain request where it
   *  shows none or cannot find them, whose answer then says why. */
  add(login: string, note: string | undefined): Promise<FriendStateOk> {
    return this.run(async () => {
      const fingerprint = await this.d.conn.findUser(login).then((ok) => ok.user.fingerprint, () => undefined);
      if (!fingerprint) return this.d.conn.friendAdd(login, note);
      try {
        return await this.offer(login, fingerprint, note);
      } catch (e) {
        if (code(e) === 'stale') this.stale();
        throw e;
      }
    });
  }

  /** Accept `f`'s request, or upgrade offer, with this client's own
   *  acceptance where it carries an offer for this identity; a plain
   *  accept otherwise. An offer under a key other than the one a
   *  friendship with this login holds, with no checked rotation to it,
   *  is someone new (§10): a request is accepted plainly, and an
   *  upgrade offer refused. */
  accept(f: Friend): Promise<FriendStateOk> {
    return this.run(async () => {
      const plain = () => this.d.conn.friendRespond(f.login, true);
      if (!f.offer) return plain();
      const now = this.now();
      let offer;
      try {
        offer = await checkFriendOffer(unb64(f.offer), now, this.cutoffs());
      } catch {
        return plain();
      }
      const from = fingerprintToString(offer.offerer);
      const usable =
        fingerprintToString(offer.to) === this.self &&
        now <= offer.expires &&
        (f.fingerprint === undefined || f.fingerprint === from) &&
        !this.cutOff(await this.pairWith(from));
      if (!usable) return plain();
      const under = this.b.friendships.find((k) => k.logins[this.d.server] === f.login && k.friend !== from);
      const old = this.rotatedFrom(from);
      if (under && under.friend !== old) {
        if (f.state === 'pending_in') return plain();
        throw new Error(
          `${f.login} offers under a key your friendship with them is not under, and no rotation to it checks, so it was not accepted.`,
        );
      }
      const acceptance = await signFriendAcceptance(this.d.signer.key, {
        offer: offer.raw,
        from: this.identity,
        time: now,
        cert: this.d.signer.cert,
      });
      const friendship = await checkFriendship(friendshipBytes(offer.raw, acceptance), now, this.cutoffs());
      let ok: FriendStateOk;
      try {
        ok = await this.d.conn.friendRespond(f.login, true, b64(friendship.raw));
      } catch (e) {
        if (code(e) === 'stale') this.stale();
        throw e;
      }
      // A successor's friendship goes wherever the old one was presented.
      const before = this.with(old);
      await this.keep(friendship, true, true, f.login, [...new Set(before.flatMap((k) => k.presented))]);
      if (before.length) await this.present();
      return ok;
    });
  }

  /** End the friendship with `f`: everywhere, with a withdrawal, where it
   *  is portable; here alone otherwise. A request is canceled plainly. */
  remove(f: Friend, block = false): Promise<void> {
    return this.run(async () => {
      const friend = f.fingerprint ?? this.b.friendships.find((k) => k.logins[this.d.server] === f.login)?.friend;
      const portable = f.state !== 'pending_out' && f.state !== 'pending_in' && this.with(friend).length > 0;
      if (!portable || !friend) {
        await (block ? this.d.conn.block({ login: f.login }) : this.d.conn.friendRemove(f.login));
        if (friend) await this.update((b) => void (b.offers = b.offers.filter((o) => o.to !== friend)));
        return;
      }
      const now = this.now();
      const pair = await this.pairWith(friend);
      const withdraw = b64(await this.signWithdrawal(pair, this.self, now, now));
      try {
        await (block ? this.d.conn.block({ login: f.login, withdraw }) : this.d.conn.friendRemove({ login: f.login, withdraw }));
      } catch (e) {
        // Removed here all the same; the other servers are owed it.
        if (code(e) !== 'stale') throw e;
        this.stale();
      }
      await this.cut({ pair, party: this.self, before: now, owed: [] }, true);
      await this.update((b) => void (b.offers = b.offers.filter((o) => o.to !== friend)));
    });
  }

  /** The user's word on a friendship this device did not sign: kept and
   *  presented, or withdrawn everywhere it was seen (§6). */
  confirm(hash: string, keep: boolean): Promise<void> {
    return this.run(async () => {
      const k = this.b.friendships.find((x) => x.hash === hash);
      if (!k) return;
      if (keep) {
        await this.update((b) => {
          const into = b.friendships.find((x) => x.hash === hash);
          if (into) into.adoptedBy = addTo(into.adoptedBy, this.device);
        });
        return this.present();
      }
      const now = this.now();
      const w = await this.signWithdrawal(k.pair, this.self, now, now);
      const ok = await this.d.conn.friendshipsPresent({ withdrawals: [b64(w)] });
      if (ok.withdrawals[0]?.result === 'stale') this.stale();
      await this.cut({ pair: k.pair, party: this.self, before: now, owed: ok.withdrawals[0]?.result === 'ok' ? [] : [this.d.server] }, true);
    });
  }

  /** Whether the user brings their portable friends to this server, and
   *  with it on, whom they leave out, settled before anything is
   *  presented: the list chosen replaces the one before. */
  setBring(on: boolean, leftOut: string[] = []): Promise<void> {
    return this.run(async () => {
      await this.update((b) => {
        const c = (b.servers[this.d.server] ??= { bring: on, leftOut: [], refused: [] });
        c.bring = on;
        c.device = this.device;
        if (on) c.leftOut = leftOut;
      });
      if (on) await this.present();
    });
  }

  /** Leave `friend` out on this server, or bring them again. Leaving one
   *  out drops what this account presented for them here, where it
   *  presented anything, and is not brought here again. */
  leaveOut(friend: string, out: boolean): Promise<void> {
    return this.run(async () => {
      const server = this.d.server;
      const presented = this.with(friend).some((k) => k.presented.includes(server));
      await this.update((b) => {
        const c = (b.servers[server] ??= { bring: false, leftOut: [], refused: [] });
        c.leftOut = out ? addTo(c.leftOut, friend) : without(c.leftOut, friend);
        if (out) {
          for (const k of b.friendships) {
            if (k.friend === friend) [k.presented, k.bringTo] = [without(k.presented, server), without(k.bringTo, server)];
          }
        }
      });
      if (out && presented) await this.d.conn.friendRemove({ fingerprint: friend });
      if (!out) await this.present();
    });
  }
}

/** The keeper a connection holds for its latest login. An open that a
 *  later login, or an open for another connection, overtook while it
 *  was in flight publishes nothing, so a keeper never outlives the grant
 *  and the signer it was opened with. */
export class KeeperSlot<K, O> {
  private generation = 0;
  private owner: O | null = null;
  private keeper: K | null = null;

  /** The keeper `owner` holds now, if any. */
  get(owner: O): K | null {
    return owner === this.owner ? this.keeper : null;
  }

  /** A new login: whatever was held, or is being opened, is not its. */
  reset(): void {
    this.generation++;
    this.owner = this.keeper = null;
  }

  /** The keeper `owner` holds, or the one `make` opens for it, published
   *  only if nothing overtook it. */
  async open(owner: O, make: () => Promise<K>): Promise<K | null> {
    const held = this.get(owner);
    if (held) return held;
    const generation = ++this.generation;
    const keeper = await make();
    if (generation !== this.generation) return null;
    [this.owner, this.keeper] = [owner, keeper];
    return keeper;
  }
}
