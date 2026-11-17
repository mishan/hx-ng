import { describe, expect, it } from 'vitest';

import { deviceLabelFor, deviceLabelFrom, validLabel, writeDeviceLabel } from '../src/devices';

describe('deviceLabelFrom', () => {
  it('names a device by its browser and system, and nothing it cannot tell', () => {
    const cases: [string, string | undefined][] = [
      ['Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0', 'Firefox on Android'],
      ['Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1', 'Chrome on iPhone'],
      ['Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15', 'Firefox on iPad'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15', 'Safari on macOS'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', 'Edge on Windows'],
      ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox on Linux'],
      ['Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'Chrome on ChromeOS'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/120.0.0.0', 'Opera on Windows'],
      ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36', 'Chrome on Linux'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'macOS'],
      ['Node.js/22', undefined],
      ['', undefined],
    ];
    for (const [ua, want] of cases) expect(deviceLabelFrom(ua), ua).toBe(want);
  });
});

describe('the device label setting', () => {
  function memory() {
    const kept = new Map<string, string>();
    return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  }
  const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

  it('is the user agent\'s until one is set, and then that server\'s alone', () => {
    const store = memory();
    expect(deviceLabelFor('wss://a', UA, store)).toBe('Firefox on Linux');
    expect(writeDeviceLabel('wss://a', 'Desk', store)).toBe('saved');
    expect(deviceLabelFor('wss://a', UA, store)).toBe('Desk');
    expect(writeDeviceLabel('wss://a', ' Desk', store), 'refused, the one before kept').toBe('invalid');
    expect(deviceLabelFor('wss://a', UA, store)).toBe('Desk');
    expect(deviceLabelFor('wss://b', UA, store)).toBe('Firefox on Linux');
    writeDeviceLabel('wss://a', '', store);
    expect(deviceLabelFor('wss://a', UA, store)).toBe('Firefox on Linux');
  });

  it('falls back to the user agent\'s where storage is gone or holds nonsense', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(writeDeviceLabel('wss://a', 'Desk', broken)).toBe('unstored');
    const readOnly = { getItem: () => null, setItem: broken.setItem };
    expect(writeDeviceLabel('wss://a', 'Desk', readOnly), 'one read but not written').toBe('unstored');
    expect(writeDeviceLabel('wss://a', '', readOnly), 'nor cleared').toBe('unstored');
    expect(writeDeviceLabel('wss://a', 'Desk', null)).toBe('unstored');
    expect(deviceLabelFor('wss://a', UA, broken)).toBe('Firefox on Linux');
    expect(deviceLabelFor('wss://a', UA, { getItem: () => '{"wss://a": 5}', setItem: () => {} })).toBe('Firefox on Linux');
    expect(deviceLabelFor('wss://a', UA, { getItem: () => 'not json', setItem: () => {} })).toBe('Firefox on Linux');
    expect(deviceLabelFor('0', UA, { getItem: () => '["Desk"]', setItem: () => {} })).toBe('Firefox on Linux');
    // One kept before the rules, or written by another tab: not sent.
    expect(deviceLabelFor('wss://a', UA, { getItem: () => '{"wss://a": "\\u202eevil"}', setItem: () => {} })).toBe('Firefox on Linux');
  });
});

describe('validLabel', () => {
  it('keeps a label as the server would, normalized, and nothing it would drop', () => {
    const cases: [string, string | null][] = [
      ['Desk', 'Desk'],
      ['Cafe\u0301', 'Caf\u00e9'],
      ['x'.repeat(32), 'x'.repeat(32)],
      ['x'.repeat(33), null],
      ['\u{1F4F1}'.repeat(32), '\u{1F4F1}'.repeat(32)],
      ['', null],
      [' Desk', null],
      ['Desk ', null],
      ['De\tsk', null],
      ['De\u200bsk', null],
      ['\u202eksed', null],
      ['De\u2066sk', null],
      ['De\u2028sk', null],
      ['My desk', 'My desk'],
    ];
    for (const [label, want] of cases) expect(validLabel(label), JSON.stringify(label)).toBe(want);
  });
});
