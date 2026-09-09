# Identity keys in the browser

Who holds which key, where it is kept, and what a page can do with it.

> Every `*.md` named here without a path is a **hxd-ng** document —
> `hotline-ng-identity.md`, `hotline-ng-auth.md`, `identity-enrollment.md`
> and the identity threat model all live in that repository's `docs/`,
> not this one. This is the only file in hx-ng's `docs/`.

`hotline-ng-identity.md` defines two keys per person — a long-lived
*identity key* that certifies devices and signs the user card, and a
per-device key that signs login proofs. It does not say what a *browser*
is in that scheme, and that is the decision this document makes, because
every other piece of client work depends on it: what enrollment looks
like, what the storage schema holds, whether a Worker is needed, and
whether hx-ng can link a classic account at all.

The short version: **a browser profile is a device, not an identity.**
The identity key stays outside the browser in the first cut, and the
schema leaves room for it to come inside later, behind an explicit
choice the user makes with the trust consequence in front of them.

---

## 1. Who you are trusting

This has to come first, because it is the argument that decides
everything below.

A web client is code the page's operator serves you, freshly, on every
load. The threat model's line that a server operator "cannot sign as a
key they don't hold" is true of the *Hotline* operator — it is not true
of whoever serves the JavaScript, and in the ordinary hx-ng deployment
those are the same person. `config.json` derives the WebSocket address
from the page's own origin precisely because the usual case is a client
sitting in front of its own server.

So the question "should the browser hold the identity key" is really
"should visiting a Hotline server's web page be enough to lose your
identity everywhere." A hostile or compromised page:

| | holds the device key | holds the identity key |
|---|---|---|
| can | sign proofs and read PMs to this device, while the page is open | everything, forever: certify new devices, move your standing, sign as you on every server |
| cannot | export the key, certify a device, move standing | — |
| recovery | end the session, remove the link; the cert expires anyway | rotation, if a successor was committed; otherwise you are gone |

Keeping the identity key out of the browser turns identity-key theft
into device-key theft, which is the one the design already has answers
for: expiry, revocation, and a blast radius of one browser profile.

That is not an argument against ever holding an identity key in a
browser. It is an argument that doing so is a *different* trust
decision from using the client, that it should be made explicitly, and
that it should not be the thing standing between us and shipping
identity at all.

**What "non-extractable" does and does not buy.** A non-extractable
`CryptoKey` cannot be read by page code, which is what bounds an XSS to
"use of the key while the page is open". It is not a container the
browser keeps secret from the disk: the key bytes live in the profile
directory, and whoever copies the profile has them. Against page code
the browser is a better container than a key file; against a stolen
laptop it is the same container. §7.2 and §11 lean on that distinction.

---

## 2. The keys, concretely

Per browser profile (IndexedDB is origin-scoped, so this is per origin
per profile):

| | type | extractable | lifetime | used for |
|---|---|---|---|---|
| device signing key | Ed25519 | **no** | until the cert expires | the login proof of §3.6, on every fresh login |
| device encryption key | X25519 | **no** | same | nothing yet; `device_enc` is a required field of the cert and future E2E PMs decrypt with it |
| device certificate | CBOR bytes | — | 90 days recommended | presented at `/identity/auth` |
| user card | CBOR bytes | — | until the profile changes | presented at `/identity/auth`; the server caches it |
| identity key | Ed25519 | n/a in phase 1 | long-lived | signs the two above — **not stored here** |

`device_enc` is not optional and not deferrable: `crates/hl-identity/src/cert.rs`
requires a `bstr(32)`, the certificate's signature covers it, and a cert
minted today is what a future E2E rollout will have to decrypt against.
Generate it now, keep it non-extractable, and never think about it again
until messaging-e2e lands.

Both device keys are stored as `CryptoKey` objects directly in
IndexedDB — structured clone handles them, and a non-extractable key
stored this way can be used by the page and never read out of it, which
is the whole point. An XSS gets *use* of the key for as long as the page
lives; it does not get the key.

WebCrypto's Ed25519 and X25519 are recent enough that the identity panel
should feature-detect both (`crypto.subtle.generateKey` with the named
algorithm, in a try/catch) and say plainly which browser is missing
what, rather than failing at the first signature.

