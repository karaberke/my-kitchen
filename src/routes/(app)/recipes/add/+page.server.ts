import { guard } from '$lib/server/http';
import type { PageServerLoadEvent } from './$types';
import { requireUser } from '$lib/server/access';

const loadImpl = (event: PageServerLoadEvent) => {
	requireUser(event);
	return { title: 'Add a recipe' };
};

export const load = guard(loadImpl);
