import { describe, expect, it } from 'vitest';

import {
  blocksText,
  parseArticle,
  parseChat,
  parseInline,
  schemeAllowed,
  splitChatBlocks,
  type MdBlock,
  type MdRun,
} from '../src/markdown';
import type { NewsReference } from '../src/protocol';

/** A run's styling, as one comparable word. */
const attrs = (r: MdRun): string =>
  [r.bold && 'bold', r.italic && 'italic', r.code && 'code', r.strike && 'strike', r.href !== undefined && 'link', r.ref && 'ref']
    .filter(Boolean)
    .join('+');

const text = (runs: readonly MdRun[]): string => runs.map((r) => r.text).join('');

/** The styled slices of a parse — GtkHx's `styled` helper, over runs. */
const styled = (runs: readonly MdRun[]): [string, string][] =>
  runs.filter((r) => attrs(r)).map((r) => [r.text, attrs(r)]);

const ref = (id: number, over: Partial<NewsReference> = {}): NewsReference => ({
  id,
  subject: `about ${id}`,
  from: 'alice',
  at: 1_789_000_000,
  deleted: false,
  ...over,
});

// The GtkHx scanner's own tests (`hxchat-layout/src/tests.rs`), ported so
// the two implementations are pinned to the same answers. Rust counts in
// bytes and JavaScript in UTF-16 units; these compare rendered text and
// styled slices, which do not care.
describe('chat inline, as GtkHx has it', () => {
  it('leaves plain text alone', () => {
    const p = parseInline('just a normal chat line');
    expect(p).toEqual([{ text: 'just a normal chat line' }]);
  });

  it('draws bold, italic, code and strike', () => {
    const p = parseInline('a **b** c *d* e `f` g ~~h~~');
    expect(text(p)).toBe('a b c d e f g h');
    expect(styled(p)).toEqual([
      ['b', 'bold'],
      ['d', 'italic'],
      ['f', 'code'],
      ['h', 'strike'],
    ]);
  });

  it('nests emphasis', () => {
    const p = parseInline('**bold *and italic* still bold**');
    expect(text(p)).toBe('bold and italic still bold');
    expect(styled(p)).toEqual([
      ['bold ', 'bold'],
      ['and italic', 'bold+italic'],
      [' still bold', 'bold'],
    ]);
  });

  it('never eats a lone delimiter', () => {
    for (const src of ['2 * 3 * 4', 'a ** b', '**unclosed', '*unclosed', '~~unclosed', '`unclosed', 'x_y', 'a_b_c']) {
      expect(parseInline(src), src).toEqual([{ text: src }]);
    }
  });

  it('keeps snake_case and still emphasizes a word-boundary underscore', () => {
    expect(parseInline('call hx_chat_view_append please')).toEqual([{ text: 'call hx_chat_view_append please' }]);
    const p = parseInline('this is _emphatic_ yes');
    expect(text(p)).toBe('this is emphatic yes');
    expect(styled(p)).toEqual([['emphatic', 'italic']]);
  });

  it('lets a code span suppress the rest', () => {
    const p = parseInline('use `a **b** c` here');
    expect(text(p)).toBe('use a **b** c here');
    expect(styled(p)).toEqual([['a **b** c', 'code']]);
  });

  it('closes a code span on a run of the same length', () => {
    expect(styled(parseInline('``hello``'))).toEqual([['hello', 'code']]);
    expect(styled(parseInline('``a `b` c``'))).toEqual([['a `b` c', 'code']]);
    expect(styled(parseInline('```x`y```'))).toEqual([['x`y', 'code']]);
  });

  it('strips one pad space from each side of a code span, and only both', () => {
    expect(styled(parseInline('`` ` ``'))).toEqual([['`', 'code']]);
    expect(text(parseInline('` a `'))).toBe('a');
    expect(text(parseInline('` a`'))).toBe(' a');
  });

  it('skips an unmatched backtick run whole', () => {
    expect(parseInline('``unclosed')).toEqual([{ text: '``unclosed' }]);
    const p = parseInline('``a `b` c');
    expect(text(p)).toBe('``a b c');
    expect(styled(p)).toEqual([['b', 'code']]);
  });

  it('resolves escapes, and keeps a backslash before anything else', () => {
    expect(parseInline('literal \\*stars\\* and \\`ticks\\`')).toEqual([{ text: 'literal *stars* and `ticks`' }]);
    expect(text(parseInline('C:\\path\\to\\file and \\d+'))).toBe('C:\\path\\to\\file and \\d+');
  });

  it('links an allowed scheme', () => {
    const p = parseInline('see [the docs](https://example.com/x) ok');
    expect(p).toEqual([{ text: 'see ' }, { text: 'the docs', href: 'https://example.com/x' }, { text: ' ok' }]);
  });

  it('renders a disallowed scheme literally', () => {
    for (const src of [
      '[click](javascript:alert(1))',
      '[click](data:text/html;base64,xx)',
      '[click](file:///etc/passwd)',
      '[click](vbscript:x)',
    ]) {
      expect(parseInline(src), src).toEqual([{ text: src }]);
    }
  });

  it('keeps a label and a destination that disagree, for the reader to see', () => {
    expect(parseInline('[https://good.example](https://evil.example)')).toEqual([
      { text: 'https://good.example', href: 'https://evil.example' },
    ]);
  });

  it('draws no image: `![]()` in chat is a `!` and a link', () => {
    const p = parseInline('![alt](https://example.com/x.png)');
    expect(p).toEqual([{ text: '!' }, { text: 'alt', href: 'https://example.com/x.png' }]);
  });

  it('keeps the style under a URL, for autolinking to link within', () => {
    expect(parseInline('**see https://example.com ok**')).toEqual([{ text: 'see https://example.com ok', bold: true }]);
    expect(parseInline('**bold**plain')).toEqual([{ text: 'bold', bold: true }, { text: 'plain' }]);
  });

  it('does not split a surrogate pair', () => {
    expect(parseInline('**héllo → wörld 😀**')).toEqual([{ text: 'héllo → wörld 😀', bold: true }]);
    expect(text(parseInline('\\😀 *😀*'))).toBe('\\😀 😀');
  });

  it('terminates on pathological input', () => {
    for (const src of [
      '*'.repeat(2000),
      '**'.repeat(1000),
      '`'.repeat(1000),
      '['.repeat(1000),
      '~~'.repeat(1000),
      '\\'.repeat(1000),
      `${'**'.repeat(64)}text${'**'.repeat(64)}`,
    ]) {
      expect(text(parseInline(src)).length).toBeLessThanOrEqual(src.length);
    }
  });

  it('checks schemes the way GtkHx does', () => {
    expect(schemeAllowed(' HTTPS://x')).toBe(true);
    expect(schemeAllowed('hotline://server')).toBe(true);
    expect(schemeAllowed('mailto:a@b')).toBe(true);
    expect(schemeAllowed('news:51')).toBe(false);
    expect(schemeAllowed('javascript:alert(1)')).toBe(false);
  });
});

