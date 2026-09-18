// Breadth-first crawl of a small business site: same host, bounded page count,
// every request through safeFetch.

import { htmlToText } from './html';
import { safeFetch } from './ssrf';
import type { CrawledPage, CrawlOptions } from './types';

export const DEFAULT_USER_AGENT = 'SM-Automation-Knowledge/1.0 (+business knowledge ingestion)';
export const CRAWL_CONCURRENCY = 2;
const DEFAULT_PAGE_BYTES = 3 * 1024 * 1024;
const DEFAULT_PAGE_TIMEOUT_MS = 15_000;
const ROBOTS_BYTES = 256 * 1024;
const SITEMAP_BYTES = 2 * 1024 * 1024;
const MAX_SITEMAP_SEEDS = 200;
/** Extensions that are never HTML: skipping them saves a request each. */
const SKIP_EXTENSION_RE = /\.(jpe?g|png|gif|webp|svg|ico|bmp|mp4|mov|avi|mp3|wav|zip|gz|tar|rar|exe|dmg|pkg|woff2?|ttf|eot|css|js|json|xml|rss|atom)$/i;

export interface RobotsRules {
  /** Path prefixes the crawler must not fetch. */
  disallow: string[];
  /** Longer-matching allow rules win over a disallow (Google's precedence rule). */
  allow: string[];
  sitemaps: string[];
  crawlDelayMs: number | null;
}

const EMPTY_ROBOTS: RobotsRules = { disallow: [], allow: [], sitemaps: [], crawlDelayMs: null };

/** Parse robots.txt, keeping the most specific group that applies to `userAgent`. */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const token = userAgent.split('/')[0]?.toLowerCase() ?? '';
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;
  const sitemaps: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'sitemap') {
      if (value !== '') sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { disallow: [], allow: [], sitemaps: [], crawlDelayMs: null } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'disallow') current.rules.disallow.push(value);
    else if (field === 'allow') current.rules.allow.push(value);
    else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) current.rules.crawlDelayMs = Math.min(seconds, 30) * 1000;
    }
  }

  const specific = groups.find((group) => group.agents.some((agent) => agent !== '*' && token.includes(agent)));
  const wildcard = groups.find((group) => group.agents.includes('*'));
  const chosen = specific ?? wildcard;
  return {
    disallow: chosen?.rules.disallow.filter((rule) => rule !== '') ?? [],
    allow: chosen?.rules.allow.filter((rule) => rule !== '') ?? [],
    sitemaps,
    crawlDelayMs: chosen?.rules.crawlDelayMs ?? null,
  };
}

function matchLength(pattern: string, path: string): number {
  // robots.txt wildcards: `*` matches anything, `$` anchors the end.
  if (!pattern.includes('*') && !pattern.endsWith('$')) return path.startsWith(pattern) ? pattern.length : -1;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}${anchored ? '$' : ''}`);
  return regex.test(path) ? body.length : -1;
}

export function robotsAllows(rules: RobotsRules, url: URL): boolean {
  const path = `${url.pathname}${url.search}`;
  let bestDisallow = -1;
  let bestAllow = -1;
  for (const rule of rules.disallow) bestDisallow = Math.max(bestDisallow, matchLength(rule, path));
  for (const rule of rules.allow) bestAllow = Math.max(bestAllow, matchLength(rule, path));
  if (bestDisallow === -1) return true;
  return bestAllow >= bestDisallow;
}

/** Drop the fragment and common tracking parameters so one page is fetched once. */
export function normalizeUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  for (const key of [...copy.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_eid|msclkid|ref)$/i.test(key)) copy.searchParams.delete(key);
  }
  if (copy.pathname.length > 1 && copy.pathname.endsWith('/')) copy.pathname = copy.pathname.slice(0, -1);
  return copy.href;
}

function extractSitemapLinks(xml: string): string[] {
  const links: string[] = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const value = match[1];
    if (value) links.push(value.replace(/&amp;/g, '&'));
  }
  return links;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function crawlSite(startUrl: string, options: CrawlOptions): Promise<CrawledPage[]> {
  const maxPages = Math.max(1, options.maxPages);
  const maxBytes = options.maxBytesPerPage ?? DEFAULT_PAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const sameHostOnly = options.sameHostOnly ?? true;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const headers = { 'user-agent': userAgent };

  const start = new URL(startUrl);
  const startHost = start.host;

  let robots: RobotsRules = EMPTY_ROBOTS;
  try {
    const response = await safeFetch(new URL('/robots.txt', start), {
      headers,
      maxBytes: ROBOTS_BYTES,
      timeoutMs,
    });
    if (response.status === 200) robots = parseRobots(response.text(), userAgent);
  } catch {
    // No robots.txt (or it is unreachable) means no restrictions.
  }

  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (candidate: string | URL): void => {
    let url: URL;
    try {
      url = candidate instanceof URL ? candidate : new URL(candidate);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (sameHostOnly && url.host !== startHost) return;
    if (SKIP_EXTENSION_RE.test(url.pathname)) return;
    if (!robotsAllows(robots, url)) return;
    const key = normalizeUrl(url);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(key);
  };

  enqueue(start);

  // Sitemaps give a far better page set than following navigation links.
  const sitemapUrls = robots.sitemaps.length > 0 ? robots.sitemaps : [new URL('/sitemap.xml', start).href];
  for (const sitemapUrl of sitemapUrls.slice(0, 3)) {
    if (queue.length >= maxPages * 3) break;
    try {
      const response = await safeFetch(sitemapUrl, { headers, maxBytes: SITEMAP_BYTES, timeoutMs });
      if (response.status !== 200) continue;
      const links = extractSitemapLinks(response.text());
      // A sitemap index points at more sitemaps: follow one level.
      const nested = links.filter((link) => /\.xml(\.gz)?$/i.test(link)).slice(0, 3);
      for (const link of links.slice(0, MAX_SITEMAP_SEEDS)) {
        if (!/\.xml(\.gz)?$/i.test(link)) enqueue(link);
      }
      for (const child of nested) {
        try {
          const childResponse = await safeFetch(child, { headers, maxBytes: SITEMAP_BYTES, timeoutMs });
          if (childResponse.status !== 200) continue;
          for (const link of extractSitemapLinks(childResponse.text()).slice(0, MAX_SITEMAP_SEEDS)) enqueue(link);
        } catch {
          // A broken child sitemap is not fatal.
        }
      }
    } catch {
      // No sitemap: fall back to link following.
    }
  }

  const pages: CrawledPage[] = [];
  const delay = robots.crawlDelayMs;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (pages.length >= maxPages) return;
      const next = queue.shift();
      if (next === undefined) return;

      let html: string;
      let finalUrl = next;
      try {
        const response = await safeFetch(next, {
          headers,
          maxBytes,
          timeoutMs,
          accept: 'text/html,application/xhtml+xml',
        });
        if (response.status !== 200) continue;
        html = response.text();
        finalUrl = response.url;
      } catch {
        // Blocked, too large, wrong type or unreachable: skip this page.
        continue;
      }

      const extract = htmlToText(html, finalUrl);
      if (extract.text.trim() !== '') {
        if (pages.length >= maxPages) return;
        pages.push({ url: finalUrl, title: extract.title, text: extract.text, links: extract.links, fetchedAt: new Date() });
      }
      // Keep discovering while there is still room for more pages.
      if (pages.length + queue.length < maxPages * 3) {
        for (const link of extract.links) enqueue(link);
      }
      if (delay !== null) await sleep(delay);
    }
  };

  await Promise.all(Array.from({ length: CRAWL_CONCURRENCY }, () => worker()));
  return pages.slice(0, maxPages);
}
