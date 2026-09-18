// Bluesky rich text. The post record stores plain text plus `facets`: byte ranges over
// the UTF-8 encoding of the text, each carrying a link, mention or tag feature. JS
// strings are UTF-16, so every offset is converted before it is written.
//
// Detection follows the patterns in the Bluesky post-richtext doc, restricted to
// explicit http(s) URLs (bare domains would need a TLD table and misfire on prices and
// file names in generated captions).

const ENCODER = new TextEncoder();

export interface FacetIndex {
  byteStart: number;
  byteEnd: number;
}

export type FacetFeature =
  | { $type: 'app.bsky.richtext.facet#link'; uri: string }
  | { $type: 'app.bsky.richtext.facet#mention'; did: string }
  | { $type: 'app.bsky.richtext.facet#tag'; tag: string };

export interface Facet {
  index: FacetIndex;
  features: FacetFeature[];
}

interface Candidate {
  start: number;
  end: number;
  kind: 'link' | 'mention' | 'tag';
  value: string;
}

const LINK_RE = /(^|[\s(])(https?:\/\/[^\s<>]+)/g;
const MENTION_RE = /(^|[\s(])(@([a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)+))/g;
const TAG_RE = /(^|\s)(#[^\s\d#][^\s#]*)/g;
const TRAILING_PUNCT_RE = /[.,;:!?'"»”]+$/u;

export function utf8Length(value: string): number {
  return ENCODER.encode(value).length;
}

/** Trim the trailing punctuation a sentence puts after a URL or tag. */
function trimTrailing(value: string): string {
  let out = value.replace(TRAILING_PUNCT_RE, '');
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1);
  }
  return out;
}

function collect(text: string): Candidate[] {
  const found: Candidate[] = [];

  for (const match of text.matchAll(LINK_RE)) {
    const lead = match[1] ?? '';
    const raw = match[2];
    if (raw === undefined || match.index === undefined) continue;
    const uri = trimTrailing(raw);
    if (!uri) continue;
    const start = match.index + lead.length;
    found.push({ start, end: start + uri.length, kind: 'link', value: uri });
  }

  for (const match of text.matchAll(MENTION_RE)) {
    const lead = match[1] ?? '';
    const raw = match[2];
    const handle = match[3];
    if (raw === undefined || handle === undefined || match.index === undefined) continue;
    const trimmed = trimTrailing(raw);
    const start = match.index + lead.length;
    found.push({ start, end: start + trimmed.length, kind: 'mention', value: trimmed.slice(1) });
  }

  for (const match of text.matchAll(TAG_RE)) {
    const lead = match[1] ?? '';
    const raw = match[2];
    if (raw === undefined || match.index === undefined) continue;
    const tag = trimTrailing(raw);
    const value = tag.slice(1);
    // The lexicon caps a tag at 64 graphemes / 640 bytes.
    if (!value || [...value].length > 64 || utf8Length(value) > 640) continue;
    const start = match.index + lead.length;
    found.push({ start, end: start + tag.length, kind: 'tag', value });
  }

  // Facets may not overlap; renderers drop the whole set when they do.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Candidate[] = [];
  let cursor = -1;
  for (const candidate of found) {
    if (candidate.start < cursor) continue;
    kept.push(candidate);
    cursor = candidate.end;
  }
  return kept;
}

export type HandleResolver = (handle: string) => Promise<string | null>;

/**
 * Build the facet array for a post. Unresolvable mentions are skipped so the text still
 * renders, exactly as the official client does.
 */
export async function buildFacets(text: string, resolveHandle: HandleResolver): Promise<Facet[]> {
  const candidates = collect(text);
  if (candidates.length === 0) return [];

  const facets: Facet[] = [];
  for (const candidate of candidates) {
    const index: FacetIndex = {
      byteStart: utf8Length(text.slice(0, candidate.start)),
      byteEnd: utf8Length(text.slice(0, candidate.end)),
    };
    if (candidate.kind === 'link') {
      facets.push({ index, features: [{ $type: 'app.bsky.richtext.facet#link', uri: candidate.value }] });
    } else if (candidate.kind === 'tag') {
      facets.push({ index, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: candidate.value }] });
    } else {
      const did = await resolveHandle(candidate.value);
      if (did) facets.push({ index, features: [{ $type: 'app.bsky.richtext.facet#mention', did }] });
    }
  }
  return facets;
}

/** First http(s) URL in the text, used as the link-card target when none was supplied. */
export function firstLink(text: string): string | null {
  for (const candidate of collect(text)) {
    if (candidate.kind === 'link') return candidate.value;
  }
  return null;
}
