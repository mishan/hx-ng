/** Files wire shapes (`hxd-ng` docs/hotline-ng.md §7.2). */

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
  /** Whether `files_upload` would take a file into this folder; absent
   *  from a server without uploads. */
  uploadable?: boolean;
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

/** What `files_preview` serves: an image the server has drawn again, the
 *  start of a text as UTF-8, or a video, which is the file itself,
 *  streamed in ranges as a player asks for it. */
export type FilePreviewKind = 'image' | 'text' | 'video';

export interface FilePreviewOk {
  kind: FilePreviewKind;
  /** Same-server bearer URL, as a download's; a video's lasts an hour
   *  from each fetch. */
  url: string;
  media_type: string;
  /** The file's, not the preview's. */
  size: DecimalU64;
  /** A text shown only from its start. */
  truncated: boolean;
  /** An image's, as drawn. */
  width?: number;
  height?: number;
}

/** `files_upload`'s answer (`hxd-ng` docs/ng-uploads.md). */
export interface FileUploadOk {
  /** Same-server bearer URL the pieces are `PUT` to. */
  url: string;
  /** Where the first piece starts: past what the server already holds of
   *  this file, when this account left part of it. */
  offset: DecimalU64;
  /** The most one piece may carry. */
  piece: DecimalU64;
  /** The Large File resume digest of the part the server holds, as hex. */
  digest?: string;
}

/** The Large File resume digest (fogWraith Capabilities-Large-File.md)
 *  of `file` at `offset`, as hex: the window's length, then SHA-256 of the
 *  offset and the window, the 64 KiB before `offset` or all of it. */
export async function resumeDigest(file: Blob, offset: bigint): Promise<string> {
  const windowLen = offset < 65_536n ? offset : 65_536n;
  const window = new Uint8Array(
    await file.slice(Number(offset - windowLen), Number(offset)).arrayBuffer(),
  );
  const hashed = new Uint8Array(8 + window.length);
  new DataView(hashed.buffer).setBigUint64(0, offset);
  hashed.set(window, 8);
  const digest = new Uint8Array(40);
  new DataView(digest.buffer).setBigUint64(0, windowLen);
  digest.set(new Uint8Array(await crypto.subtle.digest('SHA-256', hashed)), 8);
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The changes to the file area, by the access bit each needs. */
export const FILES_ACTS = [
  'create_folders',
  'delete_files',
  'delete_folders',
  'rename_files',
  'rename_folders',
  'move_files',
  'move_folders',
  'comment_files',
  'comment_folders',
  'upload_files',
  'upload_anywhere',
] as const;
export type FilesAct = (typeof FILES_ACTS)[number];

/** The login reply's `files` block: what this session may change, so a
 *  client offers only what it would not be refused. */
export interface FilesConfig {
  /** `false`: nothing in the area can change, and `may` is empty. */
  writable: boolean;
  may: FilesAct[];
  /** The kinds `files_preview` makes; absent where the server has none. */
  previews?: FilePreviewKind[];
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
  let tenths = (value * 10n + divisor / 2n) / divisor;
  if (tenths === 10_240n && unit < units.length - 1) {
    divisor *= 1024n;
    unit++;
    tenths = (value * 10n + divisor / 2n) / divisor;
  }
  return `${tenths / 10n}.${tenths % 10n} ${units[unit]}`;
}

/** An entry's `size` as a person reads it. A folder's is how many items
 *  it holds, not bytes, as a classic client shows it. */
export function formatEntrySize(entry: Pick<FileEntry, 'kind' | 'size'>): string {
  const value = parseDecimalU64(entry.size);
  if (entry.kind === 'folder') {
    return `${value.toLocaleString()} ${value === 1n ? 'item' : 'items'}`;
  }
  return formatFileSize(value);
}
