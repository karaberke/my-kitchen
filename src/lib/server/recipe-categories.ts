import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '$lib/server/db';
import { recipeCategories, recipeCategoryItems, recipeShares } from '$lib/server/db/schema';
import { assertMember, assertRecipeReadable } from '$lib/server/access';
import { AppError, notFound, pgError } from '$lib/server/errors';
import { lockHousehold } from '$lib/server/inventory';
import { isUniqueViolation, withTransaction } from '$lib/server/operations';
import type { ActorContext } from '$lib/server/pantry';

/** Mirrors `recipe_category_name_length_chk`. */
export const CATEGORY_NAME_MAX = 40;
export const CATEGORIES_PER_HOUSEHOLD_MAX = 50;

const NAME_UNIQUE = 'recipe_category_name_uq';
const ITEM_CATEGORY_FK = 'recipe_category_item_category_fk';
const ITEM_SHARE_FK = 'recipe_category_item_share_fk';

export interface CategoryView {
	id: string;
	name: string;
}

/** The one place a category name is trimmed and validated. */
export function categoryName(input: unknown): string {
	const name = typeof input === 'string' ? input.trim() : '';
	if (!name) throw new AppError(400, 'Enter a category name');
	// char_length counts code points, not UTF-16 units
	if ([...name].length > CATEGORY_NAME_MAX)
		throw new AppError(400, `Keep the category name to ${CATEGORY_NAME_MAX} characters or fewer`);
	return name;
}

function duplicateName(err: unknown): unknown {
	return isUniqueViolation(err, NAME_UNIQUE)
		? new AppError(409, 'A category with that name already exists')
		: err;
}

/** A concurrent delete of the category or the share between our check and the insert. */
function itemReferenceGone(err: unknown): unknown {
	const pg = pgError(err);
	if (pg?.code !== '23503') return err;
	if (pg.constraint_name === ITEM_CATEGORY_FK) return notFound('Category not found');
	if (pg.constraint_name === ITEM_SHARE_FK)
		return new AppError(409, 'The recipe is no longer shared with this household');
	return err;
}

async function insertCategory(tx: Tx, householdId: string, name: string): Promise<string> {
	// Serialises creates per household so the cap cannot be overrun concurrently.
	await lockHousehold(tx, householdId, {});
	const [{ n }] = await tx
		.select({ n: count() })
		.from(recipeCategories)
		.where(eq(recipeCategories.householdId, householdId));
	if (n >= CATEGORIES_PER_HOUSEHOLD_MAX)
		throw new AppError(
			409,
			`A household can have at most ${CATEGORIES_PER_HOUSEHOLD_MAX} categories`
		);
	try {
		const [row] = await tx
			.insert(recipeCategories)
			.values({ householdId, name })
			.returning({ id: recipeCategories.id });
		return row.id;
	} catch (err) {
		throw duplicateName(err);
	}
}

async function assertCategory(tx: Tx, householdId: string, categoryId: string): Promise<void> {
	const [row] = await tx
		.select({ id: recipeCategories.id })
		.from(recipeCategories)
		.where(and(eq(recipeCategories.id, categoryId), eq(recipeCategories.householdId, householdId)))
		.limit(1);
	if (!row) throw notFound('Category not found');
}

/** Whether the recipe is shared with the household. Callers check membership first. */
export async function recipeSharedWith(
	dbx: DbOrTx,
	recipeId: string,
	householdId: string
): Promise<boolean> {
	const [row] = await dbx
		.select({ recipeId: recipeShares.recipeId })
		.from(recipeShares)
		.where(and(eq(recipeShares.recipeId, recipeId), eq(recipeShares.householdId, householdId)))
		.limit(1);
	return !!row;
}

/**
 * Share the recipe with the actor's household if it is not yet, which only its
 * owner may do. Returns true when this call created the share.
 */
async function ensureShared(
	tx: Tx,
	actor: ActorContext,
	recipe: { id: string; ownerUserId: string }
): Promise<boolean> {
	if (await recipeSharedWith(tx, recipe.id, actor.householdId)) return false;
	if (recipe.ownerUserId !== actor.userId)
		throw new AppError(403, 'Only the owner can share this recipe with the household');
	const inserted = await tx
		.insert(recipeShares)
		.values({ recipeId: recipe.id, householdId: actor.householdId })
		.onConflictDoNothing()
		.returning({ recipeId: recipeShares.recipeId });
	return inserted.length > 0;
}

