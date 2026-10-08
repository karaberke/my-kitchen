import { and, eq, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import type { Tx } from '$lib/server/db';
import {
	groceryBatchRequirements,
	groceryBatches,
	groceryLines,
	groceryLists,
	ingredients,
	purchaseAllocations,
	recipes
} from '$lib/server/db/schema';
import { assertMember, householdActor, type ActorContext } from '$lib/server/access';
import { AppError, ReviewConflict, notFound, type ReviewDetail } from '$lib/server/errors';
import { assertIngredientsVisible, createCustomIngredient } from '$lib/server/ingredients';
import { createLot, insertEvent, lockHousehold } from '$lib/server/inventory';
import { runOperation, withTransaction } from '$lib/server/operations';
import { Dec } from '$lib/shared/decimal';
import { remainingTarget } from '$lib/shared/grocery-math';
import { convertAmount, isUnitId, unitsCompatible } from '$lib/shared/units';
import { validateDate } from '$lib/server/pantry';
import { match as isUuid } from '../../../params/uuid';
import { LOCATION_MAX_CHARS, NOTE_MAX_CHARS } from '$lib/shared/text';
import { lockList, bumpList } from './shared';
import { recalculateDraft, recipeRequirements, insertRequirements } from './draft';

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
