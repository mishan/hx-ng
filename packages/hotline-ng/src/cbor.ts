/**
 * The CBOR subset the identity objects use (RFC 8949 §4.2.1 deterministic
 * encoding), byte-for-byte compatible with hxd-ng's
 * `crates/hl-identity/src/cbor.rs` — checked against that file directly,
 * not just against the prose in `docs/hotline-ng-identity.md`.
 *
 * Five major types: unsigned integer, byte string, text string, array,
 * map. `decodeCanonical` is the only decoder exported, and it works the
 * way the Rust one does: decode leniently, then re-encode, and require
 * the re-encoding to match the input byte-for-byte. That single
 * comparison rules out non-shortest integer heads, indefinite lengths and
 * out-of-order map keys all at once — a signature is only meaningful over
 * bytes with exactly one valid encoding. A separate pass catches
 * duplicate map keys, which re-encode to identical bytes and so survive
 * the comparison on their own.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export type CborValue =
  | { readonly t: 'uint'; readonly v: bigint }
  | { readonly t: 'bytes'; readonly v: Uint8Array }
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'array'; readonly v: readonly CborValue[] }
  | { readonly t: 'map'; readonly v: readonly (readonly [CborValue, CborValue])[] };

export function cUint(n: number | bigint): CborValue {
  const v = typeof n === 'bigint' ? n : BigInt(n);
  if (v < 0n) throw new RangeError('a CBOR uint must not be negative');
  return { t: 'uint', v };
}
export function cBytes(v: Uint8Array): CborValue {
  return { t: 'bytes', v };
}
export function cText(v: string): CborValue {
  return { t: 'text', v };
}
export function cArray(v: readonly CborValue[]): CborValue {
  return { t: 'array', v };
}
export function cMap(entries: readonly (readonly [string, CborValue])[]): CborValue {
  return { t: 'map', v: entries.map(([k, val]) => [cText(k), val] as const) };
}

/** Build a map from text keys, dropping any entry whose value is
 *  `undefined` — how an optional field stays out of the encoding. The
 *  twin of `hl-identity`'s `cbor::map`, which takes `Option<Value>` for
 *  the same reason. */
export function cOptMap(entries: readonly (readonly [string, CborValue | undefined])[]): CborValue {
  const out: [string, CborValue][] = [];
  for (const [k, v] of entries) if (v !== undefined) out.push([k, v]);
  return cMap(out);
}

/** Look up a text key in a map. `undefined` for a missing key *or* a
 *  non-map — callers treat both as "field absent". */
export function mapGet(v: CborValue, key: string): CborValue | undefined {
  if (v.t !== 'map') return undefined;
  for (const [k, val] of v.v) if (k.t === 'text' && k.v === key) return val;
  return undefined;
}

/** The same map with one text key removed — how the signed bytes (the
 *  object without its `sig`) are produced. */
export function mapWithout(v: CborValue, key: string): CborValue {
  if (v.t !== 'map') return v;
  return { t: 'map', v: v.v.filter(([k]) => !(k.t === 'text' && k.v === key)) };
}

export type CborErrorKind =
  | 'truncated'
  | 'trailing'
  | 'unsupported'
  | 'utf8'
  | 'too-deep'
  | 'not-canonical';

export class CborError extends Error {
  constructor(
    readonly kind: CborErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CborError';
  }
}

// --- encode ---------------------------------------------------------------

function putHead(out: number[], major: number, n: bigint): void {
  const mt = major << 5;
  if (n < 24n) {
    out.push(mt | Number(n));
  } else if (n <= 0xffn) {
    out.push(mt | 24, Number(n));
  } else if (n <= 0xffffn) {
    out.push(mt | 25, Number((n >> 8n) & 0xffn), Number(n & 0xffn));
  } else if (n <= 0xffffffffn) {
    out.push(mt | 26);
    for (const shift of [24n, 16n, 8n, 0n]) out.push(Number((n >> shift) & 0xffn));
  } else {
    out.push(mt | 27);
    for (const shift of [56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n]) out.push(Number((n >> shift) & 0xffn));
  }
}