async function insertItem(tx: Tx, householdId: string, categoryId: string, recipeId: string) {
	try {
		await tx
			.insert(recipeCategoryItems)
			.values({ categoryId, recipeId, householdId })
			.onConflictDoNothing();
	} catch (err) {
		throw itemReferenceGone(err);
	}
}

export async function createCategory(actor: ActorContext, rawName: unknown): Promise<string> {
	return withTransaction(async (tx) => {
		await assertMember(tx, actor.householdId, actor.userId);
		return insertCategory(tx, actor.householdId, categoryName(rawName));
	});
}

export async function renameCategory(
	actor: ActorContext,
	categoryId: string,
	rawName: unknown
): Promise<void> {
	await withTransaction(async (tx) => {
		await assertMember(tx, actor.householdId, actor.userId);
		const name = categoryName(rawName);
		let updated: { id: string }[];
		try {
			updated = await tx
				.update(recipeCategories)
				.set({ name })
				.where(
					and(
						eq(recipeCategories.id, categoryId),
						eq(recipeCategories.householdId, actor.householdId)
					)
				)
				.returning({ id: recipeCategories.id });
		} catch (err) {
			throw duplicateName(err);
		}
		if (updated.length === 0) throw notFound('Category not found');
	});
}

/** Removes the category and, by cascade, its items. Recipes and shares stay. */
export async function deleteCategory(actor: ActorContext, categoryId: string): Promise<void> {
	await withTransaction(async (tx) => {
		await assertMember(tx, actor.householdId, actor.userId);
		const deleted = await tx
			.delete(recipeCategories)
			.where(
				and(
					eq(recipeCategories.id, categoryId),
					eq(recipeCategories.householdId, actor.householdId)
				)
			)
			.returning({ id: recipeCategories.id });
		if (deleted.length === 0) throw notFound('Category not found');
	});
}

/**
 * Put a recipe into, or take it out of, a household category. Adding an
 * unshared recipe shares it first (owner only); `sharedNow` reports that.
 */
export async function setRecipeCategory(
	actor: ActorContext,
	recipeId: string,
	categoryId: string,
	on: boolean
): Promise<{ sharedNow: boolean }> {
	return withTransaction(async (tx) => {
		await assertMember(tx, actor.householdId, actor.userId);
		await assertCategory(tx, actor.householdId, categoryId);
		const recipe = await assertRecipeReadable(tx, recipeId, actor.userId);
		if (!on) {
			await tx
				.delete(recipeCategoryItems)
				.where(
					and(
						eq(recipeCategoryItems.categoryId, categoryId),
						eq(recipeCategoryItems.recipeId, recipeId)
					)
				);
			return { sharedNow: false };
		}
		const sharedNow = await ensureShared(tx, actor, recipe);
		await insertItem(tx, actor.householdId, categoryId, recipe.id);
		return { sharedNow };
	});
}

/** Create a category and put the recipe in it, all or nothing. */
export async function createCategoryForRecipe(
	actor: ActorContext,
	recipeId: string,
	rawName: unknown
): Promise<{ categoryId: string; sharedNow: boolean }> {
	return withTransaction(async (tx) => {
		await assertMember(tx, actor.householdId, actor.userId);
		const name = categoryName(rawName);
		const categoryId = await insertCategory(tx, actor.householdId, name);
		const recipe = await assertRecipeReadable(tx, recipeId, actor.userId);
		const sharedNow = await ensureShared(tx, actor, recipe);
		await insertItem(tx, actor.householdId, categoryId, recipe.id);
		return { categoryId, sharedNow };
	});
}

/** The household's categories by name. Callers check membership first. */
export async function listCategories(dbx: DbOrTx, householdId: string): Promise<CategoryView[]> {
	return dbx
		.select({ id: recipeCategories.id, name: recipeCategories.name })
		.from(recipeCategories)
		.where(eq(recipeCategories.householdId, householdId))
		.orderBy(asc(sql`lower(${recipeCategories.name})`), asc(recipeCategories.id));
}

/** The household categories the recipe is in. Callers check membership first. */
export async function recipeCategoryIds(
	dbx: DbOrTx,
	householdId: string,
	recipeId: string
): Promise<string[]> {
	const rows = await dbx
		.select({ categoryId: recipeCategoryItems.categoryId })
		.from(recipeCategoryItems)
		.where(
			and(
				eq(recipeCategoryItems.householdId, householdId),
				eq(recipeCategoryItems.recipeId, recipeId)
			)
		);
	return rows.map((r) => r.categoryId);
}
