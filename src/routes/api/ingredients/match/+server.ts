import type { RequestEvent } from './$types';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { matchIngredientNames } from '$lib/server/ingredient-match';
import { noStoreJson, guard } from '$lib/server/http';

/** The catalog match the app proposes for one written name, or null. */
const GETImpl = async (event: RequestEvent) => {
	const user = requireUserApi(event);
	const name = (event.url.searchParams.get('name') ?? '').slice(0, 80);
	if (!name.trim()) return noStoreJson({ match: null });
	const matches = await matchIngredientNames(db, user.id, [name]);
	return noStoreJson({ match: matches.get(name) ?? null });
};

export const GET = guard(GETImpl);