---

## 3. The three models, and the choice

**A — the browser is an identity.** It generates both keys, self-signs
its own certificate, publishes a card. Self-contained; no other tool.
The identity key must then be stored, which means wrapped under a
passphrase, which means a KDF, a Worker, an unwrap ceremony, an export
format, and the trust problem of §1.

**B — the browser is a device.** The identity key lives in `hlid` or a
native client. Enrollment is: the browser shows its device public keys,
the user mints a certificate for them elsewhere and pastes it back. No
identity key handling in the browser at all.

**C — both, user's choice.**

**The choice is B first, C eventually.** B is safer by §1, and it is
also much less code: no KDF, no key wrapping, no Worker, no export
format, no recovery flow. It is the smaller half of the feature and it
is the half that is correct under the worse threat. A is what makes
identity useful to someone who has never opened a terminal, and it
should land — but it should land second, as an explicit choice, and not
as the thing that holds the rest up.

The storage schema in §4 is written so A is an added optional record
rather than a migration.

The cost of B, said plainly: it needs `hlid` (or another identity
holder), and the certificate expires. §7 is about making that ceremony
tolerable rather than pretending it isn't there — and, since the user is
at a terminal for enrollment anyway, about doing everything that needs the
identity key in that one trip (§5).

---

## 4. Storage

One IndexedDB database, `hxd-ng.identity`, one object store `devices`
keyed by the device signing public key (32 bytes, hex), with an index on
`fingerprint`, plus a `meta` store holding `{ active: devicePub }`.

```ts
interface StoredDevice {
  devicePub: string;          // 32 bytes hex; the record key, known at generation
  deviceSign: CryptoKey;      // Ed25519 private, non-extractable
  deviceEnc: CryptoKey;       // X25519 private, non-extractable
  deviceEncPub: Uint8Array;   // 32 bytes, kept beside it so enrollment can show it
  // Absent until a certificate has been pasted (§7.1):
  fingerprint?: string;       // 52-char Crockford base32, the display form; indexed
  cert?: Uint8Array;          // signed CBOR, as pasted or minted
  card?: Uint8Array;          // signed CBOR
  certExpires?: number;       // unix seconds, parsed out of the cert for the renewal nag
  label?: string;             // the cert's `name`, for a device list
  // Phase C only:
  identityWrapped?: WrappedKey;
}
```

Keyed by the device key rather than the identity fingerprint because the
keys exist before the certificate does: §7.1 generates them the first
time the panel opens, and the fingerprint is only known once a cert
naming an identity has been pasted. A record with no `cert` is a device
waiting to be enrolled, and it is a legal state rather than one the
schema cannot hold. It is also how the server keys its own cache (spec
§13), and it gives each identity in one browser its own device keypair —
a second identity (an alt, a test key) is a second record, not a second
cert over the same key. The UI in phase 1 may still show exactly one.
Retrofitting the key of a store is worse than allowing for it now.

The identity is **not** scoped per server. That is the point of the
scheme — one key, many servers — and it is why this store is separate
from the per-server `hxd-ng.connect` record in `localStorage` and the
per-tab `hxd-ng.session` record in `sessionStorage`. Those two hold
things that die with a server or a tab; this one holds something that
outlives both.

Nothing in this store goes in `localStorage`. A `CryptoKey` cannot live
there anyway, and the encoded objects sitting beside it in one place
makes "what does this browser know about me" one question with one
answer, and "forget me" one deletion.

---

## 5. The device certificate: capabilities

`crates/hl-identity/src/cert.rs` already defines the mask this client
should use:

```rust
pub const WEB: u64 = LOGIN | MESSAGE;
```

`hlid cert --caps web` writes it. It omits `VOUCH` and `MANAGE`, which
is what §3.3 of the spec recommends for web clients and what the threat
model's open question ("restricting the web client's device key would
shrink the XSS blast radius") is asking for. hx-ng should answer that
question yes.

