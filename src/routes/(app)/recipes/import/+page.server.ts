import { isRedirect } from '@sveltejs/kit';
import { actionError, formText, guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/access';
import { handleRecipeSubmit } from '$lib/server/recipe-form';
import { attachToRecipe } from '$lib/server/media/attachments';
import { importRecipe } from '$lib/server/recipe-import';
import { llmEnabled } from '$lib/server/llm/client';
import { match as isUuid } from '../../../../params/uuid';

const TITLES = {
	pdf: 'Import a PDF',
	url: 'Import from a link',
	html: 'Import a recipe'
} as const;

export const load = guard((event: PageServerLoadEvent) => {
	requireUser(event);
	const asked = event.url.searchParams.get('kind');
	const kind = asked === 'pdf' ? 'pdf' : asked === 'url' ? 'url' : 'html';
	return { title: TITLES[kind], kind, aiEnabled: llmEnabled() };
});

export const actions: Actions = {
	parse: async (event) => {
		try {
			const user = requireUser(event);
			const fd = await event.request.formData();
			const file = fd.get('file');
			const link = formText(fd, 'url').trim();
			const common = {
				titleOverride: formText(fd, 'title').trim(),
				// The checkbox asks the assistant to read even a page the app read itself.
				forced: fd.get('useAssistant') === 'on',
				clientParsed: fd.get('clientParsed')
			};
			return await importRecipe(
				user.id,
				file instanceof File && file.size > 0
					? {
							...common,
							kind: 'file',
							filename: file.name,
							size: file.size,
							bytes: async () => Buffer.from(await file.arrayBuffer())
						}
					: link
						? { ...common, kind: 'link', url: link }
						: { ...common, kind: 'pasted', html: formText(fd, 'html') }
			);
		} catch (err) {
			// An unreadable file is the user's problem to fix, not a crash.
			return actionError(err);
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
			if (isRedirect(err) && isUuid(attachmentId)) {
				const id = err.location.match(/\/recipes\/([^/?#]+)/)?.[1];
				if (id && isUuid(id)) await attachToRecipe(db, user.id, id, attachmentId);
			}
			throw err;
		}
	}
};
