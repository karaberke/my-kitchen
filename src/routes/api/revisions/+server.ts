import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assertMember, loadHouseholdOrThrow, requireUserApi } from '$lib/server/access';
import { noStoreJson } from '$lib/server/http';
import { AppError } from '$lib/server/errors';

/** Tiny authorized poll target: { pantry, grocery } revision counters of a household. */
export const GET: RequestHandler = async (event) => {
	const user = requireUserApi(event);
	const householdId = event.url.searchParams.get('household') ?? event.locals.household?.id;
	if (!householdId) throw new AppError(400, 'No household');
	await assertMember(db, householdId, user.id);
	const h = await loadHouseholdOrThrow(db, householdId);
	return noStoreJson({ household: h.id, pantry: h.pantryRevision, grocery: h.groceryRevision });
};
