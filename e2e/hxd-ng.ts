/**
 * Building and running a real hxd-ng server for the identity
 * end-to-end test, from a sibling checkout — the same convention
 * `tools/build-icons.py` uses for gtkhx's `icons.rsrc`. Neither repo
 * depends on the other; this is what lets the test exercise the real
 * `hlid` binary and the real server instead of a hand-built fixture,
 * which is the only way to actually catch a bug like the one that
 * blocked this feature's first landing (`wsToHttp` building a
 * cross-origin URL the browser's own CORS policy refused).
 *
 * Absence is not a failure: a checkout without `../hxd-ng`, or without
 * `cargo`, skips this test rather than failing it — see
 * `hxdNgAvailable()`, checked once at collection time in
 * `identity.spec.ts`.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HXD_NG_DIR = join(import.meta.dirname, '..', '..', 'hxd-ng');

export function hxdNgAvailable(): boolean {
  if (!existsSync(HXD_NG_DIR)) return false;
  return spawnSync('cargo', ['--version']).status === 0;
}

function bin(name: string): string {
  return join(HXD_NG_DIR, 'target', 'release', name);
}

/** `cargo build` is a no-op the moment nothing has changed, so this
 *  always runs rather than trying to guess whether the binaries are
 *  stale — the first run pays for a real build, every one after is a
 *  fraction of a second. */
export function buildHxdNg(): void {
  const result = spawnSync('cargo', ['build', '--release', '-p', 'hxd', '-p', 'hlid'], {
    cwd: HXD_NG_DIR,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('cargo build --release -p hxd -p hlid failed');
}

export interface RunningServer {
  /** Same host as `httpBase`, on purpose — `wsToHttp` decides
   *  page-relative vs. absolute by comparing hostnames, and the test
   *  navigates the page to `httpBase`'s host, so this has to match. */
  wsUrl: string;
  httpBase: string;
  hlidDir: string;
  stop(): void;
}

async function waitForPort(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not answer within ${timeoutMs}ms: ${String(lastError)}`);
}

/** Starts a freshly built `hxd` in a throwaway directory: a guest-only,
 *  unattested identity server — enough to exercise enrollment and login
 *  without also needing a registrar or an existing account. */
export async function startServer(ngPort: number): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), 'hxd-ng-e2e-'));
  writeFileSync(
    join(dir, 'hxd-ng.toml'),
    `
[server]
bind = "127.0.0.1:${ngPort - 100}"
name = "hx-ng e2e"

[paths]
accounts = "accounts"

[ng]
bind = "127.0.0.1:${ngPort}"

[identity]
key = "identity-server.key"
new_accounts = "guest"
unattested = "guest"
`,
  );
  const proc: ChildProcessWithoutNullStreams = spawn(bin('hxd'), ['--config', 'hxd-ng.toml'], {
    cwd: dir,
    stdio: 'pipe',
  });
  let log = '';
  proc.stdout.on('data', (d: Buffer) => (log += d.toString()));
  proc.stderr.on('data', (d: Buffer) => (log += d.toString()));
  proc.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`hxd exited ${code}:\n${log}`);
  });

  const httpBase = `http://127.0.0.1:${ngPort}`;
  await waitForPort(`${httpBase}/.well-known/hotline`, 10_000);

  return {
    wsUrl: `${httpBase.replace('http://', 'ws://')}/ng`,
    httpBase,
    hlidDir: dir,
    stop: () => proc.kill(),
  };
}

/** Runs `hlid` and returns its stdout — `keygen`'s public key and
 *  fingerprint lines, in particular. Throws with stderr attached on a
 *  non-zero exit, which is always a paste-worthy diagnostic here (a bad
 *  argument, a rejected field) rather than something to recover from. */
export function hlid(cwd: string, args: string[]): string {
  const result = spawnSync(bin('hlid'), args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`hlid ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr}`);
  }
  return result.stdout;
}
