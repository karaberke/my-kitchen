import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { catalogIngredientId, createUser, d, recipeInput, resetDb } from './helpers';
import { createRecipe, getRecipeDetail } from '$lib/server/recipes';
import { linkIngredientNames, listUnlinkedIngredients } from '$lib/server/ingredient-links';
import { createCustomIngredient } from '$lib/server/ingredients';

const ing = (name: string, position = 0) => ({
	position,
	name,
	ingredientId: null,
	amount: d(1),
	unit: 'tbsp',
	preparation: '',
	groupName: '',
	optional: false,
	createIdentity: false
});

describe('ingredient links', () => {
	beforeEach(resetDb);

	it('lists an unlinked name one time with its proposal and its recipes', async () => {
		const user = await createUser('Alice');
		await createRecipe(user.id, recipeInput({ title: 'Foam', ingredients: [ing('Sugar')] }));
		await createRecipe(user.id, recipeInput({ title: 'Cake', ingredients: [ing('sugar')] }));
		const sugar = await catalogIngredientId('sugar');

		const groups = await listUnlinkedIngredients(db, user.id);

		expect(groups).toHaveLength(1);
		expect(groups[0].name.toLowerCase()).toBe('sugar');
		expect(groups[0].key).toBe('sugar');
		expect(groups[0].rowCount).toBe(2);
		expect(groups[0].recipeTitles.sort()).toEqual(['Cake', 'Foam']);
		expect(groups[0].proposal?.ingredientId).toBe(sugar);
	});

	it('leaves out ingredients that already have a link', async () => {
		const user = await createUser('Alice');
		const sugar = await catalogIngredientId('sugar');
		await createRecipe(
			user.id,
			recipeInput({ title: 'Cake', ingredients: [{ ...ing('sugar'), ingredientId: sugar }] })
		);
		expect(await listUnlinkedIngredients(db, user.id)).toEqual([]);
	});

	it('never lists a recipe of another user', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await createRecipe(bob.id, recipeInput({ title: 'Bob cake', ingredients: [ing('sugar')] }));
		expect(await listUnlinkedIngredients(db, alice.id)).toEqual([]);
	});

	it('links every row of the name and raises the revision of each recipe', async () => {
		const user = await createUser('Alice');
		const sugar = await catalogIngredientId('sugar');
		const foam = await createRecipe(
			user.id,
			recipeInput({ title: 'Foam', ingredients: [ing('Sugar')] })
		);
		const cake = await createRecipe(
			user.id,
			recipeInput({ title: 'Cake', ingredients: [ing('sugar'), ing('flour', 1)] })
		);
		const before = await getRecipeDetail(db, user.id, cake, null);

		const result = await linkIngredientNames(user.id, [{ name: 'sugar', ingredientId: sugar }]);

		expect(result).toEqual({ rows: 2, recipes: 2 });
		const after = await getRecipeDetail(db, user.id, cake, null);
		expect(after.ingredients[0].ingredientId).toBe(sugar);
		expect(after.ingredients[1].ingredientId).toBeNull();
		expect(after.revision).toBe(before.revision + 1);
		const foamDetail = await getRecipeDetail(db, user.id, foam, null);
		expect(foamDetail.ingredients[0].ingredientId).toBe(sugar);
	});

	it('links a second time with no change and no error', async () => {
		const user = await createUser('Alice');
		const sugar = await catalogIngredientId('sugar');
		await createRecipe(user.id, recipeInput({ title: 'Foam', ingredients: [ing('sugar')] }));
		await linkIngredientNames(user.id, [{ name: 'sugar', ingredientId: sugar }]);
		expect(await linkIngredientNames(user.id, [{ name: 'sugar', ingredientId: sugar }])).toEqual({
			rows: 0,
			recipes: 0
		});
	});

	it('never changes a recipe of another user', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const sugar = await catalogIngredientId('sugar');
		const bobCake = await createRecipe(
			bob.id,
			recipeInput({ title: 'Bob cake', ingredients: [ing('sugar')] })
		);
		await linkIngredientNames(alice.id, [{ name: 'sugar', ingredientId: sugar }]);
		const detail = await getRecipeDetail(db, bob.id, bobCake, null);
		expect(detail.ingredients[0].ingredientId).toBeNull();
	});

	it('refuses an ingredient the user cannot see', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const secret = await createCustomIngredient(db, bob.id, 'bob secret spice');
		await createRecipe(alice.id, recipeInput({ title: 'Foam', ingredients: [ing('sugar')] }));
		await expect(
			linkIngredientNames(alice.id, [{ name: 'sugar', ingredientId: secret.id }])
		).rejects.toThrow();
	});
});
