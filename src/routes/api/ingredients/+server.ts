import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { searchIngredients } from '$lib/server/ingredients';
import { noStoreJson } from '$lib/server/http';

/** Autocomplete: catalog + the caller's own custom identities only. */
export const GET: RequestHandler = async (event) => {
	const user = requireUserApi(event);
	const q = (event.url.searchParams.get('q') ?? '').slice(0, 60);
	const limit = Math.min(12, Math.max(1, Number(event.url.searchParams.get('limit') ?? 8) || 8));
	const items = await searchIngredients(db, user.id, q, limit);
	return noStoreJson({ items });
};
