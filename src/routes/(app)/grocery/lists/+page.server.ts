import { guard } from '$lib/server/http';
import type { PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { requireMember } from '$lib/server/access';
import { listGroceryLists } from '$lib/server/grocery';

export const load = guard(async (event: PageServerLoadEvent) => {
	const { household } = await requireMember(db, event);
	return { title: 'All grocery lists', lists: await listGroceryLists(db, household.id, 50) };
});
