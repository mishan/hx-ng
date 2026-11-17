/** This browser's own devices on a server that groups persons (hxd-ng's
 * `docs/hotline-ng.md` §7.6). No DOM. */

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
