import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { type DbOrTx } from '$lib/server/db';
import {
	groceryBatches,
	groceryLists,
	ingredients,
	recipeIngredients,
	recipes
} from '$lib/server/db/schema';
import { assertMember, assertRecipeReadable } from '$lib/server/access';
import { AppError, ReviewConflict } from '$lib/server/errors';
import { getIngredientMeta } from '$lib/server/ingredients';
import {
	activeLotsForIngredients,
	applyMovement,
	insertEvent,
	lockHousehold,
	lockLots,
	planDeduction
} from '$lib/server/inventory';
import { runOperation } from '$lib/server/operations';
import { Dec } from '$lib/shared/decimal';
import { scaleAmount } from '$lib/shared/scaling';
import { convertAmount, isUnitId, unitsCompatible, type Convention } from '$lib/shared/units';
import type { ActorContext } from '$lib/server/pantry';

export interface CookPreviewItem {
	position: number;
	name: string;
	ingredientId: string | null;
	ingredientName: string | null;
	scaledAmount: string | null;
	unit: string | null;
	optional: boolean;
	preparation: string;
	/** suggested lots (FEFO) in the ingredient's unit */
	suggestions: {
		lotId: string;
		quantity: string;
		unit: string;
		location: string;
		expiresOn: string | null;
		revision: number;
		take: string;
		takeInRequested: string;
	}[];
	incompatible: { lotId: string; quantity: string; unit: string }[];
	shortfall: string | null;
	tracked: boolean;
	/** default mode chosen by the server */
	defaultMode: 'deduct' | 'skip';
	reason: string | null;
}

export interface CookPreview {
	recipeId: string;
	title: string;
	revision: number;
	baseServings: string;
	servings: string;
	convention: Convention;
	items: CookPreviewItem[];
	batches: {
		id: string;
		listId: string;
		listName: string;
		servings: string;
		remainingServings: string;
	}[];
}

