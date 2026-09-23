import { beforeAll, describe, expect, it, vi } from 'vitest';

import { canInstall, install, listenForInstall, watchInstall } from '../src/install';

// The browser is an EventTarget, and Chromium's offer an Event with two
// members added. That is all `src/install.ts` sees of either.

const browser = new EventTarget();

function offer(outcome: 'accepted' | 'dismissed') {
  const e = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome }),
  });
  browser.dispatchEvent(e);
  return e;
}

describe('install', () => {
  beforeAll(() => listenForInstall(browser));

  it('offers nothing until the browser does', async () => {
    expect(canInstall()).toBe(false);
    expect(await install()).toBe(false);
  });

  it('keeps the offer, and keeps the browser’s own bar out of the way', () => {
    const seen: boolean[] = [];
    const stop = watchInstall((a) => seen.push(a));
    const e = offer('dismissed');
    expect(e.defaultPrevented).toBe(true);
    expect(canInstall()).toBe(true);
    expect(seen).toEqual([false, true]);
    stop();
  });

  it('spends the offer on one prompt, whatever the answer', async () => {
    const e = offer('dismissed');
    expect(await install()).toBe(false);
    expect(e.prompt).toHaveBeenCalledOnce();
    expect(canInstall()).toBe(false);
    expect(await install()).toBe(false);
    expect(e.prompt).toHaveBeenCalledOnce();
  });

  it('says yes when the user did', async () => {
    offer('accepted');
    expect(await install()).toBe(true);
  });

  it('withdraws the offer once installed some other way', () => {
    offer('accepted');
    browser.dispatchEvent(new Event('appinstalled'));
    expect(canInstall()).toBe(false);
  });
});
