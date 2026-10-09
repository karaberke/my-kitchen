import { redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { PageServerLoadEvent } from './$types';

export const load = guard(({ locals }: PageServerLoadEvent) => {
	throw redirect(303, locals.user ? '/recipes' : '/login');
});
