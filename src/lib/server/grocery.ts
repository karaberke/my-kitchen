import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { type DbOrTx, type Tx } from '$lib/server/db';
import {
	groceryBatchRequirements,
	groceryBatches,
	groceryLineSources,
	groceryLines,
	groceryLists,
	households,
	ingredients,
	purchaseAllocations,
	recipeIngredients,
	recipes,
	stockLots,
	type ListStatus
} from '$lib/server/db/schema';
import {
	assertMember,
	assertRecipeReadable,
	householdActor,
	type ActorContext
} from '$lib/server/access';
import { AppError, ReviewConflict, notFound, type ReviewDetail } from '$lib/server/errors';
import {
	assertIngredientsVisible,
	createCustomIngredient,
	getIngredientMeta
} from '$lib/server/ingredients';
import { createLot, insertEvent, lockHousehold } from '$lib/server/inventory';
import { runOperation, withTransaction } from '$lib/server/operations';
import { Dec } from '$lib/shared/decimal';
import {
	computePlan,
	planManualLine,
	remainingTarget,
	type PlanBatch,
	type StockLotInput
} from '$lib/shared/grocery-math';
import { convertAmount, isUnitId, unitsCompatible, type Convention } from '$lib/shared/units';
import { validateDate } from '$lib/server/pantry';
import { match as isUuid } from '../../params/uuid';
import { LOCATION_MAX_CHARS, NOTE_MAX_CHARS, cleanText } from '$lib/shared/text';
import { parseGroceryEntry } from '$lib/shared/ingredient-line';

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
async function planStock(tx: Tx, householdId: string, ingredientIds: string[]) {
	const [meta, lotRows] = await Promise.all([
		getIngredientMeta(tx, ingredientIds),
		ingredientIds.length
			? tx
					.select({
						id: stockLots.id,
						ingredientId: stockLots.ingredientId,
						quantity: stockLots.quantity,
						unit: stockLots.unit
					})
					.from(stockLots)
					.where(
						and(
							eq(stockLots.householdId, householdId),
							inArray(stockLots.ingredientId, ingredientIds),
							sql`${stockLots.quantity} > 0`
						)
					)
			: Promise.resolve([])
	]);
	const densities: Record<string, Dec> = {};
	for (const [id, m] of meta) if (m.gramsPerMl) densities[id] = Dec.from(m.gramsPerMl);
	const stock: StockLotInput[] = lotRows.map((l) => ({
		lotId: l.id,
		ingredientId: l.ingredientId,
		quantity: Dec.from(l.quantity),
		unit: l.unit
	}));
	return { meta, stock, densities };
}

/**
 * Recalculate a draft from original unfulfilled recipe demand and current stock.
 * Manual lines keep their identity; recipe lines are matched by plan key so
 * user edits (category, note) survive. Never derived from previous shortages.
 */
