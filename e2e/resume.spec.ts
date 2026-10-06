/**
 * A reload whose resume cannot be made says why on the connect form,
 * and keeps the session for the next reload rather than inviting a
 * second login beside it.
 */

import { expect, test } from '@playwright/test';

import { buildHxdNg, hxdNgAvailable, startServer } from './hxd-ng';

const NG_PORT = 5790;

test.describe('resuming after a reload', () => {
  test.skip(!hxdNgAvailable(), 'requires a sibling hxd-ng checkout (with cargo) at ../hxd-ng');

  test('a server out of reach is said so, and the session kept', async ({ page }) => {
    buildHxdNg();
    const server = await startServer(NG_PORT, {
      accounts: { alice: 'name = "Alice"\npassword = "pw"\n[access]\nread_chat = true\n' },
    });
    try {
      await page.goto(`/?server=${encodeURIComponent(server.wsUrl)}`);
      await page.getByLabel('Account').fill('alice');
      await page.getByLabel('Password').fill('pw');
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(page.locator('.app')).toBeVisible();
    } finally {
      server.stop();
    }

    await page.reload();
    await expect(page.locator('.connect-card .error')).toContainText('Your session is still there');
  });
});