**What that costs, precisely:** `MANAGE` is enforced on four paths in
`crates/hxd-ng-session/src/identity.rs` — link-at-auth, `/identity/link`,
`/identity/unlink`, and `PUT /identity/card`. A `web`-capability browser
therefore cannot link a classic account, and linking a classic account
is the single most likely thing a hx-ng user wants from identity: *I am
already `alice` on this server, bind my key to that.*

Three ways out, and which one depends on where the identity key is:

1. Put `MANAGE` in the web cert. Rejected — it makes an XSS an
   account-management compromise, permanently, in exchange for a
   ceremony most users perform once.
2. **Link from `hlid`, with the identity's own device.** This is the
   phase B answer. A link is server-side state keyed on the identity, not
   on the device that wrote it: once `hlid link` has bound the account,
   the browser's `web` certificate lands on that account at its next
   fresh login (spec §8.1), and no `MANAGE` bit ever enters the browser.
3. **Mint a `MANAGE` certificate on demand, use it, discard it.** This
   is the phase C answer, for when the identity key is in the browser and
   there is no terminal to go to. Detail below.

Under phase B, option 2 is not the awkward fallback — it is strictly
less ceremony than option 3. Both need a trip to the terminal, because
both need the identity key. Option 3 then also needs a paste, a second
challenge round trip, and a session that carries `MANAGE` for its
lifetime. Option 2 needs one more line at the prompt the user is already
sitting at:

```
hlid link --server https://host --login alice --password-stdin
```

The identity panel pre-fills this exactly as it pre-fills the cert
command (§7.1), and shows it on the line after `hlid cert`, so that
"enroll this browser and link my account" is one terminal trip. If the
browser already holds a guest session on that server, it reconnects to
pick up the link; the panel says so.

**Option 3, for phase C.** The client holds a `web` cert for everyday
use. When the user asks to link an account, it unwraps the identity key,
mints a second certificate carrying `LOGIN | MANAGE`, short-lived (an
hour), re-authenticates with it, sends `login` and `password` in that
same `/identity/auth` call (spec §8.2 "at auth" — one round trip fewer
than `/identity/link` afterwards), and throws the certificate away.
`MANAGE` in the browser is then scoped to exactly the window in which
the identity key is already exposed, which the threat model has already
accounted for; it collapses to "you cannot get manage without the
identity key," which is the property that should have been true all
along. The socket that redeems that token carries `LOGIN | MANAGE` for
the life of the session, which sounds worse than it is: no ng JSON
request consults `device_caps` at all — only the four HTTP paths do, and
the upgrade consumed the token they would have needed. A client that
prefers the tidier story re-authenticates with the web certificate for
the session proper, at the cost of one more challenge round trip.

### 5.1 `create: false`, and the first auth against a new server

