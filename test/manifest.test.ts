import { describe, expect, it } from 'vitest';

// The web app manifest is a static file nothing type-checks, and a
// browser that finds it wrong says so only in DevTools, by declining to
// offer the install. These are the mistakes that fail quietly.

// `node:fs` behind an `any`, as tsconfig.json asks, so Node's types stay
// out of a program that also typechecks as browser code.
const fsModule = 'node:fs';
const { existsSync, readFileSync } = (await import(/* @vite-ignore */ fsModule)) as any;

const pub = new URL('../public/', import.meta.url);

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', pub), 'utf8')) as {
  id: string;
  start_url: string;
  scope: string;
  display: string;
  icons: Icon[];
};

/** Width and height from a PNG's IHDR, which always comes first. */
function pngSize(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(String.fromCharCode(...bytes.subarray(1, 4))).toBe('PNG');
  return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

describe('manifest.webmanifest', () => {
  it('resolves every URL against itself, so `dist/` can live under any path', () => {
    // `base: './'` in vite.config.ts: a leading slash would point at the
    // root of whatever host serves this, not at the client.
    for (const url of [manifest.id, manifest.start_url, manifest.scope, ...manifest.icons.map((i) => i.src)]) {
      expect(url).not.toMatch(/^\/|^[a-z]+:/i);
    }
  });

  it('opens standalone', () => {
    expect(manifest.display).toBe('standalone');
  });

  it('ships every icon it names, at the size it claims', () => {
    for (const icon of manifest.icons) {
      const file = new URL(icon.src, pub);
      expect(existsSync(file), icon.src).toBe(true);
      if (icon.type === 'image/png') expect(pngSize(readFileSync(file)), icon.src).toBe(icon.sizes);
    }
  });

  it('has the plain and maskable sizes launchers ask for', () => {
    const png = manifest.icons.filter((i) => i.type === 'image/png');
    expect(png.some((i) => i.sizes === '192x192' && i.purpose !== 'maskable')).toBe(true);
    expect(png.some((i) => i.sizes === '512x512' && i.purpose !== 'maskable')).toBe(true);
    expect(png.some((i) => i.purpose === 'maskable')).toBe(true);
  });
});

describe('index.html', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  it('links the manifest and the icons, and each is in public/', () => {
    for (const rel of ['icon', 'manifest', 'apple-touch-icon']) {
      const m = html.match(new RegExp(`<link rel="${rel}" href="/([^"]+)"`));
      expect(m, rel).not.toBeNull();
      expect(existsSync(new URL(m![1], pub)), m![1]).toBe(true);
    }
  });

  it('gives iOS its Home Screen icon at the size it asks for', () => {
    const bytes = readFileSync(new URL('apple-touch-icon.png', pub));
    expect(pngSize(bytes)).toBe('180x180');
  });
});
