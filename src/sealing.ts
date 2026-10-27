/** Who a private message is sealed to (hxd-ng's `docs/e2e-messages.md`
 * §4.3, §4.4, §8): the fingerprint each conversation was verified under,
 * remembered by server and fingerprint across reloads, and the session a message to
 * it goes to, or why none can be. No DOM. */

import type { User } from '@hotline-ng/client';

import { mergePeer, peerKey, type PeerRecord } from './identity/storage';
import type { Line } from './state';

export interface PeerStore {
  all(): Promise<PeerRecord[]>;
  merge(record: PeerRecord): Promise<PeerRecord>;
}

/** The peers this browser has sealed to, or had messages verified from,
 *  one record per server and fingerprint, held in memory and merged into
 *  `store`, which every tab shares. */
export class PeerMemory {
  private readonly records = new Map<string, PeerRecord>();

  constructor(private readonly store: PeerStore | null = null) {}

  /** What the store holds, merged with what was noted here. */
  async load(): Promise<void> {
    for (const r of (await this.store?.all()) ?? []) this.merged(r);
  }

  get(server: string, fingerprint: string): PeerRecord | undefined {
    return this.records.get(peerKey(server, fingerprint));
  }

  /** `fingerprint` seen as `who` on `server`, with what changed, and
   *  `accepted` where the user took it in place of another; settled once
   *  it is written, or could not be. */
  note(
    fingerprint: string,
    server: string,
    who: { login?: string; nick: string },
    change: { sealed?: true; deniable?: boolean; accepted?: true } = {},
  ): Promise<void> {
    const { accepted, ...rest } = change;
    const now = Date.now();
    const record = this.merged({
      fingerprint,
      server,
      logins: who.login ? [who.login] : [],
      nick: who.nick,
      at: now,
      ...rest,
      ...(accepted ? { accepted: now } : {}),
    });
    return (this.store?.merge(record).then((stored) => void this.merged(stored)) ?? Promise.resolve()).catch(() => {
      /* storage refused; remembered this page load */
    });
  }

  private merged(r: PeerRecord): PeerRecord {
    const key = peerKey(r.server, r.fingerprint);
    const record = mergePeer(this.records.get(key), r);
    this.records.set(key, record);
    return record;
  }

  /** The fingerprint this account was last seen under on this server. */
  byLogin(server: string, login: string): string | null {
    return this.latest((r) => r.server === server && r.logins.some((l) => same(l, login)));
  }

  /** The fingerprint last seen under this nick on this server. Anyone
   *  can take a nick, so this only ever makes a question: a wrong match
   *  costs one, a missed one a silent downgrade. */
  byNick(server: string, nick: string): string | null {
    return this.latest((r) => r.server === server && r.nick === nick);
  }

