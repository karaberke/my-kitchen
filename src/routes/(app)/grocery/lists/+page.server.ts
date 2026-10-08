import { redirect } from '@sveltejs/kit';
import { actionError, guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { assertMember, householdActor, requireHousehold } from '$lib/server/access';
import { createList, listGroceryLists } from '$lib/server/grocery';

const loadImpl = async (event: PageServerLoadEvent) => {
	const { user, household } = requireHousehold(event);
	await assertMember(db, household.id, user.id);
	return { title: 'All grocery lists', lists: await listGroceryLists(db, household.id, 50) };
};

export const actions: Actions = {
	create: async (event) => {
		const actor = householdActor(event);
		const fd = await event.request.formData();
		try {
			const id = await createList(actor, String(fd.get('name') ?? ''));
			throw redirect(303, `/grocery/${id}`);
		} catch (err) {
			return actionError(err);
		}
	}
};

export const load = guard(loadImpl);
