import { describe, expect, it } from 'vitest';

import { IdentityError, bytesToBase64url } from '@hotline-ng/client';

import { parseScanFragment } from '../src/identity/scan';
import vectors from '../packages/hotline-ng/test/identity-vectors.json';

const IDENTITY = vectors.keys.identity.fingerprint;
const SECRET = bytesToBase64url(new Uint8Array(16).fill(0x5a));

const fragment = (over: Partial<Record<string, string>> = {}) => {
  const fields: Record<string, string> = {
    enroll: 'K7PM-4XWE',
    mailbox: 'hl.example',
    identity: IDENTITY,
    pair: SECRET,
    ...over,
  };
  return '#' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('&');
};

describe('parseScanFragment', () => {
  it('reads the four fields a QR code carries', () => {
    const s = parseScanFragment(fragment())!;
    expect(s.code).toBe('K7PM-4XWE');
    expect(s.mailbox).toBe('hl.example');
    expect(s.identity).toBe(IDENTITY);
    expect(s.pairingSecret).toEqual(new Uint8Array(16).fill(0x5a));
  });

  it('is null for a page nobody scanned', () => {
    // The ordinary case: a fragment with no `enroll` is not this
    // client's business, and neither is no fragment at all.
    expect(parseScanFragment('')).toBeNull();
    expect(parseScanFragment('#')).toBeNull();
    expect(parseScanFragment('#debug')).toBeNull();
  });

  it('refuses an enrollment link that is missing any of the other three', () => {
    // Degrading to the typed path would silently drop the pinned
    // identity and the pairing proof — turning the stronger ceremony
    // into the weaker one without telling anyone.
    for (const missing of ['mailbox', 'identity', 'pair']) {
      const f = fragment();
      const stripped = f
        .split('&')
        .filter((kv) => !kv.startsWith(`${missing}=`) && !kv.startsWith(`#${missing}=`))
        .join('&');
      expect(() => parseScanFragment(stripped), missing).toThrow(IdentityError);
    }
  });

  it('refuses a malformed identity or pairing secret', () => {
    expect(() => parseScanFragment(fragment({ identity: 'nope' }))).toThrow(/malformed identity/);
    // Crockford excludes i, l, o and u, so a fingerprint carrying one
    // did not come from a `Fingerprint`.
    expect(() => parseScanFragment(fragment({ identity: 'i'.repeat(52) }))).toThrow(/malformed identity/);
    expect(() => parseScanFragment(fragment({ pair: '!!!!' }))).toThrow(/pairing secret/);
    // Right shape, wrong size — 15 bytes is not 16, and a short secret
    // is the thing §5.6 explicitly refuses.
    expect(() => parseScanFragment(fragment({ pair: bytesToBase64url(new Uint8Array(15)) }))).toThrow(
      /wrong size/,
    );
  });
});
