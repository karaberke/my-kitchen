import type { RequestEvent } from './$types';
import { downloadResponse, guard } from '$lib/server/http';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { exportRecipes } from '$lib/server/recipes';

/** The caller's collection. `?scope=all` also includes recipes shared with them. */
export const GET = guard(async (event: RequestEvent) => {
	const user = requireUserApi(event);
	const scope = event.url.searchParams.get('scope') === 'all' ? 'all' : 'mine';
	const data = await exportRecipes(db, user.id, { scope });
	return downloadResponse(
		JSON.stringify(data, null, 2),
		'application/json; charset=utf-8',
		'recipes.json'
	);
});
