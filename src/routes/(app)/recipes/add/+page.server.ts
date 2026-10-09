import { guard } from '$lib/server/http';
import type { PageServerLoadEvent } from './$types';
import { requireUser } from '$lib/server/access';

export const load = guard((event: PageServerLoadEvent) => {
	requireUser(event);
	return { title: 'Add a recipe' };
});
