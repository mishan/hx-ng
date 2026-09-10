import { describe, expect, it } from 'vitest';

import type { NewsConfig } from '@hotline-ng/client';

import { isMarkdown, markdownOffered } from '../src/news';
import { wrapSelection } from '../src/ui/markdown';

const cfg = (over: Partial<NewsConfig>): NewsConfig => ({
  post: true,
  attach: false,
  max_body: 65535,
  max_subject: 255,
  max_depth: 3,
  markdown: 'render',
  body_types: ['text/plain', 'text/markdown'],
  max_refs: 32,
  search: false,
  ...over,
});

describe('which bodies are markdown', () => {
  it('reads markdown only from an article that says so', () => {
    expect(isMarkdown('text/markdown')).toBe(true);
    expect(isMarkdown('Text/Markdown; charset=utf-8')).toBe(true);
    expect(isMarkdown('text/plain')).toBe(false);
    expect(isMarkdown(undefined)).toBe(false);
  });

  it('offers markdown to compose only where the server takes it', () => {
    expect(markdownOffered(cfg({}))).toBe(true);
    expect(markdownOffered(cfg({ markdown: 'source' }))).toBe(true);
    expect(markdownOffered(cfg({ markdown: 'off', body_types: ['text/plain'] }))).toBe(false);
    // `off` wins whatever the list says; a list without it is a server
    // that does not take it.
    expect(markdownOffered(cfg({ markdown: 'off' }))).toBe(false);
    expect(markdownOffered(cfg({ body_types: ['text/plain'] }))).toBe(false);
    expect(markdownOffered(null)).toBe(false);
  });
});

describe('Ctrl+B and Ctrl+I', () => {
  it('wrap a selection and keep it selected', () => {
    expect(wrapSelection('say hello now', 4, 9, '**')).toEqual({ value: 'say **hello** now', start: 6, end: 11 });
  });

  it('put a pair down with the caret between when nothing is selected', () => {
    expect(wrapSelection('ab', 1, 1, '*')).toEqual({ value: 'a**b', start: 2, end: 2 });
  });
});
