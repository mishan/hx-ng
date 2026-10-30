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

### Added

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
