// HTML → text with node-html-parser. Script/style/nav/footer are removed first, and
// `structuredText` is used so block boundaries survive as line breaks.

import { parse } from 'node-html-parser';
import type { PageExtract } from './types';

/** Parsing a multi-megabyte page costs more than the content is worth. */
export const MAX_HTML_BYTES = 5 * 1024 * 1024;

const STRIP_SELECTOR = 'script,style,noscript,template,svg,iframe,canvas,form,nav,footer,header,aside';
const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

// Non-breaking space and the Unicode line/paragraph separators, built from char codes
// so the source file itself stays plain ASCII.
const NBSP_RE = new RegExp(String.fromCharCode(0x00a0), 'g');
const LINE_SEPARATOR_RE = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalize(text: string): string {
  return text
    .replace(NBSP_RE, ' ')
    .replace(LINE_SEPARATOR_RE, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToText(html: string, baseUrl: string): PageExtract {
  const root = parse(html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html, { comment: false });

  const baseHref = root.querySelector('base[href]')?.getAttribute('href');
  let base = baseUrl;
  if (baseHref) {
    try {
      base = new URL(baseHref, baseUrl).href;
    } catch {
      base = baseUrl;
    }
  }

  const rawTitle = root.querySelector('title')?.text.trim() ?? '';
  const description = root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? '';

  // Chrome/boilerplate first: a script's source text otherwise shows up as content.
  for (const node of root.querySelectorAll(STRIP_SELECTOR)) node.remove();

  // Markdown-style headings survive chunking and give the retriever a section label.
  for (const level of HEADINGS) {
    for (const heading of root.querySelectorAll(level)) {
      const text = heading.text.replace(/\s+/g, ' ').trim();
      if (text === '') continue;
      heading.set_content(escapeHtml(`\n${'#'.repeat(Number(level.slice(1)))} ${text}\n`));
    }
  }

  const body = root.querySelector('main') ?? root.querySelector('article') ?? root.querySelector('body') ?? root;
  const parts = [description, body.structuredText].filter((part) => part.trim() !== '');
  const text = normalize(parts.join('\n\n'));

  const links = new Set<string>();
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) continue;
    try {
      const url = new URL(href, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      url.hash = '';
      links.add(url.href);
    } catch {
      // A malformed href is simply not a link.
    }
  }

  return { title: rawTitle === '' ? null : rawTitle, text, links: [...links] };
}
