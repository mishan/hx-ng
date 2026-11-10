# Changelog

While the version is 0.x, a minor version may break callers; each entry
says how.

## Unreleased

### Changed

- `onSnapshot` also fires when the server says `roster_stale`, with
  `stale: true`: only the roster is new, so a caller that resets more
  on a snapshot can skip it.
- `outranked` reads "That account or role may do…".
- A connection started `resumeOnly` whose resume is refused on a
  reconnect ends, with `onEnded`, rather than staying `reconnecting`.
- `onLogin` is handed, beside the reply, the rooms the session that
  login replaces was in, from the record saved with the session, so a
  client can join them again after a reload whose resume failed.
- Breaking: `ReactionKey` is `{ emoji }` or, for one of the server's
  own emoji, `{ custom: id }`, which every reader of reactions may be
  shown, so a caller reading `key.emoji` checks it is there.
- Breaking: `MsgOk` has no `id`. A stored message's `id` is its place
  in the recipient's mailbox, shown to the recipient alone, and `ref`
  names it to both parties (hxd-ng's `docs/hotline-ng.md` §7.1):
  `MsgOk.ref`, and `ref` on the `msg` and `im` events, `StoredMessage`
  and `RequestMessage`, absent from a server before references.
  `ReportTarget.msg` is that `ref`, or a number from such a server.
  `FakeServer` numbers each mailbox by itself and refuses a cursor one
  never issued `bad_request`, as the server does.

### Added

- Server emoji (hxd-ng's `docs/server-emoji.md` §8): `Credentials.emoji`
  says `emoji` at login, and `Connection.emoji` is the login reply's
  `EmojiConfig`, the catalog's revision and its limits, saved with the
  session; `CAP_EMOJI`. `emojiList({ revision, after })` answers a page
  of `EmojiEntry`s, `LiveEmoji` or `RemovedEmoji`, as `EmojiListOk`,
  and `EmojiCatalog` keeps them: it pages, keeps the first page's
  revision, starts again when a delta's later page comes back whole,
  and runs a refresh asked for while one pages once more after it. The
  `emoji_changed` event says when to refresh. `fetchEmoji(hash)` gets an
  image with the session's bearer, refused `no_such_emoji` once no live
  entry has it. `EmojiRef` is `emoji` on `chat` and `msg`, on the
  `chat`, `msg` and `im` events, `HistoryLine`, `StoredMessage` and
  `RequestMessage`; `emojiRefsFor` makes them for a text from the
  catalog, and `emojiSegments` splits a text by them, only a name a
  reference binds to a live id becoming an emoji. `react` and
  `reactionsGet` take `{ custom: id }`, and `react` may be refused
  `no_such_emoji`. `FakeServer` serves it: granted to a login that
  asks, a catalog the test edits with `addEmoji`, `renameEmoji` and
  `removeEmoji`, each told as `emoji_changed`, `emoji_list` paged by
  `emojiPage`, references kept and carried as hxd-ng keeps them, and
  server emoji as reaction keys.
- The news timeline (hxd-ng's `docs/news.md` §10.8, §10.9):
  `newsTimeline({ before, after, limit })` answers `NewsTimelineOk`, the
  threads started in every category the account follows and has not
  muted, newest first, each a `NewsTimelineThread` that says whether
  its category counts it `unread`. `newsSeenTimeline(from, upTo)` marks
  a run of it seen, `from` 0 for a run that reached its end. A server
  without the timeline refuses it `unknown_method`.
- Reactions (hxd-ng's `docs/hotline-ng.md` §7.3): `Credentials.reactions`
  says `reactions` at login, and `Connection.reactions` is the login
  reply's `ReactionsConfig`, the kinds of target the server takes and
  its `max_keys` and `max_per_user`, saved with the session;
  `CAP_REACTIONS`. `react(target, key, { remove })` answers the key's
  `count`, sending the key without U+FE0E, and its refusals are
  `WireFailure`s, `too_many_reactions` among the codes and
  `reactionErrorText` their wording. `HistoryLine` carries `reactions`
  and `reactions_mine`, and the `reactions_changed` event a
  `ReactionChange` for each target. `FakeServer` serves it: granted to a
  login that asks where lines are kept, with `reactionCaps`, a reaction
  its account's, refused as hxd-ng refuses it but for its rate limit,
  on `history` to such sessions, and its changes sent a room at a time
  by `flushReactions()`. `reactionsGet(targets, key?)` reads again the
  reactions on up to 50 lines, a `LineReactions` for each this session
  could have read, tombstones left out, and with `key` and one target
  `from`, who holds it; `FakeServer` does not serve it yet.
  `ReactionTarget` is also an instant message, `{ im: { login, guid } }`,
  whose `react` takes the other party's login as `{ with }`, and a stored
  message, `{ pm: ref }`; both are answered `{}`. `reactionsGet` takes
  lines and stored messages, `StoredReactionTarget`. A
  `ReactionChange` is a stored message's `summary`, or an instant
  message's key, `add` or `remove`, by `from.login`. `StoredMessage` and
  the `msg` event carry `reactions`, `reactions_mine`, and an instant
  message's `im: true` and `guid`. `MsgOk` carries `im: true` and the
  `guid` for a message that went as an instant message. `FakeServer`
  takes `line` targets alone.
- `onCaughtUp` is called once the catch-up after a login or a resync
  has handed over its pages: where a client reads again what a gap may
  have changed on lines it holds.
- Replies (hxd-ng's `docs/hotline-ng.md` §7.3): `Credentials.replies`
  says `replies` at login, and `Connection.replies` is the login
  reply's `RepliesConfig`, the kinds of target the server keeps, saved
  with the session; `CAP_REPLIES`. `ReplyTarget` is `re` on `chat` and
  `msg`, on the `chat`, `msg` and `im` events, `HistoryLine`,
  `StoredMessage` and `RequestMessage`; `history` takes `ids`.
  `FakeServer` serves it as the server does: granted only to a login
  that asks, `re` carried to such sessions alone, refused `bad_request`
  across rooms or of the wrong kind, malformed, of a kind it does not
  keep or beside `signed`, and `ids` answered within the server's bound.
- `Credentials.sessionStore` keeps the resume record in a
  `SessionStore` of the caller's (such as `localStorage`, for an
  installed app) in place of `sessionStorage`, and `hasSavedSession`
  takes the same store as a second argument. A connection clears the
  record only while it holds what that connection last wrote or read,
  so windows sharing a store do not clear each other's.
- `hasSavedSession(url, store, login)` answers only for a session on
  that account. The record keeps the account it is on, and `start`
  resumes a saved session only when `Credentials.login` is empty or
  names that account.
- Instant messaging (hxd-ng's `docs/hotline-ng.md` §7.5):
  `Credentials.messaging` says `messaging` at login, and
  `Connection.messaging` is the login reply's `MessagingConfig`, and
  `sync`'s, saved with the session. `onFriends` is handed `friends`
  after each login, resume and resync of a session that speaks the
  family and takes part, and after the request that made it one, which
  is what hands over the instant messages that waited; a `friends`
  refused `rate_limited` is asked again. `friends`,
  `friendAdd`, `friendRespond`, `friendRemove`, `friendAlias`,
  `setPresence`, `findUser`, `userProfile`, `receipt`, `typing`,
  `requests` (every page, one entry per sender, as `mergeRequests`
  joins two), `requestAnswer` and `requestsClear`; the events `friend`, `friend_request`, `presence`,
  `im`, `receipt`, `typing` and `requests_changed`; `MsgOk.requested`;
  `CAP_MESSAGING`; the codes `already_friends`, `request_pending`,
  `not_friends`, `roster_full`, `request_full` and `no_such_request`.
- Portable friendships (hxd-ng's `docs/hotline-ng.md` §7.5,
  `docs/proposals/friendship-objects.md`): the offer, acceptance,
  friendship and withdrawal, signed by `signFriendOffer`,
  `signFriendAcceptance` and `signFriendWithdrawal` and checked by
  `checkFriendOffer`, `checkFriendship` and `checkFriendWithdrawal`,
  each refusal a `FriendshipRefused` naming its step. A withdrawal
  checked without its pair is a `KeptWithdrawal` from
  `parseFriendWithdrawal`, which `checkWithdrawalPair` finishes; one
  checked whole is a `HeldWithdrawal`, the only kind `cutoffOf` takes.
  `pairHash`, `friendshipBytes`, `cutoffEnds`, `offerEndedBy` and
  `friendshipEndedBy`; rotation records by `parseRotation`, followed
  by `rotationChainEnd`. On the wire, `Credentials.friendships`,
  `CAP_FRIENDSHIPS` and `beforeFriends`; `friendAdd`'s `offer`,
  `friendRespond`'s `friendship`, `friendRemove` by
  `FriendRemoveParams`, `findUser` by fingerprint and `block`'s
  `withdraw`; `friendshipsPresent` and `friendshipsFetch`;
  `friendships`, `offer` and `withdraw` on `Friend`, `offer` on
  `friend_request`, `fingerprint` on `MessagingUser`; the codes
  `withdrawn` and `stale`, and the `IdentityError` kind `withdrawn`.
- Roles (hxd-ng's `docs/roles.md` §7): `Connection.roles`, a
  `RolesConfig` from the login reply and `sync`, kept current by
  `roles_changed` and `account_changed` and saved with the session;
  `User.roles`; `roleList`, `roleGet`, and a role manager's
  `roleCreate`, `roleUpdate`, `roleDelete`, with the types `RoleShown`,
  `Role`, `RoleListOk`, `RoleGetOk`, `RoleOk` and `RoleEditParams`;
  `SelfAccess.manage_roles`; the codes `no_such_role` and
  `role_in_use`.
- `roles_changed` and `roster_stale` in `Events`. `roster_stale` is
  answered with a `sync`, asked again after `rate_limited` and at the
  next resume if the socket drops first.
- `AccountInfo` carries an account's `roles` and its own keys, and
  `AccountEditParams` takes `roles` and `grant`, `deny`, `raw_grant`,
  `raw_deny` in place of `access`.

## 0.2.0

### Changed

- `onMissedHistory(page, room)` is also handed pages from the rooms a
  session has joined after a resync, with the room as its second
  argument (0 for the lobby). Room lines no longer move the lobby's
  history cursor.
- A refusal from the media, avatar, banner, news blob and upload routes
  that is not the server's JSON takes its code from the HTTP status:
  429 is `rate_limited` (with `Retry-After`), 413 the route's too-large
  code, 404 its not-found code, 5xx `server_error`, any other 4xx
  `bad_request`. Before, uploads read every such refusal as
  `not_available` and media every non-404 as `server_error`. The flat
  `{ error, text, retry_after }` body of hxd-ng's avatar throttle is
  read too.
- `Connection.moderator` follows `account_changed` and `sync`, as the
  new `Connection.manageRooms` does.
- `account_changed`'s payload is typed `SelfAccess`.
- `not_a_member` reads "You are not in that room or chat."

### Added

- Rooms: `rooms()`, `roomJoin`, `roomPart`, `roomTopic`, and a
  manager's `roomCreate`, `roomEdit`, `roomArchive`, `roomUnarchive`;
  `Room`, `RoomsConfig`, `SyncRooms` and the reply types;
  `room_member_joined`, `room_member_parted`, `room_added`,
  `room_changed` and `room_removed` in `Events`, and `room` on
  `notice`, `subject`, `chat_redacted` and `chat_purged`; a history
  cursor per joined room (`roomHistoryIds`), kept with the session.
- `MsgOk.id`, which a queued message from a sender with an inbox
  carries.
- `Credentials.webSocket`, a socket factory returning `SocketLike`,
  which a browser `WebSocket` and a `ws` socket both satisfy.
- The CBOR codec: `encodeCbor`, `decodeCanonicalCbor`, `CborValue`,
  `CborError`, the value constructors, `mapGet` and `mapWithout`.
- Error codes: `WireCode`, `isWireCode` and `retryClass`, which says
  whether a refusal may pass on a resend (`soon`), once something
  outside the request changes (`later`), or not (`never`).
- `@hotline-ng/client/node`: `loadDevice` for a device `hlid` made,
  `identityToken` for its login, and `FilePinStore` for server pins.
- `@hotline-ng/client/testing`: `FakeServer`, an in-memory server that
  drives a real `Connection`.

## 0.1.0

The first release.
