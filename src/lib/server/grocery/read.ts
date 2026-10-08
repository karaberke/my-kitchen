import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '$lib/server/db';
import {
	groceryBatchRequirements,
	groceryBatches,
	groceryLineSources,
	groceryLines,
	groceryLists,
	households,
	recipes,
	type ListStatus
} from '$lib/server/db/schema';
import { notFound } from '$lib/server/errors';
import { Dec } from '$lib/shared/decimal';
import { remainingTarget } from '$lib/shared/grocery-math';

/* ------------------------------ reads ------------------------------ */

export interface ListSummary {
	id: string;
	name: string;
	status: ListStatus;
	revision: number;
	updatedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	pendingCount: number;
	totalCount: number;
}

export async function listGroceryLists(
	dbx: DbOrTx,
	householdId: string,
	limit = 50
): Promise<ListSummary[]> {
	const rows = await dbx
		.select({
			id: groceryLists.id,
			name: groceryLists.name,
			status: groceryLists.status,
			revision: groceryLists.revision,
			updatedAt: groceryLists.updatedAt,
			startedAt: groceryLists.startedAt,
			completedAt: groceryLists.completedAt,
			pendingCount: sql<number>`(select count(*)::int from ${groceryLines} l where l.list_id = ${groceryLists.id} and l.status = 'pending')`,
			totalCount: sql<number>`(select count(*)::int from ${groceryLines} l where l.list_id = ${groceryLists.id})`
		})
		.from(groceryLists)
		.where(eq(groceryLists.householdId, householdId))
		.orderBy(
			sql`case ${groceryLists.status} when 'shopping' then 0 when 'draft' then 1 else 2 end`,
			desc(groceryLists.updatedAt),
			desc(groceryLists.id)
		)
		.limit(limit);
	return rows;
}

/** The household's current list: shopping first, then the newest draft. */
export async function getCurrentList(
	dbx: DbOrTx,
	householdId: string
): Promise<{ id: string; name: string; status: ListStatus } | null> {
	const [row] = await dbx
		.select({ id: groceryLists.id, name: groceryLists.name, status: groceryLists.status })
		.from(groceryLists)
		.where(
			and(
				eq(groceryLists.householdId, householdId),
				inArray(groceryLists.status, ['shopping', 'draft'])
			)
		)
		.orderBy(
			sql`case ${groceryLists.status} when 'shopping' then 0 else 1 end`,
			desc(groceryLists.updatedAt),
			desc(groceryLists.id)
		)
		.limit(1);
	return row ?? null;
}

/** The id of `getCurrentList`. */
export async function getCurrentListId(dbx: DbOrTx, householdId: string): Promise<string | null> {
	return (await getCurrentList(dbx, householdId))?.id ?? null;
}

export interface BatchView {
	id: string;
	recipeId: string | null;
	recipeTitle: string;
	recipeRevision: number;
	currentRecipeRevision: number | null;
	recipeChanged: boolean;
	recipeDeleted: boolean;
	baseServings: string;
	servings: string;
	fulfilledServings: string;
	remainingServings: string;
	status: string;
	requirements: {
		id: string;
		position: number;
		ingredientId: string | null;
		name: string;
		baseAmount: string | null;
		unit: string | null;
		optional: boolean;
		include: boolean;
	}[];
}

/** A grocery line without the recipe batches it came from. */
export type LineFields = Omit<LineView, 'sources'>;

export interface LineView {
	id: string;
	kind: 'recipe' | 'manual';
	ingredientId: string | null;
	name: string;
	category: string;
	unit: string | null;
	demandAmount: string | null;
	stockConsidered: string | null;
	targetAmount: string | null;
	purchasedAmount: string;
	remaining: string | null;
	status: string;
	unresolvedReason: string | null;
	otherStock: { quantity: string; unit: string }[];
	subtractPantry: boolean;
	note: string;
	position: number;
	revision: number;
	sources: { batchId: string; recipeTitle: string; amount: string | null; unit: string | null }[];
}

