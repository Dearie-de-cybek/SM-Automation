// PDF text extraction with unpdf. The bundled PDF.js has no worker, so this runs on
// the worker's event loop only: pass a fresh Uint8Array, cap the page count and destroy
// the loading task afterwards.

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export const DEFAULT_MAX_PDF_PAGES = 300;

export function pdfToText(_bytes: Uint8Array, _options?: { maxPages?: number }): Promise<{ pages: number; text: string }> {
  return ni('knowledge.pdfToText');
}
