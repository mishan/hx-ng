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
    // GtkHx steps past the `[` and reads on, so a label's emphasis is
    // still drawn between the literal brackets. Its chat-view.md says
    // the whole construct is literal; its scanner, which this ports,
    // does this.
    expect(parseInline('[**x**](javascript:y)')).toEqual([{ text: '[' }, { text: 'x', bold: true }, { text: '](javascript:y)' }]);
  });

  it('has no raw HTML: a tag is characters, and markdown inside it is read', () => {
    expect(styled(parseInline('<b title="**x**">'))).toEqual([['x', 'bold']]);
    expect(parseInline('<b>').some((r) => r.html)).toBe(false);
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
        // A short row is as short as it was written; the renderer draws
        // what it lacks.
        rows: [[[{ text: 'full' }], [{ text: '412000', bold: true }]], [[{ text: 'a | b' }]]],
      },
    ]);
    // A delimiter row whose count does not match is no table.
    expect(parseArticle('a | b\n--- | --- | ---', []).map((b) => b.type)).toEqual(['paragraph']);
    // Nor is one wider than any reader could use.
    const wide = (c: number) => `${'|a'.repeat(c)}|\n${'|-'.repeat(c)}|\nx`;
    expect(parseArticle(wide(64), [])).toMatchObject([{ type: 'table', rows: [[[{ text: 'x' }]]] }]);
    expect(parseArticle(wide(65), []).map((b) => b.type)).toEqual(['paragraph']);
  });

  it('stays fast on a wide table over many short rows', () => {
    // Padding each row to the head's width made this columns times rows,
    // for every reader of a small body and every listing that showed it.
    const table = (cols: number, rows: string) => `${'|a'.repeat(cols)}|\n${'|-'.repeat(cols)}|\n${rows}`;
    const started = performance.now();
    for (const src of [
      table(4000, 'x\n'.repeat(4000)),
      table(64, 'x\n'.repeat(100000)),
      table(64, `${'|x'.repeat(10000)}|\n`.repeat(20)),
    ]) {
      blocksText(parseArticle(src, []));
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('draws an image as a link to it, and raw HTML as the characters typed', () => {
    expect(parseArticle('![pixel](https://tracker.example/p.gif) <b>x</b>', [])).toEqual([
      {
        type: 'paragraph',
        content: [
          { text: 'pixel', href: 'https://tracker.example/p.gif' },
          { text: ' ' },
          { text: '<b>', html: true },
          { text: 'x' },
          { text: '</b>', html: true },
        ],
      },
    ]);
  });

  it('reads a tag as the server does: prose between tags, nothing inside one', () => {
    const r51 = ref(51);
    const runs = (src: string) => (parseArticle(src, [r51])[0] as { content: MdRun[] }).content;
    expect(runs('<b>#51</b> <a title="#51 *x*" href="https://x.example">')).toEqual([
      { text: '<b>', html: true },
      { text: '#51', ref: r51 },
      { text: '</b>', html: true },
      { text: ' ' },
      { text: '<a title="#51 *x*" href="https://x.example">', html: true },
    ]);
    // Every inline shape CommonMark has, and each is one piece. After a
    // word, so that none of them opens an HTML block.
    for (const tag of ['<!-- #51 -->', '<!-->', '<!--->', '<? #51 ?>', '<!DOCTYPE #51>', '<![CDATA[ #51 ]]>', '</a >', '<br/>', "<x a='#51' b=c>"]) {
      expect(runs(`x ${tag} #51`), tag).toEqual([{ text: 'x ' }, { text: tag, html: true }, { text: ' ' }, { text: '#51', ref: r51 }]);
    }
    // Things that only look like tags are prose, and a `#51` in them is
    // linked as anywhere else.
    for (const src of ['a < b #51', 'x <3 #51', 'x <b #51', 'x <a title="x #51', 'x <!-- #51', 'x <!1 #51>']) {
      const got = runs(src);
      expect(got.some((r) => r.html), src).toBe(false);
      expect(text(got), src).toBe(src);
      expect(got.filter((r) => r.ref).map((r) => r.text), src).toEqual(['#51']);
    }
    // An autolink is a link, not a tag.
    expect(runs('<https://x.example> #51')).toEqual([
      { text: 'https://x.example', href: 'https://x.example' },
      { text: ' ' },
      { text: '#51', ref: r51 },
    ]);
    // Code wins over a tag, as it does over everything.
    expect(runs('`<b>`')).toEqual([{ text: '<b>', code: true }]);
  });

  it('lets a tag bind tighter than emphasis and brackets, as CommonMark does', () => {
    const r51 = ref(51);
    const runs = (src: string) => (parseArticle(src, [r51])[0] as { content: MdRun[] }).content;
    // The closer inside the attribute closes nothing, and the tag stays
    // whole: no italic cut off at a quote, no `#51` linked in a title.
    expect(runs('*x <a title="*#51"> y* and #51')).toEqual([
      { text: 'x ', italic: true },
      { text: '<a title="*#51">', italic: true, html: true },
      { text: ' y', italic: true },
      { text: ' and ' },
      { text: '#51', ref: r51 },
    ]);
    expect(runs('**x <a title="**#51"> y** and #51')).toEqual([
      { text: 'x ', bold: true },
      { text: '<a title="**#51">', bold: true, html: true },
      { text: ' y', bold: true },
      { text: ' and ' },
      { text: '#51', ref: r51 },
    ]);
    // A bracket inside a tag pairs with nothing outside it.
    const href = 'https://x.example';
    expect(runs(`[x <a title="]"> y](${href})`)).toEqual([
      { text: 'x ', href },
      { text: '<a title="]">', html: true, href },
      { text: ' y', href },
    ]);
    // An autolink binds as tightly.
    expect(runs('*a <https://x.example/*> b*')).toEqual([
      { text: 'a ', italic: true },
      { text: 'https://x.example/*', italic: true, href: 'https://x.example/*' },
      { text: ' b', italic: true },
    ]);
    // Chat has no tags, and GtkHx's answer is unchanged.
    expect(styled(parseInline('*x <a title="*#51"> y*'))).toEqual([['x <a title="', 'italic']]);
  });

  it('reads an HTML block as the server does: opaque, to where it ends', () => {
    const r51 = ref(51);
    expect(parseArticle('<div>\n**bold** #51 https://x.example\n</div>\n\nafter #51', [r51])).toEqual<MdBlock[]>([
      { type: 'html', text: '<div>\n**bold** #51 https://x.example\n</div>' },
      { type: 'paragraph', content: [{ text: 'after ' }, { text: '#51', ref: r51 }] },
    ]);
    // Block markers inside one are its text too.
    expect(parseArticle('<div>\n# heading\n> quote\n- item\n</div>', [])).toEqual([
      { type: 'html', text: '<div>\n# heading\n> quote\n- item\n</div>' },
    ]);
    // Each of the seven kinds, and where each ends: the first five at a
    // line holding their end, blank lines and all; the last two at a
    // blank line.
    for (const [src, html] of [
      ['<script>\n*a*\n\n*b* </script> x\n*c*', '<script>\n*a*\n\n*b* </script> x'],
      ['<!-- #51\n\n-->\n*c*', '<!-- #51\n\n-->'],
      ['<?php #51\n\n?>\n*c*', '<?php #51\n\n?>'],
      ['<!DOCTYPE html>\n*c*', '<!DOCTYPE html>'],
      ['<![CDATA[\n\n]]>\n*c*', '<![CDATA[\n\n]]>'],
      ['<TABLE><tr><td>\n#51\n\n*c*', '<TABLE><tr><td>\n#51'],
      ['<custom-tag a="#51">\n#51\n\n*c*', '<custom-tag a="#51">\n#51'],
    ]) {
      const blocks = parseArticle(src!, [r51]);
      expect(blocks[0], src).toEqual({ type: 'html', text: html });
      expect(blocks.slice(1), src).toEqual([{ type: 'paragraph', content: [{ text: 'c', italic: true }] }]);
    }
    // Unended, it runs to the end of what contains it.
    expect(parseArticle('<!--\n*a*\n\n*b*', [])).toEqual([{ type: 'html', text: '<!--\n*a*\n\n*b*' }]);
    // The first six cut a paragraph short. The seventh, a tag alone on its
    // line, does not, and is an inline tag in the paragraph it is in.
    expect(parseArticle('text\n<div>\n#51', [r51])).toEqual<MdBlock[]>([
      { type: 'paragraph', content: [{ text: 'text' }] },
      { type: 'html', text: '<div>\n#51' },
    ]);
    expect(parseArticle('text\n<custom>\n#51', [r51])).toEqual([
      { type: 'paragraph', content: [{ text: 'text\n' }, { text: '<custom>', html: true }, { text: '\n' }, { text: '#51', ref: r51 }] },
    ]);
    // In a container as anywhere else, and in the excerpt as typed.
    expect(parseArticle('> <div>\n> *x*', [])).toEqual([{ type: 'quote', children: [{ type: 'html', text: '<div>\n*x*' }] }]);
    expect(blocksText(parseArticle('<p>\nhi\n</p>', []))).toBe('<p>\nhi\n</p>');
    // Chat has no HTML blocks; GtkHx reads the markdown in them.
    expect(parseChat('<div>\n**b**')).toEqual([{ type: 'paragraph', content: [{ text: '<div>\n' }, { text: 'b', bold: true }] }]);
  });

  it('reads CommonMark destinations in an article: parentheses, angle brackets, titles', () => {
    const runs = (src: string) => (parseArticle(src, [])[0] as { content: MdRun[] }).content;
    expect(runs('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      { text: 'Foo', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
    ]);
    expect(runs('[a](<https://x.example/a b>)')).toEqual([{ text: 'a', href: 'https://x.example/a b' }]);
    expect(runs(`[a](https://x.example "t") [b](https://y.example 't') [c]( https://z.example\n(t) )`)).toEqual([
      { text: 'a', href: 'https://x.example' },
      { text: ' ' },
      { text: 'b', href: 'https://y.example' },
      { text: ' ' },
      { text: 'c', href: 'https://z.example' },
    ]);
    // Escapes and character references are resolved in a destination.
    expect(runs('[a](https://x.example/\\(x&amp;y "a \\" b")')).toEqual([{ text: 'a', href: 'https://x.example/(x&y' }]);
    // Unbalanced, or with anything after the title, it is no link.
    for (const src of ['[a](https://x.example/(b)', '[a](https://x.example "t" x)', '[a](<https://x.example)']) {
      expect(runs(src).some((r) => r.href !== undefined), src).toBe(false);
    }
    // Chat keeps GtkHx's reading, which ends at the first `)`.
    expect(parseInline('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      { text: 'Foo', href: 'https://en.wikipedia.org/wiki/Foo_(bar' },
      { text: ')' },
    ]);
  });

  it('reads a reference in every form the server records one', () => {
    const r51 = ref(51);
    const one = [{ type: 'paragraph', content: [{ text: 't', ref: r51 }] }];
    for (const src of [
      '[t](news:51 "t")',
      '[t](<news:51>)',
      '[t](NEWS:51)',
      '![t](news:51)',
      '[t][1]\n\n[1]: news:51',
      '[1]: news:51\n[t][1]',
      '[t][]\n\n[T]: news:51',
      '[t]\n\n[t]: <news:51> "a title"',
      '[t]\n\n[t]:\nnews:51\n"a title on its own line"',
      '[t][x y]\n\n[X  Y]: news:51',
      '[t]\n\n[t]: news:51\n[t]: https://x.example',
      '![t][p]\n\n[p]: news:51',
    ]) {
      expect(parseArticle(src, [r51]), src).toEqual(one);
    }
    const runs = (src: string) => (parseArticle(src, [r51])[0] as { content: MdRun[] }).content;
    expect(runs('<news:51> and <NEWS:51>')).toEqual([
      { text: 'news:51', ref: r51 },
      { text: ' and ' },
      { text: 'NEWS:51', ref: r51 },
    ]);
    expect(runs('&#35;51, &#x23;51 and &num;51')).toEqual([
      { text: '#51', ref: r51 },
      { text: ', ' },
      { text: '#51', ref: r51 },
      { text: ' and ' },
      { text: '#51', ref: r51 },
    ]);
    // Undefined, a reference is the characters typed; followed by a
    // label, never a shortcut.
    expect(runs('[t] [t][nope]\n\n[x]: news:51')).toEqual([{ text: '[t] [t][nope]' }]);
  });

  it('links the plain URL forms, an image included, and fetches nothing', () => {
    const runs = (src: string) => (parseArticle(src, [])[0] as { content: MdRun[] }).content;
    expect(runs('<https://x.example/a> <mailto:a@b.example> <a@b.example>')).toEqual([
      { text: 'https://x.example/a', href: 'https://x.example/a' },
      { text: ' ' },
      { text: 'mailto:a@b.example', href: 'mailto:a@b.example' },
      { text: ' ' },
      { text: 'a@b.example', href: 'mailto:a@b.example' },
    ]);
    expect(runs('![alt](https://x.example/p.png) and [site][s]\n\n[s]: &#104;ttps://x.example')).toEqual([
      { text: 'alt', href: 'https://x.example/p.png' },
      { text: ' and ' },
      { text: 'site', href: 'https://x.example' },
    ]);
    // Escaped, the `!` is text and what follows it an ordinary link.
    expect(runs('\\![alt](https://x.example/p.png)')).toEqual([{ text: '!' }, { text: 'alt', href: 'https://x.example/p.png' }]);
  });

  it('decodes numeric character references and a common handful of named ones', () => {
    const runs = (src: string) => (parseArticle(src, [])[0] as { content: MdRun[] }).content;
    // `&lt;b&gt;` is the characters of a tag, not one; an unknown name
    // and one this client does not carry both stay as typed; code is
    // code.
    expect(runs('&amp; &lt;b&gt; &copy; &mdash; &#x1F600; &#0; &frac12; &bogus; \\&amp; `&amp;`')).toEqual([
      { text: '& <b> © — 😀 \uFFFD &frac12; &bogus; &amp; ' },
      { text: '&amp;', code: true },
    ]);
    // Chat has none.
    expect(parseInline('&amp;')).toEqual([{ text: '&amp;' }]);
  });

  it('holds every new way to a link to the same allowlist', () => {
    // Refused, each is exactly what was typed.
    for (const src of [
      '<javascript:alert(1)>',
      'x <JAVASCRIPT:alert(1)>',
      '![x](javascript:alert(1))',
      '[x](<javascript:alert(1)>)',
      '[x](javascript:alert(1) "t")',
      '[x](&#106;avascript:alert(1))',
      '[x](&#x6A;avascript&colon;alert(1))',
      '[x](data:text/html,<script>alert(1)</script>)',
    ]) {
      expect(parseArticle(src, []), src).toEqual([{ type: 'paragraph', content: [{ text: src }] }]);
    }
    // A definition is not drawn, and a reference to a refused one is the
    // reference as typed.
    for (const [src, shown] of [
      ['[x]\n\n[x]: javascript:alert(1)', '[x]'],
      ['[x][y]\n\n[y]: &#106;avascript:alert(1)', '[x][y]'],
      ['[x]\n\n[x]: <java&#115;cript&#58;alert(1)>', '[x]'],
      ['![x][y]\n\n[y]: data:image/png;base64,AAAA', '![x][y]'],
      ['[x][]\n\n[x]: vbscript:msgbox', '[x][]'],
    ]) {
      expect(parseArticle(src!, []), src).toEqual([{ type: 'paragraph', content: [{ text: shown }] }]);
    }
  });

  it('never makes a link the allowlist refuses, on random input', () => {
    // Seeded, so a failure is the same failure on the next run.
    let seed = 0x51f00d;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ['[', ']', '(', ')', '<', '>', '!', ':', '\n', ' ', '"', '\\', '&#106;', '&colon;', '&#x', ';', '*', '`', 'java', 'script', 'news', 'https', '//x', '51', '#', 'a', '[a]: '];
    const runsOf = (blocks: readonly MdBlock[]): MdRun[] =>
      blocks.flatMap((b): MdRun[] => {
        switch (b.type) {
          case 'paragraph':
          case 'heading':
            return b.content;
          case 'quote':
            return runsOf(b.children);
          case 'list':
            return b.items.flatMap(runsOf);
          case 'table':
            return [...b.head, ...b.rows.flat()].flat();
          default:
            return [];
        }
      });
    const r51 = ref(51);
    for (let n = 0; n < 20000; n++) {
      let src = '';
      const len = 1 + rand(30);
      for (let k = 0; k < len; k++) src += alphabet[rand(alphabet.length)];
      for (const r of runsOf(parseArticle(src, [r51]))) {
        if (r.href !== undefined) expect(schemeAllowed(r.href), JSON.stringify(src)).toBe(true);
        if (r.ref) expect(r.ref, JSON.stringify(src)).toBe(r51);
      }
    }
  });

  it('stays fast on links and references that never close', () => {
    const started = performance.now();
    for (const src of [
      '[a](<b'.repeat(9000),
      '[a](b "'.repeat(9000),
      '[a](b ('.repeat(9000),
      '[a]((('.repeat(9000),
      `${'[a]('.repeat(9000)}${')'.repeat(9000)}`,
      '<a:'.repeat(20000),
      '<a@'.repeat(20000),
      '&#'.repeat(20000),
      '*<a:b>'.repeat(10000),
      '[<a:b>'.repeat(10000),
      `${'[a]: b\n'.repeat(5000)}[a]`,
      `${'[a]'.repeat(20000)}\n\n[a]: https://x.example`,
      `[a]: b "${'x\n'.repeat(20000)}`,
    ]) {
      parseInline(src, { refs: [] });
      parseArticle(src, []);
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('draws a link with a disallowed scheme as it was typed, label and all', () => {
    expect(parseArticle('[**x**](javascript:y), [*y*](news:99) and [#51](data:z)', [ref(51)])).toEqual([
      // An unresolved `news:` link is its label, as typed; a label is
      // never read for emphasis.
      { type: 'paragraph', content: [{ text: '[**x**](javascript:y), *y* and [' }, { text: '#51', ref: ref(51) }, { text: '](data:z)' }] },
    ]);
  });

  it('stays fast on raw HTML that never closes', () => {
    const started = performance.now();
    for (const src of ['<!--'.repeat(15000), '<?'.repeat(30000), '<!x'.repeat(20000), '<![CDATA['.repeat(7000), '<a b="'.repeat(10000), '<a b=c '.repeat(9000)]) {
      expect(text(parseInline(src, { refs: [] }))).toBe(src);
    }
    expect(performance.now() - started).toBeLessThan(2000);
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
    // No deeper than the cap, and exactly as deep as it.
    const cap = 16;
    const quotes = parseArticle(`${'>'.repeat(5000)} deep\n${'lazy\n'.repeat(5000)}`, []);
    expect(depthOf(quotes)).toBe(cap);
    const bullets = parseArticle(`${'- '.repeat(5000)}x`, []);
    expect(depthOf(bullets)).toBe(cap);
    const indented = parseArticle(Array.from({ length: 300 }, (_, k) => `${'  '.repeat(k)}- level ${k}`).join('\n'), []);
    expect(depthOf(indented)).toBe(cap);
    expect(depthOf(parseArticle(`${'>'.repeat(cap)} x`, []))).toBe(cap);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