export interface ListDetail {
	id: string;
	name: string;
	status: ListStatus;
	revision: number;
	pantryRevisionAtPreview: number | null;
	currentPantryRevision: number;
	pantryChanged: boolean;
	previewAt: string | null;
	startedAt: string | null;
	completedAt: string | null;
	batches: BatchView[];
	lines: LineView[];
	anyRecipeChanged: boolean;
}

/**
 * One list with its batches and lines. Pass `knownPantryRevision` when the
 * caller has just read the household row, so it is not read a second time.
 */
export async function getListDetail(
	dbx: DbOrTx,
	householdId: string,
	listId: string,
	knownPantryRevision?: number
): Promise<ListDetail> {
	const columns = {
		id: groceryLists.id,
		name: groceryLists.name,
		status: groceryLists.status,
		revision: groceryLists.revision,
		pantryRevisionAtPreview: groceryLists.pantryRevisionAtPreview,
		previewAt: groceryLists.previewAt,
		startedAt: groceryLists.startedAt,
		completedAt: groceryLists.completedAt
	};
	const ofHousehold = and(eq(groceryLists.id, listId), eq(groceryLists.householdId, householdId));
	const [list] =
		knownPantryRevision === undefined
			? await dbx
					.select({ ...columns, currentPantryRevision: households.pantryRevision })
					.from(groceryLists)
					.innerJoin(households, eq(households.id, groceryLists.householdId))
					.where(ofHousehold)
					.limit(1)
			: (await dbx.select(columns).from(groceryLists).where(ofHousehold).limit(1)).map((r) => ({
					...r,
					currentPantryRevision: knownPantryRevision
				}));
	if (!list) throw notFound('Grocery list not found');

	const [batchRows, lineRows] = await Promise.all([
		dbx
			.select({
				id: groceryBatches.id,
				recipeId: groceryBatches.recipeId,
				recipeTitle: groceryBatches.recipeTitle,
				recipeRevision: groceryBatches.recipeRevision,
				currentRecipeRevision: recipes.revision,
				baseServings: groceryBatches.baseServings,
				servings: groceryBatches.servings,
				fulfilledServings: groceryBatches.fulfilledServings,
				status: groceryBatches.status
			})
			.from(groceryBatches)
			.leftJoin(recipes, eq(recipes.id, groceryBatches.recipeId))
			.where(eq(groceryBatches.listId, listId))
			.orderBy(asc(groceryBatches.createdAt), asc(groceryBatches.id)),
		selectLines(dbx, listId)
	]);
	const batchIds = batchRows.map((b) => b.id);
	const lineIds = lineRows.map((l) => l.id);
	const [reqRows, sourceRows] = await Promise.all([
		batchIds.length
			? dbx
					.select()
					.from(groceryBatchRequirements)
					.where(inArray(groceryBatchRequirements.batchId, batchIds))
					.orderBy(asc(groceryBatchRequirements.batchId), asc(groceryBatchRequirements.position))
			: Promise.resolve([]),
		lineIds.length
			? dbx
					.select({
						lineId: groceryLineSources.lineId,
						batchId: groceryLineSources.batchId,
						amount: groceryLineSources.amount,
						unit: groceryLineSources.unit,
						recipeTitle: groceryBatches.recipeTitle
					})
					.from(groceryLineSources)
					.innerJoin(groceryBatches, eq(groceryBatches.id, groceryLineSources.batchId))
					.where(inArray(groceryLineSources.lineId, lineIds))
			: Promise.resolve([])
	]);
	const reqsByBatch = new Map<string, BatchView['requirements']>();
	for (const r of reqRows) {
		const list = reqsByBatch.get(r.batchId) ?? [];
		list.push({
			id: r.id,
			position: r.position,
			ingredientId: r.ingredientId,
			name: r.name,
			baseAmount: r.baseAmount ? Dec.from(r.baseAmount).toString() : null,
			unit: r.unit,
			optional: r.optional,
			include: r.include
		});
		reqsByBatch.set(r.batchId, list);
	}
	const sourcesByLine = new Map<string, LineView['sources']>();
	for (const s of sourceRows) {
		const list = sourcesByLine.get(s.lineId) ?? [];
		list.push({
			batchId: s.batchId,
			recipeTitle: s.recipeTitle,
			amount: s.amount ? Dec.from(s.amount).toString() : null,
			unit: s.unit
		});
		sourcesByLine.set(s.lineId, list);
	}
	const batches: BatchView[] = batchRows.map((b) => ({
		id: b.id,
		recipeId: b.recipeId,
		recipeTitle: b.recipeTitle,
		recipeRevision: b.recipeRevision,
		currentRecipeRevision: b.currentRecipeRevision,
		recipeChanged: b.currentRecipeRevision !== null && b.currentRecipeRevision !== b.recipeRevision,
		recipeDeleted: b.recipeId === null,
		baseServings: Dec.from(b.baseServings).toString(),
		servings: Dec.from(b.servings).toString(),
		fulfilledServings: Dec.from(b.fulfilledServings).toString(),
		remainingServings: Dec.max(
			Dec.zero,
			Dec.from(b.servings).sub(Dec.from(b.fulfilledServings))
		).toString(),
		status: b.status,
		requirements: reqsByBatch.get(b.id) ?? []
	}));
	const lines: LineView[] = lineRows.map((l) => ({
		...lineFields(l),
		sources: sourcesByLine.get(l.id) ?? []
	}));
	return {
		id: list.id,
		name: list.name,
		status: list.status,
		revision: list.revision,
		pantryRevisionAtPreview: list.pantryRevisionAtPreview,
		currentPantryRevision: list.currentPantryRevision,
		pantryChanged:
			list.status === 'draft' &&
			list.pantryRevisionAtPreview !== null &&
			list.pantryRevisionAtPreview !== list.currentPantryRevision,
		previewAt: list.previewAt,
		startedAt: list.startedAt,
		completedAt: list.completedAt,
		batches,
		lines,
		anyRecipeChanged: batches.some((b) => b.recipeChanged)
	};
}

