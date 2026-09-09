import { and, asc, eq, isNull, or, sql, inArray } from 'drizzle-orm';
import type { DbOrTx } from '$lib/server/db';
import { ingredientAliases, ingredients } from '$lib/server/db/schema';
import { normalizeName } from '$lib/shared/text';
import { AppError } from '$lib/server/errors';

export const GROCERY_CATEGORIES = [
	'Produce',
	'Meat & fish',
	'Dairy & eggs',
	'Bakery',
	'Pantry',
	'Spices',
	'Frozen',
	'Beverages',
	'Household',
	'Other'
] as const;
export type GroceryCategory = (typeof GROCERY_CATEGORIES)[number];

export interface IngredientSuggestion {
	id: string;
	name: string;
	category: string;
	scope: 'catalog' | 'mine';
	matchedAlias: string | null;
}

/**
 * Autocomplete over the shared catalog plus the caller's own custom
 * identities. Other users' private names are never returned.
 */
export async function searchIngredients(
	db: DbOrTx,
	userId: string,
	query: string,
	limit = 8
): Promise<IngredientSuggestion[]> {
	const q = normalizeName(query);
	if (!q) return [];
	const prefix = q.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
	const scope = or(isNull(ingredients.ownerUserId), eq(ingredients.ownerUserId, userId));
	const byName = await db
		.select({
			id: ingredients.id,
			name: ingredients.name,
			category: ingredients.category,
			ownerUserId: ingredients.ownerUserId,
			exact: sql<boolean>`${ingredients.nameNormalized} = ${q}`
		})
		.from(ingredients)
		.where(and(scope, sql`${ingredients.nameNormalized} like ${prefix}`))
		.orderBy(
			sql`${ingredients.nameNormalized} = ${q} desc`,
			sql`${ingredients.ownerUserId} is not null desc`,
			asc(ingredients.nameNormalized)
		)
		.limit(limit);
	const results: IngredientSuggestion[] = byName.map((r) => ({
		id: r.id,
		name: r.name,
		category: r.category,
		scope: r.ownerUserId ? 'mine' : 'catalog',
		matchedAlias: null
	}));
	if (results.length < limit) {
		const seen = new Set(results.map((r) => r.id));
		const byAlias = await db
			.select({
				id: ingredients.id,
				name: ingredients.name,
				category: ingredients.category,
				ownerUserId: ingredients.ownerUserId,
				alias: ingredientAliases.aliasNormalized
			})
			.from(ingredientAliases)
			.innerJoin(ingredients, eq(ingredients.id, ingredientAliases.ingredientId))
			.where(and(scope, sql`${ingredientAliases.aliasNormalized} like ${prefix}`))
			.orderBy(asc(ingredientAliases.aliasNormalized))
			.limit(limit);
		for (const r of byAlias) {
			if (seen.has(r.id)) continue;
			seen.add(r.id);
			results.push({
				id: r.id,
				name: r.name,
				category: r.category,
				scope: r.ownerUserId ? 'mine' : 'catalog',
				matchedAlias: r.alias
			});
			if (results.length >= limit) break;
		}
	}
	return results;
}

/** Create (or reuse) a private custom identity owned by the user. */
export async function createCustomIngredient(
	db: DbOrTx,
	userId: string,
	name: string,
	category: string = 'Other'
) {
	const clean = name.trim().replace(/\s+/g, ' ');
	if (clean.length < 1 || clean.length > 80)
		throw new AppError(400, 'Ingredient name must be 1-80 characters');
	const normalized = normalizeName(clean);
	if (!normalized) throw new AppError(400, 'Ingredient name must contain letters or numbers');
	const cat = (GROCERY_CATEGORIES as readonly string[]).includes(category) ? category : 'Other';
	const [existing] = await db
		.select({ id: ingredients.id, name: ingredients.name, category: ingredients.category })
		.from(ingredients)
		.where(
			and(
				eq(ingredients.nameNormalized, normalized),
				or(isNull(ingredients.ownerUserId), eq(ingredients.ownerUserId, userId))
			)
		)
		.orderBy(sql`${ingredients.ownerUserId} is null desc`)
		.limit(1);
	if (existing) return existing;
	const [created] = await db
		.insert(ingredients)
		.values({ ownerUserId: userId, name: clean, nameNormalized: normalized, category: cat })
		.onConflictDoNothing()
		.returning({ id: ingredients.id, name: ingredients.name, category: ingredients.category });
	if (created) return created;
	const [again] = await db
		.select({ id: ingredients.id, name: ingredients.name, category: ingredients.category })
		.from(ingredients)
		.where(and(eq(ingredients.nameNormalized, normalized), eq(ingredients.ownerUserId, userId)))
		.limit(1);
	return again;
}

/**
 * Validate that every referenced ingredient id is visible to the user
 * (catalog or own custom). Returns the visible ids.
 */
export async function assertIngredientsVisible(
	db: DbOrTx,
	userId: string,
	ids: string[]
): Promise<Set<string>> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return new Set();
	const rows = await db
		.select({ id: ingredients.id })
		.from(ingredients)
		.where(
			and(
				inArray(ingredients.id, unique),
				or(isNull(ingredients.ownerUserId), eq(ingredients.ownerUserId, userId))
			)
		);
	const visible = new Set(rows.map((r) => r.id));
	const missing = unique.filter((id) => !visible.has(id));
	if (missing.length) throw new AppError(400, 'One or more ingredients are not available to you');
	return visible;
}

export async function getIngredientMeta(db: DbOrTx, ids: string[]) {
	const unique = [...new Set(ids)];
	if (!unique.length)
		return new Map<string, { name: string; category: string; gramsPerMl: string | null }>();
	const rows = await db
		.select({
			id: ingredients.id,
			name: ingredients.name,
			category: ingredients.category,
			gramsPerMl: ingredients.gramsPerMl
		})
		.from(ingredients)
		.where(inArray(ingredients.id, unique));
	return new Map(
		rows.map((r) => [r.id, { name: r.name, category: r.category, gramsPerMl: r.gramsPerMl }])
	);
}

/** Update the density (g/ml) of an ingredient the user owns. */
export async function setIngredientDensity(
	db: DbOrTx,
	userId: string,
	ingredientId: string,
	gramsPerMl: string | null
) {
	const result = await db
		.update(ingredients)
		.set({ gramsPerMl })
		.where(and(eq(ingredients.id, ingredientId), eq(ingredients.ownerUserId, userId)))
		.returning({ id: ingredients.id });
	if (!result.length) throw new AppError(404, 'Only your own custom ingredients can be edited');
}
