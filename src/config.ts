/**
 * Deployment settings, read from a file next to the built client.
 *
 * The server address is not a property of the code. The same `dist/`
 * gets dropped next to one server by its operator, next to a different
 * one by somebody else, and on a laptop pointed at `localhost` by
 * whoever is working on it — and none of them should have to rebuild to
 * say where their server is. `config.json` sits beside `index.html`,
 * unminified and unbundled, so changing it is an edit and a refresh.
 *
 * Everything in it is optional, and a missing or malformed file is not
 * an error: the fallback is derived from the page's own origin, which is
 * right far more often than any constant could be. Precedence, most
 * specific first:
 *
 *   ?server=… in the URL   — one page load, for trying something
 *   the connect form       — what this browser last used (localStorage)
 *   config.json            — what this deployment is for
 *   the page's origin      — ws://<this host>:5700
 */

export interface AppConfig {
  /** What the connect form starts from. */
  defaultServer: string;
  /** Extra addresses offered as suggestions in the form. */
  servers: string[];
  /** The tab title before a server names itself. */
  title: string;
  /** Whether the connect form's server field can be edited. A kiosk
   *  deployment for one server sets this false; it hides the field
   *  rather than inviting people to type into it. */
  allowCustomServer: boolean;
}

/** The ng listener on the host that served this page. `hxd` binds it to
 *  port 5700, and a page on https must reach it over wss — the spec
 *  mandates that in production anyway, and a browser would refuse the
 *  mixed content regardless. */
function fromOrigin(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = location.hostname || '127.0.0.1';
  return `${scheme}://${host}:5700`;
}

const FALLBACK: AppConfig = {
  defaultServer: '',
  servers: [],
  title: 'Hotline',
  allowCustomServer: true,
};

export async function loadConfig(base = import.meta.env.BASE_URL): Promise<AppConfig> {
  let raw: Partial<AppConfig> = {};
  try {
    // `no-cache` rather than `no-store`: the point of a config file is
    // that editing it takes effect, and a client that had cached it for
    // a year would be worse than a baked-in constant.
    const res = await fetch(`${base}config.json`, { cache: 'no-cache' });
    if (res.ok) raw = (await res.json()) as Partial<AppConfig>;
  } catch {
    /* No config file, or not valid JSON. Neither is worth failing the
       page over — the defaults below still connect to something. */
  }
  const cfg: AppConfig = {
    ...FALLBACK,
    ...raw,
    servers: Array.isArray(raw.servers) ? raw.servers.filter((s) => typeof s === 'string') : [],
  };
  if (!cfg.defaultServer) cfg.defaultServer = fromOrigin();
  return cfg;
}

/** `?server=wss://…`, for pointing one page load somewhere else without
 *  touching what the browser remembers. */
export function serverFromUrl(): string | null {
  const q = new URLSearchParams(location.search).get('server');
  return q?.trim() || null;
}
