import { fail, redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { assertMember, requireHousehold } from '$lib/server/access';
import { createList, getCurrentListId, listGroceryLists } from '$lib/server/grocery';
import { AppError } from '$lib/server/errors';

const loadImpl = async (event: PageServerLoadEvent) => {
	const { user, household } = requireHousehold(event);
	await assertMember(db, household.id, user.id);
	const current = await getCurrentListId(db, household.id);
	if (current) throw redirect(303, `/grocery/${current}`);
	const lists = await listGroceryLists(db, household.id, 10);
	return { title: 'Grocery list', lists };
};

export const actions: Actions = {
	create: async (event) => {
		const { user, household } = requireHousehold(event);
		const fd = await event.request.formData();
		try {
			const id = await createList(
				{ userId: user.id, actorName: user.name, householdId: household.id },
				String(fd.get('name') ?? '')
			);
			throw redirect(303, `/grocery/${id}`);
		} catch (err) {
			if (err instanceof AppError) return fail(err.status, { message: err.message });
			throw err;
		}
	}
};

export const load = guard(loadImpl);