export async function previewCooking(
	dbx: DbOrTx,
	ctx: ActorContext,
	recipeId: string,
	servings: Dec
): Promise<CookPreview> {
	if (!servings.isPositive()) throw new AppError(400, 'Servings must be positive');
	await assertMember(dbx, ctx.householdId, ctx.userId);
	const recipe = await assertRecipeReadable(dbx, recipeId, ctx.userId);
	const [full] = await dbx
		.select({
			title: recipes.title,
			baseServings: recipes.baseServings,
			convention: recipes.convention,
			status: recipes.status
		})
		.from(recipes)
		.where(eq(recipes.id, recipe.id));
	if (full.status !== 'active' || !full.baseServings)
		throw new AppError(409, 'Finish this recipe before cooking from it');
	const convention: Convention = full.convention === 'us' ? 'us' : 'metric';
	const base = Dec.from(full.baseServings);
	const [rows, batches] = await Promise.all([
		dbx
			.select({
				position: recipeIngredients.position,
				ingredientId: recipeIngredients.ingredientId,
				name: recipeIngredients.name,
				amount: recipeIngredients.amount,
				unit: recipeIngredients.unit,
				optional: recipeIngredients.optional,
				preparation: recipeIngredients.preparation
			})
			.from(recipeIngredients)
			.where(eq(recipeIngredients.recipeId, recipe.id))
			.orderBy(asc(recipeIngredients.position)),
		dbx
			.select({
				id: groceryBatches.id,
				listId: groceryBatches.listId,
				listName: groceryLists.name,
				servings: groceryBatches.servings,
				fulfilled: groceryBatches.fulfilledServings
			})
			.from(groceryBatches)
			.innerJoin(groceryLists, eq(groceryLists.id, groceryBatches.listId))
			.where(
				and(
					eq(groceryLists.householdId, ctx.householdId),
					eq(groceryBatches.recipeId, recipe.id),
					eq(groceryBatches.status, 'planned'),
					inArray(groceryLists.status, ['draft', 'shopping'])
				)
			)
			.orderBy(asc(groceryBatches.createdAt))
	]);
	const ingredientIds = rows.map((r) => r.ingredientId).filter((x): x is string => !!x);
	const [meta, lots] = await Promise.all([
		getIngredientMeta(dbx, ingredientIds),
		activeLotsForIngredients(dbx as never, ctx.householdId, ingredientIds)
	]);
	const items: CookPreviewItem[] = rows.map((r) => {
		const scaled = scaleAmount(r.amount ? Dec.from(r.amount) : null, base, servings);
		const m = r.ingredientId ? meta.get(r.ingredientId) : undefined;
		const tracked = !!r.ingredientId && lots.some((l) => l.ingredientId === r.ingredientId);
		if (!r.ingredientId || !scaled || !r.unit) {
			return {
				position: r.position,
				name: r.name,
				ingredientId: r.ingredientId,
				ingredientName: m?.name ?? null,
				scaledAmount: scaled?.toString() ?? null,
				unit: r.unit,
				optional: r.optional,
				preparation: r.preparation,
				suggestions: [],
				incompatible: [],
				shortfall: null,
				tracked,
				defaultMode: 'skip',
				reason: !r.ingredientId
					? 'No confirmed ingredient identity — nothing to deduct'
					: !scaled
						? 'No amount in the recipe — enter what you used or skip tracking'
						: 'No unit given'
			};
		}
		const plan = planDeduction(
			r.ingredientId,
			scaled,
			r.unit,
			lots,
			convention,
			m?.gramsPerMl ? Dec.from(m.gramsPerMl) : null
		);
		return {
			position: r.position,
			name: r.name,
			ingredientId: r.ingredientId,
			ingredientName: m?.name ?? null,
			scaledAmount: scaled.toString(),
			unit: r.unit,
			optional: r.optional,
			preparation: r.preparation,
			suggestions: plan.suggestions.map((s) => ({
				lotId: s.lotId,
				quantity: s.quantity.toString(),
				unit: s.unit,
				location: s.location,
				expiresOn: s.expiresOn,
				revision: s.revision,
				take: s.take.toString(),
				takeInRequested: s.takeInRequested.toString()
			})),
			incompatible: plan.incompatible.map((i) => ({
				lotId: i.lotId,
				quantity: i.quantity.toString(),
				unit: i.unit
			})),
			shortfall: plan.shortfall.isPositive() ? plan.shortfall.toString() : null,
			tracked,
			defaultMode: tracked && plan.suggestions.length ? 'deduct' : 'skip',
			reason: !tracked
				? 'Not tracked in the pantry'
				: plan.suggestions.length === 0
					? 'Pantry lots use units that cannot be converted'
					: plan.shortfall.isPositive()
						? `Only ${plan.covered.toHuman()} ${r.unit} tracked`
						: null
		};
	});
	return {
		recipeId: recipe.id,
		title: full.title,
		revision: recipe.revision,
		baseServings: base.toString(),
		servings: servings.toString(),
		convention,
		items,
		batches: batches.map((b) => ({
			id: b.id,
			listId: b.listId,
			listName: b.listName,
			servings: Dec.from(b.servings).toString(),
			remainingServings: Dec.max(
				Dec.zero,
				Dec.from(b.servings).sub(Dec.from(b.fulfilled))
			).toString()
		}))
	};
}

export interface CookItemInput {
	position: number;
	mode: 'deduct' | 'skip';
	/** actual ingredient used (substitution when different from the recipe row) */
	ingredientId: string | null;
	allocations: { lotId: string; amount: Dec; expectedRevision: number }[];
	note: string;
}

export interface FinishCookingInput {
	operationId: string;
	recipeId: string;
	expectedRecipeRevision: number;
	servings: Dec;
	batchId: string | null;
	items: CookItemInput[];
}

/**
 * Commit a cooking event: immutable recipe snapshot, per-item usage snapshot,
 * lot deductions (guarded, never negative), and planned-batch fulfilment.
 */
