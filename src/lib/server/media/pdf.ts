import { AppError } from '$lib/server/errors';

export interface PdfText {
	pages: string[];
	pageCount: number;
}

/**
 * Read a PDF's text layer, one entry per page.
 *
 * Only text is taken — the PDF is never rendered and no embedded scripts or
 * actions are evaluated. A scanned PDF has no text layer, so this returns empty
 * pages rather than failing; the caller tells the user and keeps the file.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
	// Imported lazily: pdf.js is large and only needed on a PDF import.
	const { extractText, getDocumentProxy } = await import('unpdf');
	// pdf.js rejects a Node Buffer outright and may detach what it is given, so
	// hand it an independent copy — the caller still needs these bytes to store.
	const data = Uint8Array.from(bytes);
	let doc;
	try {
		doc = await getDocumentProxy(data);
	} catch {
		throw new AppError(400, 'That file could not be read as a PDF');
	}
	const { text } = await extractText(doc, { mergePages: false });
	const pages = (Array.isArray(text) ? text : [text]).map((p) => (p ?? '').trim());
	return { pages, pageCount: doc.numPages };
}
