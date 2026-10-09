import type { RequestEvent } from './$types';
import { downloadResponse, guard } from '$lib/server/http';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { exportRecipes } from '$lib/server/recipes';

export const GET = guard(async (event: RequestEvent) => {
	const user = requireUserApi(event);
	const data = await exportRecipes(db, user.id, { recipeIds: [event.params.id], scope: 'all' });
	return downloadResponse(
		JSON.stringify(data, null, 2),
		'application/json; charset=utf-8',
		`recipe-${event.params.id}.json`
	);
});
