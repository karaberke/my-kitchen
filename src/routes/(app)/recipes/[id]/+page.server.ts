import { fail, redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { requireHousehold, requireUser } from '$lib/server/access';
import {
	deleteRecipe,
	duplicateRecipe,
	getRecipeDetail,
	setFavorite,
	setRecipeArchived,
	setRecipeShare
} from '$lib/server/recipes';
import { addBatch, createList, getCurrentListId, getListDetail } from '$lib/server/grocery';
import { AppError } from '$lib/server/errors';
import { Dec } from '$lib/shared/decimal';
import { parseAmount } from '$lib/shared/amount-parse';
import { randomUUID } from 'node:crypto';

const loadImpl = async (event: PageServerLoadEvent) => {
	const user = requireUser(event);
	event.depends('app:recipe');
	const householdId = event.locals.household?.id ?? null;
	const recipe = await getRecipeDetail(db, user.id, event.params.id, householdId);
	const currentListId = householdId ? await getCurrentListId(db, householdId) : null;
	const currentList = currentListId ? await getListDetail(db, householdId!, currentListId) : null;
	return {
		title: recipe.title,
		recipe,
		currentList: currentList
			? { id: currentList.id, name: currentList.name, status: currentList.status }
			: null,
		clientKey: randomUUID()
	};
};

function handle(err: unknown) {
	if (err instanceof AppError) return fail(err.status, { message: err.message });
	throw err;
}

export const actions: Actions = {
	favorite: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		try {
			await setFavorite(user.id, event.params.id, fd.get('favorite') === '1');
		} catch (err) {
			return handle(err);
		}
		return { ok: true };
	},
	share: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		const householdId = String(fd.get('householdId') ?? '');
		try {
			await setRecipeShare(user.id, event.params.id, householdId, fd.get('shared') === '1');
		} catch (err) {
			return handle(err);
		}
		return { ok: true, shared: fd.get('shared') === '1' };
	},
	duplicate: async (event) => {
		const user = requireUser(event);
		let id: string;
		try {
			id = await duplicateRecipe(user.id, event.params.id);
		} catch (err) {
			return handle(err);
		}
		throw redirect(303, `/recipes/${id}/edit`);
	},
	archive: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		try {
			await setRecipeArchived(user.id, event.params.id, fd.get('archived') === '1');
		} catch (err) {
			return handle(err);
		}
		return { ok: true };
	},
	delete: async (event) => {
		const user = requireUser(event);
		try {
			await deleteRecipe(user.id, event.params.id);
		} catch (err) {
			return handle(err);
		}
		throw redirect(303, '/recipes');
	},
	addToList: async (event) => {
		const { user, household } = requireHousehold(event);
		const fd = await event.request.formData();
		const servingsRaw = String(fd.get('servings') ?? '');
		const parsed = parseAmount(servingsRaw);
		if (!parsed.ok || !parsed.value || !parsed.value.isPositive())
			return fail(400, { message: 'Enter the number of servings to plan' });
		const includeOptional = fd
			.getAll('includeOptional')
			.map((v) => Number(v))
			.filter((n) => Number.isInteger(n));
		const clientKey = String(fd.get('clientKey') ?? '').slice(0, 100);
		const ctx = { userId: user.id, actorName: user.name, householdId: household.id };
		try {
			let listId = String(fd.get('listId') ?? '');
			if (!listId) listId = (await getCurrentListId(db, household.id)) ?? '';
			if (listId) {
				const detail = await getListDetail(db, household.id, listId);
				if (detail.status !== 'draft') listId = '';
			}
			if (!listId) listId = await createList(ctx, 'Shopping list');
			const result = await addBatch(ctx, {
				listId,
				recipeId: event.params.id,
				servings: parsed.value,
				clientKey: clientKey || randomUUID(),
				includeOptional
			});
			return {
				ok: true,
				listId,
				duplicate: result.duplicate,
				servings: Dec.from(parsed.value).toString()
			};
		} catch (err) {
			return handle(err);
		}
	}
};

export const load = guard(loadImpl);
