import { actionError, guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { assertMember, householdActor, requireUser } from '$lib/server/access';
import { listRecipes, listUserTags, parseListParams, setFavorite } from '$lib/server/recipes';
import {
	CATEGORY_NAME_MAX,
	createCategory,
	deleteCategory,
	listCategories,
	renameCategory
} from '$lib/server/recipe-categories';

const loadImpl = async (event: PageServerLoadEvent) => {
	const user = requireUser(event);
	event.depends('app:recipes');
	const params = parseListParams(event.url);
	// locals.household is a cache; confirm membership before reading its categories
	const householdId = event.locals.household?.id ?? null;
	if (householdId) await assertMember(db, householdId, user.id);
	const [list, tags, categories] = await Promise.all([
		listRecipes(db, user.id, params, householdId),
		listUserTags(db, user.id),
		householdId ? listCategories(db, householdId) : []
	]);
	return {
		title: 'Recipes',
		list,
		tags,
		params,
		categories,
		categoryNameMax: CATEGORY_NAME_MAX
	};
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
			return actionError(err);
		}
		return { ok: true };
	},
	createCategory: async (event) => {
		const actor = householdActor(event);
		const fd = await event.request.formData();
		try {
			await createCategory(actor, fd.get('name'));
		} catch (err) {
			return actionError(err);
		}
		return { ok: true };
	},
	renameCategory: async (event) => {
		const actor = householdActor(event);
		const fd = await event.request.formData();
		try {
			await renameCategory(actor, String(fd.get('categoryId') ?? ''), fd.get('name'));
		} catch (err) {
			return actionError(err);
		}
		return { ok: true };
	},
	deleteCategory: async (event) => {
		const actor = householdActor(event);
		const fd = await event.request.formData();
		try {
			await deleteCategory(actor, String(fd.get('categoryId') ?? ''));
		} catch (err) {
			return actionError(err);
		}
		return { ok: true };
	}
};

export const load = guard(loadImpl);
