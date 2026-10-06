/**
 * The classic wire's module, and what comes out of it.
 *
 * `packages/classic` is hx-libs' `hxsession` — GtkHx's protocol logic,
 * without sockets or timers — compiled to wasm. `npm run build:wasm` puts
 * it in `packages/classic/pkg/`. These are the shapes its events take,
 * spelled out by hand to match `packages/classic/src/lib.rs`; the tests
 * in `test/classic` drive the real module, so the two cannot drift
 * apart unnoticed.
 */

import init, { ClassicConfig, ClassicSession } from '../../packages/classic/pkg/hxclassic.js';

export { ClassicConfig, ClassicSession };

let ready: Promise<unknown> | null = null;
let failed = false;

/** The module trapped. Its memory — the allocator, the stack pointer, a
 *  borrow left held — may be part way through a change it will never
 *  finish, so no session runs in it again; and wasm-bindgen keeps the one
 *  instance it made, so only a reload makes another. */
export function classicFailed(): void {
  failed = true;
}

/** Load the module once. `source` is for a caller with no fetch to an
 *  asset URL — a test in Node hands over the bytes. */
export function loadClassic(source?: BufferSource): Promise<unknown> {
  if (failed) {
    return Promise.reject(new Error('The classic wire failed earlier; reload the page to reach classic servers again.'));
  }
  ready ??= (source ? init({ module_or_path: source }) : init()).catch((e: unknown) => {
    // A fetch that failed is tried again on the next connect, not
    // remembered as failing until a reload.
    ready = null;
    throw e;
  });
  return ready;
}

// What the module leaves out it leaves `undefined`, not `null`: serde
// sends an absent value as a missing key.

export interface ClassicUser {
  uid: number;
  icon: number;
  /** 1 away, 2 admin, 4 refuses messages, 8 refuses chat. Absent in a
   *  change that left them out, which means they did not change. */
  status?: number;
  name: string;
  color?: number;
}

export interface ClassicFile {
  /** For showing. */
  name: string;
  /** For naming the entry back to the server: a shown name does not
   *  always encode back to the bytes it came from. */
  name_bytes: Uint8Array;
  folder: boolean;
  /** Bytes, or a folder's item count. */
  size: number;
  type_code: number[];
  creator: number[];
}

export interface ClassicNewsItem {
  name: string;
  name_bytes: Uint8Array;
  bundle: boolean;
}

/** The name the module gives the `Error` it throws for a refusal — too
 *  long, not logged in — as against a fault in the module itself. */
export function isRefusal(e: unknown): e is Error {
  return e instanceof Error && e.name === 'ClassicRefusal';
}

export interface ClassicArticle {
  id: number;
  parent: number;
  subject: string;
  poster: string;
  /** The classic Mac date: a base year and seconds into it. */
  year: number;
  seconds: number;
}

export type ClassicEvent =
  | { type: 'logged_in'; version: number; name?: string; uid?: number }
  | { type: 'agreement'; text: string }
  | { type: 'ready' }
  | { type: 'chat'; cid: number; uid: number; text: string }
  | { type: 'message'; uid: number; from: string; text: string }
  | { type: 'broadcast'; uid: number; from: string; text: string }
  | { type: 'disconnecting'; text: string }
  | { type: 'user_list'; users: ClassicUser[] }
  | { type: 'user_changed'; cid: number; user: ClassicUser }
  | { type: 'user_left'; cid: number; uid: number }
  | { type: 'self_info'; uid: number; icon: number }
  | { type: 'user_info'; trans: number; name: string; info: string }
  | { type: 'file_list'; trans: number; files: ClassicFile[] }
  | { type: 'news_file'; trans: number; text: string }
  | { type: 'news_posted'; text: string }
  | { type: 'news_listing'; trans: number; items: ClassicNewsItem[] }
  | { type: 'news_category'; trans: number; articles: ClassicArticle[] }
  | { type: 'news_article'; trans: number; text: string }
  | { type: 'failed'; trans: number; reason?: string }
  | { type: 'unhandled'; opcode: number }
  | { type: 'closed'; reason: string; refused: boolean };

/** The events that answer a request, by the trans it went out on. */
export type ClassicReply = Extract<ClassicEvent, { trans: number }>;

/** The classic Mac epoch's dates, as Unix seconds: `seconds` past the
 *  start of `year`. Year 0 is how a server says it has no date. */
export function macDate(year: number, seconds: number): number {
  if (!year) return 0;
  return Date.UTC(year, 0, 1) / 1000 + seconds;
}