  /** The one the user last accepted, and among those accepted no later
   *  the one last seen: so a tab that never heard of an acceptance, or a
   *  clock set back, cannot undo it by seeing the old one again. */
  private latest(match: (r: PeerRecord) => boolean): string | null {
    const rank = (r: PeerRecord) => [r.accepted ?? 0, r.at] as const;
    let best: PeerRecord | undefined;
    for (const r of this.records.values()) {
      if (!match(r)) continue;
      const [a, b] = [rank(r), best && rank(best)];
      if (!b || a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) best = r;
    }
    return best?.fingerprint ?? null;
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A conversation, as far as who it is with goes. */
export interface PeerConversation {
  title: string;
  peer: { uid?: number; login?: string };
  verified?: string;
  deniable?: boolean;
}

/** The identity a conversation is under, `known`: its own, or the one
 *  remembered for its login; and with neither, `hint`, the one last seen
 *  under its nick, which anyone can take, so it only ever warns or asks. */
export function conversationIdentity(
  conv: PeerConversation,
  memory: PeerMemory,
  server: string,
): { known: string | null; hint: string | null } {
  const known = conv.verified ?? (conv.peer.login ? memory.byLogin(server, conv.peer.login) : null);
  return { known, hint: known ? null : memory.byNick(server, conv.title) };
}

/** What a message under `fp` does to a conversation: gives it that
 *  identity where it is the one known, or where nothing is known or
 *  hinted at but it; and is otherwise warned of (§8) and moves nothing,
 *  since a server can put any identity on a uid and have a message
 *  verify under it. Peer memory is written only for one adopted. */
export function adoption(ids: { known: string | null; hint: string | null }, fp: string): 'adopt' | 'warn' {
  return (ids.known ?? ids.hint ?? fp) === fp ? 'adopt' : 'warn';
}

/** What a received message adds to peer memory: its signer seen as the
 *  login and nick it came from, only where it verified, or opened
 *  deniably, under `known`, the identity its conversation is under once
 *  the message went in. An unsigned one, or one under another identity,
 *  adds nothing, since its login is only the server's word. */
export function sighting(
  sig: { state: string; signer: string | null } | null | undefined,
  known: string | null,
  from: { login?: string; nick: string },
): { fingerprint: string; who: { login?: string; nick: string } } | null {
  if (!sig?.signer || (sig.state !== 'verified' && sig.state !== 'deniable') || sig.signer !== known) return null;
  return { fingerprint: sig.signer, who: { ...(from.login ? { login: from.login } : {}), nick: from.nick } };
}

/** Whether a conversation's sealed messages go deniably by the user's
 *  choice for it, kept under its known identity, or on it alone with
 *  none; `undefined` where the user made none. */
export function deniableChoice(conv: PeerConversation, memory: PeerMemory, server: string): boolean | undefined {
  const { known } = conversationIdentity(conv, memory, server);
  return conv.deniable ?? (known ? memory.get(server, known)?.deniable : undefined);
}

/** A conversation's identity remembered as seen as `who`, with what
 *  changed, and the deniable choice made on it before it had one, which
 *  would otherwise not outlast a reload. */
export function rememberIdentity(
  conv: PeerConversation,
  memory: PeerMemory,
  server: string,
  fingerprint: string,
  who: { login?: string; nick: string },
  change: { sealed?: true } = {},
): Promise<void> {
  return memory.note(fingerprint, server, who, { ...change, ...(conv.deniable === undefined ? {} : { deniable: conv.deniable }) });
}

/** The user's choice of deniable for a conversation: kept for its known
 *  identity, never one only the roster names, which the server chose. */
export function chooseDeniable(conv: PeerConversation, memory: PeerMemory, server: string, on: boolean): Promise<void> {
  conv.deniable = on;
  const { known } = conversationIdentity(conv, memory, server);
  return known ? memory.note(known, server, { login: conv.peer.login, nick: conv.title }, { deniable: on }) : Promise.resolve();
}

/** Who a private message in the clear is signed to (§4.9, whose `to`
 *  the map must carry), `shown` being the identity the recipient's row
 *  shows, `null` for a row with none and `undefined` for no row: the
 *  identity the conversation is under, or with none the row's; the row's
 *  only once the user agrees where it shows another than the one known
 *  or the nick was last seen under, as a sealed one asks; and `null`,
 *  nothing to sign to, for a row with no identity, which the server
 *  would refuse. */
export function signedTo(
  ids: { known: string | null; hint: string | null },
  shown: string | null | undefined,
): { to: string | null } | { changed: string; was: string } {
  if (shown === null) return { to: null };
  const was = ids.known ?? ids.hint;
  if (shown && was && was !== shown) return { changed: shown, was };
  return { to: ids.known ?? shown ?? null };
}

/** Why this session can never seal a private message, or `null` where
 *  it can: then one that cannot be sealed is asked about, but here
 *  nothing could have been, so each conversation is told once instead. */
export function neverSeals(session: { sealing: boolean; device: boolean }): string | null {
  if (!session.device) return 'it did not log in with an identity whose device can seal them';
  return session.sealing ? null : 'the server does not carry sealed messages';
}

/** What a private message this session cannot seal needs before it
 *  goes in the clear: asked about each time, where it was sealed with
 *  before and this session proves a device that can seal, since then
 *  the server only failed to say it carries them; told once a
 *  conversation otherwise. */
export function neverSealedFallback(session: { device: boolean }, before: boolean): 'ask' | 'note' {
  return session.device && before ? 'ask' : 'note';
}

/** Whether a message to this conversation could have been sealed
 *  before, so one that cannot be is asked about each time (§8): one in
 *  it was; its uid's session said it could open them this connection,
 *  whatever its row says now; or one of `fingerprints`, the identity it
 *  was verified under and the one the roster shows, was seen able to, or
 *  remembered sealed to or from. */
export function sealedBefore(
  conv: { lines: readonly Line[]; peer: { uid?: number } },
  fingerprints: readonly (string | null)[],
  sealedRows: ReadonlyMap<number, string>,
  memory: PeerMemory,
  server: string,
): boolean {
  if (conv.lines.some((l) => l.sealed === true)) return true;
  if (conv.peer.uid !== undefined && sealedRows.has(conv.peer.uid)) return true;
  const seen = new Set(sealedRows.values());
  return fingerprints.some((fp) => fp !== null && (seen.has(fp) || memory.get(server, fp)?.sealed === true));
}

/** The fingerprint a private message was verified under: a received one
 *  verified or deniable by its signer, and one this client sent signed
 *  or sealed by who it went to. */
export function lineFingerprint(line: Line): string | null {
  const sig = line.signature;
  if (line.local) return sig?.to ?? null;
  return (sig?.state === 'verified' || sig?.state === 'deniable') && sig.signer ? sig.signer : null;
}

/** Where a sealed message goes: a session holding the identity it is
 *  sealed to; or, the conversation's own showing another than `was`
 *  that can open one, that other, once the user agrees; or why it
 *  cannot be sealed. */
export type SealTarget =
  | { uid: number; fingerprint: string }
  | { changed: string; uid: number; was: string }
  | { cannot: string };

/** §4.4: only to `known`, the fingerprint the conversation was verified
 *  under, at the uid the conversation names or any other holding it;
 *  with nothing known, to whoever the roster shows at that uid, asked
 *  about first where it is not `hint`, the one last seen under the
 *  conversation's nick, which never sends anywhere else. */
export function sealTarget(
  conv: { title: string; peer: { uid?: number } },
  known: string | null,
  roster: readonly User[],
  hint: string | null = null,
): SealTarget {
  const uid = conv.peer.uid;
  const row = uid !== undefined ? roster.find((u) => u.uid === uid) : undefined;
  const shown = row?.identity?.fingerprint;
  if (known && shown !== known) {
    const elsewhere = roster.find((u) => u.identity?.fingerprint === known);
    if (elsewhere) {
      return elsewhere.identity!.sealed
        ? { uid: elsewhere.uid, fingerprint: known }
        : { cannot: `the session holding ${conv.title}'s identity cannot open sealed messages` };
    }
    if (row && shown && row.identity!.sealed) return { changed: shown, uid: row.uid, was: known };
    if (row) return { cannot: `the server no longer shows ${conv.title} with the identity their messages here were verified under` };
  }
  if (!row) return { cannot: `${conv.title} is not here, and a sealed message is never stored` };
  if (!row.identity?.sealed || !shown) return { cannot: `${conv.title}'s session cannot open sealed messages` };
  if (!known && hint && hint !== shown) return { changed: shown, uid: row.uid, was: hint };
  return { uid: row.uid, fingerprint: shown };
}

/** `text` in pieces of at most `max` bytes of UTF-8, cut between
 *  characters as a reader sees them, or between code points within one
 *  too long for a piece, for a message in the clear longer than the
 *  server carries (§4.3), which it would otherwise cut. */
export function splitUtf8(text: string, max: number): string[] {
  const encoder = new TextEncoder();
  // Code points alone where the browser has no segmenter.
  const graphemes = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter().segment(text)].map((g) => g.segment) : [...text];
  const units = graphemes.flatMap((g) => (encoder.encode(g).length > max ? [...g] : [g]));
  const pieces: string[] = [];
  let piece = '';
  let bytes = 0;
  for (const ch of units) {
    const n = encoder.encode(ch).length;
    if (bytes + n > max && piece) {
      pieces.push(piece);
      [piece, bytes] = ['', 0];
    }
    piece += ch;
    bytes += n;
  }
  pieces.push(piece);
  return pieces;
}
