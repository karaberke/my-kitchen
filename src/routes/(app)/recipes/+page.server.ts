import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/access';
import { listRecipes, listUserTags, parseListParams, setFavorite } from '$lib/server/recipes';
import { AppError } from '$lib/server/errors';

export const load: PageServerLoad = async (event) => {
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
			if (err instanceof AppError) return fail(err.status, { message: err.message });
			throw err;
		}
		return { ok: true };
	}
};
