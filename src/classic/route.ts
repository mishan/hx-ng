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

export type Route = { wire: 'ng'; url: string } | { wire: 'classic'; url: string; name: string };

/** How long one probe may take. A firewall that drops rather than refuses
 *  would otherwise hold the form for as long as the browser lets it. */
const PROBE_MS = 3000;

/** The classic port when an address names none. */
const CLASSIC_PORT = 5500;

interface Doc {
  name?: string;
  ng?: { ws?: string; trtp?: string };
}

async function discover(base: string): Promise<{ doc: Doc; at: string }> {
  const at = new URL('/.well-known/hotline', base).href;
  const res = await fetch(at, { cache: 'no-cache', signal: AbortSignal.timeout(PROBE_MS) });
  if (!res.ok) throw new Error(`discovery: HTTP ${res.status}`);
  return { doc: (await res.json()) as Doc, at };
}

/** A path in a discovery document, as the WebSocket URL it names. */
function socketUrl(ref: string, at: string): string {
  const u = new URL(ref, at);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  return u.href;
}

function fromDoc(doc: Doc, at: string): Route | null {
  if (doc.ng?.ws) return { wire: 'ng', url: socketUrl(doc.ng.ws, at) };
  if (doc.ng?.trtp) return { wire: 'classic', url: socketUrl(doc.ng.trtp, at), name: doc.name ?? '' };
  return null;
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
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  try {
    const u = new URL(`http://${authority}`);
    if (!u.hostname) return null;
    return { host: u.hostname, port: u.port ? Number(u.port) : CLASSIC_PORT };
  } catch {
    return null;
  }
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
      const { doc, at } = await discover(base);
      const r = fromDoc(doc, at);
      // An ng document names its own socket, but the address the form
      // was given is the one the user meant; only a classic one changes
      // where this goes.
      if (r?.wire === 'classic') return r;
    } catch {
      /* No discovery: the ng listener, as before there was any. */
    }
    return { wire: 'ng', url: address };
  }

  // An IPv6 host keeps the brackets a URL's host has.
  const host = classic.host;
  const schemes = typeof location !== 'undefined' && location.protocol === 'http:' ? ['https', 'http'] : ['https'];
  // In order of preference, port before scheme: the classic port plus
  // 200, then the host's default port (443, or 80 for the plain-http
  // tries a page not on https may make), which may front a different
  // Hotline server from the one at that port.
  //
  // Never the classic port itself: an HTTP request there is a client
  // that does not speak Hotline, and Janus bans the address that sent it
  // for a day.
  const ports = [`:${classic.port + 200}`, ''];
  const candidates = ports.flatMap((p) => schemes.map((s) => `${s}://${host}${p}`));
  // Every candidate at once, and the best answer taken as soon as it
  // is known: a candidate that hangs holds up only the ones it outranks.
  const answers = candidates.map((c) =>
    discover(c).then(
      (a) => fromDoc(a.doc, a.at),
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
