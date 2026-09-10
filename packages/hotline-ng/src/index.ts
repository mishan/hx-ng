/**
 * @hotline-ng/client — a TypeScript client for the Hotline-ng wire.
 *
 * Three layers, each usable without the ones above it:
 *
 * - `protocol` — the wire's shapes and its error codes. No behaviour.
 * - `Connection` — one *session* across however many WebSockets it
 *   takes: handshake, resume with replay, backoff, and a trace hook that
 *   sees exactly what the socket saw.
 * - `VoiceSession` — the SFU: joining voice, publishing a camera or a
 *   screen, subscribing to other people's, and the SDP conventions that
 *   tell one stream from another.
 *
 * No UI framework anywhere near it and no dependencies. What it needs of
 * a runtime differs by layer — worth knowing before reaching for the
 * bottom one from somewhere that is not a page:
 *
 * - `protocol` is plain data and runs anywhere.
 * - `Connection` needs `WebSocket`, `fetch` and `performance`, all of
 *   which a current Node has too — the class deliberately touches no
 *   `window` and no `document`, so a bot, a test harness or an SSR pass
 *   can drive a session. It does reach for `sessionStorage`, behind a
 *   try/catch, so resume-across-reloads switches itself off where there
 *   is none rather than failing.
 * - `VoiceSession` is the browser-only layer: WebRTC and `getUserMedia`,
 *   and one hidden `<audio>` element per inbound audio mid, appended to
 *   `document.body`. Video it does not draw: it hands you a
 *   `MediaStream` and the mid it arrived on, and where that belongs on
 *   your page is your business. Importing it costs nothing outside a
 *   browser; calling into it is what needs one.
 * - `identity` needs `crypto.subtle` (Ed25519, X25519, SHA-256) and
 *   `fetch`. It holds no keys of its own — a device's private keys live
 *   in the app's own `IndexedDB` store, never here.
 *
 * Relative imports carry their `.js` extension because that is what the
 * published ESM has to say for Node to resolve it; a bundler is happy
 * either way, and only one of the two is a real specification.
 */

export * from './protocol.js';
export * from './identity.js';
export {
  Connection,
  hasSavedSession,
  WireFailure,
  type ConnectionHooks,
  type ConnState,
  type Credentials,
  type TraceEntry,
} from './connection.js';
export {
  captureBlockedReason,
  screenShareBlockedReason,
  VoiceSession,
  type RemoteVideo,
  type VoiceSessionHooks,
} from './voice.js';
