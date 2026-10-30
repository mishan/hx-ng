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
  credential for one session and dies with the tab. An installed app,
  whose window the OS may kill and reopen, can keep it somewhere that
  outlives the tab instead: pass `Credentials.sessionStore` (any
  `SessionStore`, such as `localStorage`), and the same store to
  `hasSavedSession(url, store)`. Given a third argument, a login, it
  answers only for a session on that account, and `start` resumes a
  saved session only on the account its `Credentials.login` names, when
  it names one. A `start({ resumeOnly: true })`
  connection whose resume is later refused ends, through `onEnded`.
- **A trace hook** that sees exactly what the socket saw, in both
  directions, from the first frame.

`request()` rejects with a `WireFailure` carrying the server's
`{ code, text }`; pass `err.wire` to `errorText()`.

`code` stays a `string`, since a newer server may answer with one this
version has never heard of. `WireCode` is the union of every code it
does know, and `isWireCode(code)` narrows to it, so a misspelled or
retired code fails to compile and a `switch` can be made exhaustive:

```ts
const { code } = err.wire;
if (isWireCode(code)) {
  switch (code) {
    case 'rate_limited':
      return later(err.wire.retry_after);
    // ...every other WireCode...
    default:
      code satisfies never;
  }
}
```

`retryClass(code)` says when sending the same request again could
succeed. `soon` may pass on a resend after a backoff: `rate_limited`,
`server_error`, `busy`, a full server or voice chat. Only
`rate_limited` carries `retry_after`, and a `server_error` is safe to
resend only for an idempotent request or one with a `guid`. `later`
may pass, unchanged, once something outside it does — a mailbox read,
a day gone by, a ban lapsing, a fresh login — and whether to wait for
that is the caller's decision. `never` needs the request changed, and
is what a code it does not know gets, so a program that retries on
`soon` never loops on a refusal it cannot read. `not_available` is
`never`, though the file area and its uploads also answer it for a
passing failure of their own.

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

### Rooms

Where `caps` lists `rooms`, the login reply's `rooms` block lists the
rooms this session may see, as they stood at login. No room event
reaches a session until it sends a room request other than the
lobby's `roomTopic(0, topic)`, or a `chat` or `history` naming a room,
so a client that never asks sees the protocol as it was before rooms;
one that wants the list kept current calls `rooms()` once. Room 0 is
the lobby in every request, and events about the lobby carry no
`room`.

```ts
const { list } = await conn.rooms();
const lounge = list.find((r) => r.name === 'lounge')!;
const { members, topic, may_post } = await conn.roomJoin(lounge.id);
conn.on('chat', (d) => d.room === lounge.id && append(d.text));
conn.on('room_member_parted', ({ room, uid, reason }) =>
  uid === conn.self?.uid && leftRoom(room, reason));
if (may_post) await conn.chat({ room: lounge.id, text: 'hello' });
await conn.roomTopic(lounge.id, 'anything goes');
await conn.roomPart(lounge.id);
```

A room the session may not see answers `no_such_room`, exactly as one
that does not exist. `may_post` is false in a room the session may only
read, and in a `signed` room for a session that cannot sign, where an
unsigned line is refused `signature_required`. A session that
`conn.manageRooms` says may manage rooms, which the login reply's `self`
says and a resume's does not, also has `roomCreate`, `roomEdit`,
`roomArchive` and `roomUnarchive`, and is shown each room's `read` and
`post` gates.

`Connection` keeps a history cursor per joined room beside the lobby's,
and after a resync pages each room `sync` says has moved on from its
own, handing the pages to `onMissedHistory` with the room's id. `sync`
also settles which rooms those are: a room it does not list is
forgotten, and one it lists that `Connection` had no cursor for, such
as a room joined with `request` rather than `roomJoin`, starts at its
newest line, so that gap is the caller's to page and later ones are
covered.

### Instant messaging

