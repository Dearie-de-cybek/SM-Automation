// Breadth-first crawl of a small business site: same host, bounded page count,
// every request through safeFetch.

import type { CrawledPage, CrawlOptions } from './types';

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function crawlSite(_startUrl: string, _options: CrawlOptions): Promise<CrawledPage[]> {
  return ni('knowledge.crawlSite');
}
