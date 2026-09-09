import { redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { Actions } from './$types';
import { auth } from '$lib/server/auth';

const loadImpl = () => {
	throw redirect(303, '/login');
};

export const actions: Actions = {
	default: async (event) => {
		await auth.api.signOut({ headers: event.request.headers }).catch(() => {});
		throw redirect(303, '/login');
	}
};

export const load = guard(loadImpl);
