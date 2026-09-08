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
 * No UI framework anywhere near it and no dependencies. What it does
 * need is a browser, and how much of one differs by layer — worth
 * knowing before reaching for the bottom one from somewhere that is not
 * a page:
 *
 * - `protocol` is plain data and runs anywhere.
 * - `Connection` needs `WebSocket` and `window`. It also reaches for
 *   `sessionStorage`, behind a try/catch, so resume-across-reloads
 *   switches itself off where there is none rather than failing.
 * - `VoiceSession` needs WebRTC and `getUserMedia`, and creates one
 *   hidden `<audio>` element per inbound audio mid, appended to
 *   `document.body`. Video it does not draw: it hands you a
 *   `MediaStream` and the mid it arrived on, and where that belongs on
 *   your page is your business.
 */

export * from './protocol';
export {
  Connection,
  hasSavedSession,
  WireFailure,
  type ConnectionHooks,
  type ConnState,
  type Credentials,
  type TraceEntry,
} from './connection';
export {
  captureBlockedReason,
  screenShareBlockedReason,
  VoiceSession,
  type RemoteVideo,
  type VoiceSessionHooks,
} from './voice';