export async function recalculateDraft(
	tx: Tx,
	householdId: string,
	listId: string,
	pantryRevision: number,
	stockConvention: Convention = 'metric'
) {
	const batchRows = await tx
		.select({
			id: groceryBatches.id,
			recipeTitle: groceryBatches.recipeTitle,
			baseServings: groceryBatches.baseServings,
			servings: groceryBatches.servings,
			fulfilledServings: groceryBatches.fulfilledServings,
			convention: groceryBatches.convention
		})
		.from(groceryBatches)
		.where(eq(groceryBatches.listId, listId))
		.orderBy(asc(groceryBatches.createdAt), asc(groceryBatches.id));
	const batchIds = batchRows.map((b) => b.id);
	const reqRows = batchIds.length
		? await tx
				.select()
				.from(groceryBatchRequirements)
				.where(inArray(groceryBatchRequirements.batchId, batchIds))
				.orderBy(asc(groceryBatchRequirements.batchId), asc(groceryBatchRequirements.position))
		: [];
	const existing = await tx.select().from(groceryLines).where(eq(groceryLines.listId, listId));
	const manual = existing.filter((l) => l.kind === 'manual');
	const ingredientIds = [
		...new Set(
			[...reqRows.map((r) => r.ingredientId), ...manual.map((m) => m.ingredientId)].filter(
				(x): x is string => !!x
			)
		)
	];
	const { meta, stock, densities } = await planStock(tx, householdId, ingredientIds);
	const reqsByBatch = new Map<string, typeof reqRows>();
	for (const r of reqRows) {
		const group = reqsByBatch.get(r.batchId);
		if (group) group.push(r);
		else reqsByBatch.set(r.batchId, [r]);
	}
	const batches: PlanBatch[] = batchRows.map((b) => ({
		batchId: b.id,
		recipeTitle: b.recipeTitle,
		baseServings: Dec.from(b.baseServings),
		servings: Dec.from(b.servings),
		fulfilledServings: Dec.from(b.fulfilledServings),
		convention: b.convention === 'us' ? 'us' : 'metric',
		requirements: (reqsByBatch.get(b.id) ?? []).map((r) => ({
			ingredientId: r.ingredientId,
			name: r.name,
			baseAmount: r.baseAmount ? Dec.from(r.baseAmount) : null,
			unit: r.unit,
			optional: r.optional,
			include: r.include
		}))
	}));
	const plan = computePlan(
		batches,
		stock,
		manual.map((m) => ({
			lineId: m.id,
			ingredientId: m.ingredientId,
			name: m.name,
			unit: m.unit,
			requested: m.demandAmount ? Dec.from(m.demandAmount) : null,
			subtractPantry: m.subtractPantry
		})),
		{ densities, stockConvention }
	);

	const byKey = new Map(
		existing.filter((l) => l.kind === 'recipe' && l.planKey).map((l) => [l.planKey!, l])
	);
	const keep = new Set(plan.lines.map((line) => line.key));
	const prepared = plan.lines.map((line, position) => {
		const prev = byKey.get(line.key);
		return {
			line,
			prev,
			values: {
				name: prev?.name ?? line.name,
				category:
					prev?.category ??
					(line.ingredientId ? (meta.get(line.ingredientId)?.category ?? 'Other') : 'Other'),
				unit: line.unit,
				demandAmount: line.demand?.toDb() ?? null,
				stockConsidered: line.stockConsidered?.toDb() ?? null,
				targetAmount: line.suggested?.toDb() ?? null,
				unresolvedReason: line.unresolvedReason,
				otherStock: line.otherStock,
				position,
				updatedAt: sql`now()`
			}
		};
	});
	const touchedIds = prepared.flatMap(({ prev }) => (prev ? [prev.id] : []));
	if (touchedIds.length)
		await tx.delete(groceryLineSources).where(inArray(groceryLineSources.lineId, touchedIds));

	const lineIds = new Map(
		prepared.flatMap(({ line, prev }) => (prev ? [[line.key, prev.id] as const] : []))
	);
	const newLines = prepared.filter(({ prev }) => !prev);
	if (newLines.length) {
		const created = await tx
			.insert(groceryLines)
			.values(
				newLines.map(({ line, values }) => ({
					listId,
					kind: 'recipe' as const,
					planKey: line.key,
					ingredientId: line.ingredientId,
					...values
				}))
			)
			.returning({ id: groceryLines.id, planKey: groceryLines.planKey });
		for (const row of created) lineIds.set(row.planKey!, row.id);
	}

	// Cast VALUES columns explicitly: an all-null column otherwise becomes text in Postgres.
	const updates = prepared.flatMap(({ prev, values: v }) =>
		prev
			? [
					sql`(
		${prev.id}::uuid, ${v.name}::text, ${v.category}::text, ${v.unit}::text,
		${v.demandAmount}::numeric, ${v.stockConsidered}::numeric, ${v.targetAmount}::numeric,
		${v.unresolvedReason}::text, ${JSON.stringify(v.otherStock)}::jsonb, ${v.position}::integer
	)`
				]
			: []
	);
	if (updates.length)
		await tx.execute(sql`
			update ${groceryLines} as line set
				name = v.name, category = v.category, unit = v.unit,
				demand_amount = v.demand, stock_considered = v.stock, target_amount = v.target,
				unresolved_reason = v.reason, other_stock = v.other_stock, position = v.position,
				updated_at = now(), revision = line.revision + 1
			from (values ${sql.join(updates, sql`, `)})
				as v(id, name, category, unit, demand, stock, target, reason, other_stock, position)
			where line.id = v.id and line.list_id = ${listId}::uuid
		`);

	const sources = prepared.flatMap(({ line }) =>
		line.sources.map((source) => ({
			lineId: lineIds.get(line.key)!,
			batchId: source.batchId,
			amount: source.amount ? Dec.from(source.amount).toDb() : null,
			unit: source.unit
		}))
	);
	if (sources.length) await tx.insert(groceryLineSources).values(sources);

	const stale = existing
		.filter((l) => l.kind === 'recipe' && (!l.planKey || !keep.has(l.planKey)))
		.map((l) => l.id);
	if (stale.length) await tx.delete(groceryLines).where(inArray(groceryLines.id, stale));
	if (plan.manual.length) {
		const manualUpdates = plan.manual.map(
			(m) => sql`(
			${m.lineId}::uuid, ${m.stockConsidered?.toDb() ?? null}::numeric,
			${m.suggested?.toDb() ?? null}::numeric, ${JSON.stringify(m.otherStock)}::jsonb
		)`
		);
		await tx.execute(sql`
			update ${groceryLines} as line set
				stock_considered = v.stock, target_amount = v.target,
				other_stock = v.other_stock, updated_at = now()
			from (values ${sql.join(manualUpdates, sql`, `)}) as v(id, stock, target, other_stock)
			where line.id = v.id and line.list_id = ${listId}::uuid
		`);
	}

	await tx
		.update(groceryLists)
		.set({ pantryRevisionAtPreview: pantryRevision, previewAt: sql`now()` })
		.where(eq(groceryLists.id, listId));
	return { skippedOptional: plan.skippedOptional };
}

/* ------------------------------ mutations ------------------------------ */

export async function createList(ctx: ActorContext, name: string): Promise<string> {
	const clean = name.trim().slice(0, 80) || 'Shopping list';
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		await lockHousehold(tx, ctx.householdId, { grocery: true });
		const [row] = await tx
			.insert(groceryLists)
			.values({ householdId: ctx.householdId, name: clean, createdBy: ctx.userId })
			.returning({ id: groceryLists.id });
		return row.id;
	});
}