export async function finishCooking(ctx: ActorContext, input: FinishCookingInput) {
	if (!input.servings.isPositive()) throw new AppError(400, 'Servings must be positive');
	for (const item of input.items)
		for (const a of item.allocations)
			if (!a.amount.isPositive()) throw new AppError(400, 'Deducted amounts must be positive');
	const payload = {
		recipeId: input.recipeId,
		expectedRecipeRevision: input.expectedRecipeRevision,
		servings: input.servings.toString(),
		batchId: input.batchId,
		householdId: ctx.householdId,
		items: input.items.map((i) => ({
			position: i.position,
			mode: i.mode,
			ingredientId: i.ingredientId,
			note: i.note,
			allocations: i.allocations.map((a) => ({
				lotId: a.lotId,
				amount: a.amount.toString(),
				expectedRevision: a.expectedRevision
			}))
		}))
	};
	return runOperation(
		{ operationId: input.operationId, userId: ctx.userId, kind: 'cook', payload },
		async (tx) => {
			await assertMember(tx, ctx.householdId, ctx.userId);
			const recipe = await assertRecipeReadable(tx, input.recipeId, ctx.userId);
			if (recipe.revision !== input.expectedRecipeRevision) {
				throw new ReviewConflict(
					'This recipe changed since you opened the cooking preview. Review the new version first.',
					{ currentRevision: recipe.revision }
				);
			}
			const [full] = await tx
				.select({
					title: recipes.title,
					baseServings: recipes.baseServings,
					convention: recipes.convention
				})
				.from(recipes)
				.where(eq(recipes.id, recipe.id));
			if (!full.baseServings) throw new AppError(409, 'Recipe has no base servings');
			const rows = await tx
				.select({
					position: recipeIngredients.position,
					ingredientId: recipeIngredients.ingredientId,
					name: recipeIngredients.name,
					amount: recipeIngredients.amount,
					unit: recipeIngredients.unit
				})
				.from(recipeIngredients)
				.where(eq(recipeIngredients.recipeId, recipe.id));
			const rowByPos = new Map(rows.map((r) => [r.position, r]));

			await lockHousehold(tx, ctx.householdId, { pantry: true, grocery: !!input.batchId });
			const lotIds = input.items.flatMap((i) => i.allocations.map((a) => a.lotId));
			const lots = await lockLots(tx, ctx.householdId, lotIds);
			const stale: { lotId: string; currentRevision: number; quantity: string; unit: string }[] =
				[];
			const insufficient: { lotId: string; requested: string; available: string; unit: string }[] =
				[];
			for (const item of input.items) {
				if (item.mode !== 'deduct') continue;
				for (const a of item.allocations) {
					const lot = lots.get(a.lotId);
					if (!lot) throw new AppError(404, 'A selected pantry lot no longer exists');
					if (lot.revision !== a.expectedRevision)
						stale.push({
							lotId: lot.id,
							currentRevision: lot.revision,
							quantity: lot.quantity.toString(),
							unit: lot.unit
						});
					if (a.amount.gt(lot.quantity))
						insufficient.push({
							lotId: lot.id,
							requested: a.amount.toString(),
							available: lot.quantity.toString(),
							unit: lot.unit
						});
					if (item.ingredientId && lot.ingredientId !== item.ingredientId)
						throw new AppError(400, 'Lot does not belong to the chosen ingredient');
				}
			}
			if (stale.length || insufficient.length) {
				throw new ReviewConflict(
					insufficient.length
						? 'The pantry no longer has enough of some ingredients. Review the amounts before finishing.'
						: 'Some pantry lots changed while you were cooking. Review the deductions before finishing.',
					{ stale, insufficient }
				);
			}

			let plannedFulfilled: Dec | null = null;
			let unplanned: Dec | null = null;
			if (input.batchId) {
				const [batch] = await tx
					.select({
						id: groceryBatches.id,
						listId: groceryBatches.listId,
						servings: groceryBatches.servings,
						fulfilled: groceryBatches.fulfilledServings,
						status: groceryBatches.status,
						recipeId: groceryBatches.recipeId,
						householdId: groceryLists.householdId
					})
					.from(groceryBatches)
					.innerJoin(groceryLists, eq(groceryLists.id, groceryBatches.listId))
					.where(eq(groceryBatches.id, input.batchId))
					.for('update', { of: groceryBatches });
				if (!batch || batch.householdId !== ctx.householdId || batch.recipeId !== recipe.id)
					throw new AppError(404, 'Planned batch not found');
				const remaining = Dec.max(
					Dec.zero,
					Dec.from(batch.servings).sub(Dec.from(batch.fulfilled))
				);
				plannedFulfilled = Dec.min(remaining, input.servings);
				unplanned = input.servings.sub(plannedFulfilled);
				const newFulfilled = Dec.from(batch.fulfilled).add(plannedFulfilled);
				await tx
					.update(groceryBatches)
					.set({
						fulfilledServings: newFulfilled.toDb(),
						status: newFulfilled.gte(Dec.from(batch.servings)) ? 'fulfilled' : 'planned'
					})
					.where(eq(groceryBatches.id, batch.id));
				await tx
					.update(groceryLists)
					.set({ revision: sql`${groceryLists.revision} + 1`, updatedAt: sql`now()` })
					.where(eq(groceryLists.id, batch.listId));
			}

			const ingredientNames = await getIngredientMeta(
				tx,
				[...lots.values()]
					.map((l) => l.ingredientId)
					.concat(input.items.map((i) => i.ingredientId).filter((x): x is string => !!x))
			);
			const usage = input.items.map((item) => {
				const row = rowByPos.get(item.position);
				return {
					position: item.position,
					name: row?.name ?? '?',
					recipeIngredientId: row?.ingredientId ?? null,
					usedIngredientId: item.ingredientId,
					usedIngredientName: item.ingredientId
						? (ingredientNames.get(item.ingredientId)?.name ?? null)
						: null,
					substituted: !!item.ingredientId && item.ingredientId !== (row?.ingredientId ?? null),
					mode: item.mode,
					note: item.note.slice(0, 300),
					allocations:
						item.mode === 'deduct'
							? item.allocations.map((a) => ({
									lotId: a.lotId,
									amount: a.amount.toString(),
									unit: lots.get(a.lotId)!.unit
								}))
							: []
				};
			});
			const eventId = await insertEvent(tx, {
				householdId: ctx.householdId,
				kind: 'cook',
				actorUserId: ctx.userId,
				actorName: ctx.actorName,
				operationId: input.operationId,
				recipeId: recipe.id,
				recipeTitle: full.title,
				recipeRevision: recipe.revision,
				servings: input.servings,
				batchId: input.batchId,
				plannedServingsFulfilled: plannedFulfilled,
				unplannedServings: unplanned,
				summary: `Cooked ${full.title} (${input.servings.toHuman()} servings)`,
				details: {
					usage,
					baseServings: Dec.from(full.baseServings).toString(),
					convention: full.convention
				}
			});
			let deductions = 0;
			for (const item of input.items) {
				if (item.mode !== 'deduct') continue;
				for (const a of item.allocations) {
					const lot = lots.get(a.lotId)!;
					await applyMovement(tx, {
						eventId,
						householdId: ctx.householdId,
						lotId: lot.id,
						ingredientId: lot.ingredientId,
						delta: a.amount.neg(),
						unit: lot.unit
					});
					deductions++;
				}
			}
			return {
				eventId,
				deductions,
				plannedServingsFulfilled: plannedFulfilled?.toString() ?? null,
				unplannedServings: unplanned?.toString() ?? null
			};
		}
	);
}

