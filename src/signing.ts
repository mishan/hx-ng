/** Signed public lines (hxd-ng's `docs/e2e-messages.md` §4.6 to §4.7, §8):
 * whether this session can sign, and the state each line it reads is
 * shown in. No DOM: the transcript draws what this decides. */

import {
  CAPS,
  SIGNED_CERT_MAX_BYTES,
  aliasCovers,
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  decodeDeviceCert,
  readSignedChat,
  signatureDisplay,
  type ChatScope,
  type ChatStyle,
  type Events,
  type FollowedHandover,
  type HistoryLine,
  type SignatureDisplay,
  type SignedContext,
  type SignedSender,
  type Signs,
  type User,
} from '@hotline-ng/client';

const SIGN_LOBBY_KEY = 'hxd-ng.sign.lobby';

/** Off unless the user turned it on: a signed line is evidence anyone
 *  can show of what was said (§1.3). */
export function readSignLobby(): boolean {
  try {
    return localStorage.getItem(SIGN_LOBBY_KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeSignLobby(on: boolean): void {
  try {
    localStorage.setItem(SIGN_LOBBY_KEY, on ? 'on' : 'off');
  } catch {
    /* storage disabled; the preference lasts this page load */
  }
}

/** What a session proving this certificate says at login (§4.6), or
 *  `undefined` for one whose certificate cannot sign a line. */
export function signsFor(cert: Uint8Array | undefined, lobby: boolean): Signs | undefined {
  if (!cert || cert.length > SIGNED_CERT_MAX_BYTES) return undefined;
  try {
    const caps = decodeDeviceCert(cert).caps;
    if (caps !== undefined && (caps & CAPS.MESSAGE) === 0) return undefined;
  } catch {
    return undefined;
  }
  return lobby ? 'default' : 'able';
}

/** The key this host is pinned to, and the handovers it followed, whose
 *  old keys stay in scope for what was signed before them. */
export interface PinnedKey {
  key: Uint8Array;
  followed: readonly FollowedHandover[];
}

/** How a line is shown, and by whose key when it has one. */
export interface LineSignature extends SignatureDisplay {
  /** The certificate's fingerprint, which a signed line is named by
   *  (§8); `null` for a link form whose certificate is not held. */
  signer: string | null;
  /** When it was signed, Unix seconds, in the signer's word. */
  sent?: number;
  /** A linked user's home server, by the name its row gives, on every
   *  line checked against a key the row gave rather than the pin. */
  home?: string;
  /** That key is not the one this host is pinned to. */
  foreignKey?: boolean;
  /** Where a line signed for elsewhere was signed. */
  signedFor?: string;
}

export interface LineRead {
  signature: LineSignature | null;
  /** Another copy of a signed line already read here, the same or
   *  another under its id (§3.6): not to be shown. */
  duplicate: boolean;
}

/** How many signed lines' ids are remembered, the newest kept: §3.6's
 *  window, which a session's scrollback fits in. */
const IDS_KEPT = 4096;

function keyOf(b64: string | undefined): Uint8Array | null {
  if (b64 === undefined) return null;
  try {
    return base64urlToBytes(b64);
  } catch {
    return null;
  }
}

const sameKey = (a: Uint8Array, b: Uint8Array | null) => b !== null && bytesToHex(a) === bytesToHex(b);

/**
 * Reads the lobby's lines against this host's pinned key, or for a
 * linked server's user against the key their row gives. A line from
 * anyone with no key to check it against is unverified, never verified
 * on the server's word. Lines are read one at a time, in the order they
 * are handed over, so what one teaches (who signs here, which ids are
 * taken) holds for the next.
 */
export class LineReader {
  /** Fingerprints seen signing here, whose unsigned lines are marked. */
  private signing = new Set<string>();
  /** Each signed line read, by signer (or a link form's certificate
   *  hash) and id: the server's id for the copy that was kept, which a
   *  refetched page carries again, and what it said. */
  private ids = new Map<string, { id: number | undefined; content: string }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private pinned: PinnedKey | null) {}

  /** The host's key as checked again, for the lines read from now on. */
  repin(pinned: PinnedKey | null): void {
    this.pinned = pinned;
  }

  private scope(remote: { server_key?: string } | undefined): ChatScope {
    if (remote) return { server: keyOf(remote.server_key), room: 0 };
    const pinned = this.pinned;
    if (!pinned) return { server: null, room: 0 };
    return {
      server: pinned.key,
      room: 0,
      alias: (key, sent) => pinned.followed.some((f) => aliasCovers(f, key, sent)),
    };
  }

  /** A `chat` event, with the sender's roster row as it stood. A line
   *  the event or the row says is a linked user's is read as one. */
  live(line: Events['chat'], row: User | undefined): Promise<LineRead> {
    const remote = row?.remote ?? line.from.remote;
    const fingerprint = row?.identity?.fingerprint;
    // A ghost's row names no fingerprint until user keys cross, and
    // then the certificate's is the name (§8).
    const sender: SignedSender = fingerprint ? { named: fingerprint } : remote ? 'certificate' : 'unknown';
    return this.serially(() =>
      this.read(line, { at: line.at, sender, scope: this.scope(remote) }, remote && (remote.server || 'a linked server'), {
        rowSigns: row?.identity?.signs === true,
        seenSigning: fingerprint !== undefined && this.signing.has(fingerprint),
      }),
    );
  }

  /** A `history` line, which names no uid: its certificate is the name. */
  history(line: HistoryLine): Promise<LineRead> {
    const remote = line.from.remote;
    return this.serially(() =>
      this.read(line, { at: line.at, sender: 'certificate', scope: this.scope(remote) }, remote && 'a linked server', {}),
    );
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Whether a signed line was read here before, under `key`: not the
   *  same line again unless the server's id and the words are too. */
  private seen(key: string, id: number | undefined, content: string): boolean {
    const was = this.ids.get(key);
    if (was) return id === undefined || was.id !== id || was.content !== content;
    this.ids.set(key, { id, content });
    if (this.ids.size > IDS_KEPT) this.ids.delete(this.ids.keys().next().value!);
    return false;
  }

  private async read(
    line: { text: string; style: ChatStyle; signed?: string; id?: number },
    ctx: SignedContext<ChatScope>,
    home: string | undefined,
    expected: { rowSigns?: boolean; seenSigning?: boolean },
  ): Promise<LineRead> {
    if (line.signed === undefined) {
      // A line of an image alone has no text to sign (§3.3), so none
      // was expected.
      const shown = signatureDisplay(null, line.text === '' ? {} : expected);
      return { signature: shown.signatureExpected ? { ...shown, signer: null } : null, duplicate: false };
    }
    const { outcome, line: signed, link } = await readSignedChat(line.signed, line.text, line.style === 'action', ctx);
    const signer = 'signer' in outcome ? outcome.signer : null;
    if (outcome.state === 'verified') this.signing.add(outcome.signer);
    const key = signed && signer
      ? `${signer} ${bytesToHex(signed.id)}`
      : link
        ? `cert ${bytesToHex(link.certSha256)} ${bytesToHex(link.id)}`
        : null;
    const content = signed ? `${bytesToHex(signed.server)} ${signed.room} ${signed.act} ${signed.text}` : `${line.style} ${line.text}`;
    const duplicate = key !== null && this.seen(key, line.id, content);
    const signature: LineSignature = { ...signatureDisplay(outcome), signer, ...(signed ? { sent: signed.sent } : {}) };
    if (home !== undefined) {
      signature.home = home;
      const pinned = this.pinned?.key ?? null;
      signature.foreignKey = ctx.scope.server === null || pinned === null || !sameKey(ctx.scope.server, pinned);
    }
    if (outcome.state === 'elsewhere' && signed) {
      const where = [];
      if (!sameKey(signed.server, ctx.scope.server)) {
        where.push(`the server whose key begins ${bytesToBase64url(signed.server).slice(0, 16)}`);
      }
      if (signed.room !== ctx.scope.room) where.push(`room ${signed.room}`);
      signature.signedFor = where.join(', ') || 'another scope';
    }
    return { signature, duplicate };
  }
}

const DEVICE_KEY = 'hxd-ng.signing-devices';

function devices(): Record<string, string> {
  try {
    return (JSON.parse(sessionStorage.getItem(DEVICE_KEY) ?? '{}') as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

/** Which device the session for `url` proved, kept with the tab as its
 *  session is, so a resume after a reload signs with that device and no
 *  other. `null` forgets it. */
export function rememberSigningDevice(url: string, devicePub: string | null): void {
  const all = devices();
  if (devicePub === null) delete all[url];
  else all[url] = devicePub;
  try {
    sessionStorage.setItem(DEVICE_KEY, JSON.stringify(all));
  } catch {
    /* storage disabled; a reload signs nothing */
  }
}

export function signingDeviceFor(url: string): string | null {
  return devices()[url] ?? null;
}
