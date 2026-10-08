import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '$lib/server/db';
import { groceryLists } from '$lib/server/db/schema';
import { notFound } from '$lib/server/errors';

/* ------------------------------ helpers ------------------------------ */

/** Lock one list of the household (after `lockHousehold`); a 404 when it is not there. */
export async function lockList(tx: Tx, householdId: string, listId: string) {
	const [list] = await tx
		.select({
			id: groceryLists.id,
			status: groceryLists.status,
			revision: groceryLists.revision,
			pantryRevisionAtPreview: groceryLists.pantryRevisionAtPreview
		})
		.from(groceryLists)
		.where(and(eq(groceryLists.id, listId), eq(groceryLists.householdId, householdId)))
		.for('update');
	if (!list) throw notFound('Grocery list not found');
	return list;
}

/** Bump a list's revision and `updated_at`; returns the new revision. */
export async function bumpList(tx: Tx, listId: string) {
	const [row] = await tx
		.update(groceryLists)
		.set({ revision: sql`${groceryLists.revision} + 1`, updatedAt: sql`now()` })
		.where(eq(groceryLists.id, listId))
		.returning({ revision: groceryLists.revision });
	return row.revision;
}

/**
 * What the planner needs to subtract stock for these ingredients: their
 * metadata, the household's positive lots of them, and their densities.
 */
