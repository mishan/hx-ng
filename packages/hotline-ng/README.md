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
| `Connection` | `WebSocket` | A global `WebSocket` is the only tie, so Node 22 and later run it as is. `sessionStorage` is reached for behind a try/catch, so resume-across-reloads switches itself off where there is none rather than failing. |
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
result without rounding it through a JavaScript number. A folder's `size`
is how many items it holds, not bytes, and `formatEntrySize` says which.

```ts
const listing = await conn.filesList('manuals');
for (const entry of listing.entries) {
  console.log(entry.name, formatEntrySize(entry)); // "3 items", "1.2 MiB"
}

const prepared = await conn.prepareFileDownload('manuals/guide.pdf');
const response = await conn.fetchFile(prepared, {
  offset: 4_294_967_296n,
  signal: abortController.signal,
});
```

`fetchFile` performs exactly one request. A caller may prepare again or reuse
an unexpired token with another explicit offset, but an expired or
session-bound token is never retried silently. An unknown, expired or
unauthorized token rejects with `not_found`, and a resume from a file the
server cannot read from an offset with `range_unsupported`.

### Push devices

The server never asks for a device. Where the login reply offers
`push`, `conn.push` holds the server's VAPID key and its content policy;
the caller asks its user, subscribes, and hands over what the browser
gave back. The subscription and the service worker are the caller's,
because they are the page's; this package holds only the two requests
and the shapes.

```ts
if (conn.push) {
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64urlDecode(conn.push.vapid),
  });
  const { devid } = await conn.pushRegister(pushSubscriptionParams(sub.toJSON(), myDeviceId)!);
  // …and later, to turn this device off:
  await conn.pushUnregister({ devid });
}
```

`devid` is required on a password session and ignored on an identity
one, where the device certificate names the device; keep one per install,
because a new one per registration adds a device rather than replacing
one. In the worker, `parsePushPayload` reads a decrypted body into a
`PushMessagePayload` or a `PushNewsPayload`, with whatever the server's
content policy left in it.

### Moderation

Anyone may `report` a line, an image, a message they received, a person
or an article. The rest is a moderator's, which the login reply says as
`self.moderator` and `Connection.moderator` keeps across a resume, whose
own `self` does not say: `reports` and `reportClose`, the acts `redact`,
`revoke` and `purge`, and `moderationLog`. `kick` asks the kick
privilege instead, and `purge` inside it both. Every act takes a reason
and closes every open report on what it removed, so a caller that acts
on a report does not close it as well.

```ts
const { id, follow_up } = await conn.report({ line: 42, reason: 'Not how we talk here' });

if (conn.moderator) {
  conn.on('report', (r) => showReport(r));
  conn.on('report_closed', ({ id }) => dropReport(id));
  await conn.redact(42, 'slur');
  await conn.kick({ uid: 7, ban: 86_400, purge: 3600, reason: 'flooding' });
}
conn.on('chat_redacted', ({ id }) => blankLine(id));
conn.on('chat_purged', ({ ids }) => blankLines(ids));
```

A purge of a flood is told as `chat_purged`, many ids to an event,
rather than one `chat_redacted` per line; a small purge still arrives
line by line, so a client handles both. Its articles go the same way:
`news_purged` carries many `news_deleted`s at once. Draw once per
event, not once per id.

`no_such_user` from these means nobody by that name, not nobody who can
be messaged, so `moderationErrorText` is the wording to show for them.

### Signed messages

A line, a private message or an article can be signed by the device
that wrote it, so that no server can write one in its name or alter
one (hxd-ng's `docs/e2e-messages.md` §3). `signedChatLines`,
`signedPrivateMessages` and `signedArticles` build, sign and read the
three objects; what they carry on the wire, and when to sign, is the
caller's. Signing takes the device's non-extractable key and refuses
what a reader would refuse, a certificate that does not allow messages
included.

```ts
const sent = Math.floor(Date.now() / 1000);
const whole = await signedChatLines.sign(deviceSignKey, { id, sent, server: serverKey, room: 0, cert, text });
const signed = (await signedChatLines.parse(whole, sent)).detached(); // sent beside the text
```

A reader hands over the form it was given (whole, detached beside its
texts, or a link form with the certificate fetched for it, if one was)
and what it knows: when the server received it, who the server says
sent it, and where it is shown. `read` checks it in hl-identity's order
and answers one of §8's states: `verified`, `elsewhere` (signed for
another server, room, category, parent or recipient), `unverified`
(nothing to check it against) or `invalid`.

```ts
const outcome = await signedChatLines.read(
  { form: 'detached', bytes: signed, texts: [text] },
  { at, sender: { named: row.identity.fingerprint }, scope: { server: serverKey, room: 0 } },
);
const shown = signatureDisplay(outcome); // signatureDisplay(null, { rowSigns: true }) for an unsigned line
```

A scope's server is its key; `alias` says whether another key an object
names stands for it, as a followed handover keeps an old one.
`signatureDisplay` adds `unsigned` and §8's two marks: sent at another
time, and signature expected on an unsigned line from someone seen to
sign, whose row says `signs`, or in a room that requires signing.
`contentSha256` is what tells a message signed again from another under
the same id (§3.6); remembering which ones were seen is the caller's.

