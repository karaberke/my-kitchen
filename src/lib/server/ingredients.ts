import { and, eq, isNull, or, sql, inArray } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { db as appDb, type DbOrTx } from '$lib/server/db';
import { assertMember, requireUserApi } from '$lib/server/access';
import { barcodeLinks, ingredientAliases, ingredients, stockLots } from '$lib/server/db/schema';
import { matchCandidates } from '$lib/shared/ingredient-name';
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

/** The longest ingredient name a user may type. */
export const INGREDIENT_NAME_MAX = 80;

export interface IngredientSuggestion {
	id: string;
	name: string;
	category: string;
	scope: 'catalog' | 'mine';
	matchedAlias: string | null;
}

/**
 * The lowest `strict_word_similarity` the dropdown accepts as a typo
 * ("chiken", "cinnamin", "parmezan" reach 0.5). Tuned on the evaluation set
 * in `ingredient-match-cases.ts`: "pears" against "peas" is 0.38 and "breast"
 * against "bread" is 0.44, so neither is offered as a typo.
 */
export const TYPO_MIN_SIMILARITY = 0.5;

/** Autocomplete for the signed-in caller; the remote `ingredientSuggestions` query. */
export async function suggestIngredients(event: RequestEvent, arg: { q: string; limit?: number }) {
	const user = requireUserApi(event);
	const limit = Math.min(12, Math.max(1, Number(arg.limit ?? 8) || 8));
	// The household only reorders the list; a caller without one still gets suggestions.
	const household = event.locals.household;
	if (household) await assertMember(appDb, household.id, user.id);
	return searchIngredients(appDb, user.id, arg.q.slice(0, 60), limit, household?.id ?? null);
}

/**
 * Autocomplete over the shared catalog plus the caller's own custom
 * identities. Other users' private names are never returned.
 *
 * Every name and alias is ranked by how it matches, best first: exact (also
 * as a whole-name singular, a name before an alias), prefix, a word of it (`<%`, pg_trgm's default
 * threshold), contained in the query ("whole milk org" holds "whole milk"),
 * then a typo. Within a tier, identities the household already stocks or has
 * linked to a barcode come first, then the catalog, then the shorter name.
 * Each identity appears once, through its best-matching name or alias.
 */
export async function searchIngredients(
	db: DbOrTx,
	userId: string,
	query: string,
	limit = 8,
	householdId: string | null = null
): Promise<IngredientSuggestion[]> {
	const q = normalizeName(query);
	if (!q) return [];
	const prefix = q.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
	const exact = sql.join(
		matchCandidates(query).map((c) => sql`${c}`),
		sql`, `
	);
	const used = householdId
		? sql`hit.id in (
				select ingredient_id from ${stockLots} where household_id = ${householdId}
				union
				select ingredient_id from ${barcodeLinks} where household_id = ${householdId})`
		: sql`false`;
	const rows = await db.execute<{
		id: string;
		name: string;
		category: string;
		owner_user_id: string | null;
		alias: string | null;
	}>(sql`
		with hit as (
			select i.id, i.name, i.category, i.owner_user_id, i.name_normalized as text, null::text as alias
			from ${ingredients} i
			where i.owner_user_id is null or i.owner_user_id = ${userId}
			union all
			select i.id, i.name, i.category, i.owner_user_id, a.alias_normalized, a.alias_normalized
			from ${ingredientAliases} a
			join ${ingredients} i on i.id = a.ingredient_id
			where i.owner_user_id is null or i.owner_user_id = ${userId}
		),
		tiered as (
			select hit.*,
				case
					when text in (${exact}) then 0
					when text like ${prefix} then 1
					when ${q} <% text then 2
					when word_similarity(text, ${q}) = 1 then 3
					else 4
				end as tier,
				strict_word_similarity(${q}, text) as sim,
				${used} as used
			from hit
			where text in (${exact})
				or text like ${prefix}
				or ${q} <% text
				or word_similarity(text, ${q}) = 1
				or strict_word_similarity(${q}, text) >= ${TYPO_MIN_SIMILARITY}
		),
		best as (
			select distinct on (id) *
			from tiered
			order by id, tier, case when tier = 3 then length(text) else 0 end desc,
				alias is not null, sim desc
		)
		select id, name, category, owner_user_id, alias
		from best
		order by tier,
			-- what the user typed exactly as a name beats the same text as an alias
			tier = 0 and alias is not null,
			case when tier = 3 then length(text) else 0 end desc,
			used desc,
			owner_user_id is not null,
			length(name),
			sim desc,
			name
		limit ${limit}
	`);
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		category: r.category,
		scope: r.owner_user_id ? 'mine' : 'catalog',
		matchedAlias: r.alias
	}));
}

/** Create (or reuse) a private custom identity owned by the user. */
export async function createCustomIngredient(
	db: DbOrTx,
	userId: string,
	name: string,
	category: string = 'Other'
) {
	const clean = name.trim().replace(/\s+/g, ' ');
	if (clean.length < 1 || clean.length > INGREDIENT_NAME_MAX)
		throw new AppError(400, `Ingredient name must be 1-${INGREDIENT_NAME_MAX} characters`);
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
