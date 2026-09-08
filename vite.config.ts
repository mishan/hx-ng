import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// `base: './'` so a built `dist/` works from any path a static server
// happens to mount it at — including straight out of the repo with
// `python3 -m http.server`, which is how most people will run this.
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      // The client eats its own dog food: it imports the library by the
      // name anybody else would, and the alias points that at the
      // workspace source so a change there needs no build step. The
      // published package resolves through `exports` to `dist/` instead.
      '@hotline-ng/client': fileURLToPath(new URL('./packages/hotline-ng/src/index.ts', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    // No source map in the committed build: it is a large generated file
    // that would churn on every change, and anyone debugging the client
    // itself should be running `npm run dev` against real sources.
    sourcemap: false,
  },
  server: {
    port: 5701,
    // A phone on the LAN is the whole point of the ng wire, and it
    // cannot reach a dev server bound to loopback.
    host: true,
  },
});
