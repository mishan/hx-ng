# @hotline-ng/client

A TypeScript client for the **Hotline-ng** wire — the JSON/WebSocket
protocol served by [hxd-ng](https://github.com/mishan/hxd-ng), specified
in `docs/hotline-ng.md` with the voice and video bindings in
`docs/voice.md` §8 and `docs/capabilities-video.md` §16.

No UI framework and no dependencies. It is the whole client half of the
protocol and nothing else, extracted from the web client in this
repository so that a second client does not have to reimplement resume
accounting and SFU negotiation to get to the interesting part.

The name is scoped because the client is one half of one protocol: a
server, or the parts a bot wants without the parts only a browser can
run, would be siblings under the same scope rather than hyphenated
neighbours of a package that had taken the protocol's whole name.

```sh
npm install @hotline-ng/client
```

## What it needs

A browser — but not equally, and the difference matters if you are
writing a bot or a bridge rather than a page:

| | Needs | Notes |
|---|---|---|
| `protocol` | nothing | Plain data and pure functions. Runs anywhere. |
| `Connection` | `WebSocket`, `window` | `window.setTimeout` for the reconnect backoff is the only hard browser tie. `sessionStorage` is reached for behind a try/catch, so resume-across-reloads switches itself off where there is none rather than failing. |
| `VoiceSession` | WebRTC, `getUserMedia`, `document` | `RTCPeerConnection`, `navigator.mediaDevices`, `window.isSecureContext`, and **one hidden `<audio>` element per inbound audio mid, appended to `document.body`**. |

That last one is the only DOM this package touches, and it is worth
being explicit about since nothing else here goes near a document.
Remote audio needs a sink; an `<audio>` element is never laid out, every
caller would build the same one, and Safari is markedly happier starting
an element the page actually contains. `playAudio` in `voice.ts` is the
single place to change if you would rather own that sink yourself.

Video is a different matter: `VoiceSession` does not draw it and has no
opinion about where it goes. See below.

## Three layers

```ts
import { Connection, VoiceSession, errorText } from '@hotline-ng/client';
```

### `protocol` — the wire's shapes

Every request, reply and event, as types; the error-code table and
`errorText()` for turning a `WireError` into a sentence; and the `a=mid`
grammar the SFU keys tracks on (`sendMid`, `parseRecvMid`). No behaviour
at all — this is the twin of `crates/hxd-ng-session/src/proto.rs`, and
when the server's shapes change it is what changes with them.

Beside it, and just as DOM-free, is what a body's text means:
`referenceSpans` and `markedSpans` for news references and search
marks, and markdown — `parseChat` for GtkHx's chat dialect,
`parseArticle` for a `text/markdown` article, `parseInline` for a single
line of either. They return styled runs and blocks, never HTML; drawing
them as text nodes is the caller's job, and the only safe way to do it.

An article is read as the server's parser reads it — CommonMark with
GitHub's tables and strikethrough, raw HTML opaque and shown as typed,
an image a link to where it is and never fetched, and a reference in
every link form that names `news:51` — with two known differences. Of
HTML's named character references it decodes a common handful (`&amp;`,
`&lt;`, `&quot;`, `&nbsp;`, `&copy;`, `&mdash;` and their like, and
`&num;` and `&colon;`) and leaves any other name as typed, where the
server decodes them all; numeric references are decoded in full, so
`&#35;51` is a reference on both. And a pipe table wider than any reader
could use is a paragraph here.

### `Connection` — one session, however many sockets

The protocol's whole point is that a session outlives its connection, so
`Connection` owns the *session* and treats the socket as a replaceable
attachment.

```ts
const conn = new Connection(
  { url: 'wss://example.org/ng', login: 'guest', password: '', nick: '', icon: 128 },
  {
    onSnapshot: ({ self, users, server }) => drawRoster(users),
    onResumed: (replay) => console.log(`${replay} events replayed`),
    onState: (state) => console.log(state),
    onEnded: (reason) => console.log(reason),
    onTrace: (frame) => console.debug(frame.dir, frame.raw),
  },
);

conn.on('chat', (d) => append(`${d.from.nick}: ${d.text}`));
await conn.start();
await conn.request('chat', { text: 'hello' });
```

What it handles so a caller does not have to:

- **Resume with replay.** A dropped socket reconnects with backoff and
  `resume`s, and `resync_required` is answered with a `sync` on the same
  socket rather than a fresh login.
