import { and, eq, sql } from 'drizzle-orm';
import {
	groceryBatches,
	groceryLines,
	groceryLists,
	inventoryEvents,
	inventoryMovements,
	purchaseAllocations
} from '$lib/server/db/schema';
import { assertMember } from '$lib/server/access';
import { AppError, ReviewConflict } from '$lib/server/errors';
import { applyMovement, insertEvent, lockHousehold, lockLots } from '$lib/server/inventory';
import { runOperation } from '$lib/server/operations';
import { Dec } from '$lib/shared/decimal';
import { remainingTarget } from '$lib/shared/grocery-math';
import type { ActorContext } from '$lib/server/pantry';

/**
 * Undo = one linked compensating event. It reverses the original deltas
 * against current balances (never restores an old snapshot), reverses list
 * credits and planned-serving fulfilment, and can happen only once.
 */
export async function undoEvent(
	ctx: ActorContext,
	input: { operationId: string; eventId: string }
) {
	const payload = { eventId: input.eventId, householdId: ctx.householdId };
	return runOperation(
		{ operationId: input.operationId, userId: ctx.userId, kind: 'undo', payload },
		async (tx) => {
			await assertMember(tx, ctx.householdId, ctx.userId);
			await lockHousehold(tx, ctx.householdId, { pantry: true, grocery: true });
			const [original] = await tx
				.select()
				.from(inventoryEvents)
				.where(
					and(
						eq(inventoryEvents.id, input.eventId),
						eq(inventoryEvents.householdId, ctx.householdId)
					)
				)
				.for('update');
			if (!original) throw new AppError(404, 'Event not found');
			if (original.kind === 'undo')
				throw new AppError(409, 'An undo cannot itself be undone; record a correction instead');
			if (original.reversedByEventId) throw new AppError(409, 'This action was already undone');

			const movements = await tx
				.select()
				.from(inventoryMovements)
				.where(eq(inventoryMovements.eventId, original.id));
			const lots = await lockLots(
				tx,
				ctx.householdId,
				movements.map((m) => m.lotId)
			);
			const conflicts: {
				lotId: string;
				ingredientName: string;
				needed: string;
				available: string;
				unit: string;
			}[] = [];
			for (const m of movements) {
				const delta = Dec.from(m.delta);
				const lot = lots.get(m.lotId);
				if (!lot) throw new AppError(409, 'A pantry lot from this action no longer exists');
				if (delta.isPositive() && lot.quantity.lt(delta)) {
					conflicts.push({
						lotId: lot.id,
						ingredientName: String((original.details as { name?: string }).name ?? ''),
						needed: delta.toString(),
						available: lot.quantity.toString(),
						unit: lot.unit
					});
				}
			}
			if (conflicts.length) {
				throw new ReviewConflict(
					'Part of what this action added to the pantry has already been used, so it cannot simply be reversed. Record a quantity correction on the lot instead.',
					{ reason: 'consumed', conflicts }
				);
			}

			const undoId = await insertEvent(tx, {
				householdId: ctx.householdId,
				kind: 'undo',
				actorUserId: ctx.userId,
				actorName: ctx.actorName,
				operationId: input.operationId,
				reversesEventId: original.id,
				recipeId: original.recipeId,
				recipeTitle: original.recipeTitle,
				recipeRevision: original.recipeRevision,
				batchId: original.batchId,
				groceryListId: original.groceryListId,
				summary: `Undid: ${original.summary}`,
				details: { originalKind: original.kind, originalEventId: original.id }
			});
			for (const m of movements) {
				const lot = lots.get(m.lotId)!;
				await applyMovement(tx, {
					eventId: undoId,
					householdId: ctx.householdId,
					lotId: lot.id,
					ingredientId: lot.ingredientId,
					delta: Dec.from(m.delta).neg(),
					unit: m.unit
				});
			}

			// Reverse purchase credits on list lines.
			const allocations = await tx
				.select()
				.from(purchaseAllocations)
				.where(eq(purchaseAllocations.eventId, original.id));
			for (const a of allocations) {
				const amount = Dec.from(a.amount);
				const [line] = await tx
					.select()
					.from(groceryLines)
					.where(eq(groceryLines.id, a.lineId))
					.for('update');
				if (!line) continue;
				const purchasedAfter = Dec.max(Dec.zero, Dec.from(line.purchasedAmount).sub(amount));
				const target = line.targetAmount ? Dec.from(line.targetAmount) : null;
				const remaining = remainingTarget(target, purchasedAfter);
				const status =
					target === null ? 'pending' : remaining!.isPositive() ? 'pending' : 'purchased';
				await tx
					.insert(purchaseAllocations)
					.values({ eventId: undoId, lineId: line.id, amount: amount.neg().toDb() });
				await tx
					.update(groceryLines)
					.set({
						purchasedAmount: purchasedAfter.toDb(),
						status,
						revision: sql`${groceryLines.revision} + 1`,
						updatedAt: sql`now()`
					})
					.where(eq(groceryLines.id, line.id));
				await tx
					.update(groceryLists)
					.set({ revision: sql`${groceryLists.revision} + 1`, updatedAt: sql`now()` })
					.where(eq(groceryLists.id, line.listId));
			}

			// Restore planned servings for cooking events linked to a batch.
			if (original.kind === 'cook' && original.batchId && original.plannedServingsFulfilled) {
				const restore = Dec.from(original.plannedServingsFulfilled);
				if (restore.isPositive()) {
					const [batch] = await tx
						.select()
						.from(groceryBatches)
						.where(eq(groceryBatches.id, original.batchId))
						.for('update');
					if (batch) {
						const fulfilled = Dec.max(Dec.zero, Dec.from(batch.fulfilledServings).sub(restore));
						await tx
							.update(groceryBatches)
							.set({
								fulfilledServings: fulfilled.toDb(),
								status: fulfilled.gte(Dec.from(batch.servings)) ? 'fulfilled' : 'planned'
							})
							.where(eq(groceryBatches.id, batch.id));
						await tx
							.update(groceryLists)
							.set({ revision: sql`${groceryLists.revision} + 1`, updatedAt: sql`now()` })
							.where(eq(groceryLists.id, batch.listId));
					}
				}
			}

			await tx
				.update(inventoryEvents)
				.set({ reversedByEventId: undoId })
				.where(eq(inventoryEvents.id, original.id));
			return {
				undoEventId: undoId,
				reversedMovements: movements.length,
				reversedAllocations: allocations.length
			};
		}
	);
}
