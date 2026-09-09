import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { catalogIngredientId, createUser, d, makeChickenRecipe, opId, resetDb } from './helpers';
import {
	addBatch,
	createList,
	getListDetail,
	recordPurchase,
	startShopping,
	updateLine,
	addManualLine,
	refreshDraft
} from '$lib/server/grocery';
import { addStock, getPantryOverview } from '$lib/server/pantry';
import { acceptInvite, createInvite } from '$lib/server/households';
import { ReviewConflict } from '$lib/server/errors';

async function chickenStock(householdId: string) {
	const overview = await getPantryOverview(db, householdId, {
		q: 'chicken',
		location: null,
		filter: 'all'
	});
	const group = overview.groups.find((g) => g.name === 'chicken breast');
	return group ? (group.totals.find((t) => t.unit === 'g')?.quantity ?? '0') : '0';
}

describe('grocery planning, shopping and purchases', () => {
	beforeEach(resetDb);

	it('aggregates demand, subtracts pantry once, guards against stale previews, and credits purchases exactly once', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
		const bobCtx = { ...bob.ctx, householdId: alice.householdId };
		const chicken = await catalogIngredientId('chicken breast');

		const roast = await makeChickenRecipe(alice, 'Roast', '500');
		const curry = await makeChickenRecipe(alice, 'Curry', '300');
		await addStock(alice.ctx, {
			operationId: opId(),
			ingredientId: chicken,
			newIngredientName: null,
			quantity: d(300),
			unit: 'g',
			location: 'Freezer',
			expiresOn: null,
			note: ''
		});

		const listId = await createList(alice.ctx, 'Weekly');
		await addBatch(alice.ctx, {
			listId,
			recipeId: roast,
			servings: d(4),
			clientKey: 'k1',
			includeOptional: []
		});
		const dup = await addBatch(alice.ctx, {
			listId,
			recipeId: roast,
			servings: d(4),
			clientKey: 'k1',
			includeOptional: []
		});
		expect(dup.duplicate).toBe(true);
		await addBatch(alice.ctx, {
			listId,
			recipeId: curry,
			servings: d(4),
			clientKey: 'k2',
			includeOptional: []
		});
		// intentionally planning another batch with a new key works
		const extra = await addBatch(alice.ctx, {
			listId,
			recipeId: curry,
			servings: d(4),
			clientKey: 'k3',
			includeOptional: []
		});
		expect(extra.duplicate).toBe(false);
		const { removeBatch } = await import('$lib/server/grocery');
		await removeBatch(alice.ctx, { listId, batchId: extra.batchId });

		let detail = await getListDetail(db, alice.householdId, listId);
		expect(detail.batches).toHaveLength(2);
		expect(detail.lines).toHaveLength(1);
		expect(detail.lines[0].demandAmount).toBe('800');
		expect(detail.lines[0].stockConsidered).toBe('300');
		expect(detail.lines[0].targetAmount).toBe('500');
		expect(detail.lines[0].sources.map((s) => s.recipeTitle).sort()).toEqual(['Curry', 'Roast']);
		expect(detail.pantryChanged).toBe(false);

		// Bob changes the pantry after the preview
		await addStock(bobCtx, {
			operationId: opId(),
			ingredientId: chicken,
			newIngredientName: null,
			quantity: d(100),
			unit: 'g',
			location: 'Fridge',
			expiresOn: '2030-01-01',
			note: ''
		});
		detail = await getListDetail(db, alice.householdId, listId);
		expect(detail.pantryChanged).toBe(true);
		const staleRevision = detail.revision;
		const err = await startShopping(alice.ctx, { listId, expectedRevision: staleRevision }).catch(
			(e) => e
		);
		expect(err).toBeInstanceOf(ReviewConflict);
		expect(err.review.reason).toBe('pantry_changed');
		detail = await getListDetail(db, alice.householdId, listId);
		expect(detail.status).toBe('draft');
		expect(detail.lines[0].stockConsidered).toBe('400');
		expect(detail.lines[0].targetAmount).toBe('400');

		// Bob removes his extra stock again (waste) so the classic numbers hold
		const overview = await getPantryOverview(db, alice.householdId, {
			q: 'chicken',
			location: 'Fridge',
			filter: 'all'
		});
		const { wasteLot } = await import('$lib/server/pantry');
		await wasteLot(bobCtx, {
			operationId: opId(),
			lotId: overview.groups[0].lots[0].id,
			quantity: d(100),
			reason: 'test'
		});
		await refreshDraft(alice.ctx, listId);
		detail = await getListDetail(db, alice.householdId, listId);
		expect(detail.lines[0].targetAmount).toBe('500');
		await startShopping(alice.ctx, { listId, expectedRevision: detail.revision });
		detail = await getListDetail(db, alice.householdId, listId);
		expect(detail.status).toBe('shopping');
		const line = detail.lines[0];

		// Buy 200 g
		const p1 = opId();
		const r1 = await recordPurchase(alice.ctx, {
			operationId: p1,
			listId,
			lineId: line.id,
			bought: { quantity: d(200), unit: 'g' },
			ingredientId: null,
			newIngredientName: null,
			location: 'Fridge',
			expiresOn: null,
			note: ''
		});
		expect(r1.replayed).toBe(false);
		expect(r1.result.remaining).toBe('300');
		expect(await chickenStock(alice.householdId)).toBe('500');

		// Buy a 1 kg pack
		const r2 = await recordPurchase(alice.ctx, {
			operationId: opId(),
			listId,
			lineId: line.id,
			bought: { quantity: d(1), unit: 'kg' },
			ingredientId: null,
			newIngredientName: null,
			location: 'Freezer',
			expiresOn: null,
			note: ''
		});
		expect(r2.result.remaining).toBe('0');
		expect(r2.result.lineStatus).toBe('purchased');
		expect(await chickenStock(alice.householdId)).toBe('1500');
		detail = await getListDetail(db, alice.householdId, listId);
		expect(detail.lines[0].purchasedAmount).toBe('1200');
		expect(detail.lines[0].targetAmount).toBe('500');

		// Retry of the first purchase with the same operation id: nothing changes
		const replay = await recordPurchase(alice.ctx, {
			operationId: p1,
			listId,
			lineId: line.id,
			bought: { quantity: d(200), unit: 'g' },
			ingredientId: null,
			newIngredientName: null,
			location: 'Fridge',
			expiresOn: null,
			note: ''
		});
		expect(replay.replayed).toBe(true);
		expect(replay.result.remaining).toBe('300');
		expect(await chickenStock(alice.householdId)).toBe('1500');

		// Same id, different payload: rejected
		await expect(
			recordPurchase(alice.ctx, {
				operationId: p1,
				listId,
				lineId: line.id,
				bought: { quantity: d(250), unit: 'g' },
				ingredientId: null,
				newIngredientName: null,
				location: 'Fridge',
				expiresOn: null,
				note: ''
			})
		).rejects.toMatchObject({ status: 409 });
		expect(await chickenStock(alice.householdId)).toBe('1500');
	});

	it('manual lines are not pantry-subtracted unless asked, and remaining-target edits keep totals consistent', async () => {
		const alice = await createUser('Alice');
		const rice = await catalogIngredientId('rice');
		await addStock(alice.ctx, {
			operationId: opId(),
			ingredientId: rice,
			newIngredientName: null,
			quantity: d(1000),
			unit: 'g',
			location: '',
			expiresOn: null,
			note: ''
		});
		const listId = await createList(alice.ctx, 'Manual');
		const m1 = await addManualLine(alice.ctx, {
			listId,
			name: 'rice',
			ingredientId: rice,
			amount: d(500),
			unit: 'g',
			category: '',
			subtractPantry: false,
			note: ''
		});
		const m2 = await addManualLine(alice.ctx, {
			listId,
			name: 'rice',
			ingredientId: rice,
			amount: d(500),
			unit: 'g',
			category: '',
			subtractPantry: true,
			note: ''
		});
		const m3 = await addManualLine(alice.ctx, {
			listId,
			name: 'paper towels',
			ingredientId: null,
			amount: null,
			unit: null,
			category: 'Household',
			subtractPantry: false,
			note: ''
		});
		let detail = await getListDetail(db, alice.householdId, listId);
		const l1 = detail.lines.find((l) => l.id === m1.lineId)!;
		const l2 = detail.lines.find((l) => l.id === m2.lineId)!;
		const l3 = detail.lines.find((l) => l.id === m3.lineId)!;
		expect(l1.targetAmount).toBe('500');
		expect(l1.stockConsidered).toBeNull();
		expect(l2.targetAmount).toBe('0');
		expect(l2.stockConsidered).toBe('1000');
		expect(l3.unresolvedReason).toBe('unknown_amount');

		await startShopping(alice.ctx, { listId, expectedRevision: detail.revision });
		detail = await getListDetail(db, alice.householdId, listId);
		expect(detail.lines.find((l) => l.id === m2.lineId)!.status).toBe('purchased');
		// buy 200 g against 500 g target, then edit remaining to 100 g -> total target 300
		await recordPurchase(alice.ctx, {
			operationId: opId(),
			listId,
			lineId: m1.lineId,
			bought: { quantity: d(200), unit: 'g' },
			ingredientId: null,
			newIngredientName: null,
			location: '',
			expiresOn: null,
			note: ''
		});
		detail = await getListDetail(db, alice.householdId, listId);
		const before = detail.lines.find((l) => l.id === m1.lineId)!;
		expect(before.remaining).toBe('300');
		await updateLine(alice.ctx, {
			listId,
			lineId: m1.lineId,
			expectedRevision: before.revision,
			amount: d(100)
		});
		detail = await getListDetail(db, alice.householdId, listId);
		const after = detail.lines.find((l) => l.id === m1.lineId)!;
		expect(after.targetAmount).toBe('300');
		expect(after.remaining).toBe('100');
		// stale edit rejected
		await expect(
			updateLine(alice.ctx, {
				listId,
				lineId: m1.lineId,
				expectedRevision: before.revision,
				amount: d(50)
			})
		).rejects.toBeInstanceOf(ReviewConflict);
		// unknown-quantity item can be handled without inventing stock
		const handled = await recordPurchase(alice.ctx, {
			operationId: opId(),
			listId,
			lineId: m3.lineId,
			bought: null,
			ingredientId: null,
			newIngredientName: null,
			location: '',
			expiresOn: null,
			note: ''
		});
		expect(handled.result.lineStatus).toBe('handled');
		expect(handled.result.lotId).toBeNull();
	});
});
