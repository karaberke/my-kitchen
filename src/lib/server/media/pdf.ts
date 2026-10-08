import { AppError } from '$lib/server/errors';

export interface PdfText {
	pages: string[];
	pageCount: number;
}

/** Pages whose text is read. A recipe is a few pages; a long book is not parsed whole. */
export const PDF_MAX_PAGES = 50;

/**
 * Read a PDF's text layer, one entry per page, for the first PDF_MAX_PAGES pages.
 *
 * Only text is taken — the PDF is never rendered and no embedded scripts or
 * actions are evaluated. A scanned PDF has no text layer, so this returns empty
 * pages rather than failing; the caller tells the user and keeps the file.
 * `pageCount` is the whole document's count.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
	// Imported lazily: pdf.js is large and only needed on a PDF import.
	const { getDocumentProxy } = await import('unpdf');
	// pdf.js rejects a Node Buffer outright and may detach what it is given, so
	// hand it an independent copy — the caller still needs these bytes to store.
	const data = Uint8Array.from(bytes);
	let doc;
	try {
		doc = await getDocumentProxy(data);
	} catch {
		throw new AppError(400, 'That file could not be read as a PDF');
	}
	try {
		const pages: string[] = [];
		// One page at a time, so a long document never holds every page's text items at once.
		for (let n = 1; n <= Math.min(doc.numPages, PDF_MAX_PAGES); n++) {
			const content = await (await doc.getPage(n)).getTextContent();
			// The same joining unpdf's extractText uses: each item, plus a newline where the line ends.
			const text = content.items
				.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
				.join('');
			pages.push(text.trim());
		}
		return { pages, pageCount: doc.numPages };
	} finally {
		// Frees the parsed document and its worker; a long-running server must not keep it.
		await doc.loadingTask.destroy().catch(() => {});
	}
}