describe('chat blocks, as GtkHx has them', () => {
  it('has no headings, rules or lists', () => {
    for (const src of ['# not a heading', '--- not a rule', '=== nope', '1. not a list', '- nor this']) {
      expect(splitChatBlocks(src)).toEqual([{ kind: 'paragraph', text: src }]);
    }
  });

  it('splits out a fenced block', () => {
    expect(splitChatBlocks('before\n```rust\nlet x = **y**;\n```\nafter')).toEqual([
      { kind: 'paragraph', text: 'before' },
      { kind: 'code', text: 'let x = **y**;', language: 'rust' },
      { kind: 'paragraph', text: 'after' },
    ]);
    expect(splitChatBlocks('before\n```rust\nlet x = 1;\nlet y = 2;\n```\nafter')[1]).toEqual({
      kind: 'code',
      text: 'let x = 1;\nlet y = 2;',
      language: 'rust',
    });
  });

  it('runs an unterminated fence to the end', () => {
    expect(splitChatBlocks('```\nstill typing')).toEqual([{ kind: 'code', text: 'still typing', language: null }]);
  });

  it('reads a one-line fence as a code block, not as an opening', () => {
    expect(splitChatBlocks('```hello world```')).toEqual([{ kind: 'code', text: 'hello world', language: null }]);
  });

  it('gathers quote lines of one depth', () => {
    expect(splitChatBlocks('> a\n> b\nnormal')).toEqual([
      { kind: 'quote', text: 'a\nb', depth: 1 },
      { kind: 'paragraph', text: 'normal' },
    ]);
    expect(splitChatBlocks('> a\n>> b')).toEqual([
      { kind: 'quote', text: 'a', depth: 1 },
      { kind: 'quote', text: 'b', depth: 2 },
    ]);
  });

  it('parses a line into blocks, with a quote nested as deep as it says', () => {
    expect(parseChat('> > **hi**\r\n`x`')).toEqual<MdBlock[]>([
      { type: 'quote', children: [{ type: 'quote', children: [{ type: 'paragraph', content: [{ text: 'hi', bold: true }] }] }] },
      { type: 'paragraph', content: [{ text: 'x', code: true }] },
    ]);
    expect(parseChat('```js\n**not bold**\n```')).toEqual([{ type: 'code', text: '**not bold**', language: 'js' }]);
  });

  it('caps a quote thousands deep', () => {
    const blocks = parseChat(`${'>'.repeat(5000)} deep`);
    let depth = 0;
    let b: MdBlock | undefined = blocks[0];
    while (b?.type === 'quote') {
      depth++;
      b = b.children[0];
    }
    expect(depth).toBe(8);
    expect(b).toEqual({ type: 'paragraph', content: [{ text: 'deep' }] });
  });
});

