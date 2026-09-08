/**
 * Voice and video: one peer connection, one room, one SFU.
 *
 * The wire is `docs/voice.md` §8 and the Hotline-ng binding of
 * `docs/capabilities-video.md`. The rules that shape this file are the
 * server's, not the browser's:
 *
 * - **The server is always the offerer.** There is exactly one
 *   negotiation path — take the offer, answer it, send the answer back —
 *   and video renegotiation arrives on it unchanged, because video is
 *   layered on the voice session rather than sitting beside it.
 * - **Nothing is delivered unasked.** A peer receives a publication only
 *   while it holds a subscription, so a voice-only participant is not a
 *   special case; it is a peer whose subscription set is empty.
 * - **Inbound streams are keyed by transceiver mid**, never by m-line
 *   index: sections differ per peer and move as subscriptions change.
 *   `user-{uid}` is audio, `cam-user-{uid}` and `scr-user-{uid}` video.
 *
 * This file draws nothing. It hands the embedder a `MediaStream` and the
 * mid it arrived on and stops there, because where a camera belongs on
 * the page is not a protocol question — and because the two places
 * browsers most often refuse to show a video (autoplay policy, and an
 * element attached inside a hidden container) are both problems of the
 * element rather than of the track.
 *
 * It is not DOM-free, though, and the exception is worth stating plainly
 * rather than leaving to be discovered: remote audio needs a sink, so
 * `playAudio` creates one hidden `<audio>` per inbound audio mid and
 * appends it to `document.body`. That is a real dependency on there
 * being a document. It is deliberate — an audio element is never laid
 * out, every caller would build the same one, and Safari is markedly
 * happier starting an element the page actually contains — but it is
 * the one thing here an embedder might want to own, and `playAudio` is
 * the one place to change if so.
 */

import type { Connection } from './connection';
import {
  CAM_SEND_MID,
  parseRecvMid,
  SCR_SEND_MID,
  sendMid,
  type VideoConfig,
  type VideoKind,
  type VideoLimits,
  type VideoPublication,
  type VideoStartOk,
  type VoiceJoinOk,
  type VoiceParticipant,
} from './protocol';

/** One publication arriving on this peer connection, ready to be shown. */
export interface RemoteVideo {
  /** The transceiver mid it came in on — `cam-user-12`. Stable for the
   *  life of the session and unique per publication, so it is also the
   *  right key for whatever the embedder renders it into. */
  mid: string;
  uid: number;
  kind: VideoKind;
  stream: MediaStream;
  track: MediaStreamTrack;
}

export interface VoiceSessionHooks {
  /** Something worth saying to the user, or — with `bad` — worth saying
   *  loudly. */
  onLog: (text: string, bad?: boolean) => void;
  /** Voice membership or the room's publication list changed. */
  onRoom: () => void;
  /** What this session can do next changed: joined, muted, publishing,
   *  watching. */
  onControls: () => void;
  /** A subscribed publication became renderable. */
  onRemoteVideo: (v: RemoteVideo) => void;
  /** That publication went away — stopped, unsubscribed, or its
   *  publisher left. */
  onRemoteVideoEnded: (mid: string) => void;
  /** This session's own capture started (`stream`) or stopped (`null`),
   *  so the embedder can offer a self-view. */
  onLocalVideo: (kind: VideoKind, stream: MediaStream | null) => void;
}

const DEFAULTS: Record<VideoKind, VideoLimits> = {
  camera: {
    max_width: 1280,
    max_height: 720,
    max_fps: 30,
    max_bitrate: 1_500_000,
    max_per_room: 8,
  },
  screen: {
    max_width: 1920,
    max_height: 1080,
    max_fps: 15,
    max_bitrate: 2_500_000,
    max_per_room: 1,
  },
};

/**
 * Why this page cannot capture a microphone or camera, or `null` when it
 * can.
 *
 * `navigator.mediaDevices` is only *defined* in a secure context. A page
 * served over plain http from anything but localhost therefore does not
 * have a `getUserMedia` that refuses politely — it has no `mediaDevices`
 * at all, and reaching through it throws a TypeError about reading a
 * property of undefined. That is exactly what a phone opening this
 * client over the LAN hits, so the condition is checked up front and
 * reported in words rather than left to surface as a type error.
 */
