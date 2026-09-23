import { describe, expect, it } from 'vitest';

import type { ModerationAct, Report } from '@hotline-ng/client';

import {
  actSummary,
  durationWords,
  lineReport,
  parseDuration,
  personRef,
  reportHeading,
  ReportQueue,
} from '../src/moderation';
import { LOBBY, Store, type Line } from '../src/state';

const report = (id: number, over: Partial<Report> = {}): Report => ({
  id,
  at: 1_700_000_000,
  status: 'open',
  by: { login: 'alice' },
  target: { kind: 'line', line: 42, from: { login: 'bob', nick: 'Bob' } },
  reason: 'slur',
  verified: true,
  ...over,
});

describe('durations', () => {
  it('reads what the commands take', () => {
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('10m')).toBe(600);
    expect(parseDuration('2H')).toBe(7200);
    expect(parseDuration('3d')).toBe(259200);
    expect(parseDuration('1w')).toBe(604800);
  });

  it('refuses what is not one', () => {
    for (const s of ['', '0', '0m', 'm', '1y', '-5', '1.5h', 'soon']) expect(parseDuration(s)).toBeNull();
  });

  it('says one in the largest whole unit', () => {
    expect(durationWords(3600)).toBe('1 hour');
    expect(durationWords(7200)).toBe('2 hours');
    expect(durationWords(90)).toBe('90 seconds');
    expect(durationWords(14 * 86400)).toBe('2 weeks');
  });
});

describe('naming a person', () => {
  it('takes the roster first, then a fingerprint by its shape, then an account', () => {
    const u = { uid: 7, nick: 'Bob', icon: 1, admin: false, status: 'active' as const, transport: 'encrypted' as const };
    expect(personRef('bob', u)).toEqual({ uid: 7 });
    expect(personRef('a'.repeat(52), undefined)).toEqual({ fingerprint: 'a'.repeat(52) });
    expect(personRef('bob', undefined)).toEqual({ login: 'bob' });
  });
});

describe('what reporting a line names', () => {
  const s = new Store();
  const lobby = s.conversation(LOBBY)!;
  const pm = s.openPm({ uid: 5, login: 'bob', nick: 'Bob' });
  const line = (over: Partial<Line>): Line => ({ t: 1, kind: 'chat', text: 'words', from: { uid: 5, nick: 'Bob' }, ...over });
  const me = { uid: 1, nick: 'Me' };

  it('names a public line by its id, and a stored message by its inbox id', () => {
    expect(lineReport(line({ id: 42 }), lobby, me)).toEqual({ line: 42 });
    expect(lineReport(line({ id: 9 }), pm, me)).toEqual({ msg: 9 });
  });

  it('falls back to the sender, with the words as evidence, when nothing was stored', () => {
    expect(lineReport(line({ from: { uid: 5, nick: 'Bob', login: 'bob' } }), pm, me)).toEqual({
      user: { login: 'bob' },
      evidence: 'words',
    });
    expect(lineReport(line({}), lobby, me)).toEqual({ user: { uid: 5 }, evidence: 'words' });
  });

  it('names nothing for one’s own line, a notice, a local line or a blank one', () => {
    expect(lineReport(line({ id: 1, from: { uid: 1, nick: 'Me' } }), lobby, me)).toBeNull();
    expect(lineReport(line({ kind: 'notice' }), lobby, me)).toBeNull();
    expect(lineReport(line({ local: true }), pm, me)).toBeNull();
    expect(lineReport(line({ id: 3, deleted: true, kind: 'deleted' }), lobby, me)).toBeNull();
    // Mail that waited has uid 0 and, from a guest, no login: nobody to name.
    expect(lineReport(line({ from: { uid: 0, nick: 'Guest' } }), pm, me)).toBeNull();
  });

  it('knows one’s own history lines by the name on them', () => {
    expect(lineReport(line({ id: 7, from: { nick: 'Me', icon: 1 } }), lobby, me)).toBeNull();
    expect(lineReport(line({ id: 8, from: { nick: 'Bob', icon: 1 } }), lobby, me)).toEqual({ line: 8 });
  });

  it('does not name a uid that has left the roster', () => {
    expect(lineReport(line({}), lobby, me, () => false)).toBeNull();
  });
});

describe('sentences', () => {
  it('heads a report the way the server summarizes one', () => {
    expect(reportHeading(report(1))).toBe('alice reported a chat line from Bob (bob)');
    expect(reportHeading(report(2, { by: undefined, target: { kind: 'user', from: { nick: 'eve' } } }))).toBe(
      'A guest reported eve',
    );
  });

  it('says what an act did', () => {
    const act = (over: Partial<ModerationAct>): ModerationAct => ({
      id: 1, kind: 'redact', at: 0, by: 'carol', target: {}, reason: 'r', ...over,
    });
    expect(actSummary(act({ target: { line: 42, login: 'bob' } }))).toBe('carol redacted line 42 from bob');
    expect(actSummary(act({ kind: 'purge', target: { login: 'bob' } }))).toBe('carol purged bob');
    expect(actSummary(act({ kind: 'close', target: { report: 7 } }))).toBe('carol closed report #7');
  });
});

describe('the report queue', () => {
  it('counts an event once, even replayed', () => {
    const q = new ReportQueue();
    q.reset(2);
    expect(q.filed(report(5))).toBe(true);
    expect(q.filed(report(5))).toBe(false);
    expect(q.count).toBe(3);
    q.closed(5);
    expect(q.count).toBe(2);
    expect(q.has(5)).toBe(false);
  });

  it('does not count a close twice once a listing has reached the end', () => {
    const q = new ReportQueue();
    q.page([report(3)], true, false);
    // Closed while the listing was out: the listing already left it out.
    q.closed(2);
    expect(q.count).toBe(1);
    q.closed(3);
    expect(q.count).toBe(0);
  });

  it('counts a close it cannot see while the listing is partial', () => {
    const q = new ReportQueue();
    q.reset(9);
    q.page([report(3)], true, true);
    q.closed(1);
    expect(q.count).toBe(8);
  });

  it('never counts below nothing', () => {
    const q = new ReportQueue();
    q.closed(1);
    expect(q.count).toBe(0);
  });

  it('takes a whole listing’s length as the count', () => {
    const q = new ReportQueue();
    q.reset(9);
    q.page([report(3), report(4)], true, false);
    expect(q.count).toBe(2);
    expect(q.list().map((r) => r.id)).toEqual([4, 3]);
  });

  it('keeps the larger count while there is more to page', () => {
    const q = new ReportQueue();
    q.reset(9);
    q.page([report(3)], true, true);
    expect(q.count).toBe(9);
  });
});
