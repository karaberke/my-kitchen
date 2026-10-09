import { redirect } from '@sveltejs/kit';
import { actionError, formText, guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { householdActor, requireMember } from '$lib/server/access';
import { createList, getCurrentListId, listGroceryLists } from '$lib/server/grocery';

export const load = guard(async (event: PageServerLoadEvent) => {
	const { household } = await requireMember(db, event);
	const current = await getCurrentListId(db, household.id);
	if (current) throw redirect(303, `/grocery/${current}`);
	const lists = await listGroceryLists(db, household.id, 10);
	return { title: 'Grocery list', lists };
});

export const actions: Actions = {
	create: async (event) => {
		const actor = householdActor(event);
		const fd = await event.request.formData();
		try {
			const id = await createList(actor, formText(fd, 'name'));
			throw redirect(303, `/grocery/${id}`);
		} catch (err) {
			return actionError(err);
		}
	}
};
