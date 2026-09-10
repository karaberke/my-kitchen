import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
import { assertMember, assertRecipeReadable } from '$lib/server/access';
import { AppError, ReviewConflict, notFound } from '$lib/server/errors';
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
	remainingTarget,
	type PlanBatch,
	type StockLotInput
} from '$lib/shared/grocery-math';
import { convertAmount, isUnitId, unitsCompatible, type Convention } from '$lib/shared/units';
import type { ActorContext } from '$lib/server/pantry';

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
export async function getCurrentListId(dbx: DbOrTx, householdId: string): Promise<string | null> {
	const [row] = await dbx
		.select({ id: groceryLists.id })
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
	return row?.id ?? null;
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

export async function getListDetail(
	dbx: DbOrTx,
	householdId: string,
	listId: string
): Promise<ListDetail> {
	const [list] = await dbx
		.select({
			id: groceryLists.id,
			name: groceryLists.name,
			status: groceryLists.status,
			revision: groceryLists.revision,
			pantryRevisionAtPreview: groceryLists.pantryRevisionAtPreview,
			previewAt: groceryLists.previewAt,
			startedAt: groceryLists.startedAt,
			completedAt: groceryLists.completedAt,
			currentPantryRevision: households.pantryRevision
		})
		.from(groceryLists)
		.innerJoin(households, eq(households.id, groceryLists.householdId))
		.where(and(eq(groceryLists.id, listId), eq(groceryLists.householdId, householdId)))
		.limit(1);
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
		dbx
			.select()
			.from(groceryLines)
			.where(eq(groceryLines.listId, listId))
			.orderBy(
				asc(groceryLines.category),
				asc(groceryLines.position),
				asc(groceryLines.name),
				asc(groceryLines.id)
			)
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
	const lines: LineView[] = lineRows.map((l) => {
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
			revision: l.revision,
			sources: sourcesByLine.get(l.id) ?? []
		};
	});
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

/* ------------------------------ helpers ------------------------------ */

async function lockList(tx: Tx, householdId: string, listId: string) {
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

async function bumpList(tx: Tx, listId: string) {
	const [row] = await tx
		.update(groceryLists)
		.set({ revision: sql`${groceryLists.revision} + 1`, updatedAt: sql`now()` })
		.where(eq(groceryLists.id, listId))
		.returning({ revision: groceryLists.revision });
	return row.revision;
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
	const batches: PlanBatch[] = batchRows.map((b) => ({
		batchId: b.id,
		recipeTitle: b.recipeTitle,
		baseServings: Dec.from(b.baseServings),
		servings: Dec.from(b.servings),
		fulfilledServings: Dec.from(b.fulfilledServings),
		convention: b.convention === 'us' ? 'us' : 'metric',
		requirements: reqRows
			.filter((r) => r.batchId === b.id)
			.map((r) => ({
				ingredientId: r.ingredientId,
				name: r.name,
				baseAmount: r.baseAmount ? Dec.from(r.baseAmount) : null,
				unit: r.unit,
				optional: r.optional,
				include: r.include
			}))
	}));
	const stock: StockLotInput[] = lotRows.map((l) => ({
		lotId: l.id,
		ingredientId: l.ingredientId,
		quantity: Dec.from(l.quantity),
		unit: l.unit
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

/** Add a planned recipe batch. Same clientKey twice = one batch (idempotent). */
export async function addBatch(
	ctx: ActorContext,
	input: {
		listId: string;
		recipeId: string;
		servings: Dec;
		clientKey: string;
		includeOptional: number[];
	}
) {
	if (!input.servings.isPositive() || input.servings.gt(Dec.from(1000)))
		throw new AppError(400, 'Servings must be a positive number');
	if (!input.clientKey || input.clientKey.length > 100)
		throw new AppError(400, 'Missing request key');
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const recipe = await assertRecipeReadable(tx, input.recipeId, ctx.userId);
		const [full] = await tx
			.select({
				title: recipes.title,
				baseServings: recipes.baseServings,
				convention: recipes.convention,
				status: recipes.status,
				revision: recipes.revision
			})
			.from(recipes)
			.where(eq(recipes.id, recipe.id));
		if (full.status !== 'active' || !full.baseServings)
			throw new AppError(
				409,
				'Finish this recipe (servings, ingredients, steps) before planning it'
			);
		const reqs = await tx
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
			.where(eq(recipeIngredients.recipeId, recipe.id))
			.orderBy(asc(recipeIngredients.position));
		if (!reqs.length) throw new AppError(409, 'This recipe has no ingredients to plan');
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status !== 'draft')
			throw new AppError(409, 'Shopping already started. Plan more recipes in a new draft list.');
		const [inserted] = await tx
			.insert(groceryBatches)
			.values({
				listId: input.listId,
				recipeId: recipe.id,
				recipeTitle: full.title,
				recipeRevision: full.revision,
				convention: full.convention,
				baseServings: Dec.from(full.baseServings).toDb(),
				servings: input.servings.toDb(),
				clientKey: input.clientKey
			})
			.onConflictDoNothing({ target: [groceryBatches.listId, groceryBatches.clientKey] })
			.returning({ id: groceryBatches.id });
		if (!inserted) {
			const [existing] = await tx
				.select({ id: groceryBatches.id })
				.from(groceryBatches)
				.where(
					and(
						eq(groceryBatches.listId, input.listId),
						eq(groceryBatches.clientKey, input.clientKey)
					)
				);
			return { batchId: existing.id, duplicate: true };
		}
		const include = new Set(input.includeOptional);
		await tx.insert(groceryBatchRequirements).values(
			reqs.map((r) => ({
				batchId: inserted.id,
				position: r.position,
				ingredientId: r.ingredientId,
				name: r.name,
				baseAmount: r.amount,
				unit: r.unit,
				preparation: r.preparation,
				optional: r.optional,
				include: r.optional ? include.has(r.position) : true
			}))
		);
		await recalculateDraft(tx, ctx.householdId, input.listId, pantryRevision);
		await bumpList(tx, input.listId);
		return { batchId: inserted.id, duplicate: false };
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
	}
) {
	const name = input.name.trim().replace(/\s+/g, ' ').slice(0, 120);
	if (!name) throw new AppError(400, 'Name the item');
	if (input.unit && !isUnitId(input.unit)) throw new AppError(400, 'Unknown unit');
	if (input.amount && input.amount.isNegative())
		throw new AppError(400, 'Amount cannot be negative');
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
				unit: input.unit,
				demandAmount: input.amount ? input.amount.toDb() : null,
				targetAmount: input.amount ? input.amount.toDb() : null,
				subtractPantry: input.subtractPantry,
				unresolvedReason: input.amount ? null : 'unknown_amount',
				note: input.note.trim().slice(0, 300),
				position: max + 1
			})
			.returning({ id: groceryLines.id });
		if (list.status === 'draft')
			await recalculateDraft(tx, ctx.householdId, input.listId, pantryRevision);
		else if (input.subtractPantry && input.ingredientId && input.amount && input.unit) {
			// Shopping: explicit request to consider current stock once, now.
			const lots = await tx
				.select({ quantity: stockLots.quantity, unit: stockLots.unit })
				.from(stockLots)
				.where(
					and(
						eq(stockLots.householdId, ctx.householdId),
						eq(stockLots.ingredientId, input.ingredientId),
						sql`${stockLots.quantity} > 0`
					)
				);
			let considered = Dec.zero;
			for (const l of lots) {
				if (!unitsCompatible(l.unit, input.unit)) continue;
				considered = considered.add(
					convertAmount(Dec.from(l.quantity), l.unit, input.unit, 'metric') ?? Dec.zero
				);
			}
			await tx
				.update(groceryLines)
				.set({
					stockConsidered: considered.toDb(),
					targetAmount: Dec.max(Dec.zero, input.amount.sub(considered)).toDb()
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
}

export async function updateLine(ctx: ActorContext, input: UpdateLineInput) {
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status === 'completed') throw new AppError(409, 'This trip is completed');
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
		const set: Partial<typeof groceryLines.$inferInsert> = {
			revision: sql`${groceryLines.revision} + 1` as never,
			updatedAt: sql`now()` as never
		};
		if (input.category !== undefined) set.category = input.category.trim().slice(0, 40) || 'Other';
		if (input.note !== undefined) set.note = input.note.trim().slice(0, 300);
		if (input.amount !== undefined) {
			if (input.amount && input.amount.isNegative())
				throw new AppError(400, 'Amount cannot be negative');
			if (list.status === 'draft') {
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
		if (list.status === 'draft' && input.amount !== undefined)
			await recalculateDraft(tx, ctx.householdId, input.listId, pantryRevision);
		const revision = await bumpList(tx, input.listId);
		return { listRevision: revision };
	});
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
		| { ok: true; revision: number }
		| { ok: false; message: string; review: Record<string, unknown> };
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
	const reqs = await tx
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
	const previous = await tx
		.select({
			position: groceryBatchRequirements.position,
			include: groceryBatchRequirements.include
		})
		.from(groceryBatchRequirements)
		.where(eq(groceryBatchRequirements.batchId, batchId));
	const includeByPos = new Map(previous.map((p) => [p.position, p.include]));
	await tx.delete(groceryBatchRequirements).where(eq(groceryBatchRequirements.batchId, batchId));
	if (reqs.length) {
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
				include: r.optional ? (includeByPos.get(r.position) ?? false) : true
			}))
		);
	}
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
	if (input.expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresOn))
		throw new AppError(400, 'Use a calendar date');
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
					expiresOn: input.expiresOn
				}
			});
			const lotId = await createLot(tx, {
				eventId,
				householdId: ctx.householdId,
				ingredientId,
				quantity: input.bought.quantity,
				unit: input.bought.unit,
				location: input.location.trim().slice(0, 60),
				expiresOn: input.expiresOn,
				note: input.note.trim().slice(0, 300)
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