On the wire, `signChatRequest` signs a line into the `text`, `guid` and
`signed` a `chat` request carries, and `readSignedChat` reads a `chat`
event's or a history line's `signed` beside its text and style,
detached or in its link form, and hands back the line as signed, whose
`id` and `sent` are what to name and dedupe it by. A server that offers
`chat_guid` honors `guid`, and one that offers `signed` carries the
line. An identity login says the `signs` its `identity.signs` gives,
every resume says `Connection.signs`, and `signing` is the server's
echo, without which nothing may be sent signed.

```ts
// serverKey: the key pinned for this host first, as Server keys below has it.
const conn = new Connection({ ...creds, identity: { getToken, signs: () => 'able' } });
await conn.start();
if (conn.hasCap(CAP_SIGNED) && conn.hasCap(CAP_CHAT_GUID) && conn.signing) {
  await conn.chat(await signChatRequest(deviceSignKey, { cert, server: serverKey, room: 0, text }));
}
```

A private message and an article go the same way. `signMsgRequest`
signs a message to the recipient's identity fingerprint into the
`text`, `guid` and `signed` a `msg` carries, and `readSignedMessage`
reads a `msg` event's or an `inbox` row's `signed` against the
fingerprint the reader's session proved, `null` for none.
`signNewsPost` signs an article into a category's node `guid` and under
its parent into the `subject`, `body`, `mime` and `signed` a
`news_post` carries, and `readSignedArticle` reads an article's
`signed` against the category and parent it is listed under and the
`mime` it is shown as. Each takes an `id` to sign one again as the same
message (§3.6), which a server answers as the original.

```ts
const to = fingerprintFromString(row.identity.fingerprint)!;
await conn.msg({ to: row.uid, ...(await signMsgRequest(deviceSignKey, { cert, to, text })) });
const category = base64urlToBytes(node.guid!);
const post = await signNewsPost(deviceSignKey, { cert, server: serverKey, category, subject, body, mime: 'text/plain' });
await conn.newsPost({ category: node.id, subject: post.subject, body: post.body, mime: post.mime, signed: post.signed });
```

### Sealed messages

A private message can be sealed to the one device that reads it, so
that no server on its way can (hxd-ng's `docs/e2e-messages.md`
§3.7–§3.11): signed and sealed with HPKE (RFC 9180, X25519 and
AES-256-GCM, all in WebCrypto), or sealed deniably, unsigned and in
HPKE's auth mode under the sender device's own `device_enc` key, which
convinces its recipient and nobody else. `sealMessage` takes the
device's two non-extractable keys and the recipient's `device_enc`;
`sealMessageTo` takes the recipient's certificate instead, the bytes
`device_cert` answers, and seals only to one that passes the checks a
sender's does (§4.2) and is of the identity `to` names.
Where the box rides on the wire is the caller's.

```ts
const keys = { sign: deviceSignKey, enc: deviceEncKey };
const box = await sealMessageTo({ id, sent, to, cert, text }, keys, recipientCert, deniable);
```

On the wire, a login or resume whose credentials say `sealed` asks to
carry them, and `conn.sealing` is the server's echo: false, nothing
sealed goes to or from the session. `deviceCert` fetches the
certificate a session proves now, and `sealMsgRequest` seals to it and
names the key it sealed to, which is what `msg` carries:

```ts
const { cert } = await conn.deviceCert(uid);
await conn.msg({ to: uid, ...(await sealMsgRequest(keys, { cert: myCert, to, text }, base64urlToBytes(cert))) });
```

`openSealed` opens one with the reader's `device_enc` key in §3.9's
order and answers §8's states: `verified` (a signed box, its `message`
the signed map), `deniable` (with `senderEnc`, the key it opened
under), `unverified`, `invalid`, `dropped` (stale or replayed, never
shown) or `unopened`. Freshness is judged by the reader's own clock,
and a box is accepted once: the `SealedReplay` it is handed is the
caller's to keep with the device key, across restarts and shared by
every tab using it. `MemorySealedReplay` keeps one in memory.

```ts
const opened = await openSealed(box, deviceEncKey, {
  now: Math.floor(Date.now() / 1000),
  at,
  reader: myFingerprint,
  sender: { named: from.fingerprint },
}, replay);
```

### Server keys

A server key is pinned per host, and follows the server's handovers to
a key it committed to in advance (hxd-ng's `docs/server-key-handover.md`
§5), so a rotation warns nobody and what was signed under the old key
stays in scope. `ServerTrust` keeps the pins in a `ServerPinStore` the
caller supplies (`MemoryServerPinStore` in memory, or one of your own
on disk) and decides from discovery's `serverHandovers` and a verified
challenge, with the time passed in:

```ts
const trust = new ServerTrust(store);
const discovery = await fetchDiscovery(base);
const challenge = await fetchChallenge(`${base}${discovery.identity.endpoints.challenge}`);
const now = Math.floor(Date.now() / 1000);
const r = await trust.check(challenge.host, discovery.serverHandovers, challenge, now);
if (r.outcome === 'warn' && (await userAccepts(r.warning))) {
  await trust.accept(challenge.host, r.warning, discovery.serverHandovers, challenge, now);
}
// Later, for a signed line whose in.server is not the current key:
const inScope = await trust.covers(challenge.host, line.in.server, line.sent);
```

A warning stores nothing. Accepting a changed key or commitment pins it
again without taking aliases from the chain served then, and accepting
a fork does the same and never warns of that handover again. `checkServerKey`, `pinServerKey`, `repinServerKey` and
`aliasCovers` are the same decisions without the store.

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

## License

Apache-2.0 (`LICENSE`), so a program under any license can use it. The rest of
hx-ng is GPL-2.0-or-later.
