import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { createUser, recipeInput, resetDb, type TestUser } from './helpers';
import {
	createRecipe,
	duplicateRecipe,
	getRecipeDetail,
	setRecipeShare,
	updateRecipe
} from '$lib/server/recipes';
import { createCustomIngredient } from '$lib/server/ingredients';
import { acceptInvite, createInvite } from '$lib/server/households';
import { Dec } from '$lib/shared/decimal';

describe('duplicating a recipe', () => {
	let alice: TestUser;
	let bob: TestUser;

	beforeAll(async () => {
		await resetDb();
		alice = await createUser('Alice');
		bob = await createUser('Bob');
		const inv = await createInvite(db, alice.id, alice.householdId);
		await acceptInvite(bob.id, inv.token);
	});

	it('drops identities from a shared recipe that the duplicator cannot see', async () => {
		const priv = await createCustomIngredient(db, alice.id, 'Aunties secret spice mix');
		const recipeId = await createRecipe(
			alice.id,
			recipeInput({
				title: 'Secret stew',
				ingredients: [
					{
						position: 0,
						name: 'secret spice',
						ingredientId: priv.id,
						amount: Dec.from('2'),
						unit: 'g',
						preparation: '',
						groupName: '',
						optional: false,
						createIdentity: false
					}
				]
			})
		);
		await setRecipeShare(alice.id, recipeId, alice.householdId, true);

		const copyId = await duplicateRecipe(bob.id, recipeId);
		const copy = await getRecipeDetail(db, bob.id, copyId, null);

		// The identity reference is gone, the human-readable name survives.
		expect(copy.ingredients[0].ingredientId).toBeNull();
		expect(copy.ingredients[0].name).toBe('secret spice');
		expect(copy.ingredients[0].amount).toBe('2');

		// ...and the copy is now editable, which it was not before.
		await expect(
			updateRecipe(
				bob.id,
				copyId,
				recipeInput({
					title: 'Secret stew, my way',
					ingredients: copy.ingredients.map((i, n) => ({
						position: n,
						name: i.name,
						ingredientId: i.ingredientId,
						amount: i.amount ? Dec.from(i.amount) : null,
						unit: i.unit,
						preparation: i.preparation,
						groupName: i.groupName,
						optional: i.optional,
						createIdentity: false
					}))
				}),
				copy.revision
			)
		).resolves.toBeTruthy();
	});

	it('keeps your own identities when you duplicate your own recipe', async () => {
		const mine = await createCustomIngredient(db, alice.id, 'My own blend');
		const recipeId = await createRecipe(
			alice.id,
			recipeInput({
				title: 'Mine',
				ingredients: [
					{
						position: 0,
						name: 'my blend',
						ingredientId: mine.id,
						amount: Dec.from('1'),
						unit: 'g',
						preparation: '',
						groupName: '',
						optional: false,
						createIdentity: false
					}
				]
			})
		);
		const copyId = await duplicateRecipe(alice.id, recipeId);
		const copy = await getRecipeDetail(db, alice.id, copyId, null);
		expect(copy.ingredients[0].ingredientId).toBe(mine.id);
	});
});