export async function deleteDraftList(ctx: ActorContext, listId: string): Promise<void> {
	await withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, listId);
		if (list.status !== 'draft')
			throw new AppError(409, 'Only drafts can be deleted; complete the trip instead');
		await tx.delete(groceryLists).where(eq(groceryLists.id, listId));
	});
}

/** One recipe batch to plan. The same clientKey on the same list twice = one batch. */
export interface BatchRequest {
	recipeId: string;
	servings: Dec;
	clientKey: string;
	includeOptional: number[];
}

function validateBatchRequest(input: BatchRequest) {
	if (!input.servings.isPositive() || input.servings.gt(Dec.from(1000)))
		throw new AppError(400, 'Servings must be a positive number');
	if (!input.clientKey || input.clientKey.length > 100)
		throw new AppError(400, 'Missing request key');
}

/** A recipe's ingredient rows as a batch snapshots them, in position order. */
async function recipeRequirements(tx: Tx, recipeId: string) {
	return tx
		.select({
			position: recipeIngredients.position,
			ingredientId: recipeIngredients.ingredientId,
			name: recipeIngredients.name,
			amount: recipeIngredients.amount,
			unit: recipeIngredients.unit,
			preparation: recipeIngredients.preparation,
			optional: recipeIngredients.optional
		})
		.from(recipeIngredients)
		.where(eq(recipeIngredients.recipeId, recipeId))
		.orderBy(asc(recipeIngredients.position));
}

/** Store a `recipeRequirements` snapshot for a batch; `include` decides each optional row. */
async function insertRequirements(
	tx: Tx,
	batchId: string,
	reqs: Awaited<ReturnType<typeof recipeRequirements>>,
	include: (position: number) => boolean
) {
	if (!reqs.length) return;
	await tx.insert(groceryBatchRequirements).values(
		reqs.map((r) => ({
			batchId,
			position: r.position,
			ingredientId: r.ingredientId,
			name: r.name,
			baseAmount: r.amount,
			unit: r.unit,
			preparation: r.preparation,
			optional: r.optional,
			include: r.optional ? include(r.position) : true
		}))
	);
}

/** Check that the user may plan this recipe, and read what its batch snapshots. */
async function prepareBatch(tx: Tx, userId: string, input: BatchRequest) {
	const recipe = await assertRecipeReadable(tx, input.recipeId, userId);
	const baseServings = recipe.baseServings;
	if (recipe.status !== 'active' || !baseServings)
		throw new AppError(409, 'Finish this recipe (servings, ingredients, steps) before planning it');
	const reqs = await recipeRequirements(tx, recipe.id);
	if (!reqs.length) throw new AppError(409, 'This recipe has no ingredients to plan');
	return { input, recipe: { ...recipe, baseServings }, reqs };
}

/**
 * Insert a prepared batch into a draft list the caller has locked. A clientKey
 * already on the list returns that batch as a duplicate and writes nothing.
 */
async function insertBatch(
	tx: Tx,
	listId: string,
	{ input, recipe, reqs }: Awaited<ReturnType<typeof prepareBatch>>
): Promise<{ batchId: string; duplicate: boolean }> {
	const [inserted] = await tx
		.insert(groceryBatches)
		.values({
			listId,
			recipeId: recipe.id,
			recipeTitle: recipe.title,
			recipeRevision: recipe.revision,
			convention: recipe.convention,
			baseServings: Dec.from(recipe.baseServings).toDb(),
			servings: input.servings.toDb(),
			clientKey: input.clientKey
		})
		.onConflictDoNothing({ target: [groceryBatches.listId, groceryBatches.clientKey] })
		.returning({ id: groceryBatches.id });
	if (!inserted) {
		const [existing] = await tx
			.select({ id: groceryBatches.id })
			.from(groceryBatches)
			.where(and(eq(groceryBatches.listId, listId), eq(groceryBatches.clientKey, input.clientKey)));
		return { batchId: existing.id, duplicate: true };
	}
	const include = new Set(input.includeOptional);
	await insertRequirements(tx, inserted.id, reqs, (position) => include.has(position));
	return { batchId: inserted.id, duplicate: false };
}

/** Add a planned recipe batch to this draft list. Same clientKey twice = one batch (idempotent). */
export async function addBatch(ctx: ActorContext, input: BatchRequest & { listId: string }) {
	validateBatchRequest(input);
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const prepared = await prepareBatch(tx, ctx.userId, input);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status !== 'draft')
			throw new AppError(409, 'Shopping already started. Plan more recipes in a new draft list.');
		const result = await insertBatch(tx, input.listId, prepared);
		if (!result.duplicate) {
			await recalculateDraft(tx, ctx.householdId, input.listId, pantryRevision);
			await bumpList(tx, input.listId);
		}
		return result;
	});
}

/**
 * Add recipe batches to a draft in one transaction with one recalculation.
 * The target is `listId` when that is a draft of this household, else the
 * newest draft, else a new list named `newListName`. A list that is being
 * shopped is never the target. Every batch is added, or none is.
 */
