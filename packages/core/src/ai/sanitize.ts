// Post-checks on model output. The model is instructed not to invent contact details,
// links or prices; this is the part that actually enforces it.

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi;
const BARE_DOMAIN_RE =
  /\b(?!\d+\.\d+)[a-z0-9][a-z0-9-]{1,62}(?:\.[a-z0-9-]{2,63})*\.(?:com|net|org|io|co|shop|store|app|dev|info|biz|online|site|uk|de|fr|es|it|nl|se|pl|ie|ca|au|us|ng|za|in|br)\b(?:\/[^\s<>"')]*)?/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/gi;
const PHONE_RE = /(?:\+\d[\d\s().-]{7,}\d)|(?:\b\d{3,5}[\s.-]\d{3,4}[\s.-]\d{3,4}\b)/g;
const PRICE_RE = /(?:[$€£₦¥₹]\s?\d[\d.,]*)|(?:\b\d[\d.,]*\s?(?:usd|eur|gbp|ngn|inr|dollars?|euros?|pounds?|naira)\b)/gi;

export type ClaimKind = 'url' | 'email' | 'phone' | 'price';

export interface UngroundedClaim {
  kind: ClaimKind;
  value: string;
}

/** Comparison key: case, spacing and separators must not hide a match. */
function key(kind: ClaimKind, value: string): string {
  const lower = value.toLowerCase().trim();
  if (kind === 'phone') return lower.replace(/[^\d+]/g, '');
  if (kind === 'price') return lower.replace(/[\s,]/g, '');
  if (kind === 'url') return lower.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  return lower;
}

function matches(text: string, kind: ClaimKind): string[] {
  const patterns: RegExp[] =
    kind === 'url' ? [URL_RE, BARE_DOMAIN_RE] : kind === 'email' ? [EMAIL_RE] : kind === 'phone' ? [PHONE_RE] : [PRICE_RE];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].replace(/[.,;:!?)]+$/, '').trim();
      if (value !== '') found.add(value);
    }
  }
  return [...found];
}

/**
 * Claims in `draft` that do not appear in `corpus` (brand profile + retrieved
 * knowledge). Emails found inside a URL are ignored, otherwise every link with an
 * `@` would double-report.
 */
export function findUngroundedClaims(draft: string, corpus: string): UngroundedClaim[] {
  const claims: UngroundedClaim[] = [];
  const kinds: ClaimKind[] = ['url', 'email', 'phone', 'price'];
  const corpusKeys: Record<ClaimKind, Set<string>> = {
    url: new Set(matches(corpus, 'url').map((value) => key('url', value))),
    email: new Set(matches(corpus, 'email').map((value) => key('email', value))),
    phone: new Set(matches(corpus, 'phone').map((value) => key('phone', value))),
    price: new Set(matches(corpus, 'price').map((value) => key('price', value))),
  };
  const normalizedCorpus = corpus.toLowerCase().replace(/[\s,]/g, '');

  for (const kind of kinds) {
    for (const value of matches(draft, kind)) {
      const candidate = key(kind, value);
      if (candidate === '') continue;
      if (corpusKeys[kind].has(candidate)) continue;
      // A price like "€12.50" may appear in prose the regexes did not tokenise the
      // same way, so fall back to a normalised substring check before escalating.
      if (normalizedCorpus.includes(candidate)) continue;
      claims.push({ kind, value });
    }
  }
  return claims;
}

/** Remove banned words (whole word, case-insensitive) and tidy the leftover spacing. */
export function stripBannedWords(text: string, bannedWords: readonly string[]): string {
  let out = text;
  for (const word of bannedWords) {
    const trimmed = word.trim();
    if (trimmed === '') continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // \b does not work next to non-ASCII letters, so bound on whitespace/punctuation.
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1');
  }
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([.,!?;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
