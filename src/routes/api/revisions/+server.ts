import type { RequestEvent } from './$types';
import { db } from '$lib/server/db';
import { assertMember, loadHouseholdOrThrow, requireUserApi } from '$lib/server/access';
import { noStoreJson, guard } from '$lib/server/http';
import { AppError } from '$lib/server/errors';

/** Tiny authorized poll target: { pantry, grocery } revision counters of a household. */
const GETImpl = async (event: RequestEvent) => {
	const user = requireUserApi(event);
	const householdId = event.url.searchParams.get('household') ?? event.locals.household?.id;
	if (!householdId) throw new AppError(400, 'No household');
	await assertMember(db, householdId, user.id);
	const h = await loadHouseholdOrThrow(db, householdId);
	return noStoreJson({ household: h.id, pantry: h.pantryRevision, grocery: h.groceryRevision });
};

export const GET = guard(GETImpl);
