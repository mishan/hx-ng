/** Read-only Files wire shapes (`hxd-ng` docs/hotline-ng.md §7.2). */

export type FileKind = 'file' | 'folder';
export type DecimalU64 = string;

export interface FileEntry {
  name: string;
  kind: FileKind;
  /** Decimal u64; use `parseDecimalU64`, never `Number`. */
  size: DecimalU64;
  media_type?: string | null;
  modified?: number | null;
}

export interface FilesListOk {
  path: string;
  entries: FileEntry[];
}

export interface FileInfo extends FileEntry {
  path: string;
  created?: number | null;
  comment?: string | null;
}

export interface FileDownloadOk {
  /** Same-server, short-lived bearer URL. */
  url: string;
  size: DecimalU64;
  media_type?: string | null;
}

export interface FileFetchOptions {
  /** Open-ended byte-range start. Zero is meaningful and produces 206. */
  offset?: bigint;
  signal?: AbortSignal;
}

const U64_MAX = 18_446_744_073_709_551_615n;

/** Parse the wire's exact decimal-u64 representation. */
export function parseDecimalU64(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RangeError('not a decimal u64');
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new RangeError('decimal value exceeds u64');
  return parsed;
}

/** Produce the only representation accepted for a u64 request value. */
export function decimalU64(value: bigint): DecimalU64 {
  if (value < 0n || value > U64_MAX) throw new RangeError('value is outside u64');
  return value.toString(10);
}

/** Exact, localized display without first rounding through `number`. */
export function formatFileSize(value: bigint): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] as const;
  let unit = 0;
  let divisor = 1n;
  while (unit < units.length - 1 && value >= divisor * 1024n) {
    divisor *= 1024n;
    unit++;
  }
  if (unit === 0) return `${value.toLocaleString()} ${value === 1n ? 'byte' : 'bytes'}`;
  const tenths = (value * 10n + divisor / 2n) / divisor;
  return `${tenths / 10n}.${tenths % 10n} ${units[unit]}`;
}
