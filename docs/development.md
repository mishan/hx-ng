# Working on hx-ng

Building and running it are in the [README](../README.md#running-it).

`dist/` is a build artefact and is **not** committed — it would churn on
every change. `public/icons.png` and `public/icons.json` are, because
they change only when `icons.rsrc` does, and committing them means
running the client needs no Python.

The app icons are rasterized from `public/icon.svg` and
`tools/icon-maskable.svg` by `tools/build-app-icons.sh`, which needs
`rsvg-convert`. Like `icons.png`, the PNGs are committed.

Chromium announces that the app can be installed with
`beforeinstallprompt`, early in the load, so `src/install.ts` listens
from the first line of `main.ts`.

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
[`packages/hotline-ng/test/fake-wire.ts`](../packages/hotline-ng/test/fake-wire.ts),
which is the piece worth knowing about. A session outlives its
connection, so nearly everything worth asserting about `Connection` is
about what happens when a socket dies and another opens: resume, replay,
the `resync_required` recovery. None of that is reachable without playing
the server, so the fake is a harness rather than a mock — a test
registers handlers per request name and pushes events, and replies come
back asynchronously and in order, on a socket the test can close out from
under the client.

[`test/classic.test.ts`](../test/classic.test.ts) does the same for the
classic wire one level down: the real wasm session, a fake socket, and
classic frames written by hand, checking both the module's event shapes
and their translation into the ng ones the views take.

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
represent honestly. [`e2e/identity.spec.ts`](../e2e/identity.spec.ts)
opens the Identity panel in a real headless Chromium, certifies the
real generated device key with a real `hlid`, pastes it back, and logs
in against a real `hxd` — then drops the socket and confirms resume
still works without going through identity again.

It needs a sibling checkout of
[hxd-ng](https://github.com/mishan/hxd-ng) — `git clone` it next to
this repo — and `cargo` to build `hxd` and `hlid` from it, same
convention as `gtkhx` for the icons below. Neither is a dependency of
`npm test` or `npm run build`; without them,
[`e2e/hxd-ng.ts`](../e2e/hxd-ng.ts) skips this test rather than failing
the run.

### End-to-end: a classic server through a relay

[`e2e/classic.spec.ts`](../e2e/classic.spec.ts) starts a real `hxd`, puts
a real `hlrelay` in front of its classic port, and connects two browsers
— one by the relay's address, one by the classic address — that see each
other, chat, write to each other and list the server's files. The same
sibling checkout; `HXD_NG_DIR` points the suite at one somewhere else.

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

## Layout of the source

The protocol half is a separate package, [`@hotline-ng/client`](../packages/hotline-ng/),
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
| `packages/classic/` | the classic wire: hx-libs' `hxsession` wrapped for JavaScript, built to wasm |
| `src/classic/` | a classic server as a `Session`: the socket, the timer, and the ng shapes; finding the relay |
| `src/session.ts` | what the views ask of a connection, on either wire |
| `src/config.ts` | `config.json`, and where the server address comes from |
| `src/state.ts` | roster and transcripts; no DOM |
| `src/ui/` | the shell, roster, transcript, composer, icon picker, video tiles, debug drawer |
| `src/ui/tiles.ts` | the video strip, and everything a browser needs before it will paint a `<video>` |
| `src/ui/media.ts` | inline images: one fetch per handle, the blob URLs, and the sized placeholder they replace |
| `src/moderation.ts`, `src/ui/moderation.ts` | reports and moderation: what a report on a line names, the open count; the reports view |
| `src/push/`, `src/sw.ts` | notifications: permission, subscription and registration in the page; the service worker that draws them |
| `test/`, `packages/hotline-ng/test/` | the tests, kept out of `src` so the published package ships neither them nor a test runner |
| `tools/build-icons.py` | `icons.rsrc` → sprite sheet |
| `tools/build-app-icons.sh` | the app icon → the manifest's and iOS's PNGs |
| `deploy/pages/` | what the hosted build at hx.foggyden.org connects to |

There is no UI framework, on purpose: this client doubles as a readable
reference for the protocol, and a reader chasing a bug should not have to
know a rendering library's rules to follow what the DOM is doing.
`src/ui/dom.ts` is the whole abstraction.

The minimal single-file rig for poking at the SFU with no build step at all
stays where it was, in the hxd-ng repo:
[`tools/ng-voice.html`](https://github.com/mishan/hxd-ng/blob/main/tools/ng-voice.html).
