import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '$lib/server/db';
import { recipeIngredients, recipes } from '$lib/server/db/schema';
import { assertIngredientsVisible } from '$lib/server/ingredients';
import { groupKey, matchIngredientNames, type IngredientMatch } from '$lib/server/ingredient-match';
import { withTransaction } from '$lib/server/operations';

export interface UnlinkedGroup {
	/** the key every row of the group shares, and what the write takes */
	key: string;
	/** the name as written in the first recipe, for the screen */
	name: string;
	rowCount: number;
	recipeTitles: string[];
	proposal: IngredientMatch | null;
}

const TITLES_SHOWN = 3;

/**
 * Every ingredient name in the caller's own recipes that has no catalog link,
 * one entry per name, with the match the app proposes for it.
 */
export async function listUnlinkedIngredients(
	dbx: DbOrTx,
	userId: string,
	limit = 100
): Promise<UnlinkedGroup[]> {
	// One row per written name (trimmed), newest first, counted per recipe in SQL.
	// The group key comes from matchCandidates, which SQL cannot compute, so the
	// names that share one are merged here, and the limit applies after that.
	const rows = await dbx.execute<{ name: string; row_count: number; titles: string[] }>(sql`
		with per_recipe as (
			select trim(ri.name) as name, r.title, r.updated_at, count(*)::int as row_count
			from ${recipeIngredients} ri
			join ${recipes} r on r.id = ri.recipe_id
			where r.owner_user_id = ${userId}
				and ri.ingredient_id is null
				and length(trim(ri.name)) > 0
			group by trim(ri.name), r.id
		)
		select name, sum(row_count)::int as row_count,
			(array_agg(title order by updated_at desc))[1:${TITLES_SHOWN}] as titles
		from per_recipe
		group by name
		order by max(updated_at) desc
	`);

	const groups = new Map<string, UnlinkedGroup>();
	for (const r of rows) {
		const key = groupKey(r.name);
		if (!key) continue;
		const held = groups.get(key);
		const group = held ?? { key, name: r.name, rowCount: 0, recipeTitles: [], proposal: null };
		group.rowCount += r.row_count;
		for (const title of r.titles) {
			if (!group.recipeTitles.includes(title) && group.recipeTitles.length < TITLES_SHOWN)
				group.recipeTitles.push(title);
		}
		if (!held) groups.set(key, group);
	}

	const list = [...groups.values()].sort((a, b) => b.rowCount - a.rowCount).slice(0, limit);
	const matches = await matchIngredientNames(
		dbx,
		userId,
		list.map((g) => g.name)
	);
	for (const g of list) g.proposal = matches.get(g.name) ?? null;
	return list;
}

export interface LinkRequest {
	/** the name as the screen listed it; its group key selects the rows */
	name: string;
	ingredientId: string;
}

/**
 * Writes the confirmed links. Only rows that are still unlinked change, so a
 * second confirmation — or a second tab — writes nothing instead of fighting.
 */
export async function linkIngredientNames(
	userId: string,
	requests: LinkRequest[]
): Promise<{ rows: number; recipes: number }> {
	const wanted = new Map<string, string>();
	for (const r of requests) {
		const key = groupKey(r.name);
		if (key) wanted.set(key, r.ingredientId);
	}
	if (!wanted.size) return { rows: 0, recipes: 0 };

	return withTransaction(async (tx) => {
		await assertIngredientsVisible(tx, userId, [...wanted.values()]);
		const open = await tx
			.select({
				id: recipeIngredients.id,
				recipeId: recipeIngredients.recipeId,
				name: recipeIngredients.name
			})
			.from(recipeIngredients)
			.innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
			.where(and(eq(recipes.ownerUserId, userId), isNull(recipeIngredients.ingredientId)))
			.for('update');

		const byIngredient = new Map<string, string[]>();
		const touched = new Set<string>();
		for (const row of open) {
			const ingredientId = wanted.get(groupKey(row.name));
			if (!ingredientId) continue;
			const held = byIngredient.get(ingredientId);
			if (held) held.push(row.id);
			else byIngredient.set(ingredientId, [row.id]);
			touched.add(row.recipeId);
		}
		if (!touched.size) return { rows: 0, recipes: 0 };

		// One statement for every row: each row id with the ingredient it takes.
		const pairs = sql.join(
			[...byIngredient].flatMap(([ingredientId, ids]) =>
				ids.map((id) => sql`(${id}::uuid, ${ingredientId}::uuid)`)
			),
			sql`, `
		);
		const updated = await tx.execute<{ id: string }>(sql`
			update ${recipeIngredients} ri
			set ingredient_id = v.ingredient_id
			from (values ${pairs}) as v(id, ingredient_id)
			where ri.id = v.id
			returning ri.id
		`);
		const rows = updated.length;
		await tx
			.update(recipes)
			.set({ revision: sql`${recipes.revision} + 1`, updatedAt: sql`now()` })
			.where(sql`${recipes.id} in ${[...touched]}`);
		return { rows, recipes: touched.size };
	});
}
