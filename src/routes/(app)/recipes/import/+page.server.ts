import { fail, isRedirect, type RequestEvent } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/access';
import { asAppError } from '$lib/server/errors';
import { handleRecipeSubmit } from '$lib/server/recipe-form';
import { importRecipeHtml } from '$lib/shared/recipe-html';
import { parseRecipeText } from '$lib/shared/recipe-text';
import { extractPdfText } from '$lib/server/media/pdf';
import {
	attachToRecipe,
	storeAttachment,
	MAX_ATTACHMENT_BYTES
} from '$lib/server/media/attachments';
import { readImportedRecipe } from '$lib/server/import-payload';
import { matchIngredientNames } from '$lib/server/ingredient-match';
import type { RecipeIngredientInput } from '$lib/shared/recipe-input';
import { fetchRecipePage } from '$lib/server/import-fetch';
import { IMPORT_LIMITS, consume } from '$lib/server/ratelimit';

/** Generous for a saved page, small enough to keep parsing cheap. */
const MAX_HTML_BYTES = 2_000_000;

const TITLES = {
	pdf: 'Import a PDF',
	url: 'Import from a link',
	html: 'Import a recipe'
} as const;

const loadImpl = (event: PageServerLoadEvent) => {
	requireUser(event);
	const asked = event.url.searchParams.get('kind');
	const kind = asked === 'pdf' ? 'pdf' : asked === 'url' ? 'url' : 'html';
	return { title: TITLES[kind], kind };
};

function looksLikePdf(bytes: Buffer): boolean {
	return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

async function parseImport(event: RequestEvent) {
	const user = requireUser(event);
	const fd = await event.request.formData();
	const pasted = String(fd.get('html') ?? '');
	const link = String(fd.get('url') ?? '').trim();
	const file = fd.get('file');
	const titleOverride = String(fd.get('title') ?? '').trim();

	if (file instanceof File && file.size > 0) {
		if (file.size > MAX_ATTACHMENT_BYTES)
			return fail(413, { message: 'That file is larger than 10 MB.' });
		const bytes = Buffer.from(await file.arrayBuffer());

		if (looksLikePdf(bytes)) {
			// The browser parses this for us when it can, which keeps pdf.js out of the
			// server process entirely. Absent or malformed, we do it here as before.
			const fromClient = readImportedRecipe(fd.get('clientParsed'));
			const { pages, pageCount } = fromClient
				? { pages: [] as string[], pageCount: fromClient.pageCount ?? 0 }
				: await extractPdfText(bytes);
			const parsed = fromClient
				? { input: fromClient.input, empty: fromClient.source === 'pdf-empty' }
				: parseRecipeText(pages);
			// Kept either way: a scan with no text is still worth having to hand.
			const attachmentId = await storeAttachment(user.id, {
				bytes,
				filename: file.name,
				kind: 'pdf',
				pageCount
			});
			if (titleOverride) parsed.input.title = titleOverride;
			return {
				parsed: true,
				source: parsed.empty ? 'pdf-empty' : 'pdf',
				input: parsed.input,
				attachmentId,
				filename: file.name,
				pageCount
			};
		}

		if (bytes.byteLength > MAX_HTML_BYTES)
			return fail(413, { message: 'That page is larger than 2 MB.' });
		const fromClient = readImportedRecipe(fd.get('clientParsed'));
		const { source, input } = fromClient ?? importRecipeHtml(bytes.toString('utf8'));
		const attachmentId = await storeAttachment(user.id, {
			bytes,
			filename: file.name,
			kind: 'html'
		});
		if (titleOverride) input.title = titleOverride;
		return { parsed: true, source, input, attachmentId, filename: file.name, pageCount: null };
	}

	if (link) {
		// The fetch reaches any address this host can route to, by decision. The
		// bucket is the only thing bounding that, so it is checked before the request.
		const limit = consume(`import:${user.id}`, IMPORT_LIMITS.fetch);
		if (!limit.allowed)
			return fail(429, {
				message: `Too many link imports. Try again in ${limit.retryAfterSeconds} seconds.`
			});
		const page = await fetchRecipePage(link, { maxBytes: MAX_HTML_BYTES });
		// The final URL, so a relative og:image on the page becomes a usable address.
		const { source, input } = importRecipeHtml(page.html, page.finalUrl);
		// Kept like every other import source, so a recipe can be traced back.
		const attachmentId = await storeAttachment(user.id, {
			bytes: Buffer.from(page.html, 'utf8'),
			filename: page.filename,
			kind: 'html'
		});
		if (!input.source) input.source = page.finalUrl;
		if (titleOverride) input.title = titleOverride;
		return {
			parsed: true,
			source,
			input,
			attachmentId,
			filename: page.filename,
			pageCount: null,
			url: page.finalUrl
		};
	}

	if (pasted.length > MAX_HTML_BYTES)
		return fail(413, { message: 'That page is larger than 2 MB.' });
	if (!pasted.trim())
		return fail(400, { message: 'Paste the page source, a link, or choose a file.' });

	const fromClient = readImportedRecipe(fd.get('clientParsed'));
	const { source, input } = fromClient ?? importRecipeHtml(pasted);
	// Pasted source is kept too, so a recipe can always be traced back.
	const attachmentId = await storeAttachment(user.id, {
		bytes: Buffer.from(pasted, 'utf8'),
		filename: 'pasted-source.html',
		kind: 'html'
	});
	if (titleOverride) input.title = titleOverride;
	return {
		parsed: true,
		source,
		input,
		attachmentId,
		filename: 'pasted-source.html',
		pageCount: null
	};
}

/**
 * An import writes the names as the source wrote them, so nothing points at the
 * pantry yet. Each name the catalog recognises comes back as a proposal that
 * the review form shows and one ✕ removes; saving is the confirmation.
 */
async function withProposals<T extends { input: { ingredients: RecipeIngredientInput[] } }>(
	event: RequestEvent,
	result: T
): Promise<T & { identityLabels: Record<string, string> }> {
	const user = requireUser(event);
	const identityLabels: Record<string, string> = {};
	const open = result.input.ingredients.filter((i) => !i.ingredientId && i.name.trim());
	if (!open.length) return { ...result, identityLabels };
	const matches = await matchIngredientNames(
		db,
		user.id,
		open.map((i) => i.name)
	);
	for (const ing of open) {
		const match = matches.get(ing.name);
		if (!match) continue;
		ing.ingredientId = match.ingredientId;
		ing.proposed = true;
		identityLabels[match.ingredientId] = match.name;
	}
	return { ...result, identityLabels };
}

export const actions: Actions = {
	parse: async (event) => {
		try {
			const result = await parseImport(event);
			return 'input' in result ? await withProposals(event, result) : result;
		} catch (err) {
			// An unreadable file is the user's problem to fix, not a crash.
			const app = asAppError(err);
			if (app) return fail(app.status, { message: app.message });
			throw err;
		}
	},
	save: async (event) => {
		const user = requireUser(event);
		// The id rides on the action URL: the form body is consumed by handleRecipeSubmit.
		const attachmentId = event.url.searchParams.get('attachment') ?? '';
		try {
			return await handleRecipeSubmit(event, null);
		} catch (err) {
			// A successful save redirects to the new recipe; link the source on the way past.
			if (isRedirect(err) && /^[0-9a-f-]{36}$/i.test(attachmentId)) {
				const id = err.location.match(/\/recipes\/([0-9a-f-]{36})/i)?.[1];
				if (id) await attachToRecipe(db, user.id, id, attachmentId);
			}
			throw err;
		}
	}
};

export const load = guard(loadImpl);