- **Exact `seq` accounting.** Every event advances `seq`, including the
  `unsupported` placeholders the server emits for domain events this
  revision cannot express — which is what makes `last_seq` meaningful on
  the next resume.
- **Reload survival.** Session id, token and `last_seq` live in
  `sessionStorage`, so a page reload resumes into the same uid.
  `hasSavedSession(url)` says whether that is possible before you draw a
  login form. Passwords are never stored; the token is a bearer
  credential for one session and dies with the tab.
- **A trace hook** that sees exactly what the socket saw, in both
  directions, from the first frame.

`request()` rejects with a `WireFailure` carrying the server's
`{ code, text }`; pass `err.wire` to `errorText()`.

### Files

The read-only Files API keeps full `u64` values as decimal strings on the
wire. Convert them with `parseDecimalU64`; `formatFileSize` formats the
result without rounding it through a JavaScript number.

```ts
const listing = await conn.filesList('manuals');
for (const entry of listing.entries) {
  console.log(entry.name, formatFileSize(parseDecimalU64(entry.size)));
}

const prepared = await conn.prepareFileDownload('manuals/guide.pdf');
const response = await conn.fetchFile(prepared, {
  offset: 4_294_967_296n,
  signal: abortController.signal,
});
```

`fetchFile` performs exactly one request. A caller may prepare again or reuse
an unexpired token with another explicit offset, but an expired or
session-bound token is never retried silently.

### `VoiceSession` — the SFU

Layered on a `Connection`, because video is layered on the voice session
rather than sitting beside it.

```ts
const voice = new VoiceSession(conn, {
  onLog: (text, bad) => note(text, bad),
  onRoom: () => redrawRoster(),
  onControls: () => redrawButtons(),
  onRemoteVideo: (v) => attach(v.mid, v.stream, `${nickOf(v.uid)} — ${v.kind}`),
  onRemoteVideoEnded: (mid) => detach(mid),
  onLocalVideo: (kind, stream) => selfView(kind, stream),
});

await voice.join();               // voice, joined muted as the spec asks
await voice.setMuted(false);
await voice.toggleCamera();       // publish
await voice.setWatching(true);    // subscribe to everything in the room
```

The rules it keeps for you:

- **The server is always the offerer**, and offers are answered strictly
  one at a time. The socket delivers events concurrently with an
  in-flight `await`, and two overlapping `setRemoteDescription` calls
  fail the second — which in a video room, where publishing and
  subscribing both renegotiate, is the difference between a picture and
  a black rectangle.
- **ICE candidates that arrive before a remote description are held**
  rather than thrown at `addIceCandidate`, which rejects outright in
  that state.
- **Inbound video is keyed on `mid`,** and rebuilt from the
  transceivers' negotiated directions after each answer rather than from
  `ontrack` alone. `ontrack` fires once per receiver for the life of the
  connection, so a section parked at `a=inactive` by an unsubscribe and
  revived by the next subscribe would otherwise never be seen again.
- **`a=ssrc` on send sections is checked,** because
  `capabilities-video.md` forbids the server from guessing when it is
  missing: it drops the publication instead, and the publisher would
  have no way to know why.
- **Encoders are capped** to the server's advertised ceilings with
  `setParameters`, since `getUserMedia` constrains resolution and frame
  rate but never bitrate.

For **video** it hands you a `MediaStream` and stops. Where a camera goes
on the page is not a protocol question — and the two ways browsers most
often refuse to show one (autoplay policy, and an element attached inside
a `display: none` subtree) are properties of the element, not the track.

For **audio** it does not stop: it builds the sink, as described in
[What it needs](#what-it-needs).

`voice.stats()` flattens the peer connection, the transceiver mids and
per-SSRC packet and frame counts into something you can print.

## Secure contexts

`navigator.mediaDevices` is not merely restricted outside a secure
context — it is **undefined**, so reaching through it throws a TypeError
rather than refusing politely. A phone opening a client over plain http
on the LAN gets chat and the roster working perfectly and no microphone
at all. `captureBlockedReason()` and `screenShareBlockedReason()` return
that as a sentence to show, or `null`, so a client can disable the
button instead of discovering it with a failed tap.

## Status

Version 0.1.0, extracted from the `hx-ng` web client and used by it. The
protocol it implements is itself a draft; expect the shapes to follow
the spec rather than semver until both settle.

GPL-2.0-or-later.