export function captureBlockedReason(): string | null {
  if (!window.isSecureContext) {
    return (
      `Voice needs a secure context and ${location.origin} is not one, so this ` +
      'browser withholds the microphone entirely. Serve the client over https, ' +
      'or reach it as localhost (an SSH tunnel counts).'
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser does not offer getUserMedia, so voice is unavailable here.';
  }
  return null;
}

/** Screen sharing is a separate capability, not a corollary of the one
 *  above: iOS Safari has `getUserMedia` and no `getDisplayMedia` at all. */
export function screenShareBlockedReason(): string | null {
  const blocked = captureBlockedReason();
  if (blocked) return blocked;
  // Typed as always present, actually optional in the wild.
  const md = navigator.mediaDevices as Partial<MediaDevices>;
  return md.getDisplayMedia
    ? null
    : 'This browser cannot share a screen — it has no getDisplayMedia.';
}

export class VoiceSession {
  private pc: RTCPeerConnection | null = null;
  private mic: MediaStream | null = null;
  private cam: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private audioEls = new Map<string, HTMLAudioElement>();
  private remote = new Map<string, RemoteVideo>();

  /**
   * Negotiation runs one at a time.
   *
   * The server serialises its offers, but its *events* reach us through
   * a socket that does not: a `voice_offer` can land while the previous
   * one is still inside an `await`, and two overlapping
   * `setRemoteDescription` calls fail the second with a wrong-state
   * error. Video is where this bites — publishing, subscribing and a
   * publisher stopping each renegotiate, so a video room produces the
   * bursts a voice room never does — and a dropped renegotiation is
   * exactly the failure that looks like a black tile.
   */
  private turn: Promise<void> = Promise.resolve();
  /** Candidates that arrived before there was a remote description to
   *  add them to. `addIceCandidate` rejects outright in that state, and
   *  the server is free to start trickling the moment it has offered. */
  private earlyIce: (RTCIceCandidateInit | null)[] = [];

  /** The room. The public chat is 0, and voice is one room at a time. */
  cid = 0;
  joined = false;
  muted = true;
  camPaused = false;
  watching = false;
  codec = '';
  participants: VoiceParticipant[] = [];
  publications: VideoPublication[] = [];
  limits: VideoConfig | null = null;

  constructor(
    private conn: Connection,
    private hooks: VoiceSessionHooks,
  ) {
    conn.on('voice_offer', (d) => {
      // `negotiate` already reported whatever went wrong; the catch here
      // is only so a failed renegotiation is not also an unhandled
      // rejection in the console.
      void this.negotiate(d.sdp).catch(() => {});
    });
    conn.on('voice_ice', (d) => this.addIce(d.candidate ?? null));
    conn.on('voice_status', (d) => {
      this.participants = d.participants;
      this.hooks.onRoom();
    });
    conn.on('video_status', (d) => {
      // The complete publication list, every time: replace the view of
      // the room rather than patching it.
      this.publications = d.publishers ?? [];
      this.pruneRemote();
      this.hooks.onRoom();
      this.hooks.onControls();
      if (this.watching) void this.subscribeAll().catch((e) => this.fail(e));
    });
  }

  get hasVoice(): boolean {
    return this.conn.caps.includes('voice');
  }

  get hasVideo(): boolean {
    return this.conn.caps.includes('video');
  }

  get publishing(): VideoKind[] {
    const out: VideoKind[] = [];
    if (this.cam) out.push('camera');
    if (this.screen) out.push('screen');
    return out;
  }

  /** This session's own capture of `kind`, for a self-view. */
  localVideo(kind: VideoKind): MediaStream | null {
    return kind === 'camera' ? this.cam : this.screen;
  }

  /** Everything currently arriving, for an embedder rebuilding its view
   *  from scratch. */
  remoteVideo(): RemoteVideo[] {
    return [...this.remote.values()];
  }

  inVoice(uid: number): VoiceParticipant | undefined {
    return this.participants.find((p) => p.uid === uid);
  }

  publicationsOf(uid: number): VideoPublication[] {
    return this.publications.filter((p) => p.uid === uid);
  }

  // --- voice ------------------------------------------------------------

  async join(): Promise<void> {
    const blocked = captureBlockedReason();
    if (blocked) throw new Error(blocked);
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.pc = this.newPeerConnection();
    for (const t of this.mic.getTracks()) this.pc.addTrack(t, this.mic);

    const ok = await this.conn.request<VoiceJoinOk>('voice_join', { cid: this.cid });
    this.codec = ok.codec;
    this.participants = ok.participants;
    this.joined = true;
    // Through the same queue as every later offer, so the join's offer
    // and a renegotiation that arrives on its heels cannot interleave.
    await this.negotiate(ok.sdp);
    // Clients SHOULD join muted, and the server enforces it; say so
    // rather than letting the two disagree.
    await this.setMuted(true);
    this.hooks.onLog(`joined voice (${ok.codec})`);
    this.hooks.onRoom();
    this.hooks.onControls();
  }

  async leave(): Promise<void> {
    await this.conn.request('voice_leave', { cid: this.cid }).catch(() => {});
    this.teardown();
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.conn.request('voice_mute', { cid: this.cid, muted });
    this.muted = muted;
    // Both sides, on purpose: replacing the microphone with silence
    // keeps RTP flowing at its normal rate, which keeps the NAT path
    // warm. Dropping the packets would save nothing worth having.
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted;
    this.hooks.onControls();
  }

  teardown(): void {
    this.pc?.close();
    this.pc = null;
    this.turn = Promise.resolve();
    this.earlyIce = [];
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = null;
    this.stopCapture('camera');
    this.stopCapture('screen');
    for (const el of this.audioEls.values()) {
      el.pause();
      el.srcObject = null;
      el.remove();
    }
    this.audioEls.clear();
    for (const mid of [...this.remote.keys()]) this.dropRemote(mid);
    this.joined = false;
    this.muted = true;
    this.camPaused = false;
    this.watching = false;
    this.codec = '';
    this.participants = [];
    this.publications = [];
    this.hooks.onRoom();
    this.hooks.onControls();
  }

  private newPeerConnection(): RTCPeerConnection {
    // No ICE servers: the SFU is the only peer and we already know where
    // it is. No STUN, no TURN — that is the whole point of the model.
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = (e) => {
      void this.conn
        .request('voice_ice', { cid: this.cid, candidate: e.candidate ?? null })
        .catch((err: Error) => this.hooks.onLog(`voice_ice: ${err.message}`, true));
    };
    pc.ontrack = (e) => {
      // Video is picked up by the transceiver sweep at the end of each
      // negotiation instead of here, because `ontrack` fires once per
      // receiver for the life of the connection: a section that goes
      // `a=inactive` on an unsubscribe and comes back on the next
      // subscribe never fires it a second time, and a client that only
      // listened here would show that stream once and never again.
      if (e.track.kind !== 'video') this.playAudio(e.transceiver?.mid ?? '?', e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => this.hooks.onLog(`peer connection: ${pc.connectionState}`);
    return pc;
  }

  /** Queue an offer for answering. Returns when *this* offer has been
   *  answered, so a caller that has one in hand can await it. */
  private negotiate(sdp: string): Promise<void> {
    const next = this.turn.then(() => this.answerOffer(sdp));
    // The queue must survive a failed negotiation, or one bad offer ends
    // every renegotiation for the rest of the call.
    this.turn = next.catch(() => {});
    return next.catch((e: unknown) => {
      this.fail(e);
      throw e instanceof Error ? e : new Error(String(e));
    });
  }

  private async answerOffer(sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await this.flushIce();
    // Attach capture tracks *before* creating the answer: the answer's
    // `a=ssrc` comes from the sender's track, and the server keys
    // inbound video on it with no fallback to guess from — a camera and
    // a screen are the same codec at the same payload type on one
    // bundled transport, so there is nothing else to tell them apart.
    await this.bindSendSections();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const local = pc.localDescription?.sdp ?? answer.sdp ?? '';
    this.checkSendSsrc(local);
    await this.conn.request('voice_answer', { cid: this.cid, sdp: local });
    // Only now is `currentDirection` the negotiated one, which is what
    // says whether a section is actually delivering anything.
    this.syncRemote();
    await this.applyEncoderLimits();
  }

  private async bindSendSections(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    for (const [mid, stream] of [
      [CAM_SEND_MID, this.cam],
      [SCR_SEND_MID, this.screen],
    ] as const) {
      const tr = pc.getTransceivers().find((t) => t.mid === mid);
      if (!tr) continue;
      const track = stream?.getVideoTracks()[0] ?? null;
      if (tr.sender.track !== track) await tr.sender.replaceTrack(track);
      // A transceiver the remote offer created starts `recvonly`
      // whatever the offer said, so this is not a no-op even when the
      // server has asked for exactly this: without it the answer says
      // `recvonly` too and not one frame is ever sent.
      if (track) tr.direction = 'sendonly';
      else if (tr.direction === 'sendonly') tr.direction = 'inactive';
    }
  }

  /**
   * The one answer requirement that fails silently.
   *
   * `docs/capabilities-video.md` §Send SSRC Declaration makes `a=ssrc`
   * mandatory on a video send section and forbids the server from
   * guessing, so an answer without one costs the publication — the
   * server drops it, the room sees the publication vanish, and the
   * publisher's own UI has no idea why. Browsers emit it, but a browser
   * that stopped would look exactly like a camera that does not work,
   * so check rather than assume.
   */
  private checkSendSsrc(sdp: string): void {
    for (const kind of this.publishing) {
      const mid = sendMid(kind);
      const section = sectionFor(sdp, mid);
      if (!section) continue;
      if (!/^m=\S+ (?!0\b)\d+/m.test(section)) {
        this.hooks.onLog(`this browser declined the ${kind} section (port 0)`, true);
      } else if (!/^a=ssrc:\d+/m.test(section)) {
        this.hooks.onLog(
          `the answer's ${mid} section declares no a=ssrc, so the server will drop the ${kind}`,
          true,
        );
      }
    }
  }

  /** Keep the encoder inside the server's advertised ceiling. The limits
   *  are configuration, not negotiation: a client that cannot be
   *  constrained to them must not publish, and `getUserMedia` alone
   *  constrains resolution and frame rate but never bitrate. */
  private async applyEncoderLimits(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    for (const kind of this.publishing) {
      const tr = pc.getTransceivers().find((t) => t.mid === sendMid(kind));
      if (!tr?.sender.track) continue;
      const l = this.limits?.[kind] ?? DEFAULTS[kind];
      const params = tr.sender.getParameters();
      // Chrome hands back an empty `encodings` before the first
      // `setParameters`; writing into that array is the documented way
      // to seed it.
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      for (const e of params.encodings) {
        e.maxBitrate = l.max_bitrate;
        e.maxFramerate = l.max_fps;
      }
      await tr.sender.setParameters(params).catch((err: Error) => {
        this.hooks.onLog(`could not cap the ${kind} encoder: ${err.message}`);
      });
    }
  }

  // --- ice ---------------------------------------------------------------

  private addIce(candidate: RTCIceCandidateInit | null): void {
    const pc = this.pc;
    if (!pc) return;
    if (!pc.remoteDescription) {
      this.earlyIce.push(candidate);
      return;
    }
    void pc
      .addIceCandidate(candidate ?? undefined)
      .catch((e: Error) => this.hooks.onLog(`ICE candidate refused: ${e.message}`, true));
  }

  private async flushIce(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.earlyIce.length === 0) return;
    const queued = this.earlyIce;
    this.earlyIce = [];
    for (const c of queued) {
      await pc
        .addIceCandidate(c ?? undefined)
        .catch((e: Error) => this.hooks.onLog(`ICE candidate refused: ${e.message}`, true));
    }
  }

  // --- video ------------------------------------------------------------

  async toggleCamera(): Promise<void> {
    if (this.cam) {
      await this.conn.request('video_stop', { cid: this.cid, kind: 'camera' });
      this.stopCapture('camera');
      this.camPaused = false;
      this.hooks.onControls();
      return;
    }
    const blocked = captureBlockedReason();
    if (blocked) throw new Error(blocked);
    // Configure the encoder inside the advertised ceiling *before*
    // publishing: the limits are configuration, not negotiation, and a
    // client that cannot be constrained to them must not publish.
    const l = this.limits?.camera ?? DEFAULTS.camera;
    this.cam = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { max: l.max_width },
        height: { max: l.max_height },
        frameRate: { max: l.max_fps },
        facingMode: 'user',
      },
    });
    this.watchCapture('camera');
    try {
      const ok = await this.conn.request<VideoStartOk>('video_start', {
        cid: this.cid,
        kind: 'camera',
      });
      this.hooks.onLog(`publishing a camera (${ok.codec})`);
    } catch (e) {
      this.stopCapture('camera');
      throw e;
    }
    // No offer came back with that reply and none was expected: one may
    // already be outstanding toward us, and the server sends ours as a
    // voice_offer when serialisation allows.
    this.hooks.onLocalVideo('camera', this.cam);
    this.hooks.onControls();
  }

  async togglePause(): Promise<void> {
    const paused = !this.camPaused;
    await this.conn.request('video_state', { cid: this.cid, kind: 'camera', paused });
    this.camPaused = paused;
    // Pause is to video what mute is to audio: no renegotiation, the
    // section and the slot both stay. Stopping the local track as well
    // is what turns the camera's hardware light off, which is the half
    // of it people actually check.
    for (const t of this.cam?.getVideoTracks() ?? []) t.enabled = !paused;
    this.hooks.onControls();
  }

  async toggleShare(): Promise<void> {
    if (this.screen) {
      await this.conn.request('video_stop', { cid: this.cid, kind: 'screen' });
      this.stopCapture('screen');
      this.hooks.onControls();
      return;
    }
    const blocked = screenShareBlockedReason();
    if (blocked) throw new Error(blocked);
    const l = this.limits?.screen ?? DEFAULTS.screen;
    // getDisplayMedia is its own consent step, per share, with the
    // browser's own sharing indicator — exactly what the spec asks a
    // client to provide and forbids it from remembering.
    this.screen = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { max: l.max_width },
        height: { max: l.max_height },
        frameRate: { max: l.max_fps },
      },
    });
    // A share can be ended from the browser's own UI, and that has to
    // reach the server or the room's one screen slot stays occupied.
    this.watchCapture('screen');
    try {
      await this.conn.request('video_start', { cid: this.cid, kind: 'screen' });
    } catch (e) {
      this.stopCapture('screen');
      throw e;
    }
    this.hooks.onLocalVideo('screen', this.screen);
    this.hooks.onControls();
  }

  async setWatching(on: boolean): Promise<void> {
    this.watching = on;
    if (on) await this.subscribeAll();
    else {
      // `[]` turns it all off in one request, which is the message this
      // binding exists for on a metered connection.
      await this.conn.request('video_subscribe', { cid: this.cid, streams: [] });
      for (const mid of [...this.remote.keys()]) this.dropRemote(mid);
    }
    this.hooks.onControls();
  }

  private async subscribeAll(): Promise<void> {
    // The complete desired set in one request: four separate subscribes
    // would cost four renegotiations, serialised behind one another.
    const streams = this.publications
      .filter((p) => p.uid !== this.conn.self?.uid)
      .map((p) => ({ uid: p.uid, kind: p.kind }));
    await this.conn.request('video_subscribe', { cid: this.cid, streams });
  }

  /** A capture can end without us: the browser's own "stop sharing"
   *  button, a camera unplugged, a phone's other app taking it. The
   *  server has to hear about it or the room's slot stays occupied by a
   *  publication that can never produce a pixel. */
  private watchCapture(kind: VideoKind): void {
    const stream = this.localVideo(kind);
    stream?.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.localVideo(kind) !== stream) return;
      this.hooks.onLog(`${kind} capture ended`);
      void this.conn.request('video_stop', { cid: this.cid, kind }).catch(() => {});
      this.stopCapture(kind);
      this.hooks.onControls();
    });
  }

  private stopCapture(kind: VideoKind): void {
    const which = kind === 'camera' ? 'cam' : 'screen';
    for (const t of this[which]?.getTracks() ?? []) t.stop();
    if (this[which]) this.hooks.onLocalVideo(kind, null);
    this[which] = null;
  }

  // --- inbound media -----------------------------------------------------

  private playAudio(mid: string, stream: MediaStream): void {
    let el = this.audioEls.get(mid);
    if (!el) {
      el = new Audio();
      el.autoplay = true;
      // In the document, off the layout: Safari is markedly happier
      // starting an element the page actually contains, and `hidden`
      // keeps it out of the way of everything else.
      el.hidden = true;
      document.body.append(el);
      this.audioEls.set(mid, el);
    }
    el.srcObject = stream;
    void el.play().catch(() => {
      // Autoplay for audio needs a gesture in some configurations. The
      // gesture that joined voice usually counts; when it does not,
      // saying so beats silence with no explanation.
      this.hooks.onLog('this browser is holding incoming audio until you interact with the page');
    });
  }

  /**
   * Rebuild the set of arriving publications from the transceivers.
   *
   * `currentDirection` is the negotiated truth and the only thing that
   * distinguishes a live section from one the server has parked at
   * `a=inactive`; mids are never reassigned, so a section reappearing is
   * the same publication resuming rather than a new one.
   */
  private syncRemote(): void {
    const pc = this.pc;
    if (!pc) return;
    for (const t of pc.getTransceivers()) {
      const mid = t.mid;
      if (!mid) continue;
      const ref = parseRecvMid(mid);
      if (!ref) continue;
      const live = t.currentDirection === 'recvonly' || t.currentDirection === 'sendrecv';
      if (!live) {
        this.dropRemote(mid);
        continue;
      }
      if (this.remote.has(mid)) continue;
      const track = t.receiver.track;
      const v: RemoteVideo = { mid, ...ref, track, stream: new MediaStream([track]) };
      this.remote.set(mid, v);
      this.hooks.onRemoteVideo(v);
    }
  }

  /** Drop what `video_status` says is gone, without waiting for the
   *  renegotiation that will park its section. The mid encodes uid and
   *  kind, which is exactly what the status lists. */
  private pruneRemote(): void {
    for (const [mid, v] of this.remote) {
      if (!this.publications.some((p) => p.uid === v.uid && p.kind === v.kind)) this.dropRemote(mid);
    }
  }

  private dropRemote(mid: string): void {
    if (!this.remote.delete(mid)) return;
    this.hooks.onRemoteVideoEnded(mid);
  }

  private fail(e: unknown): void {
    this.hooks.onLog(e instanceof Error ? e.message : String(e), true);
  }

  // --- diagnostics -------------------------------------------------------

  /** Everything the media layer knows, flattened for a debug panel or a
   *  bug report. */
  async stats(): Promise<Record<string, unknown>> {
    const facts: Record<string, unknown> = {
      'voice joined': this.joined,
      muted: this.muted,
      codec: this.codec || null,
      participants: this.participants.length,
      publications: this.publications.map(
        (p) => `${p.uid}:${p.kind}${p.paused ? ' (paused)' : ''}`,
      ),
      publishing: this.publishing,
      watching: this.watching,
      'receiving video': [...this.remote.keys()],
      'peer connection': this.pc?.connectionState ?? null,
      'ice state': this.pc?.iceConnectionState ?? null,
      'signalling state': this.pc?.signalingState ?? null,
      mids:
        this.pc
          ?.getTransceivers()
          .map((t) => `${t.mid ?? '?'}:${t.currentDirection ?? '-'}`) ?? [],
    };
    if (!this.pc) return facts;
    try {
      const report = await this.pc.getStats();
      report.forEach((s) => {
        if (s.type === 'inbound-rtp') {
          facts[`in ${s.kind} ${s.ssrc}`] =
            `${s.packetsReceived ?? 0} pkts, ${s.packetsLost ?? 0} lost` +
            (s.framesDecoded !== undefined ? `, ${s.framesDecoded} frames` : '');
        } else if (s.type === 'outbound-rtp') {
          facts[`out ${s.kind} ${s.ssrc}`] =
            `${s.packetsSent ?? 0} pkts` +
            (s.framesEncoded !== undefined ? `, ${s.framesEncoded} frames` : '');
        } else if (s.type === 'candidate-pair' && s.state === 'succeeded') {
          facts['rtt (ice)'] =
            s.currentRoundTripTime !== undefined
              ? `${Math.round(s.currentRoundTripTime * 1000)} ms`
              : '—';
        }
      });
    } catch {
      /* getStats can reject on a closed connection; the facts above
         still describe the state usefully */
    }
    return facts;
  }
}

/** The lines of one `m=` section of an SDP, by mid. */
function sectionFor(sdp: string, mid: string): string | null {
  const sections = sdp.split(/^m=/m).slice(1);
  const found = sections.find((s) => new RegExp(`^a=mid:${mid}\\s*$`, 'm').test(s));
  return found === undefined ? null : `m=${found}`;
}
