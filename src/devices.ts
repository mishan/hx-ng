/** This browser's own devices on a server that groups persons (hxd-ng's
 * `docs/hotline-ng.md` §7.6). No DOM. */

import type { DeviceEntry } from '@hotline-ng/client';

// Most specific first: every Chromium names Chrome and Safari too, and
// an iPhone says it is like Mac OS X.
const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/Android/, 'Android'],
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];

/** What to call this device in its person's device list, from its user
 *  agent: "Firefox on Android". A hint the server keeps or drops, and
 *  shows only beside its own facts. Undefined where neither the browser
 *  nor the system can be told. */
export function deviceLabelFrom(ua: string): string | undefined {
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return browser && system ? `${browser} on ${system}` : (browser ?? system);
}

/** The parts of a `Storage` the label setting uses. */
export interface LabelStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LABELS_KEY = 'hx-ng.device-labels';

function local(): LabelStore | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** The labels set, by server; an empty object where none can be read. */
function labels(store: LabelStore | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(LABELS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `label` as the server keeps it (§7.6), NFC, or null where it would
 *  drop it: empty, more than 32 characters, space at either end, or a
 *  control, format (invisible and bidirectional among them) or line or
 *  paragraph separator character anywhere. */
export function validLabel(label: string): string | null {
  const s = label.normalize('NFC');
  if (!s || [...s].length > 32 || /^\s|\s$/u.test(s) || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(s)) return null;
  return s;
}

/** What this device is called on `server`: the label set for it, or
 *  the user agent's. */
export function deviceLabelFor(server: string, ua: string, store: LabelStore | null = local()): string | undefined {
  const set = labels(store)[server];
  return (typeof set === 'string' && validLabel(set)) || deviceLabelFrom(ua);
}

/** The label set for `server` alone, if any. */
export function deviceLabelSet(server: string, store: LabelStore | null = local()): string {
  const set = labels(store)[server];
  return typeof set === 'string' ? set : '';
}

/** What became of a label set: kept for the next login; `invalid`, one
 *  the server would drop (`validLabel`), with the one before kept; or
 *  `unstored`, storage that would not keep it, so the next login says
 *  what it would have said before. */
export type LabelWrite = 'saved' | 'invalid' | 'unstored';

/** Set this device's label on `server`, or with an empty one go back to
 *  the user agent's. */
export function writeDeviceLabel(server: string, label: string, store: LabelStore | null = local()): LabelWrite {
  const all = labels(store);
  if (label) {
    const valid = validLabel(label);
    if (!valid) return 'invalid';
    all[server] = valid;
  } else delete all[server];
  if (!store) return 'unstored';
  try {
    store.setItem(LABELS_KEY, JSON.stringify(all));
  } catch {
    return 'unstored';
  }
  return 'saved';
}

/** The server's facts about a device, in words, to show beside its
 *  label, which is only what its client calls it. */
export function deviceFacts(d: DeviceEntry, when: (since: number) => string): string[] {
  return [
    d.wire,
    d.proved ? 'device key' : 'password',
    d.transport === 'encrypted' ? 'encrypted' : 'not encrypted',
    d.status,
    `since ${when(d.since)}`,
  ];
}