/**
 * GtkHx's scanner, ported straight across with none of the memoization:
 * the oracle the real one is fuzzed against. Its searches rescan from
 * every opener, which is the cost the real one does not pay, and nothing
 * else.
 */
function oracle(src: string): { text: string; a: string; href?: string }[] {
  type P = { text: string; a: number; link: number; href?: string };
  const out: P[] = [];
  let links = 0;
  const push = (t: string, a: number, link: number, href?: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.a === a && last.link === link) last.text += t;
    else out.push({ text: t, a, link, href });
  };
  const ws = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
  const alnum = (c: string | undefined) => c !== undefined && /[0-9A-Za-z]/.test(c);
  const run = (s: string, at: number) => {
    let k = at;
    while (s[k] === '`') k++;
    return k - at;
  };
  const codeSpan = (s: string, at: number): [number, number, number] | null => {
    const n = run(s, at);
    let j = at + n;
    while (j < s.length) {
      if (s[j] === '`') {
        const m = run(s, j);
        if (m === n) return [at + n, j, j + m];
        j += m;
        continue;
      }
      j++;
    }
    return null;
  };
  const canOpen = (s: string, after: number) => after < s.length && !ws(s[after]);
  const canClose = (s: string, at: number) => at > 0 && !ws(s[at - 1]);
  const findDelim = (s: string, from: number, d: string) => {
    let i = from;
    while (i + d.length <= s.length) {
      if (s[i] === '\\') {
        i += 2;
        continue;
      }
      if (s[i] === '`') {
        const cs = codeSpan(s, i);
        if (!cs) return -1;
        i = cs[2];
        continue;
      }
      if (s.startsWith(d, i)) {
        if (i === from || !canClose(s, i)) {
          i += d.length;
          continue;
        }
        return i;
      }
      i++;
    }
    return -1;
  };
  const findItalic = (s: string, from: number, open: string) => {
    let i = from;
    while (i < s.length) {
      if (s[i] === '\\') {
        i += 2;
        continue;
      }
      if (s[i] === '`') {
        const cs = codeSpan(s, i);
        if (!cs) return -1;
        i = cs[2];
        continue;
      }
      if (s[i] === open) {
        if (s[i + 1] === open) {
          i += 2;
          continue;
        }
        if (i === from || !canClose(s, i) || (open === '_' && alnum(s[i + 1]))) {
          i++;
          continue;
        }
        return i;
      }
      i++;
    }
    return -1;
  };
  const parseLink = (s: string, open: number) => {
    let i = open + 1;
    let depth = 1;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']' && --depth === 0) break;
      i++;
    }
    if (depth !== 0 || i >= s.length || s[i + 1] !== '(') return null;
    let j = i + 2;
    while (j < s.length && s[j] !== ')') {
      if (s[j] === '\\') {
        j += 2;
        continue;
      }
      if (ws(s[j])) return null;
      j++;
    }
    if (j >= s.length) return null;
    const label = s.slice(open + 1, i);
    const href = s.slice(i + 2, j);
    return label && href ? { label, href, end: j + 1 } : null;
  };
  const scan = (s: string, a: number, link: number, href: string | undefined, depth: number) => {
    let i = 0;
    let lit = 0;
    const flush = (upto: number) => {
      if (upto > lit) push(s.slice(lit, upto), a, link, href);
    };
    while (i < s.length) {
      const c = s[i]!;
      if (c === '\\' && i + 1 < s.length) {
        if ('\\*_`~[]()>#'.includes(s[i + 1]!)) {
          flush(i);
          push(s[i + 1]!, a, link, href);
          i += 2;
          lit = i;
          continue;
        }
        i++;
        continue;
      }
      if (c === '`') {
        const cs = codeSpan(s, i);
        if (cs) {
          flush(i);
          const inner = s.slice(cs[0], cs[1]);
          const padded = inner.length >= 2 && inner[0] === ' ' && inner.endsWith(' ') && /[^ ]/.test(inner);
          push(padded ? inner.slice(1, -1) : inner, a | 4, link, href);
          i = cs[2];
          lit = i;
          continue;
        }
        i += run(s, i);
        continue;
      }
      if (depth < 8) {
        const two = c === '*' && s[i + 1] === '*' ? ['**', 1] : c === '~' && s[i + 1] === '~' ? ['~~', 8] : null;
        if (two) {
          if (canOpen(s, i + 2)) {
            const close = findDelim(s, i + 2, two[0] as string);
            if (close >= 0) {
              flush(i);
              scan(s.slice(i + 2, close), a | (two[1] as number), link, href, depth + 1);
              i = close + 2;
              lit = i;
              continue;
            }
          }
          i += 2;
          continue;
        }
        const wordOk = i === 0 || !alnum(s[i - 1]);
        if ((c === '*' && canOpen(s, i + 1)) || (c === '_' && canOpen(s, i + 1) && wordOk && s[i + 1] !== '_')) {
          const close = findItalic(s, i + 1, c);
          if (close >= 0) {
            flush(i);
            scan(s.slice(i + 1, close), a | 2, link, href, depth + 1);
            i = close + 1;
            lit = i;
            continue;
          }
          i++;
          continue;
        }
        if (c === '[') {
          const l = parseLink(s, i);
          if (l && schemeAllowed(l.href)) {
            flush(i);
            scan(l.label, a, ++links, l.href, 8);
            i = l.end;
            lit = i;
            continue;
          }
          i++;
          continue;
        }
      }
      i++;
    }
    flush(s.length);
  };
  scan(src, 0, 0, undefined, 0);
  const names = ['bold', 'italic', 'code', 'strike'];
  return out.map((p) => ({
    text: p.text,
    a: [...names.filter((_, k) => p.a & (k === 3 ? 8 : 1 << k)), ...(p.href !== undefined ? ['link'] : [])].join('+'),
    ...(p.href !== undefined ? { href: p.href } : {}),
  }));
}

