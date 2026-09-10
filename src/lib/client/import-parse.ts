import { importRecipeHtml } from '$lib/shared/recipe-html';
import { parseRecipeText } from '$lib/shared/recipe-text';
import type { RecipeFormInput } from '$lib/shared/recipe-input';

/**
 * Read an imported recipe in the browser instead of on the server.
 *
 * Both parsers already live in $lib/shared and are pure string work, so the only
 * server-bound piece was pdf.js — a multi-megabyte module that stays resident in
 * the Node process once loaded. Doing it here keeps it off a small self-hosted box.
 *
 * The original file is still uploaded, because it is kept as the recipe's source;
 * what this saves is the server's parsing work, not the bytes. Every failure falls
 * back to the server action, which parses exactly as before.
 */

export type ImportKind = 'json-ld' | 'text' | 'pdf' | 'pdf-empty';

export interface ClientParse {
	source: ImportKind;
	input: RecipeFormInput;
	pageCount: number | null;
}

async function looksLikePdf(file: File): Promise<boolean> {
	const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
	return String.fromCharCode(...head) === '%PDF-';
}

export function parseHtmlInBrowser(html: string): ClientParse {
	const { source, input } = importRecipeHtml(html);
	return { source, input, pageCount: null };
}

export async function parseFileInBrowser(file: File): Promise<ClientParse> {
	if (await looksLikePdf(file)) {
		// Loaded only when a PDF is actually chosen, so the bundle cost falls on the
		// few imports that need it rather than every page view.
		const { extractText, getDocumentProxy } = await import('unpdf');
		const doc = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
		const { text } = await extractText(doc, { mergePages: false });
		const pages = (Array.isArray(text) ? text : [text]).map((p) => (p ?? '').trim());
		const parsed = parseRecipeText(pages);
		return {
			source: parsed.empty ? 'pdf-empty' : 'pdf',
			input: parsed.input,
			pageCount: doc.numPages
		};
	}
	return parseHtmlInBrowser(await file.text());
}
