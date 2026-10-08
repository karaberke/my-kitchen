import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '$lib/server/db';
import {
	groceryBatchRequirements,
	groceryBatches,
	groceryLineSources,
	groceryLines,
	groceryLists,
	recipeIngredients,
	stockLots
} from '$lib/server/db/schema';
import { assertMember, assertRecipeReadable, type ActorContext } from '$lib/server/access';
import { AppError, notFound } from '$lib/server/errors';
import { getIngredientMeta } from '$lib/server/ingredients';
import { lockHousehold } from '$lib/server/inventory';
import { withTransaction } from '$lib/server/operations';
import { Dec } from '$lib/shared/decimal';
import { computePlan, type PlanBatch, type StockLotInput } from '$lib/shared/grocery-math';
import type { Convention } from '$lib/shared/units';
import { match as isUuid } from '../../../params/uuid';
import { lockList, bumpList } from './shared';

export async function planStock(tx: Tx, householdId: string, ingredientIds: string[]) {
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
export async function recipeRequirements(tx: Tx, recipeId: string) {
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
export async function insertRequirements(
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
