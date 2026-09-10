import { fail } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/access';
import { listRecipes, listUserTags, parseListParams, setFavorite } from '$lib/server/recipes';
import { asAppError } from '$lib/server/errors';

const loadImpl = async (event: PageServerLoadEvent) => {
	const user = requireUser(event);
	event.depends('app:recipes');
	const params = parseListParams(event.url);
	const [list, tags] = await Promise.all([
		listRecipes(db, user.id, params),
		listUserTags(db, user.id)
	]);
	return { title: 'Recipes', list, tags, params };
};

export const actions: Actions = {
	favorite: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		const recipeId = String(fd.get('recipeId') ?? '');
		const favorite = fd.get('favorite') === '1';
		try {
			await setFavorite(user.id, recipeId, favorite);
		} catch (err) {
			const app = asAppError(err);
			if (app) return fail(app.status, { message: app.message });
			throw err;
		}
		return { ok: true };
	}
};

export const load = guard(loadImpl);