export async function addBatchesToDraft(
	ctx: ActorContext,
	input: { listId: string | null; newListName: string; batches: BatchRequest[] }
): Promise<{ listId: string; batches: { batchId: string; duplicate: boolean }[] }> {
	if (input.listId !== null && !isUuid(input.listId)) throw notFound('Grocery list not found');
	input.batches.forEach(validateBatchRequest);
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const prepared = [];
		for (const batch of input.batches) prepared.push(await prepareBatch(tx, ctx.userId, batch));
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		let listId: string | null = null;
		if (input.listId) {
			const chosen = await lockList(tx, ctx.householdId, input.listId);
			if (chosen.status === 'draft') listId = chosen.id;
		}
		if (!listId) {
			const [draft] = await tx
				.select({ id: groceryLists.id })
				.from(groceryLists)
				.where(and(eq(groceryLists.householdId, ctx.householdId), eq(groceryLists.status, 'draft')))
				.orderBy(desc(groceryLists.updatedAt), desc(groceryLists.id))
				.limit(1)
				.for('update');
			listId = draft?.id ?? null;
		}
		if (!listId) {
			const [created] = await tx
				.insert(groceryLists)
				.values({
					householdId: ctx.householdId,
					name: input.newListName,
					createdBy: ctx.userId
				})
				.returning({ id: groceryLists.id });
			listId = created.id;
		}
		const batches: { batchId: string; duplicate: boolean }[] = [];
		for (const p of prepared) batches.push(await insertBatch(tx, listId, p));
		if (batches.some((b) => !b.duplicate)) {
			await recalculateDraft(tx, ctx.householdId, listId, pantryRevision);
			await bumpList(tx, listId);
		}
		return { listId, batches };
	});
}

export async function updateBatch(
	ctx: ActorContext,
	input: { listId: string; batchId: string; servings: Dec; includeOptional: number[] }
) {
	if (!input.servings.isPositive() || input.servings.gt(Dec.from(1000)))
		throw new AppError(400, 'Servings must be a positive number');
	await withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status !== 'draft')
			throw new AppError(409, 'Recipe batches can only change while the list is a draft');
		const [batch] = await tx
			.select({ id: groceryBatches.id })
			.from(groceryBatches)
			.where(and(eq(groceryBatches.id, input.batchId), eq(groceryBatches.listId, input.listId)));
		if (!batch) throw notFound('Batch not found');
		await tx
			.update(groceryBatches)
			.set({ servings: input.servings.toDb() })
			.where(eq(groceryBatches.id, batch.id));
		const include = new Set(input.includeOptional);
		await tx
			.update(groceryBatchRequirements)
			.set({
				include: sql`case when ${groceryBatchRequirements.optional} then ${groceryBatchRequirements.position} in (${
					include.size
						? sql.join(
								[...include].map((n) => sql`${n}`),
								sql`, `
							)
						: sql`-1`
				}) else true end`
			})
			.where(eq(groceryBatchRequirements.batchId, batch.id));
		await recalculateDraft(tx, ctx.householdId, input.listId, pantryRevision);
		await bumpList(tx, input.listId);
	});
}

export async function removeBatch(ctx: ActorContext, input: { listId: string; batchId: string }) {
	await withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status !== 'draft')
			throw new AppError(409, 'Recipe batches can only change while the list is a draft');
		await tx
			.delete(groceryBatches)
			.where(and(eq(groceryBatches.id, input.batchId), eq(groceryBatches.listId, input.listId)));
		await recalculateDraft(tx, ctx.householdId, input.listId, pantryRevision);
		await bumpList(tx, input.listId);
	});
}

/** Recompute the preview of a draft from scratch. */
export async function refreshDraft(ctx: ActorContext, listId: string) {
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, listId);
		if (list.status !== 'draft') throw new AppError(409, 'Only drafts are recalculated');
		const result = await recalculateDraft(tx, ctx.householdId, listId, pantryRevision);
		const revision = await bumpList(tx, listId);
		return { ...result, revision };
	});
}

/** The longest name a grocery line keeps. */
export const GROCERY_LINE_NAME_MAX = 120;

