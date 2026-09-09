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
# Where the test's page actually lives — a different origin from this
# server, which is the ordinary split-origin deployment and also why the
# enroll runs below pass --web. A QR is drawn for a server-advertised
# client only on the server's own origin: the fragment carries the
# pairing secret, and a mailbox free to name any origin could collect it.
web = "http://localhost:5701/"
# The default is 4, and it is right for a deployment. This suite is not
# one: every test here is a different holder on 127.0.0.1 against one
# server, and a holder that is killed rather than closed leaves its
# session in the mailbox for the full ten-minute TTL. So the limit
# counts the whole suite as a single abusive client. Raised rather than
# worked around, because the alternative — a server per test — would
# cost more than it proves.
enroll_per_address = 64
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

/**
 * `hlid enroll`, which does not exit until a device asks — so unlike
 * {@link hlid} it has to be driven while it runs: read the pairing code
 * off its output, then answer the prompt it shows afterwards.
 *
 * The answer is written to stdin up front. It waits in the pipe until
 * `hlid` reaches its prompt, which is the only moment it reads stdin,
 * and doing it this way means the test never has to guess when that is.
 */
export function hlidEnroll(cwd: string, args: string[], approve: boolean): HlidEnroll {
  return hlidHolder(cwd, ['enroll', ...args], approve);
}

/** `hlid agent`: the same driver with no budget, so it stays up and
 *  takes renewals without a code. */
export function hlidAgent(cwd: string, args: string[]): HlidEnroll {
  return hlidHolder(cwd, ['agent', ...args], true);
}

function hlidHolder(cwd: string, args: string[], approve: boolean): HlidEnroll {
  const child = spawn(bin('hlid'), args, { cwd, env: hlidEnv(cwd) });
  // Enough answers for every prompt a test will produce; each waits in
  // the pipe until it is asked for.
  child.stdin.write((approve ? 'y\n' : 'n\n').repeat(4));
  child.stdin.end();

  let output = '';
  let resolveCode: (c: string) => void;
  let resolveUrl: (u: string) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    setTimeout(() => reject(new Error(`hlid enroll showed no code:\n${output}`)), 30_000).unref();
  });
  // Only meaningful with `--show-url`; without it there is no URL to
  // wait for and the timeout is not armed, so this simply never settles
  // and no caller has any business awaiting it.
  const wantsUrl = args.includes('--show-url');
  const scanUrl = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    if (wantsUrl) {
      setTimeout(() => reject(new Error(`hlid enroll showed no scan URL:\n${output}`)), 30_000).unref();
    }
  });
  // A rejection nobody is waiting for is an unhandled rejection, and in
  // Playwright that fails whichever test happens to be running. This
  // handler does not consume it — `await holder.scanUrl` still sees the
  // rejection — it only says somebody is watching.
  void scanUrl.catch(() => {});
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    // The same eight characters and hyphen a user reads off the screen.
    const m = /\b([0-9A-Z]{4}-[0-9A-Z]{4})\b/.exec(output);
    if (m) resolveCode(m[1]!);
    const u = /(https?:\/\/\S*#enroll=\S+)/.exec(output);
    if (u) resolveUrl(u[1]!);
  });

  return {
    code,
    scanUrl,
    output: () => output,
    exited: new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1))),
    stop: () => child.kill(),
  };
}

/** The temp directory is the identity's home, so nothing lands in the
 *  real one. See {@link hlid}. */
function hlidEnv(cwd: string): NodeJS.ProcessEnv {
  return { ...process.env, HLID_HOME: cwd };
}

export interface HlidEnroll {
  /** Resolves with the pairing code as soon as `hlid` prints it. */
  code: Promise<string>;
  /** Resolves with the QR code's URL, when run with `--show-url`. */
  scanUrl: Promise<string>;
  /** Everything `hlid` has said so far — its prompt, for assertions. */
  output: () => string;
  exited: Promise<number>;
  stop: () => void;
}

/** Runs `hlid` and returns its stdout — `keygen`'s public key and
 *  fingerprint lines, in particular. Throws with stderr attached on a
 *  non-zero exit, which is always a paste-worthy diagnostic here (a bad
 *  argument, a rejected field) rather than something to recover from. */
export function hlid(cwd: string, args: string[]): string {
  // HLID_HOME, always: `hlid init` and every flag fallback default to
  // ~/.hlid, and a test that writes an identity into the home directory
  // of whoever ran it is a test that has done real damage — hlid would
  // then silently use it as the default for their own commands.
  const result = spawnSync(bin('hlid'), args, { cwd, env: hlidEnv(cwd), encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`hlid ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr}`);
  }
  return result.stdout;
}
