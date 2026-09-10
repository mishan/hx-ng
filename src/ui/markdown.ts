/**
 * Drawing parsed markdown: the library's runs and blocks, turned into
 * elements with `h()` and text nodes and nothing else.
 *
 * Nothing here ever hands a string to the HTML parser. The parse is the
 * only interpretation a body gets — a closed set of constructs, decided
 * in `@hotline-ng/client`'s `markdown` — and what comes out of it is text
 * to be set as text. A `<b>` somebody typed is four characters on the
 * screen, in chat and in an article alike.
 *
 * Bare URLs are still `linkify`'s, and only in plain prose: never inside
 * code, where a URL is being shown rather than offered, and never inside
 * a link's own label.
 */

import { parseChat, type MdBlock, type MdRun, type NewsReference } from '@hotline-ng/client';

import { h, linkify } from './dom';

export interface MarkdownHooks {
  /** Draw a resolved article reference around its label. Without it, a
   *  reference is drawn as its label and nothing more. */
  ref?: (r: NewsReference, label: (Node | string)[]) => Node;
}

/** Text with its line breaks as `<br>`, so a body needs no `pre-wrap` —
 *  which would also keep the indentation markdown strips. */
function withBreaks(parts: (Node | string)[]): (Node | string)[] {
  const out: (Node | string)[] = [];
  for (const p of parts) {
    if (typeof p !== 'string' || !p.includes('\n')) {
      out.push(p);
      continue;
    }
    p.split('\n').forEach((line, k) => {
      if (k) out.push(h('br'));
      if (line) out.push(line);
    });
  }
  return out;
}

function styled(r: MdRun, autolink: boolean): (Node | string)[] {
  let nodes: (Node | string)[] = r.code
    ? [h('code', { class: 'md-code' }, r.text)]
    : withBreaks(autolink ? linkify(r.text) : [r.text]);
  if (r.strike) nodes = [h('s', {}, ...nodes)];
  if (r.italic) nodes = [h('em', {}, ...nodes)];
  if (r.bold) nodes = [h('strong', {}, ...nodes)];
  return nodes;
}

const sameTarget = (a: MdRun, b: MdRun): boolean => a.href === b.href && a.ref === b.ref;

/** Inline runs as nodes. The runs of one link's label — `[a `b` c](…)`
 *  is three — are gathered into one link. */
export function inlineNodes(runs: readonly MdRun[], hooks: MarkdownHooks = {}): (Node | string)[] {
  const out: (Node | string)[] = [];
  let k = 0;
  while (k < runs.length) {
    const r = runs[k]!;
    if (r.href === undefined && !r.ref) {
      out.push(...styled(r, true));
      k++;
      continue;
    }
    let end = k + 1;
    while (end < runs.length && sameTarget(runs[end]!, r)) end++;
    const label = runs.slice(k, end).flatMap((x) => styled(x, false));
    if (r.ref) out.push(hooks.ref ? hooks.ref(r.ref, label) : h('span', {}, ...label));
    else out.push(h('a', { href: r.href, target: '_blank', rel: 'noreferrer noopener', title: r.href }, ...label));
    k = end;
  }
  return out;
}

/** Blocks as elements. A `tight` list's items hold their text as lines
 *  rather than as spaced paragraphs, and so does every chat line. */
export function blockNodes(blocks: readonly MdBlock[], hooks: MarkdownHooks = {}, tight = false): HTMLElement[] {
  return blocks.map((b) => blockNode(b, hooks, tight));
}

function blockNode(b: MdBlock, hooks: MarkdownHooks, tight: boolean): HTMLElement {
  switch (b.type) {
    case 'paragraph':
      return h(tight ? 'div' : 'p', { class: tight ? 'md-line' : 'md-p' }, ...inlineNodes(b.content, hooks));
    case 'heading':
      return h(`h${b.level}`, { class: 'md-h' }, ...inlineNodes(b.content, hooks));
    case 'code':
      return h('pre', { class: 'md-pre', dataset: b.language ? { lang: b.language } : undefined }, h('code', {}, b.text));
    case 'quote':
      return h('blockquote', { class: 'md-quote' }, ...blockNodes(b.children, hooks, tight));
    case 'list': {
      const items = b.items.map((item) => h('li', {}, ...blockNodes(item, hooks, b.tight)));
      return b.ordered ? h('ol', { class: 'md-list', start: b.start }, ...items) : h('ul', { class: 'md-list' }, ...items);
    }
    case 'rule':
      return h('hr', { class: 'md-rule' });
    case 'table': {
      const cell = (tag: 'th' | 'td', runs: MdRun[], k: number) => {
        const align = b.align[k];
        return h(tag, { style: align ? { textAlign: align } : undefined }, ...inlineNodes(runs, hooks));
      };
      return h(
        'div',
        { class: 'md-table-wrap' },
        h(
          'table',
          { class: 'md-table' },
          h('thead', {}, h('tr', {}, ...b.head.map((c, k) => cell('th', c, k)))),
          h('tbody', {}, ...b.rows.map((row) => h('tr', {}, ...row.map((c, k) => cell('td', c, k))))),
        ),
      );
    }
  }
}

/**
 * A chat body, drawn. A line that is one paragraph — nearly all of them —
 * comes back as inline nodes, so it still flows beside the nick on a
 * phone; one with a quote or a code block in it comes back as blocks.
 */
export function chatNodes(text: string): (Node | string)[] {
  const blocks = parseChat(text);
  const only = blocks[0];
  if (blocks.length === 1 && only?.type === 'paragraph') return inlineNodes(only.content);
  return blockNodes(blocks, {}, true);
}

/**
 * Wrap a selection in a delimiter — Ctrl+B's `**`, Ctrl+I's `*` — or,
 * with nothing selected, put a pair down with the caret between. Returns
 * the new value and selection. What is sent is still exactly what the
 * box then says.
 */
export function wrapSelection(
  value: string,
  start: number,
  end: number,
  delim: string,
): { value: string; start: number; end: number } {
  const inner = value.slice(start, end);
  return {
    value: value.slice(0, start) + delim + inner + delim + value.slice(end),
    start: start + delim.length,
    end: end + delim.length,
  };
}
