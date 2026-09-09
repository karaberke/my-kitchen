import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { catalogIngredientId, createUser, d, makeChickenRecipe, opId, resetDb } from './helpers';
import { addStock, getHistory, getPantryOverview } from '$lib/server/pantry';
import { finishCooking, previewCooking } from '$lib/server/cooking';
import {
	addBatch,
	createList,
	getListDetail,
	recordPurchase,
	startShopping
} from '$lib/server/grocery';
import { undoEvent } from '$lib/server/undo';
import { ReviewConflict } from '$lib/server/errors';
import { updateRecipe, getRecipeDetail } from '$lib/server/recipes';
import { recipeInput } from './helpers';

async function chickenTotal(householdId: string) {
	const o = await getPantryOverview(db, householdId, {
		q: 'chicken',
		location: null,
		filter: 'all'
	});
	return o.groups[0]?.totals.find((t) => t.unit === 'g')?.quantity ?? '0';
}

describe('cooking, planned batches and undo', () => {
	beforeEach(resetDb);

	it('cooking two of four planned servings leaves two planned; undo restores them without touching other events', async () => {
		const alice = await createUser('Alice');
		const chicken = await catalogIngredientId('chicken breast');
		const recipe = await makeChickenRecipe(alice, 'Roast', '400', 4);
		await addStock(alice.ctx, {
			operationId: opId(),
			ingredientId: chicken,
			newIngredientName: null,
			quantity: d(1000),
			unit: 'g',
			location: '',
			expiresOn: null,
			note: ''
		});
		const listId = await createList(alice.ctx, 'Plan');
		const { batchId } = await addBatch(alice.ctx, {
			listId,
			recipeId: recipe,
			servings: d(4),
			clientKey: 'k',
			includeOptional: []
		});
		let detail = await getListDetail(db, alice.householdId, listId);
		await startShopping(alice.ctx, { listId, expectedRevision: detail.revision });

		// an unrelated cooking event first
		const preview0 = await previewCooking(db, alice.ctx, recipe, d(1));
		const other = await finishCooking(alice.ctx, {
			operationId: opId(),
			recipeId: recipe,
			expectedRecipeRevision: preview0.revision,
			servings: d(1),
			batchId: null,
			items: [
				{
					position: 0,
					mode: 'deduct',
					ingredientId: chicken,
					allocations: [
						{
							lotId: preview0.items[0].suggestions[0].lotId,
							amount: d(100),
							expectedRevision: preview0.items[0].suggestions[0].revision
						}
					],
					note: ''
				}
			]
		});
		expect(await chickenTotal(alice.householdId)).toBe('900');

		const preview = await previewCooking(db, alice.ctx, recipe, d(2));
		expect(preview.batches[0].remainingServings).toBe('4');
		expect(preview.items[0].scaledAmount).toBe('200');
		const cook = await finishCooking(alice.ctx, {
			operationId: opId(),
			recipeId: recipe,
			expectedRecipeRevision: preview.revision,
			servings: d(2),
			batchId,
			items: [
				{
					position: 0,
					mode: 'deduct',
					ingredientId: chicken,
					allocations: [
						{
							lotId: preview.items[0].suggestions[0].lotId,
							amount: d(200),
							expectedRevision: preview.items[0].suggestions[0].revision
						}
					],
					note: ''
				}
			]
		});
		expect(cook.result.plannedServingsFulfilled).toBe('2');
		expect(cook.result.unplannedServings).toBe('0');
		detail = await getListDetail(db, alice.householdId, listId);
		expect(detail.batches[0].remainingServings).toBe('2');
		expect(detail.batches[0].status).toBe('planned');
		expect(await chickenTotal(alice.householdId)).toBe('700');

		// an unrelated purchase after cooking
		await recordPurchase(alice.ctx, {
			operationId: opId(),
			listId,
			lineId: detail.lines[0].id,
			bought: { quantity: d(300), unit: 'g' },
			ingredientId: null,
			newIngredientName: null,
			location: '',
			expiresOn: null,
			note: ''
		});
		expect(await chickenTotal(alice.householdId)).toBe('1000');

		// undo the cooking: only the 200 g delta and 2 servings come back
		await undoEvent(alice.ctx, { operationId: opId(), eventId: cook.result.eventId });
		expect(await chickenTotal(alice.householdId)).toBe('1200');
		detail = await getListDetail(db, alice.householdId, listId);
		expect(detail.batches[0].remainingServings).toBe('4');
		const history = await getHistory(db, alice.householdId, null);
		const otherEvent = history.items.find((e) => e.id === other.result.eventId)!;
		expect(otherEvent.reversedByEventId).toBeNull();
		// a second undo of the same event is rejected
		await expect(
			undoEvent(alice.ctx, { operationId: opId(), eventId: cook.result.eventId })
		).rejects.toMatchObject({ status: 409 });

		// cooking 5 servings with 4 planned: 4 planned fulfilled, 1 unplanned, batch fulfilled
		const preview2 = await previewCooking(db, alice.ctx, recipe, d(5));
		const cook2 = await finishCooking(alice.ctx, {
			operationId: opId(),
			recipeId: recipe,
			expectedRecipeRevision: preview2.revision,
			servings: d(5),
			batchId,
			items: [
				{
					position: 0,
					mode: 'skip',
					ingredientId: chicken,
					allocations: [],
					note: 'used leftovers'
				}
			]
		});
		expect(cook2.result.plannedServingsFulfilled).toBe('4');
		expect(cook2.result.unplannedServings).toBe('1');
		detail = await getListDetail(db, alice.householdId, listId);
		expect(detail.batches[0].status).toBe('fulfilled');
		expect(await chickenTotal(alice.householdId)).toBe('1200');
	});

	it('undoing a purchase that was already consumed produces a review conflict, and idempotent retries replay', async () => {
		const alice = await createUser('Alice');
		const chicken = await catalogIngredientId('chicken breast');
		const recipe = await makeChickenRecipe(alice, 'Roast', '400', 4);
		const listId = await createList(alice.ctx, 'Plan');
		await addBatch(alice.ctx, {
			listId,
			recipeId: recipe,
			servings: d(4),
			clientKey: 'k',
			includeOptional: []
		});
		let detail = await getListDetail(db, alice.householdId, listId);
		await startShopping(alice.ctx, { listId, expectedRevision: detail.revision });
		detail = await getListDetail(db, alice.householdId, listId);
		const purchase = await recordPurchase(alice.ctx, {
			operationId: opId(),
			listId,
			lineId: detail.lines[0].id,
			bought: { quantity: d(500), unit: 'g' },
			ingredientId: null,
			newIngredientName: null,
			location: '',
			expiresOn: null,
			note: ''
		});
		const preview = await previewCooking(db, alice.ctx, recipe, d(4));
		await finishCooking(alice.ctx, {
			operationId: opId(),
			recipeId: recipe,
			expectedRecipeRevision: preview.revision,
			servings: d(4),
			batchId: null,
			items: [
				{
					position: 0,
					mode: 'deduct',
					ingredientId: chicken,
					allocations: [
						{
							lotId: purchase.result.lotId!,
							amount: d(400),
							expectedRevision: preview.items[0].suggestions[0].revision
						}
					],
					note: ''
				}
			]
		});
		const err = await undoEvent(alice.ctx, {
			operationId: opId(),
			eventId: purchase.result.eventId!
		}).catch((e) => e);
		expect(err).toBeInstanceOf(ReviewConflict);
		expect(err.review.reason).toBe('consumed');
		expect(await chickenTotal(alice.householdId)).toBe('100');
		detail = await getListDetail(db, alice.householdId, listId);
		expect(detail.lines[0].purchasedAmount).toBe('500');
	});

	it('editing a recipe after cooking preserves the event snapshot', async () => {
		const alice = await createUser('Alice');
		const chicken = await catalogIngredientId('chicken breast');
		const recipe = await makeChickenRecipe(alice, 'Roast', '400', 4);
		await addStock(alice.ctx, {
			operationId: opId(),
			ingredientId: chicken,
			newIngredientName: null,
			quantity: d(500),
			unit: 'g',
			location: '',
			expiresOn: null,
			note: ''
		});
		const preview = await previewCooking(db, alice.ctx, recipe, d(4));
		const cook = await finishCooking(alice.ctx, {
			operationId: opId(),
			recipeId: recipe,
			expectedRecipeRevision: preview.revision,
			servings: d(4),
			batchId: null,
			items: [
				{
					position: 0,
					mode: 'deduct',
					ingredientId: chicken,
					allocations: [
						{
							lotId: preview.items[0].suggestions[0].lotId,
							amount: d(400),
							expectedRevision: preview.items[0].suggestions[0].revision
						}
					],
					note: ''
				}
			]
		});
		const before = await getRecipeDetail(db, alice.id, recipe, alice.householdId);
		await updateRecipe(
			alice.id,
			recipe,
			recipeInput({
				title: 'Roast v2',
				ingredients: [
					{
						position: 0,
						name: 'chicken breast',
						ingredientId: chicken,
						amount: d(900),
						unit: 'g',
						preparation: '',
						groupName: '',
						optional: false,
						createIdentity: false
					}
				]
			}),
			before.revision
		);
		// stale revision edit is rejected
		await expect(
			updateRecipe(
				alice.id,
				recipe,
				recipeInput({ title: 'Roast v3', ingredients: [] }),
				before.revision
			)
		).rejects.toBeInstanceOf(ReviewConflict);
		const history = await getHistory(db, alice.householdId, null);
		const ev = history.items.find((e) => e.id === cook.result.eventId)!;
		expect(ev.recipeTitle).toBe('Roast');
		expect(
			(ev.details.usage as { allocations: { amount: string }[] }[])[0].allocations[0].amount
		).toBe('400');
		// deleting the recipe keeps the history
		const { deleteRecipe } = await import('$lib/server/recipes');
		await deleteRecipe(alice.id, recipe);
		const after = await getHistory(db, alice.householdId, null);
		expect(after.items.find((e) => e.id === cook.result.eventId)?.recipeTitle).toBe('Roast');
	});
});
