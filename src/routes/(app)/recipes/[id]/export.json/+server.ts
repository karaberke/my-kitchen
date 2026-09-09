import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { exportRecipes } from '$lib/server/recipes';

export const GET: RequestHandler = async (event) => {
	const user = requireUserApi(event);
	const data = await exportRecipes(db, user.id, { recipeIds: [event.params.id], scope: 'all' });
	return new Response(JSON.stringify(data, null, 2), {
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'private, no-store',
			'content-disposition': `attachment; filename="recipe-${event.params.id}.json"`
		}
	});
};
