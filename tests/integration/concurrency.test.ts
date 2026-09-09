import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { catalogIngredientId, createUser, d, makeChickenRecipe, opId, resetDb } from './helpers';
import { addStock, getPantryOverview, consistencyCheck } from '$lib/server/pantry';
import { finishCooking, previewCooking } from '$lib/server/cooking';
import { acceptInvite, createInvite } from '$lib/server/households';
import { setRecipeShare } from '$lib/server/recipes';

describe('concurrent deductions', () => {
	beforeEach(resetDb);

	it('two 400 g deductions against 600 g: exactly one commits and stock never goes negative', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
		const bobCtx = { ...bob.ctx, householdId: alice.householdId };
		const chicken = await catalogIngredientId('chicken breast');
		const recipe = await makeChickenRecipe(alice, 'Big roast', '400');
		await setRecipeShare(alice.id, recipe, alice.householdId, true);
		const { result } = await addStock(alice.ctx, {
			operationId: opId(),
			ingredientId: chicken,
			newIngredientName: null,
			quantity: d(600),
			unit: 'g',
			location: '',
			expiresOn: null,
			note: ''
		});
		const preview = await previewCooking(db, alice.ctx, recipe, d(4));
		const item = preview.items[0];
		expect(item.suggestions[0].lotId).toBe(result.lotId);
		const input = (actor: typeof alice.ctx) =>
			finishCooking(actor, {
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
								lotId: result.lotId,
								amount: d(400),
								expectedRevision: item.suggestions[0].revision
							}
						],
						note: ''
					}
				]
			});
		const outcomes = await Promise.allSettled([input(alice.ctx), input(bobCtx)]);
		const ok = outcomes.filter((o) => o.status === 'fulfilled');
		const failed = outcomes.filter((o) => o.status === 'rejected');
		expect(ok).toHaveLength(1);
		expect(failed).toHaveLength(1);
		expect((failed[0] as PromiseRejectedResult).reason.status).toBe(409);
		const overview = await getPantryOverview(db, alice.householdId, {
			q: 'chicken',
			location: null,
			filter: 'all'
		});
		expect(overview.groups[0].totals[0].quantity).toBe('200');
		const report = await consistencyCheck(db, alice.householdId);
		expect(report.lotMismatches).toHaveLength(0);
	});
});
