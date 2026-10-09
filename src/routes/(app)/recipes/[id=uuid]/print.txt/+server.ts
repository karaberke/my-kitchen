import type { RequestEvent } from './$types';
import { downloadResponse, guard } from '$lib/server/http';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { getRecipeDetail, recipeToPlainText } from '$lib/server/recipes';

export const GET = guard(async (event: RequestEvent) => {
	const user = requireUserApi(event);
	const detail = await getRecipeDetail(db, user.id, event.params.id, null);
	return downloadResponse(recipeToPlainText(detail), 'text/plain; charset=utf-8');
});
