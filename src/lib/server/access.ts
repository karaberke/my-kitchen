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
 * The active-household rule, the one place it is written: the stored
 * preference (`wanted`) while the user is still a member of it, otherwise the
 * first membership (oldest household first, as `sessionMemberships` orders
 * them). Null without memberships.
 */
export function pickActiveMembership<M extends { householdId: string }>(
	memberships: readonly M[],
	wanted: string | null
): M | null {
	return memberships.find((m) => m.householdId === wanted) ?? memberships[0] ?? null;
}

/**
 * Pick the active household with `pickActiveMembership`. Persist a repaired
 * preference lazily.
 */
export async function resolveActiveHousehold(
	db: DbOrTx,
	userId: string,
	memberships: Membership[],
	wanted: string | null
): Promise<App.Locals['household']> {
	const match = pickActiveMembership(memberships, wanted);
	if (!match) return null;
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

/** Who acts, and for which household: what every pantry/grocery/plan action passes to its domain function. */
export interface ActorContext {
	userId: string;
	actorName: string;
	householdId: string;
}

/** The `ActorContext` of the signed-in user in their active household. */
export function householdActor(event: RequestEvent): ActorContext {
	const { user, household } = requireHousehold(event);
	return { userId: user.id, actorName: user.name, householdId: household.id };
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

/**
 * `assertMember` and `loadHouseholdOrThrow` in one query: the household row
 * with the caller's role, or a 403 when the user is not a member.
 */
export async function memberHousehold(db: DbOrTx, householdId: string, userId: string) {
	const [row] = await db
		.select({
			id: households.id,
			name: households.name,
			role: householdMembers.role,
			pantryRevision: households.pantryRevision,
			groceryRevision: households.groceryRevision,
			planRevision: households.planRevision
		})
		.from(householdMembers)
		.innerJoin(households, eq(households.id, householdMembers.householdId))
		.where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId)))
		.limit(1);
	if (!row) throw forbidden('You are not a member of this household');
	return row;
}

/** The `{ pantry, grocery, plan }` counters a page hands to `PollRevisions`. */
export function revisionsOf(h: {
	pantryRevision: number;
	groceryRevision: number;
	planRevision: number;
}) {
	return { pantry: h.pantryRevision, grocery: h.groceryRevision, plan: h.planRevision };
}

export async function loadHouseholdOrThrow(db: DbOrTx, householdId: string) {
	const [row] = await db
		.select({
			id: households.id,
			name: households.name,
			pantryRevision: households.pantryRevision,
			groceryRevision: households.groceryRevision,
			planRevision: households.planRevision
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

/** The recipe when this user may read it (else a 404), with the columns cooking and planning use. */
export async function assertRecipeReadable(db: DbOrTx, recipeId: string, userId: string) {
	const [row] = await db
		.select({
			id: recipes.id,
			ownerUserId: recipes.ownerUserId,
			status: recipes.status,
			revision: recipes.revision,
			title: recipes.title,
			baseServings: recipes.baseServings,
			convention: recipes.convention
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
