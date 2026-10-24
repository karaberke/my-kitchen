import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { inventoryMovements, stockLots } from '$lib/server/db/schema';
import { acceptInvite, createInvite, removeMember, revisionsFor } from '$lib/server/households';
import { createCustomIngredient } from '$lib/server/ingredients';
import {
	addBatch,
	addManualLine,
	createList,
	getListDetail,
	recordPurchase,
	refreshDraft,
	startShopping
} from '$lib/server/grocery';
import { setRecipeShare, updateRecipe } from '$lib/server/recipes';
import { pantryLotsFor } from '$lib/server/cooking';
import {
	catalogIngredientId,
	createUser,
	d,
	holdDatabaseTransaction,
	makeChickenRecipe,
	opId,
	recipeInput,
	requestAs,
	resetDb
} from './helpers';

beforeEach(resetDb);

describe('grocery snapshots and household access', () => {
	it.each([true, false])(
		'keeps an unshared recipe snapshot usable (shared household: %s)',
		async (sharedHousehold) => {
			const alice = await createUser('Alice');
			const bob = await createUser('Bob');
			await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
			const ctx = {
				...bob.ctx,
				householdId: sharedHousehold ? alice.householdId : bob.householdId
			};
			const recipeId = await makeChickenRecipe(alice, 'Shared roast', '500');
			const listId = await createList(ctx, 'Shared snapshot');
			await addBatch(ctx, {
				listId,
				recipeId,
				servings: d(4),
				clientKey: opId(),
				includeOptional: []
			});
			const before = await getListDetail(db, ctx.householdId, listId, bob.id);
			await setRecipeShare(alice.id, recipeId, alice.householdId, false);
			await updateRecipe(
				alice.id,
				recipeId,
				recipeInput({
					title: 'PRIVATE TITLE AFTER UNSHARE',
					ingredients: [
						{
							position: 0,
							name: 'PRIVATE INGREDIENT AFTER UNSHARE',
							ingredientId: null,
							amount: d(99),
							unit: 'g',
							preparation: '',
							groupName: '',
							optional: false,
							createIdentity: false
						}
					]
				}),
				null
			);
			await refreshDraft(ctx, listId);
			const preview = await getListDetail(db, ctx.householdId, listId, bob.id);
			expect(preview.batches[0]).toMatchObject({
				recipeId: null,
				currentRecipeRevision: null,
				recipeChanged: false
			});
			expect(preview.batches[0].requirements).toEqual(before.batches[0].requirements);
			expect(JSON.stringify(preview)).not.toContain('PRIVATE');
			await startShopping(ctx, { listId, expectedRevision: preview.revision });
			const trip = await getListDetail(db, ctx.householdId, listId, bob.id);
			expect(trip.status).toBe('shopping');
			expect(trip.batches[0].requirements).toEqual(before.batches[0].requirements);
			expect(JSON.stringify(trip)).not.toContain('PRIVATE');
			await expect(
				recordPurchase(ctx, {
					operationId: opId(),
					listId,
					lineId: trip.lines[0].id,
					bought: { quantity: d(500), unit: 'g' },
					ingredientId: trip.lines[0].ingredientId,
					newIngredientName: null,
					location: '',
					expiresOn: null,
					note: ''
				})
			).resolves.toMatchObject({ result: { lineStatus: 'purchased' } });
		}
	);

	it('keeps the recorded snapshot when sharing is revoked during a waiting recipe refresh', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
		const recipeId = await makeChickenRecipe(alice, 'Original shared roast', '500');
		const listId = await createList(bob.ctx, 'Recorded recipe');
		await addBatch(bob.ctx, {
			listId,
			recipeId,
			servings: d(4),
			clientKey: opId(),
			includeOptional: []
		});
		const before = await getListDetail(db, bob.householdId, listId, bob.id);
		await updateRecipe(
			alice.id,
			recipeId,
			recipeInput({
				title: 'Public revised roast',
				ingredients: [
					{
						position: 0,
						name: 'chicken breast',
						ingredientId: await catalogIngredientId('chicken breast'),
						amount: d(700),
						unit: 'g',
						preparation: '',
						groupName: '',
						optional: false,
						createIdentity: false
					}
				]
			}),
			null
		);
		// The owner publishes a private edit atomically while the refresh waits on its recipe lock.
		const gate = await holdDatabaseTransaction(async (tx) => {
			await tx`update recipe set title = 'PRIVATE RACING TITLE', revision = revision + 1
				where id = ${recipeId}`;
			await tx`delete from recipe_share where recipe_id = ${recipeId}`;
			await tx`update recipe_ingredient set name = 'PRIVATE RACING INGREDIENT',
				ingredient_id = null, amount = 99 where recipe_id = ${recipeId}`;
		});
		const starting = startShopping(bob.ctx, { listId, expectedRevision: before.revision });
		const settled = Promise.allSettled([starting]);
		try {
			await gate.waitForBlocked();
		} finally {
			await gate.release();
			await settled;
		}
		await expect(starting).rejects.toMatchObject({ status: 409 });
		const after = await getListDetail(db, bob.householdId, listId, bob.id);
		expect(after.batches[0].requirements).toEqual(before.batches[0].requirements);
		expect(after.batches[0].recipeTitle).toBe('Original shared roast');
		expect(after.batches[0]).toMatchObject({ recipeId: null, currentRecipeRevision: null });
		expect(JSON.stringify(after)).not.toContain('PRIVATE');
		await expect(
			startShopping(bob.ctx, { listId, expectedRevision: after.revision })
		).resolves.toBeDefined();
	});

	it('still reviews a readable recipe changed after the draft was created', async () => {
		const alice = await createUser('Alice');
		const recipeId = await makeChickenRecipe(alice, 'Roast', '500');
		const listId = await createList(alice.ctx, 'Draft');
		await addBatch(alice.ctx, {
			listId,
			recipeId,
			servings: d(4),
			clientKey: opId(),
			includeOptional: []
		});
		const before = await getListDetail(db, alice.householdId, listId, alice.id);
		await updateRecipe(
			alice.id,
			recipeId,
			recipeInput({
				title: 'Updated roast',
				ingredients: [
					{
						position: 0,
						name: 'chicken breast',
						ingredientId: await catalogIngredientId('chicken breast'),
						amount: d(700),
						unit: 'g',
						preparation: '',
						groupName: '',
						optional: false,
						createIdentity: false
					}
				]
			}),
			null
		);
		await expect(
			startShopping(alice.ctx, { listId, expectedRevision: before.revision })
		).rejects.toMatchObject({ status: 409 });
		const updated = await getListDetail(db, alice.householdId, listId, alice.id);
		expect(updated.batches[0].recipeTitle).toBe('Updated roast');
		expect(updated.batches[0].requirements).toMatchObject([
			{ name: 'chicken breast', baseAmount: '700' }
		]);
		await expect(
			startShopping(alice.ctx, { listId, expectedRevision: updated.revision })
		).resolves.toBeDefined();
	});

	it('revocation blocks real reads and writes with stale household locals without changing revisions', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
		const staleEvent = requestAs(bob, alice.householdId);
		const staleActor = { ...bob.ctx, householdId: alice.householdId };
		const chicken = await catalogIngredientId('chicken breast');
		await removeMember(alice.id, alice.householdId, bob.id);
		const before = await revisionsFor(requestAs(alice), {});
		await expect(
			pantryLotsFor(staleEvent, { ingredient: chicken, unit: 'g', convention: 'metric' })
		).rejects.toMatchObject({ status: 403 });
		await expect(createList(staleActor, 'Unauthorized')).rejects.toMatchObject({ status: 403 });
		expect(await revisionsFor(requestAs(alice), {})).toEqual(before);
	});
});

