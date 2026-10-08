import { db } from '$lib/server/db';
import { AppError } from '$lib/server/errors';
import { fetchRecipePage } from '$lib/server/import-fetch';
import { readImportedRecipe, type ImportedRecipe } from '$lib/server/import-payload';
import { matchIngredientNames } from '$lib/server/ingredient-match';
import { startImportJob } from '$lib/server/llm/jobs';
import type { ImportAssistArgs } from '$lib/server/llm/recipe';
import {
	MAX_ATTACHMENT_BYTES,
	storeAttachment,
	type AttachmentKind
} from '$lib/server/media/attachments';
import { extractPdfText } from '$lib/server/media/pdf';
import { IMPORT_LIMITS, consume } from '$lib/server/ratelimit';
import { importRecipeHtml } from '$lib/shared/recipe-html';
import type { RecipeFormInput } from '$lib/shared/recipe-input';
import { parseRecipeText } from '$lib/shared/recipe-text';

/**
 * Importing a recipe: read the source, keep the original as an attachment,
 * apply the title the user typed, hand the import to the assistant when it
 * asks for one, and propose catalog links for the names. Every source — a PDF,
 * an HTML file, a link, pasted page source — goes through the same steps;
 * only the read differs.
 */

/** Generous for a saved page, small enough to keep parsing cheap. */
export const MAX_HTML_BYTES = 2_000_000;
/** The name a pasted page source is kept under. */
const PASTED_FILENAME = 'pasted-source.html';

export type ImportRequest = {
	/** the title the user typed, kept over the one read */
	titleOverride: string;
	/** the user asked for the assistant even though the app read the recipe */
	forced: boolean;
	/** the browser's own parse of a file or pasted source, unchecked */
	clientParsed: FormDataEntryValue | null;
} & (
	| { kind: 'file'; filename: string; size: number; bytes: () => Promise<Buffer> }
	| { kind: 'link'; url: string }
	| { kind: 'pasted'; html: string }
);

/** One source, read: the form it fills, the file to keep, and the raw text for the assistant. */
interface ReadSource {
	input: RecipeFormInput;
	/** how the recipe was read, for the review screen */
	source: ImportedRecipe['source'];
	attachment: { bytes: Buffer; filename: string; kind: AttachmentKind; pageCount?: number };
	/** the raw source; read only when the assistant needs it */
	sourceText: () => Promise<string>;
	pageCount: number | null;
	/** the final address of a fetched link */
	url?: string;
}