export async function addManualLine(
	ctx: ActorContext,
	input: {
		listId: string;
		name: string;
		ingredientId: string | null;
		amount: Dec | null;
		unit: string | null;
		category: string;
		subtractPantry: boolean;
		note: string;
		/**
		 * The name was typed into a form: with no amount and no unit given,
		 * "400 g chopped tomatoes" is read into amount, unit and name. Text that
		 * is not that plain stays as typed.
		 */
		readTypedName?: boolean;
	}
) {
	let amount = input.amount;
	let unit = input.unit;
	let typed = input.name;
	if (input.readTypedName && amount === null && !unit) {
		const entry = parseGroceryEntry(typed);
		if (entry) ({ amount, unit, name: typed } = entry);
	}
	// A unit without an amount says nothing.
	if (!amount) unit = null;
	const name = cleanText(typed, GROCERY_LINE_NAME_MAX);
	if (!name) throw new AppError(400, 'Name the item');
	if (unit && !isUnitId(unit)) throw new AppError(400, 'Unknown unit');
	if (amount && amount.isNegative()) throw new AppError(400, 'Amount cannot be negative');
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		if (input.ingredientId) await assertIngredientsVisible(tx, ctx.userId, [input.ingredientId]);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status === 'completed') throw new AppError(409, 'This trip is completed');
		const meta = input.ingredientId ? await getIngredientMeta(tx, [input.ingredientId]) : null;
		const category = input.category || meta?.get(input.ingredientId!)?.category || 'Other';
		const [{ max }] = await tx
			.select({ max: sql<number>`coalesce(max(${groceryLines.position}), 0)` })
			.from(groceryLines)
			.where(eq(groceryLines.listId, input.listId));
		const [created] = await tx
			.insert(groceryLines)
			.values({
				listId: input.listId,
				kind: 'manual',
				ingredientId: input.ingredientId,
				name,
				category,
				unit,
				demandAmount: amount ? amount.toDb() : null,
				targetAmount: amount ? amount.toDb() : null,
				subtractPantry: input.subtractPantry,
				unresolvedReason: amount ? null : 'unknown_amount',
				note: input.note.trim().slice(0, NOTE_MAX_CHARS),
				position: max + 1
			})
			.returning({ id: groceryLines.id });
		if (list.status === 'draft')
			await recalculateDraft(tx, ctx.householdId, input.listId, pantryRevision);
		else if (input.subtractPantry && input.ingredientId && amount && unit) {
			// Shopping: explicit request to consider current stock once, now, by
			// the same rule as a draft (densities included).
			const { stock, densities } = await planStock(tx, ctx.householdId, [input.ingredientId]);
			const plan = planManualLine(
				{
					lineId: created.id,
					ingredientId: input.ingredientId,
					name,
					unit,
					requested: amount,
					subtractPantry: true
				},
				stock,
				{ densities }
			);
			await tx
				.update(groceryLines)
				.set({
					stockConsidered: plan.stockConsidered?.toDb() ?? null,
					targetAmount: plan.suggested?.toDb() ?? null,
					otherStock: plan.otherStock
				})
				.where(eq(groceryLines.id, created.id));
		}
		await bumpList(tx, input.listId);
		return { lineId: created.id };
	});
}

export interface UpdateLineInput {
	listId: string;
	lineId: string;
	expectedRevision: number;
	/** draft manual lines: requested amount; shopping lines: new remaining target */
	amount?: Dec | null;
	category?: string;
	note?: string;
	status?: 'pending' | 'handled';
	/** manual lines only */
	name?: string;
	/** manual lines only; null clears the unit */
	unit?: string | null;
	/** manual lines only; null unlinks the line from the catalog */
	ingredientId?: string | null;
}

export async function updateLine(ctx: ActorContext, input: UpdateLineInput) {
	checkLineInput(input);
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status === 'completed') throw new AppError(409, 'This trip is completed');
		const { recalculate } = await applyLineUpdate(tx, ctx, list.status, input);
		if (recalculate) await recalculateDraft(tx, ctx.householdId, input.listId, pantryRevision);
		const revision = await bumpList(tx, input.listId);
		return { listRevision: revision };
	});
}

/**
 * Save the grocery tidy changes the user kept, in one transaction with one
 * revision bump and at most one recalculation. A line changed since the
 * proposal is skipped and reported in `conflicts`; any other error saves nothing.
 */
export async function applyTidyChanges(
	ctx: ActorContext,
	listId: string,
	changes: Omit<UpdateLineInput, 'listId'>[]
): Promise<{ applied: number; conflicts: string[] }> {
	const inputs = changes.map((c) => ({ ...c, listId }));
	inputs.forEach(checkLineInput);
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, listId);
		if (list.status === 'completed') throw new AppError(409, 'This trip is completed');
		const conflicts: string[] = [];
		let applied = 0;
		let recalculate = false;
		for (const input of inputs) {
			try {
				// A ReviewConflict is thrown before this line is written, so the transaction stays usable.
				recalculate =
					(await applyLineUpdate(tx, ctx, list.status, input)).recalculate || recalculate;
				applied++;
			} catch (err) {
				if (err instanceof ReviewConflict) conflicts.push(input.lineId);
				else throw err;
			}
		}
		if (recalculate) await recalculateDraft(tx, ctx.householdId, listId, pantryRevision);
		if (applied) await bumpList(tx, listId);
		return { applied, conflicts };
	});
}

/** The checks on an `UpdateLineInput` that need no database. */
function checkLineInput(input: UpdateLineInput) {
	if (input.name !== undefined && cleanText(input.name, GROCERY_LINE_NAME_MAX) === '')
		throw new AppError(400, 'Name the item');
	if (input.unit && !isUnitId(input.unit)) throw new AppError(400, 'Unknown unit');
}

/**
 * Write one line edit inside a transaction that holds the household and list
 * locks. Returns whether the draft needs a recalculation.
 */
