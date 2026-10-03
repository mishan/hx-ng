# AGENTS.md — hx-ng working notes

> Orientation for anyone (human or AI) working in this repo. The product
> notes live in **[README.md](README.md)**; the identity design in
> **[docs/identity-keys.md](docs/identity-keys.md)**; the wire protocol is
> hxd-ng's, not ours. Git history is the record of how we got here — the
> commit messages are written to be read.

## What this is

A browser client for the **Hotline-ng** wire: chat, the user list, private
messages, threaded news, voice and video. Static files, no server-side anything, no
runtime dependencies. It never speaks the legacy wire, and a server cannot
tell it apart from any other ng client.

Two halves, and the split is load-bearing:

| | |
|---|---|
| `packages/hotline-ng` | `@hotline-ng/client` — the reusable library: the wire protocol, the CBOR codec, the identity objects, voice. Knows nothing about the DOM. Published, so its exported surface is an API. |
| `src/` | This client's UI: the app shell, the roster, the transcript, the identity panel. Imports the library by name; the Vite alias points that at the workspace source so a change there needs no build step. |

The reference server is [hxd-ng](https://github.com/mishan/hxd-ng), a
sibling checkout at `../hxd-ng`. Neither repo depends on the other, but
the e2e suite builds and runs the real `hxd` and `hlid` from there when
they are present, and skips rather than fails when they are not.

It runs in the other direction too. hxd-ng's own end-to-end suite
(`hxd-ng/e2e/`) drives a real server with **this library**, as an
independent second implementation of its wire. hxd-ng's CI runs it
against the hx-ng commit its `e2e/hx-ng.rev` pins; CI here runs the
same suite, from hxd-ng's `main`, against this working tree. So a
change in `packages/hotline-ng` that breaks the server's tests fails
*this* repo's build, without waiting for anyone to advance a pin. Worth
knowing before changing anything in `Connection`'s exported surface.

The pin sets the order for a wire change: the server lands it first,
covered by its own Rust suites; the library and UI follow here, tested
against a server that has it; then hxd-ng advances its pin in the
commit that adds the e2e cases using it. So each side only ever waits
on something already merged.

## Build and test

```sh
npm install
npm run dev          # :5701, bound to every interface so a phone on the LAN can reach it
npm run typecheck
npm test             # vitest
npm run test:e2e     # playwright; needs ../hxd-ng and cargo, else skips
```

Before calling anything done, run what CI runs — `npm run typecheck`,
`npm test`, `npm run check:package` and `npx vite build`, in that order.

`dist/` is a build artefact and is not committed. `public/icons.png` and
`public/icons.json` are, because they change only when gtkhx's
`icons.rsrc` does.

## Invariants that matter

**The library has no runtime dependencies, and neither does the client.**
That is why there is a hand-written CBOR codec in
`packages/hotline-ng/src/cbor.ts` rather than a package: the identity
objects need deterministic encoding, and pulling in a general codec to get
it would cost more than it saves. Adding a runtime dependency is a
decision to argue for, not a convenience.

**Everything below `VoiceSession` runs outside a browser.** `protocol`,
`cbor`, `identity` and `Connection` touch no `window` and no `document`:
`Connection` needs `WebSocket`, `fetch` and `performance`, which a current
Node has, and its `sessionStorage` use sits behind try/catch so resume
across reloads switches itself off rather than failing. That is not
housekeeping — it is what lets hxd-ng's end-to-end suite drive a real
server with this library as an independent second implementation of the
wire, which is worth more to both projects than any mock. `VoiceSession`
is the exception and stays one; it may be imported anywhere and called
only in a page.

Two things defend it, and both are load-bearing. Relative imports carry
their **`.js` extension** and `tsconfig.build.json` says `NodeNext`, so
the compiler refuses a specifier Node could not resolve. And
`npm run check:package` (in CI) loads the built ESM with `node`, because
a bundler is forgiving in exactly the way that hides this.

**Identity keys are non-extractable and never leave WebCrypto.** The
device keypairs are generated with `extractable: false` and stored as
`CryptoKey` objects in IndexedDB. An XSS gets *use* of the key while the
page lives; it never gets the key. Anything that would require exporting a
private key is a change to the threat model, not an implementation detail
— see `docs/identity-keys.md` §1.

**The server address does not come from the code.** `public/config.json`
lands in `dist/` unbundled and takes effect on a refresh. Precedence is
`?server=`, then the connect form's `localStorage`, then `config.json`,
then the page's own origin.

**Voice needs a secure context** — outside one, `navigator.mediaDevices`
is `undefined` rather than merely failing, so a phone on plain http gets
chat and no microphone. Feature-detect it; never assume it exists.

## Conventions

- **Branches, not direct main commits.** Short kebab-case topic names —
  no prefixes. Misha opens the PR, reviews, merges; CI must be green.
- **One commit per branch**, squashed before the PR opens. During review,
  push follow-up commits; **don't force-push without asking**.
- Commits are authored `Misha Nasledov <misha@nasledov.com>`, descriptive
  bodies, no `Author:` line in the body, no `Co-Authored-By` trailer.
- **No AI attribution anywhere it lands in the tree** — not in commit
  messages, not in PR bodies, not in code comments or docs. No
  `Co-Authored-By`, no "generated with", no tool names. The work is the
  work; who or what typed it is not part of the record.
- **US spelling** in code, comments, docs and commit messages:
  *enrollment*, *behavior*, *canceled*, *license* (noun and verb). It is
  the spelling hxd-ng's specs use, and a codebase that mixes the two makes
  `grep` unreliable — `enrolment` and `enrollment` are two different
  symbols. Existing British spellings get corrected when the line is
  touched for another reason, not in sweeps of their own.
- **Avoid exact counts in comments and docs** (lines, tests, files) — they
  go stale and the narrative is stronger without them.
- Review feedback comes from bots as well as humans; verify claims before
  acting.