/** The lines of one list in display order, every column. */
function selectLines(dbx: DbOrTx, listId: string) {
	return dbx
		.select()
		.from(groceryLines)
		.where(eq(groceryLines.listId, listId))
		.orderBy(
			asc(groceryLines.category),
			asc(groceryLines.position),
			asc(groceryLines.name),
			asc(groceryLines.id)
		);
}

function lineFields(l: typeof groceryLines.$inferSelect): LineFields {
	const target = l.targetAmount ? Dec.from(l.targetAmount) : null;
	const purchased = Dec.from(l.purchasedAmount);
	return {
		id: l.id,
		kind: l.kind,
		ingredientId: l.ingredientId,
		name: l.name,
		category: l.category,
		unit: l.unit,
		demandAmount: l.demandAmount ? Dec.from(l.demandAmount).toString() : null,
		stockConsidered: l.stockConsidered ? Dec.from(l.stockConsidered).toString() : null,
		targetAmount: target ? target.toString() : null,
		purchasedAmount: purchased.toString(),
		remaining: remainingTarget(target, purchased)?.toString() ?? null,
		status: l.status,
		unresolvedReason: l.unresolvedReason,
		otherStock: l.otherStock,
		subtractPantry: l.subtractPantry,
		note: l.note,
		position: l.position,
		revision: l.revision
	};
}

/**
 * The status and lines of one household list, without its batches and line
 * sources: for a reader of the lines alone. A 404 when the list is not there.
 */
export async function getListLines(
	dbx: DbOrTx,
	householdId: string,
	listId: string
): Promise<{ status: ListStatus; lines: LineFields[] }> {
	const [list] = await dbx
		.select({ status: groceryLists.status })
		.from(groceryLists)
		.where(and(eq(groceryLists.id, listId), eq(groceryLists.householdId, householdId)))
		.limit(1);
	if (!list) throw notFound('Grocery list not found');
	const rows = await selectLines(dbx, listId);
	return { status: list.status, lines: rows.map(lineFields) };
}
