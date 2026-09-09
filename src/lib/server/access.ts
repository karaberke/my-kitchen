import { and, eq, exists, or, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import type { DbOrTx } from '$lib/server/db';
import {
	householdMembers,
	households,
	recipeShares,
	recipes,
	userPreferences,
	type HouseholdRole
} from '$lib/server/db/schema';
import { AppError, forbidden, notFound } from '$lib/server/errors';

type Membership = App.Locals['memberships'][number];

/**
 * Pick the active household: the stored preference when still a member,
 * otherwise the first membership. Persist a repaired preference lazily.
 */
export async function resolveActiveHousehold(
	db: DbOrTx,
	userId: string,
	memberships: Membership[]
): Promise<App.Locals['household']> {
	if (memberships.length === 0) return null;
	const [pref] = await db
		.select({ activeHouseholdId: userPreferences.activeHouseholdId })
		.from(userPreferences)
		.where(eq(userPreferences.userId, userId))
		.limit(1);
	const wanted = pref?.activeHouseholdId ?? null;
	const match = memberships.find((m) => m.householdId === wanted) ?? memberships[0];
	if (match.householdId !== wanted) {
		await db
			.insert(userPreferences)
			.values({ userId, activeHouseholdId: match.householdId })
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { activeHouseholdId: match.householdId, updatedAt: sql`now()` }
			});
	}
	return { id: match.householdId, name: match.name, role: match.role };
}

/** Redirect anonymous visitors to login; return the user otherwise. */
export function requireUser(event: RequestEvent) {
	if (!event.locals.user) {
		const next = event.url.pathname + event.url.search;
		throw redirect(303, `/login?next=${encodeURIComponent(next)}`);
	}
	return event.locals.user;
}

/** API variant: 401 instead of redirect. */
export function requireUserApi(event: RequestEvent) {
	if (!event.locals.user) throw new AppError(401, 'Sign in required');
	return event.locals.user;
}

export function requireHousehold(event: RequestEvent) {
	const user = requireUser(event);
	const household = event.locals.household;
	if (!household) throw new AppError(409, 'You are not a member of any household');
	return { user, household };
}

/**
 * Authoritative membership check against the database (not the request cache)
 * for every write and for every read of household data. Returns the role.
 */
export async function assertMember(
	db: DbOrTx,
	householdId: string,
	userId: string
): Promise<HouseholdRole> {
	const [row] = await db
		.select({ role: householdMembers.role })
		.from(householdMembers)
		.where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId)))
		.limit(1);
	if (!row) throw forbidden('You are not a member of this household');
	return row.role;
}

export async function assertOwner(db: DbOrTx, householdId: string, userId: string): Promise<void> {
	const role = await assertMember(db, householdId, userId);
	if (role !== 'owner') throw forbidden('Only a household owner can do this');
}

export async function loadHouseholdOrThrow(db: DbOrTx, householdId: string) {
	const [row] = await db
		.select({
			id: households.id,
			name: households.name,
			pantryRevision: households.pantryRevision,
			groceryRevision: households.groceryRevision
		})
		.from(households)
		.where(eq(households.id, householdId))
		.limit(1);
	if (!row) throw notFound('Household not found');
	return row;
}

/** A recipe is readable by its owner, or by members of a household it is shared with. */
export function recipeReadableBy(userId: string) {
	return or(
		eq(recipes.ownerUserId, userId),
		exists(
			sql`(select 1 from ${recipeShares} rs join ${householdMembers} hm on hm.household_id = rs.household_id where rs.recipe_id = ${recipes.id} and hm.user_id = ${userId})`
		)
	);
}

export async function assertRecipeReadable(db: DbOrTx, recipeId: string, userId: string) {
	const [row] = await db
		.select({
			id: recipes.id,
			ownerUserId: recipes.ownerUserId,
			status: recipes.status,
			revision: recipes.revision
		})
		.from(recipes)
		.where(and(eq(recipes.id, recipeId), recipeReadableBy(userId)))
		.limit(1);
	if (!row) throw notFound('Recipe not found');
	return row;
}

export async function assertRecipeOwner(db: DbOrTx, recipeId: string, userId: string) {
	const [row] = await db
		.select({
			id: recipes.id,
			revision: recipes.revision,
			status: recipes.status,
			imageId: recipes.imageId
		})
		.from(recipes)
		.where(and(eq(recipes.id, recipeId), eq(recipes.ownerUserId, userId)))
		.limit(1);
	if (!row) throw notFound('Recipe not found');
	return row;
}
