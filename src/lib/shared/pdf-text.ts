/** Pages whose text is read; a long book is never parsed whole. */
export const PDF_MAX_PAGES = 50;

export interface PdfText {
	pages: string[];
	pageCount: number;
}

type PdfDocument = Awaited<ReturnType<typeof import('unpdf').getDocumentProxy>>;

/** Read the same bounded text on both sides and always release the document worker. */
export async function readPdfDocument(doc: PdfDocument): Promise<PdfText> {
	try {
		const pages: string[] = [];
		for (let n = 1; n <= Math.min(doc.numPages, PDF_MAX_PAGES); n++) {
			const content = await (await doc.getPage(n)).getTextContent();
			pages.push(
				content.items
					.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
					.join('')
					.trim()
			);
		}
		return { pages, pageCount: doc.numPages };
	} finally {
		await doc.loadingTask.destroy().catch(() => {});
	}
}
