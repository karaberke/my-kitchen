import { redirect } from '@sveltejs/kit';
import { actionError, guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { householdActor, memberHousehold, requireHousehold, revisionsOf } from '$lib/server/access';
import {
	addPlanEntry,
	getWeekPlan,
	mondayOf,
	planWeekToGrocery,
	removePlanEntry
} from '$lib/server/plan';
import { listRecipeOptions } from '$lib/server/recipes';
import { todayIso } from '$lib/server/pantry';

const loadImpl = async (event: PageServerLoadEvent) => {
	const { user, household } = requireHousehold(event);
	event.depends('app:plan');
	const h = await memberHousehold(db, household.id, user.id);
	const today = todayIso();
	const start = mondayOf(today);
	const [days, recipes] = await Promise.all([
		getWeekPlan(db, household.id, start),
		// The picker in the "Add meal" sheet: the user's own and shared recipes.
		listRecipeOptions(db, user.id)
	]);
	return {
		title: 'This week',
		today,
		start,
		days,
		recipes,
		revisions: revisionsOf(h)
	};
};

export const actions: Actions = {
	add: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		const recipeId = String(fd.get('recipeId') ?? '').trim();
		try {
			await addPlanEntry(ctx, {
				plannedOn: String(fd.get('plannedOn') ?? ''),
				recipeId: recipeId || null,
				title: String(fd.get('title') ?? '')
			});
		} catch (err) {
			return actionError(err);
		}
		return { ok: true, action: 'add' };
	},
	remove: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			await removePlanEntry(ctx, String(fd.get('entryId') ?? ''));
		} catch (err) {
			return actionError(err);
		}
		return { ok: true, action: 'remove' };
	},
	toGrocery: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		let listId: string;
		try {
			listId = await planWeekToGrocery(ctx, String(fd.get('start') ?? ''));
		} catch (err) {
			return actionError(err);
		}
		throw redirect(303, `/grocery/${listId}`);
	}
};

export const load = guard(loadImpl);
