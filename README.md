# hx-ng

A browser client for the **Hotline-ng** wire: public chat, the user list
with the classic icons, private messages, threaded news, and the voice
and video the SFU already serves. It never sees the legacy wire, and the server cannot
tell it apart from any other ng client. The protocol it speaks is
[`hotline-ng.md`](https://github.com/mishan/hxd-ng/blob/main/docs/hotline-ng.md).

The reference server is [hxd-ng](https://github.com/mishan/hxd-ng). Any
server that speaks the protocol will do; this client has no dependency on
that one beyond the wire.

## Running it

```sh
npm install
npm run dev
```

That wants a server to talk to. Against
[hxd-ng](https://github.com/mishan/hxd-ng) on the same machine, with an
`[ng]` section in its config:

```sh
cargo run --bin hxd     # in the hxd-ng checkout; [ng] bind = "127.0.0.1:5700"
```

`npm run dev` serves on <http://localhost:5701> with hot reload, bound to
every interface so a phone on the LAN can reach it.

A production build lands in `dist/` and is a directory of static files —
no server-side anything:

```sh
npm run build
cd dist && python3 -m http.server 8080
```

`dist/` is a build artefact and is **not** committed — it would churn on
every change. `public/icons.png` and `public/icons.json` are, because
they change only when `icons.rsrc` does, and committing them means
running the client needs no Python.

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

The ng spec mandates WSS in production for its own reasons; the same
certificate serves the page. `localhost` counts as secure, which is why
the development setup above works unencrypted on the machine itself.

## Tests

```sh
npm test           # once
npm run test:watch # while working
npm run typecheck  # the tests are typechecked too, so they cannot rot quietly
```

Vitest, configured from the app's own Vite config so `@hotline-ng/client`
resolves to workspace source and a change needs no build step between it
and a test run. The environment is `node` rather than jsdom: nothing
under test touches a document.

The two browser globals `Connection` does reach for — `WebSocket` and
`sessionStorage` — are faked in
[`packages/hotline-ng/test/fake-wire.ts`](packages/hotline-ng/test/fake-wire.ts),
which is the piece worth knowing about. A session outlives its
connection, so nearly everything worth asserting about `Connection` is
about what happens when a socket dies and another opens: resume, replay,
the `resync_required` recovery. None of that is reachable without playing
the server, so the fake is a harness rather than a mock — a test
registers handlers per request name and pushes events, and replies come
back asynchronously and in order, on a socket the test can close out from
under the client.

What is *not* covered here: `src/ui/` in general, which would want a
DOM, and the voice and video session, which would want a WebRTC stack.
Identity's slice of `src/ui/` is the exception — see below.

### End-to-end: identity against a real server

```sh
npx playwright install chromium   # once
npm run test:e2e
```

The unit tests fake everything below `Connection`; this is the one
thing worth checking against the real pieces instead, because the bug
it exists to catch — `wsToHttp` building a URL the browser's own CORS
policy refuses — only shows up with a real browser's CORS policy and a
real dev-proxy config in front of it, neither of which a fake can
represent honestly. [`e2e/identity.spec.ts`](e2e/identity.spec.ts)
opens the Identity panel in a real headless Chromium, certifies the
real generated device key with a real `hlid`, pastes it back, and logs
in against a real `hxd` — then drops the socket and confirms resume
still works without going through identity again.

It needs a sibling checkout of
[hxd-ng](https://github.com/mishan/hxd-ng) — `git clone` it next to
this repo — and `cargo` to build `hxd` and `hlid` from it, same
convention as `gtkhx` for the icons below. Neither is a dependency of
`npm test` or `npm run build`; without them,
[`e2e/hxd-ng.ts`](e2e/hxd-ng.ts) skips this test rather than failing
the run.

## The icons

The user-list icons are the ones every Hotline client of the era shipped:
the `cicn` resources in
[`icons.rsrc`](https://github.com/mishan/gtkhx/blob/main/icons.rsrc), which
is the same file GtkHx renders from. `DATA_ICON` on the wire is a 16-bit
index into that table.

They are packed into **one sprite sheet** — `public/icons.png` plus a
JSON index of `id → [x, y, w, h]` — by `tools/build-icons.py`:

```sh
npm run icons     # python3 tools/build-icons.py ../gtkhx/icons.rsrc public
```

That path is a **sibling checkout** of
[GtkHx](https://github.com/mishan/gtkhx) — `git clone` it next to this
repo, or point the script somewhere else:

```sh
python3 tools/build-icons.py /path/to/icons.rsrc public
```

Six hundred separate PNGs would be six hundred requests for a roster
that shows eight of them, and there is no way to know in advance which
eight. One atlas is a single cacheable file the browser decodes once,
and CSS `background-position` picks the sprite; identical art filed under
several ids shares a cell, so the sheet is smaller than the sum of its
parts. Sprites render with `image-rendering: pixelated` at 2× in the
roster and 1× in the chat gutter — these are hand-placed pixels and a
bilinear filter ruins them.

The generator needs Pillow; nothing else here needs Python at all, which
is why its output is committed. Rerun it when `icons.rsrc` changes.

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
| `/nick <name>` | needs `use_any_name` |
| `/icon <n>` | or click your own icon in the title bar |
| `/drop` | close the socket without logging out — exercises resume |
| `/clear`, `/close` | clear this transcript, close this PM |
| `/debug`, `/logout`, `/help` | |

## What it does with the protocol

- **Sessions outlive connections.** The socket is an attachment, not the
  session. A dropped connection reconnects with backoff and `resume`s,
  replaying what it missed; `resync_required` is handled as the spec
  intends, with a `sync` on the same socket rather than a new login —
  and then an `inbox` pull, because the events in that gap are gone and
  any private message among them was already marked delivered, leaving
  the store as its only copy. A **page reload** resumes too — session
  id, token and `last_seq` live in `sessionStorage` — so you keep your
  uid and your place in the room.
- **Seq accounting is exact.** Every event advances `seq`, including the
  `unsupported` placeholders the server emits for domain events this
  protocol revision cannot express. That is what makes `last_seq`
  meaningful on the next resume.
- **The roster shows what the ng wire knows and the 1.x list could not**:
  `idle` and `detached` are different states, not one away flag, and
  voice membership, mute, and video publications are marked per person.
- **Nothing is drawn optimistically.** A line of chat appears when the
  event carrying it arrives — including your own, because the server
  echoes chat to its author. Private messages are the exception the
  protocol forces: `msg` has no echo, so the sender's half is local.
- **Public history and live chat meet on the line id.** The newest page
  is loaded after login, reaching the top pages backwards without moving
  the line under the reader's eyes, and an unreplayable resume gap pages
  forward until it catches up. History replies may overlap live events;
  an id is rendered once. The transcript is a window over the log rather
  than a copy of it: paging back past the line cap drops lines off the
  other end and forgets their ids with them, so what scrolls out can be
  fetched again. Redacted rows remain as placeholders, and a line that
  carried an image says which of the three it is — still there and not
  drawable here yet, its handle expired, or removed — without inventing
  bytes the server no longer has.
- **A conversation is a person, not a uid.** Mail that waited for you
  arrives with `uid: 0`, because its sender had no session when it was
  flushed — so threads are keyed on the account where there is one, and
  fall back to the uid. That is also what stops a reissued uid from
  delivering into the previous holder's thread.
- **The mailbox is a place, not a screen.** There is no mail view: a
  stored message belongs in the conversation it is part of, so the first
  page is pulled at login and folded into threads, and a reload lands you
  in conversations that still have their history. It is also the only way
  to see all of it — the login flush is capped by `deliver_at_flush`, and
  everything past that cap exists only through `inbox`.
- **One unread count, and it is the server's.** `msg_read` is a cursor
  over the whole mailbox rather than a per-thread mark, so a per-thread
  badge would drift the moment you opened the newest thread first. The
  count in the title bar is what the server last said; selecting a
  conversation moves the cursor and takes the new count from the reply.
- **A private message to an unencrypted session says so** before it is
  sent, in the composer, with a mark on the roster row to match. That is
  what `transport` is for, and it is present whether or not the server
  runs the identity endpoints.
- **Images are a handle and a fetch, never bytes on the socket.** A
  picture is attached with the paperclip or pasted straight into the
  composer, uploaded to `POST /media` there and then — the server is the
  only thing that can say whether it will take those bytes, and finding
  out at send time would lose the typed message with them — and the
  chat line carries the handle it answered with. Inbound, the row is
  drawn at the size the server measured off its own canonical copy
  before a byte has arrived, so a slow link fills pictures in rather than
  reflowing the conversation around them. The bytes come from
  `GET /media/{id}` with the session's credential, which an `<img src>`
  cannot send — hence the blob URLs, and hence something owning them.
  An image whose handle has expired, or that a moderator has revoked,
  keeps its place and says which. The paperclip is drawn only when the
  server offers the capability: inert chrome would be a promise this
  client cannot keep.
- **Video is opt-in in both directions.** Nothing is published until you
  ask and nothing is received until you subscribe, and the subscription
  is declared as a complete set so turning it all off is one request.
  Your own camera is shown back to you as a mirrored tile — the only way
  to find out that it is pointed at the ceiling, or not sending at all,
  without asking the room. **Self view** in the call bar turns it off.
- **In chat, markdown is drawn and never sent.** Chat is read as GtkHx's dialect —
  `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `[label](https://…)`,
  fenced code and `>` quotes, and nothing else, so `# 1` and `---` stay
  ordinary chat — and a line looks the same here as there. The wire
  carries exactly what was typed. **Markdown** in the title bar turns the
  drawing off, for anybody who would rather see a 1997 client's literal
  asterisks as asterisks. A news article is markdown only when it says
  `text/markdown`, and then reads as a document: headings, lists,
  quotes, code, rules and pipe tables, minus raw HTML and images, with
  `#51` and `[text](news:51)` linked only where the server resolved them.
  The composer offers it, with a preview, where the server's login reply
  lists `text/markdown`, and an article written that way is posted
  saying so: the one place this client tells a server a body is markdown. Nothing either dialect produces is ever handed
  to the HTML parser: the library parses, and the page draws text nodes.
- **Negotiation is serialised, and inbound video is read from the
  transceivers.** Both are the difference between a picture and a black
  rectangle; `packages/hotline-ng/README.md` says why.

Passwords are never stored. The session token is a bearer credential for
one session and lives in `sessionStorage`, so it dies with the tab.

## Layout of the source

The protocol half is a separate package, [`@hotline-ng/client`](packages/hotline-ng/),
so that a second client — a different UI, a bot, a bridge — does not have
to reimplement resume accounting and SFU negotiation to get to the
interesting part. It has no dependencies and draws nothing — the one
document it touches is a hidden `<audio>` per inbound voice mid, which
its own README is explicit about. This client consumes it by its
published name like anybody else would.

| | |
|---|---|
| `packages/hotline-ng/src/protocol.ts` | the wire's shapes — the twin of [`proto.rs`](https://github.com/mishan/hxd-ng/blob/main/crates/hxd-ng-session/src/proto.rs) |
| `packages/hotline-ng/src/connection.ts` | one session across however many sockets: handshake, resume, backoff, the trace hook |
| `packages/hotline-ng/src/voice.ts` | the SFU: join, publish, subscribe, and the mid grammar that tells streams apart |
| `src/config.ts` | `config.json`, and where the server address comes from |
| `src/state.ts` | roster and transcripts; no DOM |
| `src/ui/` | the shell, roster, transcript, composer, icon picker, video tiles, debug drawer |
| `src/ui/tiles.ts` | the video strip, and everything a browser needs before it will paint a `<video>` |
| `src/ui/media.ts` | inline images: one fetch per handle, the blob URLs, and the sized placeholder they replace |
| `test/`, `packages/hotline-ng/test/` | the tests, kept out of `src` so the published package ships neither them nor a test runner |
| `tools/build-icons.py` | `icons.rsrc` → sprite sheet |

There is no UI framework, on purpose: this client doubles as a readable
reference for the protocol, and a reader chasing a bug should not have to
know a rendering library's rules to follow what the DOM is doing.
`src/ui/dom.ts` is the whole abstraction.

The minimal single-file rig for poking at the SFU with no build step at all
stays where it was, in the hxd-ng repo:
[`tools/ng-voice.html`](https://github.com/mishan/hxd-ng/blob/main/tools/ng-voice.html).
