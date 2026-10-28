/** Contacts (hxd-ng's `docs/e2e-messages.md` §8): the people peer memory
 *  holds, one per fingerprint across every server it was seen on, whether
 *  the user compared the fingerprint out of band, and the name they gave
 *  it then, which is all that names one. No DOM. */

import { fingerprintFromString, fingerprintToString } from '@hotline-ng/client';

import type { ContactMark, PeerRecord } from './identity/storage';
import type { PeerMemory } from './sealing';

export interface Contact {
  fingerprint: string;
  /** Each server it was seen on, the latest first. */
  seen: PeerRecord[];
  mark: ContactMark | undefined;
  compared: boolean;
}

/** Every contact, the one seen latest first; one marked and never seen
 *  in a private message is one too. */
export function contactList(memory: PeerMemory): Contact[] {
  const fps = new Set([...memory.all(), ...memory.marked()].map((r) => r.fingerprint));
  const latest = (c: Contact) => Math.max(c.seen[0]?.at ?? 0, c.mark?.compared ?? 0, c.mark?.unmarked ?? 0);
  return [...fps].map((fp) => contactOf(memory, fp)).sort((a, b) => latest(b) - latest(a));
}

export function contactOf(memory: PeerMemory, fingerprint: string): Contact {
  return {
    fingerprint,
    seen: memory
      .all()
      .filter((r) => r.fingerprint === fingerprint)
      .sort((a, b) => b.at - a.at),
    mark: memory.mark(fingerprint),
    compared: memory.compared(fingerprint),
  };
}

/** What a contact is named by: the name the user compared it as, and
 *  nothing else. A nick is the server's word, and a server can put any
 *  nick on any key, so one never names a key. */
export function contactName(c: Contact): string | null {
  return c.compared ? (c.mark?.name ?? null) : null;
}

/** What names what a key signed: the user's name for it, `null` with
 *  none, and whether it was compared, `null` for this user's own. */
export type ContactOf = (fingerprint: string) => { name: string | null; compared: boolean | null };

/** How much of a fingerprint names a signer with no name: enough that
 *  nobody makes another key to match it. */
const SIGNER_CHARS = 16;

/** Another compared key the user gave `name` to, besides `fingerprint`. */
export function sharedName(memory: PeerMemory, fingerprint: string, name: string): string | null {
  return memory.marked().find((m) => m.fingerprint !== fingerprint && m.name === name && memory.compared(m.fingerprint))?.fingerprint ?? null;
}

/** A name, with the key beside it where another compared key has it too. */
export function contactLookup(memory: PeerMemory, self: string | null): ContactOf {
  return (fp) => {
    const name = contactName(contactOf(memory, fp));
    return {
      name: name && sharedName(memory, fp, name) ? `${name} (key ${fp.slice(0, SIGNER_CHARS)})` : name,
      compared: fp === self ? null : memory.compared(fp),
    };
  };
}

/** A fingerprint as the library writes one, so another spelling of a key
 *  is the same key; `null` for one that is not a fingerprint. */
export function canonicalFingerprint(fp: string): string | null {
  const bytes = fingerprintFromString(fp);
  return bytes ? fingerprintToString(bytes) : null;
}

/** Who something signed is named as (§8): an unsigned one, or one whose
 *  signature did not parse, by its nick; a signed one by the name the
 *  user compared its signer as, or with none by the fingerprint, and
 *  the nick the server put on it always beside, as the server's; and an
 *  unverified one always by the fingerprint, which is all that was
 *  checked. `compared` is `null` where there is nothing to say. */
export function signerLabel(
  sig: { state: string; signer: string | null } | undefined,
  nick: string,
  contact: ContactOf | undefined,
): { name: string; byKey: boolean; nick: string | null; compared: boolean | null } {
  if (!sig || !['verified', 'elsewhere', 'unverified', 'deniable'].includes(sig.state)) {
    return { name: nick, byKey: false, nick: null, compared: null };
  }
  if (!sig.signer) return { name: 'unknown key', byKey: true, nick: nick || null, compared: null };
  const c = sig.state === 'unverified' ? undefined : contact?.(sig.signer);
  const name = c?.name ?? null;
  return { name: name ?? sig.signer.slice(0, SIGNER_CHARS), byKey: name === null, nick: nick || null, compared: c?.compared ?? null };
}

/** A fingerprint as it is read aloud: in fours, so two people can keep
 *  their place. */
export function groupFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? '';
}