Where `caps` lists `messaging`, the login reply's and `sync`'s
`messaging` block says whether this account takes part, the bounds it
is held to, and what it shows of itself: its `state`, `status_text`
and whether it `takes_requests`. A client that speaks the family says
so with `messaging: true` in its `Credentials`, or by sending any of
the family's requests; only then is it sent the family's events, and a
friend's instant messages reach it as `im` rather than `msg`. Accounts are named
by login throughout, and an instant message is a `msg` by `to_login`,
answered `requested: true` where it became a message request instead.

```ts
const conn = new Connection({ ...creds, messaging: true }, {
  onFriends: ({ friends }) => drawRoster(friends),
});
conn.on('im', (m) => {
  show(m);
  void conn.receipt(m.from.login, m.guid);
});
conn.on('friend', ({ friend }) => replaceRow(friend));
conn.on('presence', (p) => updateRow(p));
await conn.friendAdd('bob', 'it is Alice');
await conn.msg({ to_login: 'bob', text: 'hi', guid: newGuid() });
```

`onFriends` is handed the roster after each login, resume and resync,
and after the request that made a session one that speaks the family,
since asking for it is what hands over what waited. Acknowledging each
`im` with `receipt` is the caller's, and one it does not is handed over
again, so an `im` whose `guid` and sender were shown already is a
repeat. `requests` reads every page of the message requests and
approvals, and `mergeRequests` joins two pages as it does. An account
that has blocked you reads as missing, `no_such_user`, on every
request that names it; your own block of it is `friend_add`'s
`blocked`.

### Portable friendships

A friendship can belong to the two people rather than to one server:
an offer signed by one party's device and an acceptance signed by the
other's, which each client keeps and presents on the servers its user
chooses, and which a signed withdrawal ends everywhere (hxd-ng's
`docs/proposals/portable-friends.md` and `friendship-objects.md`).
`signFriendOffer`, `signFriendAcceptance` and `signFriendWithdrawal`
sign the objects with the device's key, and `checkFriendOffer`,
`checkFriendship` and `checkFriendWithdrawal` run each check in its
order, refusing with a `FriendshipRefused` that names the step. A
withdrawal whose pair is not yet known is kept from
`parseFriendWithdrawal` and finished by `checkWithdrawalPair`; only one
checked whole gives a cutoff.
`parseRotation` and `rotationChainEnd` follow a friend's rotations.

On the wire, `friendships: true` beside `messaging: true` asks for it
at login, and `caps` lists `CAP_FRIENDSHIPS` only where it was granted,
to a session proving a device of the account's linked identity. Such a
session puts an `offer` on `friendAdd`, a `friendship` on
`friendRespond` and a `withdraw` on `friendRemove` or `block`, and has
`friendshipsPresent` and `friendshipsFetch`. `beforeFriends` is where
it presents its withdrawals, since they must reach the server before
the roster is read.

```ts
const conn = new Connection({ ...creds, messaging: true, friendships: true }, {
  beforeFriends: () => presentWithdrawals(conn),
  onFriends: ({ friends }) => drawRoster(friends),
});
const offer = await signFriendOffer(deviceSignKey, { from: identity, to: theirs, time, expires, cert });
await conn.friendAdd('bob', undefined, bytesToBase64url(offer));
```

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
`setSigns` says a change at once, every resume says `Connection.signs`,
and `signing` is the server's echo, without which nothing may be sent
signed. A session saying `default` signs every lobby line, and sends
none it cannot sign until its user turns that off.

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

## In Node

