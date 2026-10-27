/** The server key a host is pinned to (hxd-ng's `docs/e2e-messages.md`
 * §4.13, `docs/server-key-handover.md` §5), checked on each connect by
 * a challenge the key signed for the host. */

import {
  ServerTrust,
  bytesToHex,
  canonicalHost,
  fetchChallenge,
  fetchDiscovery,
  type ServerTrustOutcome,
} from '@hotline-ng/client';

import type { PinnedKey } from '../signing';
import { identityBase } from './base';
import { newsGuids, serverPins } from './storage';

const trust = new ServerTrust(serverPins);

export interface ServerKeyCheck {
  outcome: ServerTrustOutcome;
  /** The user accepted the warning `outcome` carries. */
  accept(): Promise<ServerTrustOutcome>;
  /** The pin as it stands now. */
  pinned(): Promise<PinnedKey | null>;
}

/** How long discovery and the challenge may take together, so a host
 *  whose HTTP side hangs costs a connect this and no more. */
const CHECK_MS = 5000;

function timeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the server did not answer in time')), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A host that was pinned to a key and now publishes none. */
export class KeyWithdrawn extends Error {
  constructor(host: string) {
    super(`${host} was pinned to a server key and no longer publishes one`);
  }
}

/** The pin is the host this client addressed, never one discovery
 *  names: a challenge endpoint elsewhere would have another server's
 *  key pinned here at first contact, with no warning. */
function challengeUrl(origin: string, path: string): string {
  const url = new URL(path, origin);
  if (!path.startsWith('/') || path.startsWith('//') || url.origin !== origin) {
    throw new Error(`discovery names a challenge endpoint off this server: ${JSON.stringify(path)}`);
  }
  return url.href;
}

/** `null` for a server that names no key to pin. */
export async function checkHostKey(wsUrl: string): Promise<ServerKeyCheck | null> {
  // Where the login goes too, and the pin is that host's.
  const base = identityBase(wsUrl);
  const origin = new URL(base || '/', typeof location !== 'undefined' ? location.href : undefined).origin;
  const host = canonicalHost(new URL(origin).host);
  if (host === null) throw new Error(`${origin} names no host`);
  const fetched = await timeout(
    (async () => {
      const discovery = await fetchDiscovery(origin);
      if (!discovery.serverKey || !discovery.identity.enabled) return null;
      const challenge = await fetchChallenge(challengeUrl(origin, discovery.identity.endpoints.challenge));
      if (challenge.host !== host) throw new Error(`the challenge was vouched for ${challenge.host}, not ${host}`);
      return { discovery, challenge };
    })(),
    CHECK_MS,
  );
  if (!fetched) {
    if (await serverPins.get(host)) throw new KeyWithdrawn(host);
    return null;
  }
  const { discovery, challenge } = fetched;
  const chain = discovery.serverHandovers;
  const now = () => Math.floor(Date.now() / 1000);
  // The news guids a key gave are forgotten with its pin, and again when
  // a key is accepted anew, so a server whose operator re-imported its
  // news under a new key, or that the user accepted afresh, starts clean.
  const before = (await serverPins.get(host))?.key;
  const forget = async (key: Uint8Array | undefined) => {
    if (key) await newsGuids.forget(key).catch(() => undefined);
  };
  const outcome = await trust.check(host, chain, challenge, now());
  const after = (await serverPins.get(host))?.key;
  if (before && after && bytesToHex(before) !== bytesToHex(after)) await forget(before);
  return {
    outcome,
    accept: async () => {
      if (outcome.outcome !== 'warn') return outcome;
      const accepted = await trust.accept(host, outcome.warning, chain, challenge, now());
      const pinned = (await serverPins.get(host))?.key;
      await forget(pinned);
      if (after && pinned && bytesToHex(after) !== bytesToHex(pinned)) await forget(after);
      return accepted;
    },
    pinned: async () => {
      const pin = await serverPins.get(host);
      return pin ? { key: pin.key, followed: pin.followed } : null;
    },
  };
}
