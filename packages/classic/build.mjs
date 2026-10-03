// Build the classic-wire module into packages/classic/pkg/:
//
//   cargo build --release --target wasm32-unknown-unknown
//   wasm-bindgen --target web       (the CLI must match Cargo.toml's pin)
//   wasm-opt -Os                    (when binaryen is installed)
//
// Needs a Rust toolchain with the wasm32-unknown-unknown target (rustup's
// `rustup target add wasm32-unknown-unknown`, or Debian's
// libstd-rust-dev-wasm32) and `cargo install wasm-bindgen-cli
// --version <the pinned one>`. Run by `npm run build:wasm`, and before
// `dev`, `test` and `build`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Where `cargo install` puts wasm-bindgen, which a shell that never
// sourced cargo's env may not have on its PATH.
process.env.PATH = [join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin'), process.env.PATH].join(delimiter);
const pkg = join(here, 'pkg');
const wasm = join(here, 'target/wasm32-unknown-unknown/release/hxclassic.wasm');

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: here, stdio: 'inherit' });
}

function have(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const pinned = /wasm-bindgen = "=([0-9.]+)"/.exec(readFileSync(join(here, 'Cargo.toml'), 'utf8'))?.[1];
if (!have('wasm-bindgen')) {
  console.error(`wasm-bindgen is not installed: cargo install wasm-bindgen-cli --version ${pinned} --locked`);
  process.exit(1);
}
const cli = execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim().split(' ')[1];
if (cli !== pinned) {
  console.error(`wasm-bindgen ${cli} is installed, and Cargo.toml pins ${pinned}; they must match.`);
  process.exit(1);
}

// Here, whatever CARGO_TARGET_DIR says: `wasm` below is read from here,
// and one built elsewhere would leave a stale module to be packaged.
run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--locked', '--target-dir', join(here, 'target')]);
run('wasm-bindgen', ['--target', 'web', '--out-dir', pkg, '--out-name', 'hxclassic', wasm]);
const out = join(pkg, 'hxclassic_bg.wasm');
if (have('wasm-opt')) {
  try {
    run('wasm-opt', ['-Os', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', out, '-o', out]);
  } catch {
    // An old binaryen cannot read what a current Rust emits.
    console.error('wasm-opt failed; binaryen may be too old for this Rust (version 131 or later works).');
    process.exit(1);
  }
} else {
  console.warn('wasm-opt (binaryen) is not installed; the module is larger than it need be.');
}
if (!existsSync(out)) process.exit(1);
console.log(`${out}: ${statSync(out).size} bytes`);
