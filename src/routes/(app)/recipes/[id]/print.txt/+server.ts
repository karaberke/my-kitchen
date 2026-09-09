import type { RequestEvent } from './$types';
import { guard } from '$lib/server/http';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { getRecipeDetail, recipeToPlainText } from '$lib/server/recipes';

const GETImpl = async (event: RequestEvent) => {
	const user = requireUserApi(event);
	const detail = await getRecipeDetail(db, user.id, event.params.id, null);
	return new Response(recipeToPlainText(detail), {
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' }
	});
};

export const GET = guard(GETImpl);
