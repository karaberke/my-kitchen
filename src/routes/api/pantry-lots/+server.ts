import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { assertMember, requireUserApi } from '$lib/server/access';
import { lotsForIngredient } from '$lib/server/cooking';
import { noStoreJson } from '$lib/server/http';
import { AppError } from '$lib/server/errors';
import { isUnitId } from '$lib/shared/units';

/** Lots of one ingredient in the active household, for cooking substitutions and manual lot choice. */
export const GET: RequestHandler = async (event) => {
	const user = requireUserApi(event);
	const householdId = event.locals.household?.id;
	if (!householdId) throw new AppError(400, 'No household');
	await assertMember(db, householdId, user.id);
	const ingredientId = event.url.searchParams.get('ingredient') ?? '';
	if (!/^[0-9a-f-]{36}$/i.test(ingredientId)) throw new AppError(400, 'ingredient required');
	const unit = event.url.searchParams.get('unit');
	const convention = event.url.searchParams.get('convention') === 'us' ? 'us' : 'metric';
	const data = await lotsForIngredient(
		db,
		householdId,
		ingredientId,
		unit && isUnitId(unit) ? unit : null,
		convention
	);
	return noStoreJson(data);
};
