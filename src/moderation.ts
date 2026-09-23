/** What moderation decides that has nothing to do with the DOM: what a
 *  report on a line names, how a report and an act read in a sentence,
 *  and how many reports are waiting. `ui/moderation.ts` draws from here. */

import {
  isFingerprint,
  type ModerationAct,
  type PersonRef,
  type Report,
  type ReportOutcome,
  type ReportParams,
  type ReportSubject,
  type User,
} from '@hotline-ng/client';

import type { Conversation, Line } from './state';

/** Lengths a moderator picks from, in seconds, and what to call them.
 *  A select rather than a number box: nobody bans someone for 3,847
 *  seconds. */
export const DURATIONS: [number, string][] = [
  [10 * 60, '10 minutes'],
  [60 * 60, '1 hour'],
  [24 * 60 * 60, '1 day'],
  [7 * 24 * 60 * 60, '1 week'],
  [30 * 24 * 60 * 60, '30 days'],
  [365 * 24 * 60 * 60, '1 year'],
];

const UNITS: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** `10m`, `2h`, `3d`, `1w` or bare seconds, as the slash commands take
 *  them; `null` for anything else. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)([smhdw]?)$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]) * UNITS[m[2]!.toLowerCase()]!;
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

/** A length in the largest unit it is a whole number of. */
export function durationWords(seconds: number): string {
  const named = DURATIONS.find(([s]) => s === seconds);
  if (named) return named[1];
  for (const [unit, word] of [
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ] as const) {
    if (seconds % unit === 0) {
      const n = seconds / unit;
      return `${n} ${word}${n === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
}

/**
 * A person as a command names them: someone on the roster by nick or
 * uid, a fingerprint by its shape, and otherwise an account.
 */
export function personRef(arg: string, onRoster: User | undefined): PersonRef {
  if (onRoster) return { uid: onRoster.uid };
  if (isFingerprint(arg)) return { fingerprint: arg };
  return { login: arg };
}

/**
 * What reporting this line would name, or `null` when it names nothing
 * that can be reported: one's own line, this client's own remarks, a
 * notice, or something already gone.
 *
 * A public line with an id is a `line` report, and the server can show
 * a moderator the line itself. A private message with an id is a `msg`
 * report, and the server copies the body out of the recipient's inbox.
 * Without an id — a server that keeps no history or no inbox — the only
 * target left is the sender, with the words pasted as evidence, which
 * the server files as unverified: the reporter's word for it.
 */
export function lineReport(line: Line, conv: Conversation, selfUid: number | undefined): Omit<ReportParams, 'reason'> | null {
  if (line.local || line.deleted) return null;
  if (line.kind !== 'chat' && line.kind !== 'action') return null;
  const from = line.from;
  if (from?.uid !== undefined && from.uid > 0 && from.uid === selfUid) return null;
  if (line.id !== undefined) return conv.kind === 'lobby' ? { line: line.id } : { msg: line.id };
  // A uid is someone on the roster now, which is who a live line with no
  // id came from; a login outlives them.
  const who: PersonRef | null = from?.login
    ? { login: from.login }
    : from?.uid !== undefined && from.uid > 0
      ? { uid: from.uid }
      : null;
  return who ? { user: who, evidence: line.text } : null;
}

/** A report's subject in a few words: a login where there is one, then
 *  the nick they went by, and a fingerprint's first eight otherwise. */
export function subjectName(s: ReportSubject): string {
  if (s.login && s.nick && s.nick !== s.login) return `${s.nick} (${s.login})`;
  return s.login ?? s.nick ?? (s.fingerprint ? `${s.fingerprint.slice(0, 8)}…` : 'a guest');
}

const TARGET_WORDS: Record<string, string> = {
  line: 'a chat line from',
  media: 'an image from',
  msg: 'a private message from',
  article: 'an article by',
};

/** `alice reported a chat line from bob`, the server's own summary
 *  shape, for a report's heading. */
export function reportHeading(r: Report): string {
  const who = r.by?.login ?? 'A guest';
  const about = subjectName(r.target.from);
  const what = TARGET_WORDS[r.target.kind];
  return what ? `${who} reported ${what} ${about}` : `${who} reported ${about}`;
}

const OUTCOME_WORDS: Record<ReportOutcome, string> = {
  removed: 'removed',
  dismissed: 'dismissed',
  duplicate: 'closed as a duplicate',
};

export function outcomeWords(o: ReportOutcome): string {
  return OUTCOME_WORDS[o] ?? o;
}

const ACT_WORDS: Record<string, string> = {
  redact: 'redacted',
  revoke: 'revoked',
  purge: 'purged',
  close: 'closed',
  news_delete: 'deleted',
  news_node_delete: 'deleted',
};

/** `carol redacted line 42 from bob`, for a row of the audit trail. */
export function actSummary(a: ModerationAct): string {
  const t = a.target;
  const what = [
    t.line !== undefined ? `line ${t.line}` : null,
    t.media !== undefined ? 'an image' : null,
    t.article !== undefined ? (a.kind === 'news_node_delete' ? `category ${t.article}` : `article ${t.article}`) : null,
    t.report !== undefined ? `report #${t.report}` : null,
  ].filter(Boolean);
  const whose = t.login ?? (t.fingerprint ? `${t.fingerprint.slice(0, 8)}…` : null);
  const object = what.length ? what.join(', ') : (whose ?? 'something');
  const from = what.length && whose ? ` from ${whose}` : '';
  return `${a.by} ${ACT_WORDS[a.kind] ?? a.kind} ${object}${from}`;
}

/**
 * Open reports, as far as this session can tell.
 *
 * The count starts from the login reply's and moves with the events:
 * `report` only ever announces an open one, and `report_closed` only
 * ever closes one, so each is worth exactly one either way. A listing
 * that reached the end replaces it, since then it is simply the length.
 * The reports themselves are the ones a listing or an event brought,
 * newest first — a page, not the whole queue.
 */
export class ReportQueue {
  count = 0;
  /** Open reports held, by id. */
  private held = new Map<number, Report>();

  reset(count = 0): void {
    this.count = count;
    this.held.clear();
  }

  /** A `report` event. False when it was already held — a replay — and
   *  so already counted. */
  filed(r: Report): boolean {
    if (this.held.has(r.id)) return false;
    this.held.set(r.id, r);
    this.count++;
    return true;
  }

  /** A `report_closed` event. */
  closed(id: number): void {
    this.held.delete(id);
    this.count = Math.max(0, this.count - 1);
  }

  /** A page of open reports. `first` is a page from the top: what it
   *  holds replaces what was held, and when it is the whole queue, so
   *  does its length. A later page adds. */
  page(reports: Report[], first: boolean, hasMore: boolean): void {
    if (first) this.held.clear();
    for (const r of reports) if (r.status === 'open') this.held.set(r.id, r);
    if (!hasMore) this.count = this.held.size;
    else this.count = Math.max(this.count, this.held.size);
  }

  /** Newest first. */
  list(): Report[] {
    return [...this.held.values()].sort((a, b) => b.id - a.id);
  }

  has(id: number): boolean {
    return this.held.has(id);
  }
}
