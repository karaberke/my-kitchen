import { fail, redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/access';
import { createHousehold, setActiveHousehold } from '$lib/server/households';
import { AppError } from '$lib/server/errors';

/** The list of households. Managing one happens on /household/[id]. */
const loadImpl = async (event: PageServerLoadEvent) => {
	requireUser(event);
	event.depends('app:household');
	return { title: 'Households' };
};

function handle(err: unknown) {
	if (err instanceof AppError) return fail(err.status, { message: err.message });
	throw err;
}

export const actions: Actions = {
	// Posted to by HouseholdSwitcher in the app shell as well as this page.
	switch: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		try {
			await setActiveHousehold(db, user.id, String(fd.get('householdId') ?? ''));
		} catch (err) {
			return handle(err);
		}
		return { ok: true, action: 'switch' };
	},
	create: async (event) => {
		const user = requireUser(event);
		const fd = await event.request.formData();
		let id: string;
		try {
			id = await createHousehold(db, user.id, String(fd.get('name') ?? ''));
		} catch (err) {
			return handle(err);
		}
		throw redirect(303, `/household/${id}`);
	}
};

export const load = guard(loadImpl);
