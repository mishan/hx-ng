import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

// Built on the app's own Vite config rather than beside it, so the
// `@hotline-ng/client` alias is defined once. Tests import the library by
// the name anybody else would and get the workspace source, with no build
// step between a change and a test run.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // `node`, not jsdom: nothing under test touches a document. The two
      // browser globals `Connection` does reach for — `WebSocket` and
      // `sessionStorage` — are faked explicitly in `fake-socket.ts`,
      // which is worth more than a DOM implementation would be, because
      // the fake is also the thing that lets a test *drive* a server.
      environment: 'node',
      include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    },
  }),
);
