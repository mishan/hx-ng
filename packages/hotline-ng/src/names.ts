/**
 * What may appear in a name the identity layer carries — a card's display
 * name (`hotline-ng-identity.md` §3.4) and a device certificate's label
 * (§3.3). Ported character-for-character from hxd-ng's
 * `crates/hl-identity/src/names.rs`, which explains the reasoning: this
 * is `Default_Ignorable_Code_Point` (renders as nothing) plus the `Cf`
 * characters outside it, plus every whitespace character but the plain
 * space, plus controls. A zero-width space or a bidi override is
 * invisible to a reader and not to a server, so `admin​` and `admin`
 * have to be told apart here rather than trusted to look different.
 *
 * Written out rather than reached for through a Unicode package, for the
 * same reason `hl-identity` does it by hand: it's short, and this client
 * has no other dependency that would justify pulling one in.
 */

function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

function isWhitespaceNotSpace(cp: number): boolean {
  if (cp === 0x20) return false;
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** A code point that renders as nothing, or as something other than
 *  itself: controls, whitespace other than the plain space, and every
 *  invisible character. */
export function isDeceptive(cp: number): boolean {
  if (isControl(cp) || isWhitespaceNotSpace(cp)) return true;
  return (
    cp === 0x00ad || // SOFT HYPHEN
    cp === 0x034f || // COMBINING GRAPHEME JOINER
    cp === 0x061c || // ARABIC LETTER MARK
    (cp >= 0x115f && cp <= 0x1160) || // HANGUL CHOSEONG/JUNGSEONG FILLER
    (cp >= 0x17b4 && cp <= 0x17b5) || // KHMER INHERENT VOWELS
    (cp >= 0x180b && cp <= 0x180f) || // MONGOLIAN selectors and separator
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space .. RLM
    (cp >= 0x202a && cp <= 0x202e) || // bidi embedding and override
    (cp >= 0x2060 && cp <= 0x206f) || // word joiner .. deprecated bidi
    cp === 0x3164 || // HANGUL FILLER
    (cp >= 0xfe00 && cp <= 0xfe0f) || // VARIATION SELECTOR-1..16
    cp === 0xfeff || // ZERO WIDTH NO-BREAK SPACE
    cp === 0xffa0 || // HALFWIDTH HANGUL FILLER
    (cp >= 0xfff0 && cp <= 0xfff8) || // reserved, ignorable
    (cp >= 0x1bca0 && cp <= 0x1bca3) || // SHORTHAND FORMAT
    (cp >= 0x1d173 && cp <= 0x1d17a) || // MUSICAL SYMBOL BEGIN/END
    (cp >= 0xe0000 && cp <= 0xe0fff) || // tags and VARIATION SELECTOR-17..256
    // `Cf` outside Default_Ignorable_Code_Point: prefixes and marks that
    // take their width from what follows them, and the interlinear
    // annotation characters.
    (cp >= 0x0600 && cp <= 0x0605) ||
    cp === 0x06dd ||
    cp === 0x070f ||
    (cp >= 0x0890 && cp <= 0x0891) ||
    cp === 0x08e2 ||
    cp === 0x110bd ||
    cp === 0x110cd ||
    (cp >= 0x13430 && cp <= 0x1343f) ||
    (cp >= 0xfff9 && cp <= 0xfffb) ||
    // Not ignorable, not `Cf`, and blank all the same.
    cp === 0x2800 // BRAILLE PATTERN BLANK
  );
}

/** Iterates by Unicode scalar value, like Rust's `char::is_deceptive`
 *  over `.chars()` — a surrogate pair is one check, not two. */
export function hasDeceptiveChar(s: string): boolean {
  for (const ch of s) if (isDeceptive(ch.codePointAt(0)!)) return true;
  return false;
}
