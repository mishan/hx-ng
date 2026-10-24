# hx-ng

A browser client for the **Hotline-ng** wire: public chat, the user list
with the classic icons or a picture of your own, private messages,
threaded news, notifications
while you are away, reports and moderation, and the voice and video the SFU already serves. The protocol it speaks is
[`hotline-ng.md`](https://github.com/mishan/hxd-ng/blob/main/docs/hotline-ng.md),
and an ng server cannot tell it apart from any other ng client.

It also reaches **classic** Hotline servers — mhxd, Janus, the 1.9
server, anything that speaks the 1.2/1.5 wire — where one stands behind a
relay ([Classic servers](#classic-servers), below).

The reference server is [hxd-ng](https://github.com/mishan/hxd-ng). Any
server that speaks the protocol will do; this client has no dependency on
that one beyond the wire.

## Running it

```sh
npm install
npm run dev
```

Building it needs Rust as well as Node: the classic wire is hx-libs'
`hxsession`, compiled to wasm by `npm run build:wasm`, which `dev`,
`test` and `typecheck` run first. Once, beforehand:

```sh
rustup target add wasm32-unknown-unknown       # or Debian's libstd-rust-dev-wasm32
cargo install wasm-bindgen-cli --version 0.2.129 --locked   # the version packages/classic/Cargo.toml pins
```

`wasm-opt` (binaryen) is used when it is installed, and makes the module
smaller; nothing else changes without it. It has to be recent enough to
read what a current Rust emits — version 131 does, and Ubuntu's packaged
one does not.

That wants a server to talk to. Against
[hxd-ng](https://github.com/mishan/hxd-ng) on the same machine, with an
`[ng]` section in its config:

```sh
cargo run --bin hxd     # in the hxd-ng checkout; [ng] bind = "127.0.0.1:5700"
```

`npm run dev` serves on <http://localhost:5701> with hot reload, bound to
every interface so a phone on the LAN can reach it.

Logging in with an identity there also wants the server's `[identity]
hosts` to list the host the login proof names. That is the page's,
`localhost:5701` or whichever name it is opened by, when the server's ws
URL has the page's hostname, since the identity calls then go through
the dev proxy, which passes `Host` on as the browser sent it. Otherwise
it is the server's own address, `elsewhere.example:5700` say.

A production build lands in `dist/` and is a directory of static files —
no server-side anything:

```sh
npm run build
cd dist && python3 -m http.server 8080
```

## Classic servers

A browser cannot open TCP, and a classic server speaks nothing else. So
a classic server is reached through a relay beside it — hxd-ng's
[`hlrelay`](https://github.com/mishan/hxd-ng/blob/main/docs/relay.md),
which its operator runs — whose `/trtp` WebSocket carries the classic
protocol byte for byte. hxd-ng serves the same path itself.

The server field takes a relay's address, `ws://host:5700`, or the
classic address a tracker lists, `hotline://host:5500` or just
`host:5500`. For a classic address the client looks for the relay where
hxd-ng's `docs/hotline-ng-auth.md` §5.1 says it stands: the classic port
plus 200, then the host's default port (443, and 80 from a page served
over plain http). Either way the server's discovery document decides
which wire to speak — `ng.trtp` without `ng.ws` is a classic server.

On a classic server this client does chat, the user list, private
messages, the agreement, browsing files, and reading news — threaded,
and the 1.2 flat file as one more category. Reports, moderation and news
management are left out; downloads, file details, voice and everything
else the ng wire added say they are not available on a classic server
yet. A folder whose name holds a `/` cannot be opened.

## Where the server address comes from

Not from the code. `public/config.json` — which lands in `dist/` beside
`index.html`, unbundled — is what a deployment edits, and it takes
effect on a refresh rather than a rebuild:

```jsonc
{
  "defaultServer": "wss://hotline.example.org/ng",
  "servers": ["wss://elsewhere.example.net/ng"],
  "title": "Hotline",
  "allowCustomServer": true
}
```

Every key is optional. With `defaultServer` empty or missing the client
derives `ws://<the host that served this page>:5700` — the ng listener's
port on its own host, which is right for the ordinary case of the client
sitting in front of its own server, and which follows the page onto
`wss://` when the page itself is on https. `allowCustomServer: false`
hides the field entirely: one deployment, one server.

Precedence, most specific first:

| | |
|---|---|
| `?server=wss://…` | one page load, for trying something |
| the connect form | what this browser last used (`localStorage`) |
| `config.json` | what this deployment is for |
| the page's origin | `ws://<this host>:5700` |

### The hosted build

Every push to main is built and published by GitHub Pages at
**https://hx.foggyden.org/** (`.github/workflows/pages.yml`), with
`deploy/pages/config.json` in place of the generic `config.json`: it
connects to `wss://hxd.foggyden.org` by default and still lets you
type any other server. That works because hxd-ng answers the page's
cross-origin fetches with CORS, and a WebSocket is not subject to it.

It has a domain of its own rather than `mishan.github.io/hx-ng` because
storage is per origin: every Pages project on an account shares that
one, and any of them could use this client's device keys.

### Serving it to a phone, and why voice needs https

`getUserMedia` and `getDisplayMedia` do not merely *fail* outside a
secure context — `navigator.mediaDevices` is **undefined** there. So a
phone opening `http://titan:5701/` over the LAN gets chat, the roster and
private messages working perfectly and no microphone at all. The client
detects this and says so in the voice bar instead of throwing; there is
no way around it from the page's side.

Two ways to get a secure context for testing:

```sh
# a tunnel, so the phone's browser sees localhost
ssh -L 5701:localhost:5701 -L 5700:localhost:5700 titan

# or a real certificate in front of both, which is what production wants
# anyway: https for the page, wss:// for the ng endpoint
```

Notifications have the same requirement: outside a secure context there
is no `navigator.serviceWorker`, and the **Notify** button is not drawn.

The ng spec mandates WSS in production for its own reasons; the same
certificate serves the page. `localhost` counts as secure, which is why
the development setup above works unencrypted on the machine itself.

### Installing it

The client is an installable web app: `public/manifest.webmanifest` and
the icons beside it land in `dist/` like `config.json`, and every URL in
the manifest is relative, so it works wherever `dist/` is mounted.
Chromium on the desktop and Android offers **Install**; Safari on iOS
has **Add to Home Screen**. Either way it opens in a window of its own,
with no address bar.

Where Chromium is ready to install it, the client says so itself: an
**Install** button on the connect form and in the title bar, which
brings up the browser's own install dialog and goes away once the app
is installed. Safari and Firefox offer a page no way to do that, and
there the browser's menu is the only way in.

On iOS this is not cosmetic. Safari exposes web push only to a page
opened from the Home Screen, so there, installing is what makes the
**Notify** button appear at all. The same secure-context rule applies.

Two things follow from how browsers treat an installed app:

- **On iOS it is a new device.** A Home Screen app has storage of its
  own, apart from Safari's: its own IndexedDB, so its own device keys to
  enroll ([`docs/identity-keys.md`](docs/identity-keys.md)), its own
  remembered server, its own notification registrations. Chromium
  shares one profile between the tab and the installed window, so there
  it is the same device.
- **There is no app-wide service worker.** Nothing is cached for
  offline use: without its socket the client has nothing to show, and a
  cached shell would be one more thing to go stale after a deploy. The
  only workers are the notification ones, each scoped under `push/`.

A deployment that wants its own name under the icon edits `name` and
`short_name` in `manifest.webmanifest`, and `apple-mobile-web-app-title`
in `index.html` for iOS.

## The debug drawer

**Debug** in the title bar, or ⇧⌘D / Ctrl+Shift+D, or `?debug` in the
URL to have it open before the first frame:

- **Wire** — every frame in both directions, exactly as it crossed the
  socket, with a filter and a pause. Collected from the first frame
  whether or not the drawer is open, so opening it after something went
  wrong still shows you the login.
- **Session** — session id, uid, `seq`, detach grace, negotiated `caps`,
  video ceilings, ping RTT.
- **Media** — peer connection and ICE state, the transceiver mids, and
  per-SSRC packet counts from `getStats()`.

**Copy report** puts the session state and the whole frame log on the
clipboard, which is what to attach to a bug.

## Commands

Typed into the composer:

| | |
|---|---|
| `/me <text>` | chat with `style: "action"` |
| `/msg <nick\|uid\|account> <text>` | open a PM conversation and send. An account name reaches somebody who is not here |
| `/mail` | load earlier stored messages, a page at a time |
| `/history` | load an earlier page of public chat; scrolling to the top does the same |
| `/block <who>`, `/unblock <who>` | a nick, an account, or (to unblock) a fingerprint |
| `/blocks` | who you have blocked |
| `/report <who> [reason]` | report a person to the moderators; a line or an article is reported from its own **Report** button |
| `/kick <nick> [reason]`, `/ban <nick> <10m\|2h\|3d\|1w…> [reason]` | needs the kick privilege |
| `/purge <who> [length] [reason]` | a moderator's: their lines, images and articles from the window, an hour by default |
| `/reports` | a moderator's: open the reports |
| `/accounts` | open the account editor, for an account that may read or make accounts |
| `/nick <name>` | needs `use_any_name` |
| `/icon <n>` | or click your own icon in the title bar |
| `/drop` | close the socket without logging out — exercises resume |
| `/clear`, `/close` | clear this transcript, close this PM |
| `/debug`, `/logout`, `/help` | |

## What it keeps

Passwords are never stored. The session token is a bearer credential for
one session and lives in `sessionStorage`, so it dies with the tab.

## Working on it

- [`docs/development.md`](docs/development.md) — the tests, the icon
  sprite sheet, and a map of the source.
- [`docs/protocol.md`](docs/protocol.md) — what the client does with the
  Hotline-ng protocol, and how it speaks the classic one.
- [`docs/identity-keys.md`](docs/identity-keys.md) — how the browser
  holds its identity keys.
