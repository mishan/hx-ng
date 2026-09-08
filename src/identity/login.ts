/**
 * Turning an already-enrolled device into an identity login (this
 * repo's own `docs/identity-keys.md` §5, §8): given discovery the
 * caller already fetched, hand back a token-minting closure
 * `Connection` can call whenever it needs a fresh one — on the first
 * attach, and again if a resume fails and a new socket has to open
 * (`packages/hotline-ng/src/connection.ts`).
 *
 * Linking an existing classic account is deliberately not something
 * this module can do: every path that writes a link requires the
 * device certificate's `manage` bit (hxd-ng's
 * `docs/hotline-ng-identity.md` §8.2), and a Phase B browser's
 * certificate never carries it (`docs/identity-keys.md` §5's `WEB =
 * LOGIN | MESSAGE`). Linking happens out-of-band with `hlid link`,
 * which is what the identity panel's second command line is for — by
 * the time this module runs, a link either already exists on the
 * server or it doesn't, and nothing here can change that.
 */

import {
  fetchChallenge,
  hexToBytes,
  postAuth,
  signLoginProof,
  wsToHttp,
  type AuthSuccess,
  type Credentials,
  type Discovery,
} from '@hotline-ng/client';

import type { StoredDevice } from './storage';

export interface IdentityLoginPlan {
  discovery: Discovery;
  /** Whether a never-seen identity gets a guest session or an invented
   *  account here — hxd-ng's `docs/hotline-ng-identity.md` §5.3 is where
   *  the `create` flag and this trade-off are described; a client should
   *  ask before its first auth against a `create` server, and only
   *  where it matters. */
  couldCreate: boolean;
  identity: NonNullable<Credentials['identity']>;
  /** The most recent auth's own guess at what happened. A prediction,
   *  not a commitment (hxd-ng's `docs/hotline-ng-identity.md` §5.3) —
   *  `self.identity.outcome` off the login reply is the one to trust;
   *  this is for showing the guess sooner. */
  lastOutcome: () => AuthSuccess | null;
}

/**
 * Takes `discovery` as already fetched rather than fetching it itself:
 * a caller deciding the §5.3 create-account question (this repo's
 * `src/ui/connect.ts`) needs discovery *before* it knows `create`, so
 * fetching it again in here would cost the first identity login an
 * extra round trip for a document the caller is already holding.
 */
export function planIdentityLogin(
  wsUrl: string,
  discovery: Discovery,
  device: StoredDevice,
  create: boolean | undefined,
): IdentityLoginPlan {
  if (!device.cert || !device.card) throw new Error('This browser has no enrolled device yet.');
  const cert = device.cert;
  const card = device.card;
  const devicePub = hexToBytes(device.devicePub);

  const httpBase = wsToHttp(wsUrl);
  const di = discovery.identity;
  if (!di.enabled) throw new Error('This server does not run the identity endpoints.');

  let last: AuthSuccess | null = null;
  const getToken = async (): Promise<string> => {
    const challenge = await fetchChallenge(`${httpBase}${di.endpoints.challenge}`);
    const proof = await signLoginProof(device.deviceSign, {
      challenge: challenge.challenge,
      serverKey: challenge.serverKey,
      device: devicePub,
      time: Math.floor(Date.now() / 1000),
    });
    const success = await postAuth(`${httpBase}${di.endpoints.auth}`, { card, deviceCert: cert, proof, create });
    last = success;
    return success.token;
  };

  return {
    discovery,
    couldCreate: di.newAccounts === 'create',
    identity: { getToken },
    lastOutcome: () => last,
  };
}
