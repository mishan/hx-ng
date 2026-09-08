import { describe, expect, it } from 'vitest';

import { CborError, cArray, cBytes, cMap, cText, cUint, decodeCanonical, encode, mapGet, mapWithout } from '../src/cbor';

function hex(b: Uint8Array): string {
  return [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

describe('encode', () => {
  it('uses the shortest head for each integer', () => {
    expect(hex(encode(cUint(0)))).toBe('00');
    expect(hex(encode(cUint(23)))).toBe('17');
    expect(hex(encode(cUint(24)))).toBe('1818');
    expect(hex(encode(cUint(256)))).toBe('190100');
    expect(hex(encode(cUint(1n << 32n)))).toBe('1b0000000100000000');
  });

  it('sorts map keys by their encoded bytes, length first', () => {
    // "z" (one byte head + 1) sorts before "aa" (one byte head + 2).
    const v = cMap([
      ['aa', cUint(1)],
      ['z', cUint(2)],
    ]);
    expect(hex(encode(v))).toBe('a2617a0262616101');
  });

  it('round-trips byte strings, text, and arrays', () => {
    const v = cArray([cBytes(Uint8Array.of(1, 2, 3)), cText('hi'), cUint(5)]);
    const bytes = encode(v);
    expect(decodeCanonical(bytes)).toEqual(v);
  });
});

describe('decodeCanonical', () => {
  it('rejects a non-shortest integer head', () => {
    expect(() => decodeCanonical(Uint8Array.of(0x18, 0x01))).toThrow(CborError);
  });

  it('rejects map keys out of order', () => {
    const bytes = Uint8Array.of(0xa2, 0x62, 0x61, 0x61, 0x01, 0x61, 0x7a, 0x02);
    expect(() => decodeCanonical(bytes)).toThrow(CborError);
  });

  it('rejects duplicate map keys even though they re-encode identically', () => {
    const bytes = Uint8Array.of(0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02);
    try {
      decodeCanonical(bytes);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CborError);
      expect((e as CborError).kind).toBe('not-canonical');
    }
  });

  it('rejects trailing bytes after the top-level item', () => {
    expect(() => decodeCanonical(Uint8Array.of(0x00, 0x00))).toThrow(CborError);
  });

  it('rejects an unsupported major type (a negative integer)', () => {
    try {
      decodeCanonical(Uint8Array.of(0x20));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CborError);
      expect((e as CborError).kind).toBe('unsupported');
    }
  });
});

describe('mapGet / mapWithout', () => {
  it('finds a text key, and treats a missing one the same as a non-map', () => {
    const v = cMap([['a', cUint(1)]]);
    expect(mapGet(v, 'a')).toEqual(cUint(1));
    expect(mapGet(v, 'b')).toBeUndefined();
    expect(mapGet(cUint(1), 'a')).toBeUndefined();
  });

  it('drops exactly the named key, which is how signed bytes are produced', () => {
    const v = cMap([
      ['a', cUint(1)],
      ['sig', cBytes(Uint8Array.of(9, 9))],
    ]);
    expect(encode(mapWithout(v, 'sig'))).toEqual(encode(cMap([['a', cUint(1)]])));
  });
});