async function applyLineUpdate(
	tx: Tx,
	ctx: ActorContext,
	listStatus: ListStatus,
	input: UpdateLineInput
): Promise<{ recalculate: boolean }> {
	const name = input.name === undefined ? undefined : cleanText(input.name, GROCERY_LINE_NAME_MAX);
	const [line] = await tx
		.select()
		.from(groceryLines)
		.where(and(eq(groceryLines.id, input.lineId), eq(groceryLines.listId, input.listId)))
		.for('update');
	if (!line) throw notFound('Line not found');
	if (line.revision !== input.expectedRevision) {
		throw new ReviewConflict(
			'This line changed since you loaded it. Check the latest amount before editing.',
			{
				line: {
					id: line.id,
					revision: line.revision,
					targetAmount: line.targetAmount,
					purchasedAmount: line.purchasedAmount
				}
			}
		);
	}
	const identityEdit =
		name !== undefined || input.unit !== undefined || input.ingredientId !== undefined;
	if (identityEdit && line.kind !== 'manual')
		throw new AppError(409, 'Only items you added yourself can be renamed or relinked');
	const unitChanged = input.unit !== undefined && input.unit !== line.unit;
	const linkChanged = input.ingredientId !== undefined && input.ingredientId !== line.ingredientId;
	if ((unitChanged || linkChanged) && Dec.from(line.purchasedAmount).isPositive())
		throw new AppError(
			409,
			'Part of this item is already bought; its unit and link stay as they are'
		);
	if (input.ingredientId) await assertIngredientsVisible(tx, ctx.userId, [input.ingredientId]);
	const set: Partial<typeof groceryLines.$inferInsert> = {
		revision: sql`${groceryLines.revision} + 1` as never,
		updatedAt: sql`now()` as never
	};
	if (name !== undefined) set.name = name;
	if (input.unit !== undefined) set.unit = input.unit;
	if (input.ingredientId !== undefined) set.ingredientId = input.ingredientId;
	// While shopping, stock counted in the old unit or for the old item no longer applies.
	if ((unitChanged || linkChanged) && listStatus !== 'draft') set.stockConsidered = null;
	if (input.category !== undefined) set.category = input.category.trim().slice(0, 40) || 'Other';
	if (input.note !== undefined) set.note = input.note.trim().slice(0, NOTE_MAX_CHARS);
	if (input.amount !== undefined) {
		if (input.amount && input.amount.isNegative())
			throw new AppError(400, 'Amount cannot be negative');
		if (listStatus === 'draft') {
			if (line.kind !== 'manual')
				throw new AppError(
					409,
					'Recipe amounts are recalculated from the recipes; adjust servings instead'
				);
			set.demandAmount = input.amount ? input.amount.toDb() : null;
			set.targetAmount = input.amount ? input.amount.toDb() : null;
			set.unresolvedReason = input.amount ? null : 'unknown_amount';
		} else {
			// remaining-target edit: total target = credited purchases + new remaining
			const purchased = Dec.from(line.purchasedAmount);
			const newTarget = input.amount ? purchased.add(input.amount) : null;
			set.targetAmount = newTarget ? newTarget.toDb() : null;
			set.unresolvedReason = newTarget ? null : 'unknown_amount';
			if (newTarget && line.status === 'purchased' && input.amount!.isPositive())
				set.status = 'pending';
			if (newTarget && input.amount!.isZero() && line.status === 'pending')
				set.status = 'purchased';
		}
	}
	if (input.status !== undefined) set.status = input.status;
	await tx.update(groceryLines).set(set).where(eq(groceryLines.id, line.id));
	return {
		recalculate:
			listStatus === 'draft' && (input.amount !== undefined || unitChanged || linkChanged)
	};
}

export async function removeLine(ctx: ActorContext, input: { listId: string; lineId: string }) {
	await withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status === 'completed') throw new AppError(409, 'This trip is completed');
		const [line] = await tx
			.select({
				id: groceryLines.id,
				kind: groceryLines.kind,
				purchasedAmount: groceryLines.purchasedAmount
			})
			.from(groceryLines)
			.where(and(eq(groceryLines.id, input.lineId), eq(groceryLines.listId, input.listId)));
		if (!line) throw notFound('Line not found');
		if (line.kind !== 'manual')
			throw new AppError(
				409,
				'Recipe lines follow their batch. Mark it handled or remove the recipe from the plan.'
			);
		if (Dec.from(line.purchasedAmount).isPositive())
			throw new AppError(409, 'This line already has purchases; undo them first');
		await tx.delete(groceryLines).where(eq(groceryLines.id, line.id));
		await bumpList(tx, input.listId);
	});
}

/**
 * Start shopping: verify the pantry and recipe revisions the preview used.
 * If anything moved, recompute and return a fresh preview for review instead
 * of committing stale targets.
 */
