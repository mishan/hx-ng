import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  errorText,
  isEvent,
  isFingerprint,
  isReply,
  newGuid,
  parseRecvMid,
  sendMid,
  type ServerFrame,
} from '../src/protocol';

describe('frame discrimination', () => {
  it('tells the three envelopes apart by their first key', () => {
    const reply: ServerFrame = { reply: 7, ok: {} };
    const event: ServerFrame = { seq: 1, ev: 'chat', data: {} };
    expect(isReply(reply)).toBe(true);
    expect(isEvent(reply)).toBe(false);
    expect(isEvent(event)).toBe(true);
    expect(isReply(event)).toBe(false);
  });

  it('reads a reply to id 0, which the handshake uses', () => {
    // `reply: 0` is falsy, and the check is deliberately `!== undefined`.
    expect(isReply({ reply: 0, ok: {} })).toBe(true);
  });

  it('reads seq 0, for the same reason', () => {
    expect(isEvent({ seq: 0, ev: 'x', data: {} })).toBe(true);
  });
});

describe('errorText', () => {
  it('prefers wording a person can act on', () => {
    expect(errorText({ code: 'mailbox_full', text: "That user's mailbox is full." })).toMatch(
      /full/,
    );
    expect(errorText({ code: 'login_failed', text: 'Login failed.' })).toBe(
      'That account and password did not match.',
    );
  });

  it('falls back to the server’s own text for codes it does not know', () => {
    expect(errorText({ code: 'something_new', text: 'A server said this.' })).toBe(
      'A server said this.',
    );
  });

  it('falls back to the code when there is no text at all', () => {
    expect(errorText({ code: 'something_new', text: '' })).toBe('something_new');
  });

  it('covers every code the message requests can answer with', () => {
    // docs/hotline-ng.md §7: the closed set for the msg/inbox family.
    for (const code of ['no_such_user', 'no_inbox', 'mailbox_full', 'blocked', 'server_error']) {
      expect(errorText({ code, text: '' })).not.toBe(code);
    }
  });
});

describe('newGuid', () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  afterEach(() => vi.unstubAllGlobals());

  it('produces a v4 uuid', () => {
    expect(newGuid()).toMatch(UUID_V4);
  });

  it('is not the same twice', () => {
    expect(new Set(Array.from({ length: 64 }, newGuid)).size).toBe(64);
  });

  it('falls back to getRandomValues where randomUUID is missing', () => {
    // `crypto.randomUUID` is [SecureContext], so it is absent on the
    // plain-http LAN address this client is reached at from a phone
    // during development. `getRandomValues` carries no such restriction.
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    const id = newGuid();
    expect(id).toMatch(UUID_V4);
    // The version and variant bits are set by hand on that path.
    expect(id[14]).toBe('4');
    expect('89ab').toContain(id[19]);
  });

  it('says so plainly when there is no CSPRNG at all', () => {
    // A guid picked without one would be worse than none: a collision is
    // one person's message deduplicated against another's.
    vi.stubGlobal('crypto', undefined);
    expect(() => newGuid()).toThrow(/Web Crypto/);
  });
});

describe('video mids', () => {
  it('names the section a publication is sent on', () => {
    expect(sendMid('camera')).toBe('cam-send');
    expect(sendMid('screen')).toBe('scr-send');
  });

  it('reads an inbound mid back into the publication it carries', () => {
    expect(parseRecvMid('cam-user-12')).toEqual({ uid: 12, kind: 'camera' });
    expect(parseRecvMid('scr-user-23')).toEqual({ uid: 23, kind: 'screen' });
  });

  it('returns null for anything else, including our own send sections', () => {
    for (const mid of ['send', 'cam-send', 'scr-send', 'cam-user-0', 'aud-user-1', '']) {
      expect(parseRecvMid(mid)).toBeNull();
    }
  });
});

describe('isFingerprint', () => {
  const fp = 'a'.repeat(52);

  it('recognises the 52-character displayed form', () => {
    expect(isFingerprint(fp)).toBe(true);
  });

  it('recognises one that has been shouted', () => {
    // The server's parser lowercases before decoding, so an uppercase
    // fingerprint is a fingerprint. Rejecting it here sent it as a login
    // and got `no_such_user` for something perfectly valid.
    expect(isFingerprint(fp.toUpperCase())).toBe(true);
    expect(isFingerprint('6HTGZ65' + 'b'.repeat(45))).toBe(true);
  });

  it('does not mistake an account name for one', () => {
    for (const login of ['alice', 'guest', '', 'a'.repeat(51), 'a'.repeat(53)]) {
      expect(isFingerprint(login)).toBe(false);
    }
  });

  it('rejects 52 characters that could not be base32 at all', () => {
    expect(isFingerprint('!'.repeat(52))).toBe(false);
    expect(isFingerprint('a'.repeat(51) + '-')).toBe(false);
  });
});
