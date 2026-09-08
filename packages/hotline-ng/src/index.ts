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
 * There is no DOM in any of it and no UI framework anywhere near it.
 * `VoiceSession` hands you a `MediaStream` and the mid it arrived on;
 * where that belongs on your page is your business.
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