/** Runs as the oracle reports them: one per style and link, adjacent
 *  equal ones merged. */
function flat(runs: readonly MdRun[]): { text: string; a: string; href?: string }[] {
  const out: { text: string; a: string; href?: string }[] = [];
  for (const r of runs) {
    const a = attrs(r);
    const last = out[out.length - 1];
    if (last && last.a === a && last.href === r.href) last.text += r.text;
    else out.push({ text: r.text, a, ...(r.href !== undefined ? { href: r.href } : {}) });
  }
  return out;
}

describe('the memoized scanner', () => {
  it('agrees with a straight port of GtkHx on random input', () => {
    // Seeded, so a failure is the same failure on the next run.
    let seed = 0x2f6e2b1;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ['*', '*', '**', '_', '~', '~~', '`', '``', '[', ']', '(', ')', '](', '\\', ' ', 'a', 'b', '\n', '!', 'https://x', 'javascript:', '#1', 'é'];
    for (let n = 0; n < 20000; n++) {
      let src = '';
      const len = 1 + rand(24);
      for (let k = 0; k < len; k++) src += alphabet[rand(alphabet.length)];
      expect(flat(parseInline(src)), JSON.stringify(src)).toEqual(oracle(src));
    }
  });

  it('stays fast where a naive scan goes quadratic', () => {
    // Every opener here searches to the end of the text and fails; a scan
    // that forgets what it learned pays that once per opener.
    for (const src of [
      '*a '.repeat(20000),
      '_a '.repeat(20000),
      '** a'.repeat(15000),
      '['.repeat(60000),
      '[a](bbb'.repeat(9000),
      '`a``b'.repeat(12000),
      '*'.repeat(5000),
    ]) {
      const started = performance.now();
      parseInline(src);
      parseArticle(src, []);
      expect(performance.now() - started, src.slice(0, 12)).toBeLessThan(2000);
    }
  });
});

