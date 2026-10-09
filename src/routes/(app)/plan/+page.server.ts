import { redirect } from '@sveltejs/kit';
import { actionError, formText, guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { householdActor, requireMemberHousehold, revisionsOf } from '$lib/server/access';
import {
	addPlanEntry,
	getWeekPlan,
	mondayOf,
	planWeekToGrocery,
	removePlanEntry
} from '$lib/server/plan';
import { listRecipeOptions } from '$lib/server/recipes';
import { todayIso } from '$lib/server/pantry';

export const load = guard(async (event: PageServerLoadEvent) => {
	event.depends('app:plan');
	const { user, household } = await requireMemberHousehold(db, event);
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
		revisions: revisionsOf(household)
	};
});

export const actions: Actions = {
	add: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		const recipeId = formText(fd, 'recipeId').trim();
		try {
			await addPlanEntry(ctx, {
				plannedOn: formText(fd, 'plannedOn'),
				recipeId: recipeId || null,
				title: formText(fd, 'title')
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
			await removePlanEntry(ctx, formText(fd, 'entryId'));
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
			listId = await planWeekToGrocery(ctx, formText(fd, 'start'));
		} catch (err) {
			return actionError(err);
		}
		throw redirect(303, `/grocery/${listId}`);
	}
};