describe('purchasing an existing household ingredient identity', () => {
	it('lets another member buy the linked custom ingredient, but rejects unrelated private replacements', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
		const bobCtx = { ...bob.ctx, householdId: alice.householdId };
		const linked = await createCustomIngredient(db, alice.id, 'Family spice blend');
		const privateOther = await createCustomIngredient(db, alice.id, 'Unrelated secret blend');
		const listId = await createList(alice.ctx, 'Spices');
		await addManualLine(alice.ctx, {
			listId,
			name: linked.name,
			ingredientId: linked.id,
			amount: d(100),
			unit: 'g',
			category: 'Other',
			subtractPantry: false,
			note: ''
		});
		const draft = await getListDetail(db, alice.householdId, listId, bob.id);
		await startShopping(bobCtx, { listId, expectedRevision: draft.revision });
		const input = {
			operationId: opId(),
			listId,
			lineId: draft.lines[0].id,
			bought: { quantity: d(100), unit: 'g' },
			ingredientId: linked.id,
			newIngredientName: null,
			location: 'Cupboard',
			expiresOn: null,
			note: ''
		};
		await expect(
			recordPurchase(bobCtx, { ...input, ingredientId: privateOther.id })
		).rejects.toMatchObject({ status: 400 });
		const purchase = await recordPurchase(bobCtx, input);
		expect(purchase.replayed).toBe(false);
		const { lotId, eventId } = purchase.result;
		if (!lotId || !eventId)
			throw new Error('A known-quantity purchase must create a lot and event.');
		const [lot] = await db.select().from(stockLots).where(eq(stockLots.id, lotId));
		expect(lot).toMatchObject({ ingredientId: linked.id, quantity: '100.000000', unit: 'g' });
		const movements = await db
			.select()
			.from(inventoryMovements)
			.where(eq(inventoryMovements.eventId, eventId));
		expect(movements).toHaveLength(1);
		expect(movements[0]).toMatchObject({ ingredientId: linked.id, unit: 'g', delta: '100.000000' });
		await expect(recordPurchase(bobCtx, input)).resolves.toMatchObject({
			replayed: true,
			result: purchase.result
		});
	});
});