export async function startShopping(
	ctx: ActorContext,
	input: { listId: string; expectedRevision: number }
) {
	type Outcome =
		{ ok: true; revision: number } | { ok: false; message: string; review: ReviewDetail };
	const outcome = await withTransaction<Outcome>(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status !== 'draft') throw new AppError(409, 'This list is not a draft');
		if (list.revision !== input.expectedRevision) {
			return {
				ok: false,
				message: 'The list changed since you reviewed it. Please review the updated preview.',
				review: { reason: 'list_revision', revision: list.revision }
			};
		}
		const batches = await tx
			.select({
				id: groceryBatches.id,
				recipeId: groceryBatches.recipeId,
				recipeRevision: groceryBatches.recipeRevision,
				current: recipes.revision,
				title: groceryBatches.recipeTitle
			})
			.from(groceryBatches)
			.leftJoin(recipes, eq(recipes.id, groceryBatches.recipeId))
			.where(eq(groceryBatches.listId, input.listId));
		const changedRecipes = batches
			.filter((b) => b.current !== null && b.current !== b.recipeRevision)
			.map((b) => b.title);
		const pantryMoved =
			list.pantryRevisionAtPreview === null || list.pantryRevisionAtPreview !== pantryRevision;
		if (pantryMoved || changedRecipes.length) {
			// Commit a fresh preview (the transaction completes normally) and report a conflict for review.
			if (changedRecipes.length) {
				for (const b of batches) {
					if (b.current !== null && b.current !== b.recipeRevision)
						await refreshBatchFromRecipe(tx, b.id, b.recipeId!);
				}
			}
			await recalculateDraft(tx, ctx.householdId, input.listId, pantryRevision);
			const revision = await bumpList(tx, input.listId);
			return {
				ok: false,
				message: pantryMoved
					? 'The pantry changed since this preview was calculated. Here is the updated preview; start shopping again once you have reviewed it.'
					: `These recipes changed since the preview: ${changedRecipes.join(', ')}. Review the updated preview before starting.`,
				review: {
					reason: pantryMoved ? 'pantry_changed' : 'recipe_changed',
					revision,
					changedRecipes
				}
			};
		}
		const [{ lineCount }] = await tx
			.select({ lineCount: sql<number>`count(*)::int` })
			.from(groceryLines)
			.where(eq(groceryLines.listId, input.listId));
		if (lineCount === 0) throw new AppError(409, 'Add recipes or items before starting shopping');
		// Lines whose target is already zero are complete from the start.
		await tx
			.update(groceryLines)
			.set({ status: 'purchased' })
			.where(
				and(
					eq(groceryLines.listId, input.listId),
					eq(groceryLines.status, 'pending'),
					sql`${groceryLines.targetAmount} is not null and ${groceryLines.targetAmount} <= 0`
				)
			);
		await tx
			.update(groceryLists)
			.set({ status: 'shopping', startedAt: sql`now()` })
			.where(eq(groceryLists.id, input.listId));
		const revision = await bumpList(tx, input.listId);
		return { ok: true, revision };
	});
	if (!outcome.ok) throw new ReviewConflict(outcome.message, outcome.review);
	return { revision: outcome.revision };
}

/** Re-snapshot a batch's requirements from the recipe's current revision (draft lists only). */
async function refreshBatchFromRecipe(tx: Tx, batchId: string, recipeId: string) {
	const [full] = await tx
		.select({
			title: recipes.title,
			baseServings: recipes.baseServings,
			convention: recipes.convention,
			revision: recipes.revision,
			status: recipes.status
		})
		.from(recipes)
		.where(eq(recipes.id, recipeId));
	if (!full || full.status !== 'active' || !full.baseServings) return;
	const reqs = await recipeRequirements(tx, recipeId);
	const previous = await tx
		.select({
			position: groceryBatchRequirements.position,
			include: groceryBatchRequirements.include
		})
		.from(groceryBatchRequirements)
		.where(eq(groceryBatchRequirements.batchId, batchId));
	const includeByPos = new Map(previous.map((p) => [p.position, p.include]));
	await tx.delete(groceryBatchRequirements).where(eq(groceryBatchRequirements.batchId, batchId));
	await insertRequirements(tx, batchId, reqs, (position) => includeByPos.get(position) ?? false);
	await tx
		.update(groceryBatches)
		.set({
			recipeTitle: full.title,
			recipeRevision: full.revision,
			baseServings: Dec.from(full.baseServings).toDb(),
			convention: full.convention
		})
		.where(eq(groceryBatches.id, batchId));
}

export async function completeList(
	ctx: ActorContext,
	input: { listId: string; expectedRevision: number }
) {
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status === 'completed') return { revision: list.revision };
		if (list.revision !== input.expectedRevision)
			throw new ReviewConflict('The list changed since you loaded it', { revision: list.revision });
		await tx
			.update(groceryLists)
			.set({ status: 'completed', completedAt: sql`now()` })
			.where(eq(groceryLists.id, input.listId));
		const revision = await bumpList(tx, input.listId);
		return { revision };
	});
}

/** `reopenList` for the caller's active household; the remote `reopenList` command. */
export async function reopenListFor(
	event: RequestEvent,
	arg: { listId: string; expectedRevision: number }
) {
	if (!isUuid(arg.listId)) throw notFound();
	return reopenList(householdActor(event), arg);
}

/**
 * Revert an accidental completion. Completion only stamps the list, so the
 * revert only removes that stamp: targets, credited purchases and the pantry
 * stay exactly as they were, and the trip continues where it stopped.
 */
export async function reopenList(
	ctx: ActorContext,
	input: { listId: string; expectedRevision: number }
) {
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status === 'shopping') return { revision: list.revision };
		if (list.status !== 'completed')
			throw new AppError(409, 'Only a completed trip can be reopened');
		if (list.revision !== input.expectedRevision)
			throw new ReviewConflict('The list changed since you loaded it', { revision: list.revision });
		await tx
			.update(groceryLists)
			.set({ status: 'shopping', completedAt: null })
			.where(eq(groceryLists.id, input.listId));
		const revision = await bumpList(tx, input.listId);
		return { revision };
	});
}

/* ------------------------------ purchases ------------------------------ */

