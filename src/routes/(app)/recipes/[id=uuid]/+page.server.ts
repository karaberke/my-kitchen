import { fail, redirect } from '@sveltejs/kit';
import { actionError, formText, formTextOrNull, guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { assertMember, householdActor, requireUser } from '$lib/server/access';
import {
	deleteRecipe,
	duplicateRecipe,
	getRecipeDetail,
	setFavorite,
	setRecipeArchived,
	setRecipeShare
} from '$lib/server/recipes';
import {
	CATEGORY_NAME_MAX,
	createCategoryForRecipe,
	listCategories,
	recipeCategoryIds,
	recipeSharedWith,
	setRecipeCategory,
	type CategoryView
} from '$lib/server/recipe-categories';
import { addBatchesToDraft, getCurrentList } from '$lib/server/grocery';
import { parsePositiveAmount } from '$lib/shared/amount-parse';
import { randomUUID } from 'node:crypto';
import { llmEnabled } from '$lib/server/llm/client';

export const load = guard(async (event: PageServerLoadEvent) => {
	const user = requireUser(event);
	event.depends('app:recipe');
	const householdId = event.locals.household?.id ?? null;
	// locals.household is a cache; confirm membership before reading any of its data
	// (the recipe detail reads its pantry stock too).
	if (householdId) await assertMember(db, householdId, user.id);
	const recipeId = event.params.id;
	// The household reads only reach the page when the recipe read succeeds.
	const [recipe, currentList, categories, categoryIds, sharedWithActive]: [
		Awaited<ReturnType<typeof getRecipeDetail>>,
		Awaited<ReturnType<typeof getCurrentList>>,
		CategoryView[],
		string[],
		boolean
	] = await Promise.all([
		getRecipeDetail(db, user.id, recipeId, householdId),
		householdId ? getCurrentList(db, householdId) : null,
		householdId ? listCategories(db, householdId) : [],
		householdId ? recipeCategoryIds(db, householdId, recipeId) : [],
		householdId ? recipeSharedWith(db, recipeId, householdId) : false
	]);
	return {
		title: recipe.title,
		recipe,
		currentList,
		clientKey: randomUUID(),
		categories,
		categoryIds,
		sharedWithActive,
		categoryNameMax: CATEGORY_NAME_MAX,
		aiEnabled: llmEnabled()
	};
});

export const actions: Actions = {
	favorite: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		try {
			await setFavorite(user.id, event.params.id, fd.get('favorite') === '1');
		} catch (err) {
			return actionError(err);
		}
		return { ok: true };
	},
	share: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		const householdId = formText(fd, 'householdId');
		try {
			await setRecipeShare(user.id, event.params.id, householdId, fd.get('shared') === '1');
		} catch (err) {
			return actionError(err);
		}
		return { ok: true, shared: fd.get('shared') === '1' };
	},
	category: async (event) => {
		const actor = householdActor(event);
		const fd = await event.request.formData();
		const on = fd.get('on');
		if (on !== '1' && on !== '0') return fail(400, { message: 'Choose to add or remove' });
		try {
			const { sharedNow } = await setRecipeCategory(
				actor,
				event.params.id,
				formText(fd, 'categoryId'),
				on === '1'
			);
			return { ok: true, sharedNow };
		} catch (err) {
			return actionError(err);
		}
	},
	createCategory: async (event) => {
		const actor = householdActor(event);
		const fd = await event.request.formData();
		try {
			const { sharedNow } = await createCategoryForRecipe(actor, event.params.id, fd.get('name'));
			return { ok: true, sharedNow };
		} catch (err) {
			return actionError(err);
		}
	},
	duplicate: async (event) => {
		const user = requireUser(event);
		let id: string;
		try {
			id = await duplicateRecipe(user.id, event.params.id);
		} catch (err) {
			return actionError(err);
		}
		throw redirect(303, `/recipes/${id}/edit`);
	},
	archive: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		try {
			await setRecipeArchived(user.id, event.params.id, fd.get('archived') === '1');
		} catch (err) {
			return actionError(err);
		}
		return { ok: true };
	},
	delete: async (event) => {
		const user = requireUser(event);
		try {
			await deleteRecipe(user.id, event.params.id);
		} catch (err) {
			return actionError(err);
		}
		throw redirect(303, '/recipes');
	},
	addToList: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		const servings = parsePositiveAmount(formText(fd, 'servings'));
		if (!servings) return fail(400, { message: 'Enter the number of servings to plan' });
		const includeOptional = fd
			.getAll('includeOptional')
			.map((v) => Number(v))
			.filter((n) => Number.isInteger(n));
		const clientKey = formText(fd, 'clientKey').slice(0, 100);
		try {
			const { listId, batches } = await addBatchesToDraft(ctx, {
				listId: formTextOrNull(fd, 'listId'),
				newListName: 'Shopping list',
				batches: [
					{
						recipeId: event.params.id,
						servings,
						clientKey: clientKey || randomUUID(),
						includeOptional
					}
				]
			});
			return {
				ok: true,
				listId,
				duplicate: batches[0].duplicate,
				servings: servings.toString()
			};
		} catch (err) {
			return actionError(err);
		}
	}
};
