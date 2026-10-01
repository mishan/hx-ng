/**
 * Which wire a server address leads to.
 *
 * An address the connect form is given is either a WebSocket URL — the
 * ng listener, as it always was — or a classic one: `hotline://host:port`
 * or a bare `host:port`, from a tracker, a bookmark or habit. A browser
 * cannot open TCP, so a classic address is only reachable where a relay
 * stands beside the server, and hxd-ng's `docs/hotline-ng-auth.md` §5.1
 * says where to look for one: the classic port plus 200, then the host's
 * default port.
 *
 * Either way the discovery document decides. One that lists `ng.ws` is an
 * ng server; one that lists `ng.trtp` and no `ng.ws` is a classic server
 * behind a relay, reached through its `/trtp`.
 */

export type Route =
  | { wire: 'ng'; url: string }
  | {
      wire: 'classic';
      url: string;
      name: string;
      /** Found on the host's web port rather than beside the classic one,
       *  so it may front a different Hotline server on that host from the
       *  one the address names: the document does not say which. */
      shared: boolean;
    };

/** How long one probe may take. A firewall that drops rather than refuses
 *  would otherwise hold the form for as long as the browser lets it. */
const PROBE_MS = 3000;

/** The same, for an ng address, which is the ng listener unless its host
 *  says otherwise: every ng connect and resume waits on it, and a host
 *  with something to say says it quickly. */
const NG_PROBE_MS = 1000;

/** The classic port when an address names none. */
const CLASSIC_PORT = 5500;

async function discover(base: string, ms = PROBE_MS): Promise<{ doc: unknown; at: string }> {
  const at = new URL('/.well-known/hotline', base).href;
  // A redirect could lead to the classic port, and a relay sends none.
  const res = await fetch(at, { cache: 'no-cache', redirect: 'error', signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`discovery: HTTP ${res.status}`);
  return { doc: await res.json(), at };
}

/** A path in a discovery document, as the WebSocket URL it names. */
function socketUrl(ref: string, at: string): string {
  const u = new URL(ref, at);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  return u.href;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** What a discovery document says, or `null` for one that says nothing
 *  this client can use — whatever shape it came in. */
function fromDoc(doc: unknown, at: string, shared: boolean): Route | null {
  if (typeof doc !== 'object' || doc === null) return null;
  const d = doc as Record<string, unknown>;
  const ng = typeof d.ng === 'object' && d.ng !== null ? (d.ng as Record<string, unknown>) : {};
  const ws = str(ng.ws);
  if (ws) return { wire: 'ng', url: socketUrl(ws, at) };
  const trtp = str(ng.trtp);
  if (!trtp) return null;
  const url = socketUrl(trtp, at);
  // A socket elsewhere than its document could be the classic port.
  if (new URL(url).host !== new URL(at).host) return null;
  return { wire: 'classic', url, name: str(d.name) ?? '', shared };
}

/** `hotline://host:port` or `host:port`, as a host — an IPv6 one in
 *  brackets, as a URL writes it — and a classic port; `null` for anything
 *  with another scheme. */
export function classicAddress(address: string): { host: string; port: number } | null {
  const a = address.trim();
  let rest: string;
  if (/^hotline:\/\//i.test(a)) rest = a.slice('hotline://'.length);
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) rest = a;
  else return null;
  // Whatever follows the authority — a path to a file, in a hotline://
  // link — says nothing about where the server is.
  let authority = rest.split(/[/?#]/, 1)[0] ?? '';
  authority = authority.slice(authority.lastIndexOf('@') + 1);
  // The port is read here rather than by URL, which drops one that is a
  // scheme's default: `host:80` names port 80, not the classic default.
  const m = /^(\[[^\]]*\]|[^:@[\]]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!m) return null;
  const port = m[2] === undefined ? CLASSIC_PORT : Number(m[2]);
  if (port < 1 || port > 65535) return null;
  try {
    const u = new URL(`http://${m[1]}`);
    if (!u.hostname) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

/** Where a relay for `classic` may be, best first: the classic port plus
 *  200, then the host's default port (443, or 80 for the plain-http tries
 *  a page not on https may make).
 *
 *  Never the classic port itself, nor its transfer port beside it: an
 *  HTTP request there is a client that does not speak Hotline, and Janus
 *  bans the address that sent it for a day. A server on 443 or 80 has no
 *  default-port candidate for that reason. */
export function candidates(classic: { host: string; port: number }): { base: string; shared: boolean }[] {
  // An IPv6 host keeps the brackets a URL's host has.
  const host = classic.host;
  const schemes: [string, number][] =
    typeof location !== 'undefined' && location.protocol === 'http:'
      ? [
          ['https', 443],
          ['http', 80],
        ]
      : [['https', 443]];
  const out: { base: string; shared: boolean; port: number }[] = [];
  const beside = classic.port + 200;
  if (beside <= 65535) {
    for (const [s] of schemes) out.push({ base: `${s}://${host}:${beside}`, shared: false, port: beside });
  }
  for (const [s, port] of schemes) out.push({ base: `${s}://${host}`, shared: true, port });
  return out
    .filter((c) => c.port !== classic.port && c.port !== classic.port + 1)
    .map(({ base, shared }) => ({ base, shared }));
}

/**
 * Where `address` leads. A WebSocket URL whose discovery cannot be read
 * is taken as the ng listener it always was; a classic address with no
 * relay to be found is an error that says so.
 */
export async function route(address: string): Promise<Route> {
  const classic = classicAddress(address);
  if (!classic) {
    const ws = new URL(address);
    const base = `${ws.protocol === 'wss:' ? 'https:' : 'http:'}//${ws.host}`;
    try {
      const { doc, at } = await discover(base, NG_PROBE_MS);
      const r = fromDoc(doc, at, false);
      // An ng document names its own socket, but the address the form
      // was given is the one the user meant; only a classic one changes
      // where this goes.
      if (r?.wire === 'classic') return r;
    } catch {
      /* No discovery: the ng listener, as before there was any. */
    }
    return { wire: 'ng', url: address };
  }

  // Every candidate at once, and the best answer taken as soon as it is
  // known: a candidate that hangs holds up only the ones it outranks.
  const answers = candidates(classic).map((c) =>
    discover(c.base).then(
      (a) => fromDoc(a.doc, a.at, c.shared),
      () => null,
    ),
  );
  for (const answer of answers) {
    const r = await answer;
    if (r) return r;
  }
  throw new Error(
    `${classic.host}:${classic.port} is a classic Hotline server with no relay this browser can find, ` +
      `so it can only be reached from a desktop client.`,
  );
}