`@hotline-ng/client/node` is what a bot or a bridge needs that a page
keeps elsewhere, kept off the main entry because it reads files.
`loadDevice` reads the device `hlid init` writes into `$HLID_HOME`
(`device.key`, `cert.bin`, `card.bin`) and refuses, with a
`DeviceError` naming the file, a key the certificate does not certify,
a certificate expired or without login, or another identity's card;
as `too-large`, a file past its size; and, as `unsafe`, a link or anything but a regular file, or a
`device.key` that group or others can reach or another user owns
(`{ owner: false }` allows the last, for a key another user provisioned).
On Windows the mode is not checked, and the files' ACLs are what protect
them. A Kubernetes secret volume is refused as it is mounted, its files
being links and 0644 by default: mount it with `defaultMode: 0400` and
copy the files into a directory of the process's own.
`identityToken` is the challenge, the proof and auth, resolving to the
token `getToken` wants, with discovery's endpoints held to the server
addressed. It refuses a login placed in another account than `account`,
and asks with `create: false` unless told otherwise, so a server that
creates accounts does not tie the identity to a new one first. Given a
`ServerTrust`, it refuses a server key that warns, before the proof is
sent, as a `ServerKeyError`; once an operator has judged the change,
`trust.accept(e.host, e.warning, e.chain, e.challenge, now)` and a
retry go on. `FilePinStore` keeps the pins in a JSON file,
replaced atomically and mode 0600 under a lock file beside it, so a
restart is not a first contact. Its directory must exist, and it and
the file must be yours and writable by nobody else; the directories
above it are not checked, so keep it somewhere only you can rename:

```ts
import { Connection, ServerTrust, wsToHttp } from '@hotline-ng/client';
import { FilePinStore, identityToken, loadDevice } from '@hotline-ng/client/node';

const url = 'wss://example.org/ng';
const device = await loadDevice(process.env.HLID_HOME!);
const trust = new ServerTrust(new FilePinStore('pins.json'));
const conn = new Connection({
  url, login: '', password: '', nick: 'bot', icon: 128,
  identity: { getToken: () => identityToken(wsToHttp(url), device, { account: 'bot', trust }) },
});
await conn.start();
```

`device.keys` is the pair `sealMessage` takes, and `device.keys.enc`
the key `openSealed` does. The subpath's types come through `exports`
alone, so TypeScript finds them under `moduleResolution` `node16`,
`nodenext` or `bundler`.

## Testing

`@hotline-ng/client/testing` is an in-memory server for the tests of
code built on `Connection`, written in this package's own wire types so
that it moves when the protocol does. It needs no network, no DOM and
no `ws`: `server.credentials()` hands the connection a `webSocket`
factory (`Credentials.webSocket`, returning a `SocketLike`, which a
browser's `WebSocket` and a `ws` socket both are: it is also how to
supply a socket where there is no global `WebSocket`).
Each call's credentials have a URL of their own, so two connections
never share a saved session, and one reused is a reload.

```ts
import { Connection } from '@hotline-ng/client';
import { FakeServer } from '@hotline-ng/client/testing';

const server = new FakeServer({ accounts: [{ login: 'bot', password: 'pw' }], rooms: [{ name: 'lounge' }] });
const alice = server.addUser({ nick: 'Alice' });
const conn = new Connection(server.credentials({ login: 'bot', password: 'pw' }));
conn.on('chat', (d) => reply(d));
await conn.start();
server.say(alice, 'hello, bot');
server.refuseNext('chat', 'rate_limited', { retry_after: 2 });
```

It serves login (a password, a guest, or an `identityToken` for an
identity login), the roster, lobby and room chat with ids, `guid` and
`history` paged either way, `msg`, `inbox` and `msg_read` (mail stored
only between accounts with a password or an identity), and `rooms`,
`room_join`, `room_part` and `room_topic` with their events. A dropped
socket detaches a session with a password and a resume replays what it
missed; `overflow(uid)` makes the next resume `resync_required`, for the
catch-up. `event(uid, ev, data)` pushes any event, typed, to a session
`uidOf(login)` finds; `addUser` plays someone else, with a login and an
identity if wanted; `handle(req, fn)` answers a request before the
server does, or leaves it to it; `requests` holds every frame with who
sent it, and `lines(room)` and `mail(login)` what was kept; `kick`
ends a session as the server does; `addAccount` adds one later; and
`caps` chooses which families it serves. It holds no
privileges, rate limits or grace timer, and answers anything else
`unknown_method`. It has no identity endpoints either, so
`@hotline-ng/client/node`'s `identityToken` needs a fake of its own:
`server.identityToken(login)` is the token one would mint.

The CBOR codec the identity objects are made of is on the main entry,
as `encodeCbor`, `decodeCanonicalCbor`, the `cMap`-style constructors,
`mapGet` and `mapWithout`, for a test that builds them itself.

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
