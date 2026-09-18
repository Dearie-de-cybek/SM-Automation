// PDF text extraction with unpdf. The bundled PDF.js has no worker, so this runs on
// the worker's event loop only: pass a fresh Uint8Array, cap the page count and destroy
// the loading task afterwards.

import { extractText, getDocumentProxy } from 'unpdf';

export const DEFAULT_MAX_PDF_PAGES = 300;
/** Decoded image cap for hostile PDFs (16 MB of pixels). */
const MAX_IMAGE_SIZE = 16_777_216;

export async function pdfToText(
  bytes: Uint8Array,
  options: { maxPages?: number } = {},
): Promise<{ pages: number; text: string }> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PDF_PAGES;
  // getDocumentProxy detaches the array it is given, and rejects a Node Buffer outright.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: MAX_IMAGE_SIZE });
  try {
    if (pdf.numPages > maxPages) {
      throw new Error(`PDF has ${pdf.numPages} pages, the limit is ${maxPages}`);
    }
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    return { pages: totalPages, text };
  } finally {
    // PDFDocumentProxy in this build has cleanup() but no destroy().
    await pdf.loadingTask.destroy();
  }
}

/** A scanned PDF extracts almost nothing: tell the user instead of storing noise. */
export function looksLikeScannedPdf(pages: number, text: string): boolean {
  return pages > 0 && text.trim().length < 50 * pages;
}
