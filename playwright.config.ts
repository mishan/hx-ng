import { defineConfig } from '@playwright/test';

// `npm run test:e2e` only — this is not part of `npm test`, since it
// needs a sibling hxd-ng checkout, `cargo`, and a downloaded browser
// (`npx playwright install chromium`), none of which the rest of this
// repo asks for. `e2e/hxd-ng.ts` skips the one spec that needs them
// when a sibling checkout isn't there, rather than failing the run.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5701',
    trace: 'retain-on-failure',
  },
  // The dev server this exercises, not a mock of it — same reasoning
  // as running a real hxd-ng: a proxy config only means something
  // tested against the real thing it's proxying to.
  webServer: {
    command: 'npm run dev -- --port 5701 --strictPort',
    url: 'http://127.0.0.1:5701',
    reuseExistingServer: !process.env.CI,
  },
});
