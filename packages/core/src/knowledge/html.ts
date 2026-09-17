// HTML → text with node-html-parser. Script/style/nav/footer are removed first, and
// `structuredText` is used so block boundaries survive as line breaks.

import type { PageExtract } from './types';

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function htmlToText(_html: string, _baseUrl: string): PageExtract {
  return ni('knowledge.htmlToText');
}
