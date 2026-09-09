import { redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { PageServerLoadEvent } from './$types';

const loadImpl = ({ locals }: PageServerLoadEvent) => {
	throw redirect(303, locals.user ? '/recipes' : '/login');
};

export const load = guard(loadImpl);