function compareBytes(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function encodeInto(v: CborValue, out: number[]): void {
  switch (v.t) {
    case 'uint':
      putHead(out, 0, v.v);
      return;
    case 'bytes':
      putHead(out, 2, BigInt(v.v.length));
      for (const b of v.v) out.push(b);
      return;
    case 'text': {
      const bytes = textEncoder.encode(v.v);
      putHead(out, 3, BigInt(bytes.length));
      for (const b of bytes) out.push(b);
      return;
    }
    case 'array':
      putHead(out, 4, BigInt(v.v.length));
      for (const item of v.v) encodeInto(item, out);
      return;
    case 'map': {
      // Sort by the encoded key bytes — the §4.2.1 rule. Keys are
      // encoded once here and reused, so sorting doesn't re-encode.
      const encoded = v.v.map(([k, val]) => {
        const kb: number[] = [];
        encodeInto(k, kb);
        return { kb, val };
      });
      encoded.sort((a, b) => compareBytes(a.kb, b.kb));
      putHead(out, 5, BigInt(encoded.length));
      for (const { kb, val } of encoded) {
        out.push(...kb);
        encodeInto(val, out);
      }
      return;
    }
  }
}

/** Encode a value in deterministic form. */
export function encode(v: CborValue): Uint8Array {
  const out: number[] = [];
  encodeInto(v, out);
  return Uint8Array.from(out);
}

// --- decode -----------------------------------------------------------

const MAX_DEPTH = 8;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Structural equality over decoded values — used only to find duplicate
 *  map keys after the canonical-order check has already passed. */
function cborEquals(a: CborValue, b: CborValue): boolean {
  if (a.t !== b.t) return false;
  if (a.t === 'uint' && b.t === 'uint') return a.v === b.v;
  if (a.t === 'text' && b.t === 'text') return a.v === b.v;
  if (a.t === 'bytes' && b.t === 'bytes') return bytesEqual(a.v, b.v);
  if (a.t === 'array' && b.t === 'array') {
    return a.v.length === b.v.length && a.v.every((x, i) => cborEquals(x, b.v[i]!));
  }
  if (a.t === 'map' && b.t === 'map') {
    return (
      a.v.length === b.v.length &&
      a.v.every(([k, val], i) => cborEquals(k, b.v[i]![0]) && cborEquals(val, b.v[i]![1]))
    );
  }
  return false;
}

/** Sorted maps put duplicates side by side, so one pass over each map's
 *  adjacent key pairs finds them — valid only once the canonical-order
 *  check above has already passed. */
function hasDuplicateKeys(v: CborValue): boolean {
  if (v.t === 'map') {
    for (let i = 1; i < v.v.length; i++) {
      if (cborEquals(v.v[i]![0]!, v.v[i - 1]![0]!)) return true;
    }
    return v.v.some(([k, val]) => hasDuplicateKeys(k) || hasDuplicateKeys(val));
  }
  if (v.t === 'array') return v.v.some(hasDuplicateKeys);
  return false;
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  private byte(): number {
    if (this.pos >= this.buf.length) throw new CborError('truncated', 'truncated CBOR');
    return this.buf[this.pos++]!;
  }

  private take(n: number): Uint8Array {
    const end = this.pos + n;
    if (end > this.buf.length) throw new CborError('truncated', 'truncated CBOR');
    const s = this.buf.subarray(this.pos, end);
    this.pos = end;
    return s;
  }

  /** A length large enough to need this many bytes of input can't be
   *  honest; refuse before allocating anything sized by it. */
  private length(n: bigint): number {
    if (n > BigInt(this.buf.length)) throw new CborError('truncated', 'truncated CBOR');
    return Number(n);
  }

  private head(): { major: number; n: bigint } {
    const b = this.byte();
    const major = b >> 5;
    const ai = b & 0x1f;
    let n: bigint;
    if (ai <= 23) n = BigInt(ai);
    else if (ai === 24) n = BigInt(this.byte());
    else if (ai === 25) n = bytesToBigInt(this.take(2));
    else if (ai === 26) n = bytesToBigInt(this.take(4));
    else if (ai === 27) n = bytesToBigInt(this.take(8));
    else throw new CborError('unsupported', `unsupported CBOR head byte 0x${b.toString(16).padStart(2, '0')}`);
    return { major, n };
  }

  item(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new CborError('too-deep', 'CBOR nesting too deep');
    const start = this.pos;
    const { major, n } = this.head();
    switch (major) {
      case 0:
        return cUint(n);
      case 2:
        return cBytes(Uint8Array.from(this.take(this.length(n))));
      case 3: {
        const bytes = this.take(this.length(n));
        try {
          return cText(textDecoder.decode(bytes));
        } catch {
          throw new CborError('utf8', 'CBOR text string is not UTF-8');
        }
      }
      case 4: {
        const count = this.length(n);
        if (count > this.buf.length - this.pos) throw new CborError('truncated', 'truncated CBOR');
        const items: CborValue[] = [];
        for (let i = 0; i < count; i++) items.push(this.item(depth + 1));
        return cArray(items);
      }
      case 5: {
        const count = this.length(n);
        if (count > (this.buf.length - this.pos) / 2) throw new CborError('truncated', 'truncated CBOR');
        const entries: [CborValue, CborValue][] = [];
        for (let i = 0; i < count; i++) {
          const k = this.item(depth + 1);
          const val = this.item(depth + 1);
          entries.push([k, val]);
        }
        return { t: 'map', v: entries };
      }
      default:
        throw new CborError('unsupported', `unsupported CBOR head byte 0x${this.buf[start]!.toString(16).padStart(2, '0')}`);
    }
  }
}

/**
 * Decode one item, requiring the input to be exactly its deterministic
 * encoding. This is the only decoder this module exports: an object that
 * isn't canonical has no signature worth checking.
 */
export function decodeCanonical(bytes: Uint8Array): CborValue {
  const r = new Reader(bytes);
  const v = r.item(0);
  if (r.pos !== bytes.length) throw new CborError('trailing', 'trailing bytes after CBOR item');
  if (!bytesEqual(encode(v), bytes)) {
    throw new CborError('not-canonical', 'CBOR is not in deterministic encoding');
  }
  if (hasDuplicateKeys(v)) {
    throw new CborError('not-canonical', 'CBOR is not in deterministic encoding');
  }
  return v;
}
