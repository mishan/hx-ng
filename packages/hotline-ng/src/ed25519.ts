/**
 * Ed25519 verification, in script, by the one strict rule hxd-ng's
 * `docs/e2e-messages.md` §3.1 gives every implementation: hl-identity's
 * `verify_domain`, which is ed25519-dalek's `verify_strict` behind a
 * check of the key. WebCrypto does not promise that rule, and engines
 * differ (Chromium's and Firefox's accept a small-order key, the neutral
 * element among them, which signs anything with S = 0), so every verify
 * in this package comes here, Node included, and gives one answer
 * everywhere. Signing stays in WebCrypto, where the key is.
 *
 * Verify-only, on public data, so nothing here tries to be constant
 * time. Arithmetic is RFC 8032 §5.1 over BigInt; SHA-512 is WebCrypto's.
 */

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
/** -121665/121666 mod p (RFC 8032 §5.1). */
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
/** 2^((p-1)/4) mod p, a square root of -1 (RFC 8032 §5.1.3). */
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;

/** Extended homogeneous coordinates (RFC 8032 §5.1.4): x = X/Z, y = Y/Z,
 *  x·y = T/Z. */
interface Point {
  X: bigint;
  Y: bigint;
  Z: bigint;
  T: bigint;
}

const IDENTITY: Point = { X: 0n, Y: 1n, Z: 1n, T: 0n };

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  for (b = mod(b); e > 0n; e >>= 1n, b = (b * b) % P) {
    if (e & 1n) r = (r * b) % P;
  }
  return r;
}

const inv = (a: bigint) => pow(a, P - 2n);

function add(p: Point, q: Point): Point {
  const a = mod((p.Y - p.X) * (q.Y - q.X));
  const b = mod((p.Y + p.X) * (q.Y + q.X));
  const c = mod(2n * D * mod(p.T * q.T));
  const d = mod(2n * p.Z * q.Z);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return { X: mod(e * f), Y: mod(g * h), Z: mod(f * g), T: mod(e * h) };
}

function double(p: Point): Point {
  const a = mod(p.X * p.X);
  const b = mod(p.Y * p.Y);
  const c = mod(2n * p.Z * p.Z);
  const h = a + b;
  const e = h - mod((p.X + p.Y) * (p.X + p.Y));
  const g = a - b;
  const f = c + g;
  return { X: mod(e * f), Y: mod(g * h), Z: mod(f * g), T: mod(e * h) };
}

const negate = (p: Point): Point => ({ X: mod(-p.X), Y: p.Y, Z: p.Z, T: mod(-p.T) });

function isIdentity(p: Point): boolean {
  return p.X === 0n && p.Y === p.Z;
}

/** A point is of small order when its order divides the cofactor 8. */
function isSmallOrder(p: Point): boolean {
  return isIdentity(double(double(double(p))));
}

function leUint(b: Uint8Array): bigint {
  return b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
}

/** RFC 8032 §5.1.2. */
function encode(p: Point): Uint8Array {
  const zi = inv(p.Z);
  const x = mod(p.X * zi);
  const y = mod(p.Y * zi) | ((x & 1n) << 255n);
  return Uint8Array.from({ length: 32 }, (_, i) => Number((y >> BigInt(8 * i)) & 0xffn));
}

/** RFC 8032 §5.1.3, which already refuses both non-canonical encodings
 *  (y >= p, and the sign bit set on x = 0). dalek's decompression takes
 *  both, but `verify_domain` then refuses a key that does not re-encode
 *  to its own bytes, and `verify_strict` compares R by its bytes, so
 *  refusing them here gives the same answers. */
function decode(b: Uint8Array): Point | null {
  if (b.length !== 32) return null;
  const n = leUint(b);
  const y = n & ((1n << 255n) - 1n);
  const sign = n >> 255n;
  if (y >= P) return null;
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === mod(-u)) x = mod(x * SQRT_M1);
  else if (vx2 !== u) return null;
  if (x === 0n && sign === 1n) return null;
  if ((x & 1n) !== sign) x = P - x;
  return { X: x, Y: y, Z: 1n, T: mod(x * y) };
}

/** [0]P to [15]P, for a 4-bit window. */
function multiples(p: Point): Point[] {
  const t = [IDENTITY, p];
  for (let i = 2; i < 16; i++) t.push(add(t[i - 1]!, p));
  return t;
}

let baseTable: Point[] | undefined;

function base(): Point[] {
  // B is the point with y = 4/5 and x even (RFC 8032 §5.1), so its
  // encoding is 0x58 then 0x66s.
  baseTable ??= multiples(decode(Uint8Array.of(0x58, ...new Array<number>(31).fill(0x66)))!);
  return baseTable;
}

/** [a]P + [b]Q, both scalars below 2^256, by Straus's method: one chain
 *  of doublings shared by both, a 4-bit window from each table. */
function doubleMul(a: bigint, tp: Point[], b: bigint, tq: Point[]): Point {
  let r = IDENTITY;
  for (let i = 252; i >= 0; i -= 4) {
    r = double(double(double(double(r))));
    const ia = Number((a >> BigInt(i)) & 15n);
    const ib = Number((b >> BigInt(i)) & 15n);
    if (ia) r = add(r, tp[ia]!);
    if (ib) r = add(r, tq[ib]!);
  }
  return r;
}

/** A public key `verify_domain` takes: a point, canonically encoded, and
 *  not of small order. */
export function isStrongKey(publicKey: Uint8Array): boolean {
  const A = decode(publicKey);
  return A !== null && !isSmallOrder(A);
}

/** `verify_strict`: S < L, neither A nor R of small order, and the
 *  cofactorless [S]B = R + [k]A (RFC 8032 §5.1.7 without its factor of
 *  8), checked as the encoding of [S]B - [k]A against R's bytes. */
export async function verifyStrict(publicKey: Uint8Array, message: Uint8Array, sig: Uint8Array): Promise<boolean> {
  if (sig.length !== 64) return false;
  const A = decode(publicKey);
  const R = decode(sig.subarray(0, 32));
  const S = leUint(sig.subarray(32));
  if (!A || !R || S >= L || isSmallOrder(A) || isSmallOrder(R)) return false;
  const hashed = new Uint8Array(64 + message.length);
  hashed.set(sig.subarray(0, 32));
  hashed.set(publicKey, 32);
  hashed.set(message, 64);
  const k = leUint(new Uint8Array(await crypto.subtle.digest('SHA-512', hashed))) % L;
  const encoded = encode(doubleMul(S, base(), k, multiples(negate(A))));
  return encoded.every((x, i) => x === sig[i]);
}
