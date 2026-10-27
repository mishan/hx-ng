import { describe, expect, it } from 'vitest';

import { MIN_SPACING_MS, publishedBuild, UpdateCheck } from '../src/update';

/** A host serving `version.json` as `body` with `status`, or one that
 *  cannot be reached at all. */
function host(status: number | 'down', body = '') {
  const asked: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    asked.push({ url, init });
    if (status === 'down') throw new TypeError('Failed to fetch');
    return new Response(body, { status });
  };
  return { fetch, asked };
}

describe('publishedBuild', () => {
  it.each([
    ['the same build', host(200, '{"build":"abc1234"}'), null],
    ['a newer build', host(200, '{"build":"def5678"}'), 'def5678'],
    ['a dev build published', host(200, '{"build":"dev"}'), null],
    ['no version.json', host(404, 'not found'), null],
    ['a body that is not JSON', host(200, '<html>'), null],
    ['JSON without a build', host(200, '{"version":1}'), null],
    ['JSON that is not an object', host(200, 'null'), null],
    ['a host out of reach', host('down'), null],
  ])('%s', async (_, h, want) => {
    expect(await publishedBuild('abc1234', h.fetch, 1000)).toBe(want);
  });

  it('asks past every cache', async () => {
    const h = host(200, '{"build":"def5678"}');
    await publishedBuild('abc1234', h.fetch, 1000);
    expect(h.asked).toEqual([{ url: 'version.json?t=1000', init: { cache: 'no-store' } }]);
  });

  it('never asks from a dev build', async () => {
    const h = host(200, '{"build":"def5678"}');
    expect(await publishedBuild('dev', h.fetch, 1000)).toBe(null);
    expect(h.asked).toEqual([]);
  });
});

describe('UpdateCheck', () => {
  it('spaces its checks out and reports each newer build once, unless urgent', async () => {
    let body = '{"build":"abc1234"}';
    let asked = 0;
    let now = 0;
    const check = new UpdateCheck(
      'abc1234',
      async () => {
        asked++;
        return new Response(body);
      },
      () => now,
    );

    expect(await check.check()).toBe(null);
    body = '{"build":"def5678"}';
    now += MIN_SPACING_MS - 1;
    expect(await check.check()).toBe(null);
    expect(asked).toBe(1);

    now += 1;
    expect(await check.check()).toBe('def5678');
    now += MIN_SPACING_MS;
    expect(await check.check()).toBe(null);
    expect(asked).toBe(3);

    body = '{"build":"0123abc"}';
    now += MIN_SPACING_MS;
    expect(await check.check()).toBe('0123abc');

    now += 1;
    expect(await check.check()).toBe(null);
    expect(await check.check(true)).toBe('0123abc');
  });
});