export interface PurchaseInput {
	operationId: string;
	listId: string;
	lineId: string;
	/** null = mark handled without stock (unknown-quantity items) */
	bought: { quantity: Dec; unit: string } | null;
	ingredientId: string | null;
	newIngredientName: string | null;
	location: string;
	expiresOn: string | null;
	note: string;
}

/**
 * Record an actual purchase: the whole amount bought enters the pantry as a
 * new lot, and the line is credited once (converted to its unit when
 * possible). Remaining = max(0, target - credited). Never re-subtracts pantry.
 */
export async function recordPurchase(ctx: ActorContext, input: PurchaseInput) {
	if (input.bought) {
		if (!input.bought.quantity.isPositive())
			throw new AppError(400, 'Enter the amount you actually bought');
		if (!isUnitId(input.bought.unit)) throw new AppError(400, 'Unknown unit');
	}
	const expiresOn = validateDate(input.expiresOn);
	const payload = {
		...input,
		bought: input.bought
			? { quantity: input.bought.quantity.toString(), unit: input.bought.unit }
			: null,
		householdId: ctx.householdId
	};
	return runOperation(
		{ operationId: input.operationId, userId: ctx.userId, kind: 'purchase', payload },
		async (tx) => {
			await assertMember(tx, ctx.householdId, ctx.userId);
			await lockHousehold(tx, ctx.householdId, { pantry: true, grocery: true });
			const list = await lockList(tx, ctx.householdId, input.listId);
			if (list.status !== 'shopping')
				throw new AppError(409, 'Start shopping before recording purchases');
			const [line] = await tx
				.select()
				.from(groceryLines)
				.where(and(eq(groceryLines.id, input.lineId), eq(groceryLines.listId, input.listId)))
				.for('update');
			if (!line) throw notFound('Line not found');

			if (!input.bought) {
				await tx
					.update(groceryLines)
					.set({
						status: 'handled',
						revision: sql`${groceryLines.revision} + 1`,
						updatedAt: sql`now()`
					})
					.where(eq(groceryLines.id, line.id));
				await bumpList(tx, input.listId);
				return {
					eventId: null,
					lotId: null,
					credited: '0',
					remaining: line.targetAmount
						? remainingTarget(
								Dec.from(line.targetAmount),
								Dec.from(line.purchasedAmount)
							)!.toString()
						: null,
					lineStatus: 'handled' as const
				};
			}

			let ingredientId = input.ingredientId ?? line.ingredientId;
			if (!ingredientId) {
				if (!input.newIngredientName)
					throw new AppError(400, 'Choose which ingredient this is so the pantry can track it');
				ingredientId = (
					await createCustomIngredient(tx, ctx.userId, input.newIngredientName, line.category)
				).id;
			} else {
				await assertIngredientsVisible(tx, ctx.userId, [ingredientId]);
			}
			const [{ name }] = await tx
				.select({ name: ingredients.name })
				.from(ingredients)
				.where(eq(ingredients.id, ingredientId));

			let credited: Dec | null = null;
			if (line.unit) {
				credited = unitsCompatible(input.bought.unit, line.unit)
					? convertAmount(input.bought.quantity, input.bought.unit, line.unit, 'metric')
					: null;
			}
			const target = line.targetAmount ? Dec.from(line.targetAmount) : null;
			const purchasedBefore = Dec.from(line.purchasedAmount);
			const purchasedAfter = credited ? purchasedBefore.add(credited) : purchasedBefore;
			const remaining = remainingTarget(target, purchasedAfter);
			const lineStatus: 'pending' | 'purchased' | 'handled' =
				credited === null || target === null
					? 'handled'
					: remaining!.isZero()
						? 'purchased'
						: 'pending';

			const eventId = await insertEvent(tx, {
				householdId: ctx.householdId,
				kind: 'purchase',
				actorUserId: ctx.userId,
				actorName: ctx.actorName,
				operationId: input.operationId,
				groceryListId: input.listId,
				summary: `Bought ${input.bought.quantity.toHuman()} ${input.bought.unit} of ${name}`,
				details: {
					lineId: line.id,
					lineName: line.name,
					ingredientId,
					name,
					quantity: input.bought.quantity.toString(),
					unit: input.bought.unit,
					credited: credited?.toString() ?? null,
					lineUnit: line.unit,
					location: input.location,
					expiresOn
				}
			});
			const lotId = await createLot(tx, {
				eventId,
				householdId: ctx.householdId,
				ingredientId,
				quantity: input.bought.quantity,
				unit: input.bought.unit,
				location: input.location.trim().slice(0, LOCATION_MAX_CHARS),
				expiresOn,
				note: input.note.trim().slice(0, NOTE_MAX_CHARS)
			});
			await tx
				.insert(purchaseAllocations)
				.values({ eventId, lineId: line.id, amount: (credited ?? Dec.zero).toDb() });
			await tx
				.update(groceryLines)
				.set({
					purchasedAmount: purchasedAfter.toDb(),
					status: lineStatus,
					ingredientId,
					revision: sql`${groceryLines.revision} + 1`,
					updatedAt: sql`now()`
				})
				.where(eq(groceryLines.id, line.id));
			await bumpList(tx, input.listId);
			return {
				eventId,
				lotId,
				credited: credited?.toString() ?? '0',
				remaining: remaining?.toString() ?? null,
				lineStatus
			};
		}
	);
}