Independent of how the link is made, there is a trap on the way to it.
On a `new_accounts = create` server, the first `/identity/auth` for a
never-seen identity **creates an account** (`id-<short fingerprint>`, or
the handle's local part) and links it — after which linking the classic
account answers `already_linked` until an operator unlinks the invented
one. `/identity/auth` takes `"create": false` to suppress this, and
`hlid` sends it by default on every path that leads to a link
(`crates/hlid/src/main.rs`, `Credentials::create`).

The client must not send its first auth to a server without knowing the
answer. The first fresh login against a server this browser has not used
identity with is preceded by one question in the panel — *link an
existing account here / let the server make me one / stay a guest* — and
the answer sets `create`. Discovery says whether the server is `create`
at all, so the question only appears where it matters. Record the answer
in the per-server `hxd-ng.connect` entry; it is per server and dies with
it, which is that record's job.

---

## 6. The card, and what it is actually for

Worth stating because it is easy to over-build: **the card's `name` and
`icon` do not drive the roster.** In hxd-ng the login nick comes from the
`nick` param or `account.name`; `card.name` is read in exactly one
place, `find_or_create_linked` at `identity.rs:690`, where it names an
account that `new_accounts = create` is inventing. Everywhere else the
card is a published document other clients can fetch with
`GET /identity/card/<fingerprint>`.

Two consequences:

- The client does not need `PUT /identity/card`. `/identity/auth`
  caches the card it is given, subject to the `updated` monotonicity
  rule, so publishing a new card is a side effect of logging in with it.
  That is fortunate, because `PUT` needs `MANAGE` and auth does not.
- Changing your display name on a server is still the `nick` request,
  and it has nothing to do with the card. Do not wire the two together;
  they answer different questions.

Card constraints the client must enforce before signing, since the
server will refuse the object rather than explain it: `name` 1–32
characters with no leading/trailing space and no invisible characters,
`profile` ≤ 2048 bytes, ≤ 8 attestations, ≤ 16 KiB encoded. NFC-normalise
`name` before signing — the verifier deliberately does not. (Phase B
never signs a card; this is for phase C and for the constraints the
enrollment check in §7.1 can report.)

---

## 7. Enrollment, renewal, and the ceremony

### 7.1 Enrolling a browser as a device (phase B)

1. The client generates both device keypairs, non-extractable, and
   stores them with no certificate (§4). This costs nothing and can
   happen the first time the user opens the identity panel.
2. It shows the two public keys as hex, and — the part that makes this
   bearable — **the exact command to run**, pre-filled, with a copy
   button:

   ```
   hlid cert --device-pub 3f2a… --device-enc-pub 91c4… \
     --caps web --days 90 --name 'Firefox on the laptop' -o cert.bin
   ```

   Exact means exact, so this is what `buildHlidCertCommand` actually
   emits, down to the POSIX single-quoting a device name with an
   apostrophe in it needs. It does not name a key file: it relies on
   `hlid` having a default directory (§9), because a pre-filled command
   that guesses `~/.hlid/identity.key` is only exact for someone who
   followed one particular tutorial.

   **Linking an account is not part of this panel.** It used to print an
   `hlid link` line beside the certificate command, which meant the two
   halves of "enroll this browser and use my account" were ceremonies of
   different shapes — one a code, one a pasted shell command — with
   nothing tying them together. hxd-ng's `identity-enrollment.md`
   §12 sketches
   doing both in one trip through the mailbox, and that is where linking
   should reappear; until it does, `hlid link` is a thing the user runs
   in a terminal, not a thing this panel pretends to orchestrate.
3. The user pastes back the certificate, and the card beside it if they
   have one — `hlid cert --bundle` writes both as a single blob, which
   the panel does not read yet (§9). The card
   cannot be fetched from the server on a first visit — `GET
   /identity/card/<fingerprint>` serves what `/identity/auth` has cached,
   and this identity has never authed there — so the paste is the common
   case, and the fetch is a convenience for a *second* browser only.
4. The client checks before storing: `cert.device` equals its own
   signing public key, `cert.device_enc` equals its own, `cert.identity`
   equals `card.identity`, neither has expired. These are field
   comparisons on decoded CBOR and cost nothing. A mismatch here is a
   paste error and should say so; discovering it at `/identity/auth` as
   `bad_cert` is a worse place to find out.

   Verifying the two *signatures* locally as well needs a canonical
   re-encode of each object minus `sig` (§9). Do it if the codec is
   already there. If it is not, a probe auth — challenge, auth with
   `"create": false`, discard the token — reports `bad_cert` and
   `bad_card` as distinct codes and is the same UX.

Step 2 needs changes to `hlid` — see §9.

### 7.2 Renewal

A 90-day certificate means step 7.1 again, four times a year. The client
should make that a nag rather than a surprise: parse `expires` at
enrollment, store it, and from one-third remaining (§3.3's own advice)
show the renewal command in the identity panel. The device keys do not
change, so renewal is one command and one paste, and the fingerprint,
card, and every server-side link survive it untouched.

Nothing in `hl-identity` enforces a maximum lifetime — `RECOMMENDED_LIFETIME`
is 90 days, and `hlid --days` accepts up to a hundred years. The
pre-filled command defaults to 90, and the panel offers 180 and 365
beside it with the trade-off written next to the choice: what the
certificate's lifetime bounds is how long a *copied profile* can keep
logging in as you (§1) — the same threat a key file faces, which is why
the spec's number transfers unchanged. Longer is a legitimate choice for
a machine the user does not share; it is the user's choice, made with
that sentence in front of them, not a default quietly widened.

### 7.3 Creating an identity in the browser (phase C)

Deferred, and specified here only enough to show the schema survives it:

- Generate the identity keypair extractable, inside a dedicated Worker.
- Mint the device cert (`caps: WEB`) and card v1 there.
- Wrap the 32-byte seed: PBKDF2-HMAC-SHA-256, ≥ 600 000 iterations,
  random 16-byte salt, into AES-GCM-256. WebCrypto has no Argon2id and
  adding one is a WASM dependency in a client that has none, so the
  stored record carries `{ kdf: "pbkdf2-sha256", iterations }` and the
  choice can change later.
- Force an export before finishing: a JSON envelope of the wrapped seed
  plus the card, and — behind a confirmation — the bare 64-character hex
  seed, which is exactly what `hlid`'s `read_seed` takes. Interoperating
  with the CLI is the difference between a recovery file and a file.
- Terminate the Worker.

**On "sign in a worker".** The threat model asks for it, and it is worth
being precise about what it buys, because the obvious reading is wrong:
a Worker does not hide the key from an XSS on the main thread, since
that XSS can postMessage the Worker and ask it to sign. What it buys is
*deterministic destruction* — `worker.terminate()` frees that heap, and
there is no equivalent for a `Uint8Array` on the main thread that the
GC may have copied. Zeroization you can actually promise is the reason
to do it. Constraining the Worker's API to `mintCert` and `signCard`
rather than `sign(bytes)` is worth doing too, but it is defence in
depth, not a boundary.

---

## 8. What the wire actually needs, per connection

Worth writing down because it bounds how often any of this runs.

A **fresh login** needs `POST /identity/challenge`, then a login proof
signed by the device key, then `POST /identity/auth`, then the upgrade
with `?token=…` inside 60 seconds. Two round trips and one signature.
On that socket the `login` frame omits `login` and `password` — the
server ignores them on an identity socket (spec §6.2) and there is no
reason to send a password it will not read.

A **resume** needs none of it. `handle_resume` in `conn.rs` never looks
at the socket's transport identity — the session token is the credential
and the identity was fixed on the session at login. So a dropped network
inside the grace window costs nothing, and `Connection`'s backoff loop
does not need to learn about identity.

**One branch of `Connection` does.** Today `attach()` in
`packages/hotline-ng/src/connection.ts` opens the socket first and only
then decides between `resume` and `login`; if the resume fails and the
caller did not ask for resume-only, it falls through to `doLogin()` on
the same socket. With identity, the token has to exist *before* the
socket opens, and only the fresh-login path wants one — so a resume that
fails cannot fall through. It closes that socket, runs challenge and
auth, and attaches again with `?token=`. Otherwise the fallback lands as
a token-less guest with credentials, which is the silent downgrade the
spec's 401 rule exists to prevent, arrived at from the client side.

Take the association the `login` reply's `self.identity.outcome`
reports as authoritative, not the one `/identity/auth` predicted.

This is what makes the non-extractable device key workable: it must be
usable without a prompt, and it is, because it is the only key involved
in the routine path.

---

## 9. What is still missing here

Three of the four things this section used to ask for have landed on the
server side, so what is left here is this client's half of them.

**`hlid` does what §7.1's command needs it to.** It can certify a key it
did not generate (`--device-pub HEX --device-enc-pub HEX`, hxd-ng#62);
`--identity`, `--device`, `--cert` and `--card` fall back to fixed names
in `$HLID_HOME`, default `~/.hlid`, so a pre-filled command that names no
key file is exact rather than a guess; `hlid init --name S` writes an
identity key, a device key, a certificate and a card in one step; and
`hlid cert --bundle` writes the certificate and the card as a single
object.

**What this client has not caught up with is the bundle.** `hlid cert
--bundle` writes hxd-ng's `identity-enrollment.md` §5.4 — an unsigned CBOR map of
a `cert` and a `card`, verified by checking both signatures and that the
card belongs to the identity the certificate names. The panel still asks
for "one or two base64url blobs, told apart by shape", which is what
`hlid cert` plus `hlid card` produce. Teaching it the bundle collapses
§7.1 step 3's paste to one blob and, more to the point, gives it the
*same* verifier the mailbox path will use — so the paste stops being a
second code path to audit. That is the next thing to do here.

**CORS is answered by the server now.** The identity endpoints and
discovery send `Access-Control-Allow-Origin: *` with an `OPTIONS`
handler for the preflight `PUT /identity/card` triggers, and expose
`ETag` so the card fetch can still be revalidated. The `allowCustomServer`
case therefore works, and so will a device reaching a mailbox on a server
other than the one that served the page.

The Vite proxy in `vite.config.ts` stays regardless: it forwards
`/identity`, `/.well-known` and `/ng` to :5700 so that `npm run dev` on
:5701 is same-origin, which is still the right shape for the dev loop and
does not depend on the server being a recent build.

**A CBOR codec in the client.** hx-ng has no runtime dependencies and
this should not be the reason it grows one. The login proof (§3.6) is
CBOR the client *encodes* deterministically, so an encoder is
non-negotiable; decoding the pasted cert and card for §7.1's checks and
the `expires` nag needs a decoder that keeps map order; verifying their
signatures locally needs `encode(decode(bytes) − sig)`, the canonical
re-encode `Envelope::from_value` does server-side. A fixed-schema codec
covering the integer, byte-string, text-string, array and map majors is
on the order of 150 lines. Budget for that, or take §7.1's probe-auth
route and skip the local signature checks.

**A place to put the device label.** Not blocking, but the certificate's
`name` field is the only device list anyone has, and nothing reads it
back to the user. A device panel that lists what a fingerprint has
certified needs a server endpoint that does not exist. Worth knowing
before someone promises a "manage your devices" screen.

---

## 10. What is protected, and what is not

Under phase B, with a `web`-capability certificate:

- An XSS in the page **can** sign login proofs and hold a session for as
  long as the page lives, and read private messages delivered to it.
  It can also mint a transport token and redeem it *from another
  machine* — the proof is a 60-second thing, the token is a bearer — and
  that session lives as long as it is kept alive or resumed, because
  resume never re-checks the certificate (§8).
- It **cannot** export the device key, certify another device, link or
  unlink an account, update the card, or touch the identity on any other
  server.
- Revocation is not implemented anywhere yet, and **deleting the
  IndexedDB store does not end a session an attacker already holds.**
  The honest remedy, in order: ask the operator to kick the session and
  remove the account link (spec §8.1 — a device with no link is locked
  out at its next connection, not at its certificate's expiry); then
  delete the store and let the certificate lapse, which stops *new*
  logins. Say that in the UI rather than implying a revoke button
  exists or that "forget me" is a remedy for compromise.
- A hostile *page operator* is strictly worse than an XSS only in
  duration, not in kind, which is the property §1 was buying.

Under phase C, a hostile page can capture the passphrase during an
unwrap and take the identity. That is the residual risk the threat model
already names, and it is the reason phase C should be an explicit
choice with that sentence next to it — not a default, and not the first
thing built.

---

## 11. Open questions

- **Should the spec say something about web device lifetimes?** §7.2
  lets the user choose, on the reasoning that a non-extractable key is
  no better than a file against a copied profile and so the spec's
  number already fits. If that reasoning is accepted, the spec's "90
  days recommended" needs no web-specific carve-out, and the panel's
  longer options are just the user exercising a freedom the spec already
  grants. If it is not, this is where to argue.
- **Does phase C need a local-`hlid` handshake instead of copy-paste?**
  `hlid` already listens on a socket for `tunnel`; an `hlid enroll --listen`
  that the browser posts its device public keys to would remove the
  paste entirely. It also means CORS on localhost and a new surface in
  `hlid`, so: nice, later, not v1.
- **Multiple identities in one browser** — the schema allows it (one
  device record per identity); does the UI? Deferring is fine, changing
  the key of the store later is not.
- **Passkeys.** WebAuthn cannot *be* either key here — it signs its own
  structure, not arbitrary CBOR — but the PRF extension could replace
  the phase-C passphrase, which is the piece of phase C most likely to
  be done badly by hand. Worth revisiting when phase C is real.
