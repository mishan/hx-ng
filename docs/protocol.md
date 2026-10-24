# What hx-ng does with the protocol

The wire is hxd-ng's
[`hotline-ng.md`](https://github.com/mishan/hxd-ng/blob/main/docs/hotline-ng.md);
this is how this client uses it, and how it reaches a classic server.

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
  quotes, code, rules and pipe tables, with raw HTML shown as typed and
  an image drawn as a link to it, never fetched; `#51` and a link to
  `news:51`, in any of CommonMark's link forms, are linked only where the
  server resolved them.
  The composer offers it, with a preview, where the server's login reply
  lists `text/markdown`, and an article written that way is posted
  saying so: the one place this client tells a server a body is markdown. Nothing either dialect produces is ever handed
  to the HTML parser: the library parses, and the page draws text nodes.
- **Notifications are asked for, per server and per account.** Where the
  login reply offers `push`, **Notify** in the title bar says first what
  a notification from that server will carry (the text, only the sender,
  or only that something arrived; the server decides, and applies it
  before it encrypts), then asks the browser, subscribes with the
  server's own VAPID key and sends `push_register`. Each server and
  account gets its own service worker registration, scoped under
  `push/`, because a subscription is bound to one server's key: turning
  one off touches no other, and two people sharing a browser are not
  notified about each other's mail. The worker draws a private message
  or a news notice, collapsed per conversation or per thread, and a tap
  opens that conversation or article. Every login re-registers, which
  puts right a changed endpoint or a server that has changed its key
  since. Logging out leaves notifications on, since being away is what
  they are for. Only **Notify** turns them off.
- **Accounts are edited where the server says they may be.** A server
  with the `accounts` capability says in the login reply what this
  session's account may do, and a session that may read or make accounts
  gets **Accounts** on the rail. A privilege the editor does not hold is
  shown and not offered, and an account holding one is shown read-only,
  since the server would refuse either. The server also ranks accounts
  by settings in their files this client cannot see; an account it
  refuses for those is shown read-only, saying so, from then on. An edit sends only what changed,
  so renaming an account does not rewrite what it may do, and the bits
  this client has no name for travel back as they came. When an
  administrator changes your own account, `account_changed` says what
  it may do now, and the rail follows.
- **Anyone can report, and a moderator acts where the report is.** A
  line, a private message and an article each have a **Report** button,
  and a person has one in the ⋯ menu on their user-list row. Whichever
  target the wire can name is named: a public line by its id, a stored
  message by its inbox id, and otherwise the sender, with the words
  pasted and marked unverified by the server. The reporter is told how
  it ends. A session the login reply calls `moderator` gets **Reports**
  on the rail, badged from the login reply's count and moved by the
  `report` and `report_closed` events. Each report offers the act that
  fits it — redact a line, revoke an image, delete an article, purge a
  sender — and acting closes it, since the server closes every open
  report on what an act removed. Dismissing and closing as a duplicate
  are the two closes that remove nothing, and the audit trail is the
  view's third tab. A redacted line blanks in place on every page that
  drew it, on `chat_redacted`, and keeps its place. A purge blanks its
  lines the same way; a large one arrives as `chat_purged`, many lines
  to an event, and the transcript redraws once per event rather than
  once per line.
- **Negotiation is serialised, and inbound video is read from the
  transceivers.** Both are the difference between a picture and a black
  rectangle; `packages/hotline-ng/README.md` says why.

## Classic servers

The protocol on a relay's socket is GtkHx's, not a rewrite of it:
hx-libs' `hxsession`, compiled to wasm in [`packages/classic`](../packages/classic/),
and [`src/classic/connection.ts`](../src/classic/connection.ts) presents
what it says to the views in the ng shapes they already draw. A folder
whose name holds a `/` cannot be opened because the views address
folders by a slash-separated path.

Every connect reads the server's discovery document first, to learn
which wire it speaks. For a WebSocket address the client waits up to a
second for it, and with no answer connects to that address as it always
did. For a classic address it asks where a relay may be — the classic
port plus 200, then the host's web port — waiting up to three seconds on
each at once, and with no relay found says the server can only be
reached from a desktop client.
