/** Where the identity endpoints for a socket are reached: the login's
 * challenge and auth and the server key check alike, so a proof and a
 * pin name the same host. */

import { wsToHttp } from '@hotline-ng/client';

/** The socket's own origin, or under the dev server, which proxies
 *  `/identity` with `Host` kept (`vite.config.ts`), the page's for a
 *  socket on its host name: `''`, a relative base. */
export function identityBase(wsUrl: string): string {
  if (import.meta.env.DEV) return wsToHttp(wsUrl);
  const ws = new URL(wsUrl);
  return new URL(`${ws.protocol === 'wss:' ? 'https:' : 'http:'}//${ws.host}`).origin;
}