/** Lots for one ingredient in the household (for substitutions / manual lot choice). */
export async function lotsForIngredient(
	dbx: DbOrTx,
	householdId: string,
	ingredientId: string,
	unit: string | null,
	convention: Convention = 'metric'
) {
	const [m] = await dbx
		.select({ id: ingredients.id, name: ingredients.name, gramsPerMl: ingredients.gramsPerMl })
		.from(ingredients)
		.where(eq(ingredients.id, ingredientId));
	if (!m) throw new AppError(404, 'Ingredient not found');
	const lots = await activeLotsForIngredients(dbx as never, householdId, [ingredientId]);
	const density = m.gramsPerMl ? Dec.from(m.gramsPerMl) : null;
	return {
		ingredient: { id: m.id, name: m.name },
		lots: lots
			.sort((a, b) =>
				a.expiresOn && b.expiresOn
					? a.expiresOn.localeCompare(b.expiresOn)
					: a.expiresOn
						? -1
						: b.expiresOn
							? 1
							: a.createdAt.localeCompare(b.createdAt)
			)
			.map((l) => ({
				lotId: l.id,
				quantity: l.quantity.toString(),
				unit: l.unit,
				location: l.location,
				expiresOn: l.expiresOn,
				revision: l.revision,
				inRequestedUnit:
					unit && isUnitId(unit)
						? ((unitsCompatible(l.unit, unit)
								? convertAmount(l.quantity, l.unit, unit, convention)
								: convertAmount(l.quantity, l.unit, unit, convention, { gramsPerMl: density })
							)?.toString() ?? null)
						: null
			}))
	};
}
