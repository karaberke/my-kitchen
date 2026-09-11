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
	const rows = await dbx
		.select({
			name: recipeIngredients.name,
			title: recipes.title,
			updatedAt: recipes.updatedAt
		})
		.from(recipeIngredients)
		.innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
		.where(
			and(
				eq(recipes.ownerUserId, userId),
				isNull(recipeIngredients.ingredientId),
				sql`length(trim(${recipeIngredients.name})) > 0`
			)
		)
		.orderBy(sql`${recipes.updatedAt} desc`);

	const groups = new Map<string, UnlinkedGroup>();
	for (const r of rows) {
		const key = groupKey(r.name);
		if (!key) continue;
		const held = groups.get(key);
		if (held) {
			held.rowCount++;
			if (!held.recipeTitles.includes(r.title) && held.recipeTitles.length < TITLES_SHOWN)
				held.recipeTitles.push(r.title);
			continue;
		}
		groups.set(key, {
			key,
			name: r.name.trim(),
			rowCount: 1,
			recipeTitles: [r.title],
			proposal: null
		});
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

		let rows = 0;
		for (const [ingredientId, ids] of byIngredient) {
			const updated = await tx
				.update(recipeIngredients)
				.set({ ingredientId })
				.where(sql`${recipeIngredients.id} in ${ids}`)
				.returning({ id: recipeIngredients.id });
			rows += updated.length;
		}
		await tx
			.update(recipes)
			.set({ revision: sql`${recipes.revision} + 1`, updatedAt: sql`now()` })
			.where(sql`${recipes.id} in ${[...touched]}`);
		return { rows, recipes: touched.size };
	});
}
