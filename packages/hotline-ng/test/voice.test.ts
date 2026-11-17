import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Connection } from '../src/connection';
import type { LoginOk, VoiceParticipant } from '../src/protocol';
import { VoiceSession } from '../src/voice';

import { installFakeWire, settle, uninstallFakeWire, type FakeServer, type Reply } from './fake-wire';

const SELF = 1;
const BOB = 2;

const loginOk = (): LoginOk => ({
  session: 's_1',
  token: 'tok',
  self: { uid: SELF, nick: 'Alice', icon: 128, admin: false, status: 'active', transport: 'encrypted' },
  server: { name: 'Test', subject: 'hi' },
  users: [],
  detach: { grace: 300 },
  caps: ['voice'],
  seq: 0,
});

/** Just enough of a microphone to see it stopped. */
class FakeTrack {
  kind = 'audio';
  enabled = true;
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
}

/** A peer connection that answers every offer and records its closing. */
class FakePeerConnection {
  static made: FakePeerConnection[] = [];
  /** Where a test holds the next offer from being taken, when it wants to. */
  static offered: Promise<void> = Promise.resolve();
  closed = false;
  remoteDescription: unknown = null;
  localDescription: { sdp: string } | null = null;
  connectionState = 'new';
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  constructor() {
    FakePeerConnection.made.push(this);
  }
  addTrack(): void {}
  getTransceivers(): [] {
    return [];
  }
  async setRemoteDescription(d: unknown): Promise<void> {
    await FakePeerConnection.offered;
    this.remoteDescription = d;
  }
  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: 'v=0' };
  }
  async setLocalDescription(d: { sdp: string }): Promise<void> {
    this.localDescription = d;
  }
  close(): void {
    this.closed = true;
  }
}

const status = (...uids: number[]): { cid: number; participants: VoiceParticipant[] } => ({
  cid: 0,
  participants: uids.map((uid) => ({ uid, muted: true })),
});

let server: FakeServer;
let mic: FakeTrack;
/** Where a test holds the next capture from coming back. */
let captured: Promise<void>;
let logged: string[];
let errors: string[];

beforeEach(() => {
  server = installFakeWire();
  server.on('login', () => ({ ok: loginOk() }));
  // The room as the joiner found it: the joiner is in the status after.
  server.on('voice_join', () => ({
    ok: { sdp: 'v=0', codec: 'opus', participants: [{ uid: BOB, muted: false }] },
  }));
  server.on('voice_answer', () => ({ ok: {} }));
  server.on('voice_mute', () => ({ ok: {} }));
  server.on('voice_leave', () => ({ ok: {} }));
  Object.assign(globalThis.window, { isSecureContext: true });
  captured = Promise.resolve();
  vi.stubGlobal('navigator', {
    mediaDevices: {
      // A microphone of its own each time, as a browser hands out.
      getUserMedia: async () => {
        await captured;
        mic = new FakeTrack();
        return new FakeStream([mic]);
      },
    },
  });
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  FakePeerConnection.made = [];
  FakePeerConnection.offered = Promise.resolve();
  logged = [];
  errors = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  uninstallFakeWire();
});

async function session(): Promise<VoiceSession> {
  const conn = new Connection({ url: 'ws://test/ng', login: 'alice', password: 'pw', nick: 'Alice', icon: 128 }, {});
  await conn.start();
  return new VoiceSession(conn, {
    onLog: (text, bad) => (bad ? errors : logged).push(text),
    onRoom: () => {},
    onControls: () => {},
    onRemoteVideo: () => {},
    onRemoteVideoEnded: () => {},
    onLocalVideo: () => {},
  });
}

async function joined(): Promise<VoiceSession> {
  const voice = await session();
  await voice.join();
  return voice;
}

/** A reply the test sends when it chooses, as the server answering after
 *  the move it has just made. */
function held(): { reply: Promise<Reply>; refuse: () => void; answer: (ok: unknown) => void } {
  let resolve: (r: Reply) => void = () => {};
  const reply = new Promise<Reply>((r) => (resolve = r));
  return {
    reply,
    refuse: () => resolve({ error: { code: 'not_in_voice', text: 'You are not in voice.' } }),
    answer: (ok) => resolve({ ok }),
  };
}

const JOIN_OK = { sdp: 'v=0', codec: 'opus', participants: [{ uid: BOB, muted: false }] };

