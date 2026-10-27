# Changelog

While the version is 0.x, a minor version may break callers; each entry
says how.

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