describe('articles', () => {
  it('reads paragraphs, and keeps a line break inside one', () => {
    expect(parseArticle('one\n  two\n\nthree', [])).toEqual<MdBlock[]>([
      { type: 'paragraph', content: [{ text: 'one\ntwo' }] },
      { type: 'paragraph', content: [{ text: 'three' }] },
    ]);
  });

  it('reads ATX and setext headings', () => {
    expect(parseArticle('# One\n### Three ###\n####### seven\n#51 and #tag', [])).toEqual<MdBlock[]>([
      { type: 'heading', level: 1, content: [{ text: 'One' }] },
      { type: 'heading', level: 3, content: [{ text: 'Three' }] },
      { type: 'paragraph', content: [{ text: '####### seven\n#51 and #tag' }] },
    ]);
    expect(parseArticle('Title\n=====\nSub *it*\n---', [])).toEqual<MdBlock[]>([
      { type: 'heading', level: 1, content: [{ text: 'Title' }] },
      { type: 'heading', level: 2, content: [{ text: 'Sub ' }, { text: 'it', italic: true }] },
    ]);
  });

  it('reads thematic breaks', () => {
    expect(parseArticle('a\n\n---\n* * *\n___', [])).toEqual<MdBlock[]>([
      { type: 'paragraph', content: [{ text: 'a' }] },
      { type: 'rule' },
      { type: 'rule' },
      { type: 'rule' },
    ]);
  });

  it('reads bullet and ordered lists, nested, tight and loose', () => {
    expect(parseArticle('- one\n- two\n  - inner\n  - more\n- three', [])).toEqual<MdBlock[]>([
      {
        type: 'list',
        ordered: false,
        start: 1,
        tight: true,
        items: [
          [{ type: 'paragraph', content: [{ text: 'one' }] }],
          [
            { type: 'paragraph', content: [{ text: 'two' }] },
            {
              type: 'list',
              ordered: false,
              start: 1,
              tight: true,
              items: [[{ type: 'paragraph', content: [{ text: 'inner' }] }], [{ type: 'paragraph', content: [{ text: 'more' }] }]],
            },
          ],
          [{ type: 'paragraph', content: [{ text: 'three' }] }],
        ],
      },
    ]);
    const ordered = parseArticle('3) three\n\n4) four', []);
    expect(ordered).toMatchObject([{ type: 'list', ordered: true, start: 3, tight: false }]);
    // A different bullet is a different list.
    expect(parseArticle('- a\n+ b', []).map((b) => b.type)).toEqual(['list', 'list']);
    // An ordered item not starting at 1 does not cut a sentence short.
    expect(parseArticle('It happened in\n2011. Then', [])).toEqual([{ type: 'paragraph', content: [{ text: 'It happened in\n2011. Then' }] }]);
  });

  it('reads block quotes, with lazy continuation and blocks inside', () => {
    expect(parseArticle('> quoted\nlazy\n> - item\n\nafter', [])).toEqual<MdBlock[]>([
      {
        type: 'quote',
        children: [
          { type: 'paragraph', content: [{ text: 'quoted\nlazy' }] },
          { type: 'list', ordered: false, start: 1, tight: true, items: [[{ type: 'paragraph', content: [{ text: 'item' }] }]] },
        ],
      },
      { type: 'paragraph', content: [{ text: 'after' }] },
    ]);
  });

  it('reads fenced and indented code, and nothing inside it', () => {
    expect(parseArticle('```sh\n$ echo **#51**\n```\n~~~\nx\n~~~\n\n    indented *no*\n\n    more', [ref(51)])).toEqual<MdBlock[]>([
      { type: 'code', text: '$ echo **#51**', language: 'sh' },
      { type: 'code', text: 'x' },
      { type: 'code', text: 'indented *no*\n\nmore' },
    ]);
    expect(parseArticle('```\nunterminated\n\nstill code', [])).toEqual([{ type: 'code', text: 'unterminated\n\nstill code' }]);
    // A one-line fence is a code span in a paragraph, as CommonMark says.
    expect(parseArticle('```x```', [])).toEqual([{ type: 'paragraph', content: [{ text: 'x', code: true }] }]);
  });

  it('reads pipe tables', () => {
    expect(parseArticle('| size | bytes |\n|:---|---:|\n| full | **412000** |\n| a \\| b |', [])).toEqual<MdBlock[]>([
      {
        type: 'table',
        align: ['left', 'right'],
        head: [[{ text: 'size' }], [{ text: 'bytes' }]],
        rows: [
          [[{ text: 'full' }], [{ text: '412000', bold: true }]],
          [[{ text: 'a | b' }], []],
        ],
      },
    ]);
    // A delimiter row whose count does not match is no table.
    expect(parseArticle('a | b\n--- | --- | ---', []).map((b) => b.type)).toEqual(['paragraph']);
  });

  it('draws images and raw HTML as the characters typed', () => {
    expect(parseArticle('![pixel](https://tracker.example/p.gif) <b>x</b>', [])).toEqual([
      { type: 'paragraph', content: [{ text: '![pixel](https://tracker.example/p.gif) <b>x</b>' }] },
    ]);
  });

  it('links a news: reference only when the server resolved it', () => {
    const r51 = ref(51);
    expect(parseArticle('[the sizes](news:51), [gone](news:99), [bad](news:5x), [js](javascript:x)', [r51])).toEqual([
      {
        type: 'paragraph',
        content: [{ text: 'the sizes', ref: r51 }, { text: ', gone, [bad](news:5x), [js](javascript:x)' }],
      },
    ]);
  });

  it('links #51 in prose, in any emphasis, and never in code', () => {
    const r51 = ref(51);
    expect(parseArticle('See #51, **#51**, `#51` and #99.', [r51])).toEqual([
      {
        type: 'paragraph',
        content: [
          { text: 'See ' },
          { text: '#51', ref: r51 },
          { text: ', ' },
          { text: '#51', bold: true, ref: r51 },
          { text: ', ' },
          { text: '#51', code: true },
          { text: ' and #99.' },
        ],
      },
    ]);
    // With nothing resolved, nothing is looked for.
    expect(parseArticle('#51', [])).toEqual([{ type: 'paragraph', content: [{ text: '#51' }] }]);
  });

  it('flattens to its words for an excerpt', () => {
    const blocks = parseArticle('# News\n\n**Bold** and [a link](https://x).\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |', []);
    expect(blocksText(blocks)).toBe('News\nBold and a link.\none\ntwo\na b\n1 2');
  });

  it('survives five thousand asterisks, and nesting thousands deep', () => {
    // On a line of its own that is a thematic break, as CommonMark has it.
    // After a word it is a paragraph of asterisks — GtkHx reads `****` as
    // bold around `**`, and the fuzzing above holds this to the same
    // answer, so what matters here is only that it ends, and ends as one
    // paragraph of nothing but what was typed.
    const stars = '*'.repeat(5000);
    expect(parseArticle(stars, [])).toEqual([{ type: 'rule' }]);
    for (const blocks of [parseArticle(`x${stars}`, []), parseChat(stars)]) {
      expect(blocks).toHaveLength(1);
      const runs = (blocks[0] as { content: MdRun[] }).content;
      expect(text(runs)).toMatch(/^x?\*+$/);
    }

    // How many containers deep the first chain of them goes. An item may
    // hold its text before the list nested in it, so follow the first
    // container among a level's blocks rather than the first block.
    const container = (bs: readonly MdBlock[] | undefined) => bs?.find((c) => c.type === 'quote' || c.type === 'list');
    const depthOf = (blocks: MdBlock[]): number => {
      let d = 0;
      let b = container(blocks);
      while (b && (b.type === 'quote' || b.type === 'list')) {
        d++;
        b = container(b.type === 'quote' ? b.children : b.items[0]);
      }
      return d;
    };
    const started = performance.now();
    const quotes = parseArticle(`${'>'.repeat(5000)} deep\n${'lazy\n'.repeat(5000)}`, []);
    expect(depthOf(quotes)).toBe(17);
    const bullets = parseArticle(`${'- '.repeat(5000)}x`, []);
    expect(depthOf(bullets)).toBe(17);
    const indented = parseArticle(Array.from({ length: 300 }, (_, k) => `${'  '.repeat(k)}- level ${k}`).join('\n'), []);
    expect(depthOf(indented)).toBe(17);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