describe('a voice_status without this session', () => {
  it('after one with it, is the person moved to another device: media torn down, no leave sent', async () => {
    const voice = await joined();
    server.event('voice_status', status(SELF, BOB));
    await settle();
    expect(voice.joined).toBe(true);

    server.event('voice_status', status(BOB));
    await settle();
    expect(voice.joined).toBe(false);
    expect(mic.stopped).toBe(true);
    expect(FakePeerConnection.made[0]?.closed).toBe(true);
    expect(server.sent('voice_leave')).toEqual([]);
    expect(logged).toContain('voice ended here: another of your devices took it over, or the server ended it');
    expect(errors).toEqual([]);
  });

  it('with an answer in flight, ends voice without a media error', async () => {
    const voice = await joined();
    server.event('voice_status', status(SELF, BOB));
    const answer = held();
    server.on('voice_answer', () => answer.reply);
    server.event('voice_offer', { cid: 0, sdp: 'v=0' });
    await settle();
    expect(server.sent('voice_answer')).toHaveLength(2);

    server.event('voice_status', status(BOB));
    await settle();
    answer.refuse();
    await settle();
    expect(voice.joined).toBe(false);
    expect(errors).toEqual([]);
  });

  it('with an offer being taken, sends no answer for it', async () => {
    const voice = await joined();
    server.event('voice_status', status(SELF, BOB));
    let take = (): void => {};
    FakePeerConnection.offered = new Promise((resolve) => (take = resolve));
    server.event('voice_offer', { cid: 0, sdp: 'v=0' });
    await settle();

    server.event('voice_status', status(BOB));
    await settle();
    take();
    await settle();
    expect(voice.joined).toBe(false);
    expect(server.sent('voice_answer')).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('with the join still muting, ends voice and the join resolves', async () => {
    const voice = await session();
    const mute = held();
    server.on('voice_mute', () => mute.reply);
    const join = voice.join();
    await settle();
    expect(server.sent('voice_mute')).toHaveLength(1);

    server.event('voice_status', status(SELF, BOB));
    server.event('voice_status', status(BOB));
    await settle();
    mute.refuse();
    await expect(join).resolves.toBeUndefined();
    expect(voice.joined).toBe(false);
    expect(errors).toEqual([]);
  });

  it('after a rejoin, is again the room before the join until one lists it', async () => {
    const voice = await joined();
    server.event('voice_status', status(SELF, BOB));
    server.event('voice_status', status(BOB));
    await settle();
    expect(voice.joined).toBe(false);

    await voice.join();
    server.event('voice_status', status(BOB));
    await settle();
    expect(voice.joined).toBe(true);
  });

  it('is not a mute flip of this session', async () => {
    const voice = await joined();
    server.event('voice_status', status(SELF, BOB));
    server.event('voice_status', { cid: 0, participants: [{ uid: SELF, muted: false }, { uid: BOB, muted: true }] });
    await settle();
    expect(voice.joined).toBe(true);
    expect(voice.inVoice(SELF)?.muted).toBe(false);
  });

  it('before one with it, is the room before the join: still joined', async () => {
    // A join while the server still had this session in voice takes it
    // out first, and the status saying so follows the join's reply.
    const voice = await joined();
    server.event('voice_status', status(BOB));
    await settle();
    expect(voice.joined).toBe(true);
    expect(mic.stopped).toBe(false);

    server.event('voice_status', status(SELF, BOB));
    await settle();
    expect(voice.joined).toBe(true);
    expect(voice.inVoice(SELF)).toBeDefined();
  });

  it('for another room, is not about this one', async () => {
    const voice = await joined();
    server.event('voice_status', status(SELF, BOB));
    server.event('voice_status', { cid: 7, participants: [] });
    await settle();
    expect(voice.joined).toBe(true);
  });
});

describe('work begun before a teardown', () => {
  it('a capture that comes back after it is stopped and joins nothing', async () => {
    const voice = await session();
    let give = (): void => {};
    captured = new Promise((resolve) => (give = resolve));
    const join = voice.join();
    await settle();
    voice.teardown();
    give();
    await expect(join).resolves.toBeUndefined();
    expect(mic.stopped).toBe(true);
    expect(server.sent('voice_join')).toEqual([]);
    expect(voice.joined).toBe(false);
  });

  it('a join answered after it is not joined', async () => {
    const voice = await session();
    const reply = held();
    server.on('voice_join', () => reply.reply);
    const join = voice.join();
    await settle();
    voice.teardown();
    reply.answer(JOIN_OK);
    await expect(join).resolves.toBeUndefined();
    expect(voice.joined).toBe(false);
    expect(server.sent('voice_answer')).toEqual([]);
  });

  it('a join refused after it leaves the join that replaced it alone', async () => {
    const voice = await session();
    const first = held();
    server.on('voice_join', () => first.reply);
    const stale = voice.join();
    await settle();
    voice.teardown();
    server.on('voice_join', () => ({ ok: JOIN_OK }));
    await voice.join();
    first.refuse();
    await expect(stale).resolves.toBeUndefined();
    expect(voice.joined).toBe(true);
    expect(mic.stopped).toBe(false);
  });

  it('a mute answered after it leaves the session that replaced it as it was', async () => {
    const voice = await joined();
    const reply = held();
    server.on('voice_mute', () => reply.reply);
    const unmute = voice.setMuted(false);
    await settle();
    voice.teardown();
    server.on('voice_mute', () => ({ ok: {} }));
    await voice.join();
    reply.answer({});
    await unmute;
    expect(voice.muted).toBe(true);
    expect(mic.enabled).toBe(false);
  });

  it('an offer queued before it is never answered on the connection after it', async () => {
    const voice = await joined();
    let take = (): void => {};
    FakePeerConnection.offered = new Promise((resolve) => (take = resolve));
    server.event('voice_offer', { cid: 0, sdp: 'v=0 in flight' });
    server.event('voice_offer', { cid: 0, sdp: 'v=0 queued' });
    await settle();
    FakePeerConnection.offered = Promise.resolve();
    voice.teardown();
    await voice.join();
    take();
    await settle();
    expect(FakePeerConnection.made[1]?.remoteDescription).toEqual({ type: 'offer', sdp: 'v=0' });
    expect(server.sent('voice_answer')).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});
