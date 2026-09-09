import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { exportRecipes } from '$lib/server/recipes';

/** The caller's collection. `?scope=all` also includes recipes shared with them. */
export const GET: RequestHandler = async (event) => {
	const user = requireUserApi(event);
	const scope = event.url.searchParams.get('scope') === 'all' ? 'all' : 'mine';
	const data = await exportRecipes(db, user.id, { scope });
	return new Response(JSON.stringify(data, null, 2), {
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'private, no-store',
			'content-disposition': 'attachment; filename="recipes.json"'
		}
	});
};
