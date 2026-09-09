import { fail, isRedirect, type RequestEvent } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/access';
import { AppError } from '$lib/server/errors';
import { handleRecipeSubmit } from '$lib/server/recipe-form';
import { importRecipeHtml } from '$lib/shared/recipe-html';
import { parseRecipeText } from '$lib/shared/recipe-text';
import { extractPdfText } from '$lib/server/media/pdf';
import {
	attachToRecipe,
	storeAttachment,
	MAX_ATTACHMENT_BYTES
} from '$lib/server/media/attachments';

/** Generous for a saved page, small enough to keep parsing cheap. */
const MAX_HTML_BYTES = 2_000_000;

const loadImpl = (event: PageServerLoadEvent) => {
	requireUser(event);
	const kind = event.url.searchParams.get('kind') === 'pdf' ? 'pdf' : 'html';
	return { title: kind === 'pdf' ? 'Import a PDF' : 'Import a recipe', kind };
};

function looksLikePdf(bytes: Buffer): boolean {
	return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

async function parseImport(event: RequestEvent) {
	const user = requireUser(event);
	const fd = await event.request.formData();
	const pasted = String(fd.get('html') ?? '');
	const file = fd.get('file');
	const titleOverride = String(fd.get('title') ?? '').trim();

	if (file instanceof File && file.size > 0) {
		if (file.size > MAX_ATTACHMENT_BYTES)
			return fail(413, { message: 'That file is larger than 10 MB.' });
		const bytes = Buffer.from(await file.arrayBuffer());

		if (looksLikePdf(bytes)) {
			const { pages, pageCount } = await extractPdfText(bytes);
			const parsed = parseRecipeText(pages);
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
		const { source, input } = importRecipeHtml(bytes.toString('utf8'));
		const attachmentId = await storeAttachment(user.id, {
			bytes,
			filename: file.name,
			kind: 'html'
		});
		if (titleOverride) input.title = titleOverride;
		return { parsed: true, source, input, attachmentId, filename: file.name, pageCount: null };
	}

	if (pasted.length > MAX_HTML_BYTES)
		return fail(413, { message: 'That page is larger than 2 MB.' });
	if (!pasted.trim()) return fail(400, { message: 'Paste the page source, or choose a file.' });

	const { source, input } = importRecipeHtml(pasted);
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

export const actions: Actions = {
	parse: async (event) => {
		try {
			return await parseImport(event);
		} catch (err) {
			// An unreadable file is the user's problem to fix, not a crash.
			if (err instanceof AppError) return fail(err.status, { message: err.message });
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