function looksLikePdf(bytes: Buffer): boolean {
	return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

async function readPdf(
	bytes: Buffer,
	filename: string,
	clientParsed: FormDataEntryValue | null
): Promise<ReadSource> {
	// The browser parses this for us when it can, which keeps pdf.js out of the
	// server process entirely. Absent or malformed, we do it here as before.
	const fromClient = readImportedRecipe(clientParsed);
	const { pages, pageCount } = fromClient
		? { pages: [] as string[], pageCount: fromClient.pageCount ?? 0 }
		: await extractPdfText(bytes);
	const parsed = fromClient
		? { input: fromClient.input, empty: fromClient.source === 'pdf-empty' }
		: parseRecipeText(pages);
	return {
		input: parsed.input,
		source: parsed.empty ? 'pdf-empty' : 'pdf',
		// Kept either way: a scan with no text is still worth having to hand.
		attachment: { bytes, filename, kind: 'pdf', pageCount },
		// The browser sends only its parse, so the text is read here again
		// when the assistant needs it, and only then.
		sourceText: async () => (fromClient ? (await extractPdfText(bytes)).pages : pages).join('\n\n'),
		pageCount
	};
}

function readHtml(
	html: string,
	bytes: Buffer,
	filename: string,
	clientParsed: FormDataEntryValue | null
): ReadSource {
	const read = readImportedRecipe(clientParsed) ?? importRecipeHtml(html);
	return {
		input: read.input,
		source: read.source,
		attachment: { bytes, filename, kind: 'html' },
		sourceText: async () => html,
		pageCount: null
	};
}

async function readFile(
	userFile: { filename: string; size: number; bytes: () => Promise<Buffer> },
	clientParsed: FormDataEntryValue | null
): Promise<ReadSource> {
	if (userFile.size > MAX_ATTACHMENT_BYTES)
		throw new AppError(413, 'That file is larger than 10 MB.');
	const bytes = await userFile.bytes();
	if (looksLikePdf(bytes)) return readPdf(bytes, userFile.filename, clientParsed);
	if (bytes.byteLength > MAX_HTML_BYTES) throw new AppError(413, 'That page is larger than 2 MB.');
	return readHtml(bytes.toString('utf8'), bytes, userFile.filename, clientParsed);
}

async function readLink(userId: string, link: string): Promise<ReadSource> {
	// The fetch reaches any address this host can route to, by decision. The
	// bucket is the only thing bounding that, so it is checked before the request.
	const limit = consume(`import:${userId}`, IMPORT_LIMITS.fetch);
	if (!limit.allowed)
		throw new AppError(
			429,
			`Too many link imports. Try again in ${limit.retryAfterSeconds} seconds.`
		);
	const page = await fetchRecipePage(link, { maxBytes: MAX_HTML_BYTES });
	// The final URL, so a relative og:image on the page becomes a usable address.
	const read = importRecipeHtml(page.html, page.finalUrl);
	if (!read.input.source) read.input.source = page.finalUrl;
	return {
		input: read.input,
		source: read.source,
		// Kept like every other import source, so a recipe can be traced back.
		attachment: { bytes: Buffer.from(page.html, 'utf8'), filename: page.filename, kind: 'html' },
		sourceText: async () => page.html,
		pageCount: null,
		url: page.finalUrl
	};
}

function readPasted(html: string, clientParsed: FormDataEntryValue | null): ReadSource {
	if (html.length > MAX_HTML_BYTES) throw new AppError(413, 'That page is larger than 2 MB.');
	if (!html.trim()) throw new AppError(400, 'Paste the page source, a link, or choose a file.');
	// Pasted source is kept too, so a recipe can always be traced back.
	return readHtml(html, Buffer.from(html, 'utf8'), PASTED_FILENAME, clientParsed);
}

/**
 * Hand the import to the assistant in the background when it asks for one.
 * The review form shows the app's own reading at once; the job saves the
 * assistant's as a draft later. A job that cannot start leaves the message.
 */
async function startAssistant(
	userId: string,
	args: ImportAssistArgs & { attachmentId: string; titleOverride: string; label: string }
): Promise<{ assistantJob: { id: string; title: string } | null; assistantError: string | null }> {
	try {
		const job = await startImportJob(userId, args);
		return { assistantJob: job && { id: job.id, title: job.title }, assistantError: null };
	} catch (err) {
		if (err instanceof AppError) return { assistantJob: null, assistantError: err.message };
		throw err;
	}
}

/**
 * An import writes the names as the source wrote them, so nothing points at the
 * pantry yet. Each name the catalog recognises comes back as a proposal that
 * the review form shows and one ✕ removes; saving is the confirmation.
 */
async function proposeLinks(
	userId: string,
	input: RecipeFormInput
): Promise<Record<string, string>> {
	const identityLabels: Record<string, string> = {};
	const open = input.ingredients.filter((i) => !i.ingredientId && i.name.trim());
	if (!open.length) return identityLabels;
	const matches = await matchIngredientNames(
		db,
		userId,
		open.map((i) => i.name)
	);
	for (const ing of open) {
		const match = matches.get(ing.name);
		if (!match) continue;
		ing.ingredientId = match.ingredientId;
		ing.proposed = true;
		identityLabels[match.ingredientId] = match.name;
	}
	return identityLabels;
}

/** Read, keep and hand over one import. Throws `AppError` for a source that cannot be used. */
export async function importRecipe(userId: string, request: ImportRequest) {
	const read =
		request.kind === 'file'
			? await readFile(request, request.clientParsed)
			: request.kind === 'link'
				? await readLink(userId, request.url)
				: readPasted(request.html, request.clientParsed);
	const { input } = read;
	const attachmentId = await storeAttachment(userId, read.attachment);
	if (request.titleOverride) input.title = request.titleOverride;
	const assistant = await startAssistant(userId, {
		input,
		forced: request.forced,
		sourceText: read.sourceText,
		attachmentId,
		titleOverride: request.titleOverride,
		label: read.attachment.filename
	});
	const result = {
		parsed: true,
		source: read.source,
		input,
		assistantJob: assistant.assistantJob,
		assistantError: assistant.assistantError,
		attachmentId,
		filename: read.attachment.filename,
		pageCount: read.pageCount,
		...(read.url === undefined ? {} : { url: read.url })
	};
	// After the assistant took its own copy: the proposals are for the review form.
	return { ...result, identityLabels: await proposeLinks(userId, input) };
}
