import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { catalogIngredientId, createUser, d, recipeInput, resetDb } from './helpers';
import {
	createRecipe,
	duplicateRecipe,
	exportRecipes,
	getRecipeDetail,
	listRecipes,
	parseListParams,
	setFavorite,
	setRecipeShare,
	updateRecipe
} from '$lib/server/recipes';
import { acceptInvite, createInvite } from '$lib/server/households';
import { addBatch, createList } from '$lib/server/grocery';
import { addStock } from '$lib/server/pantry';
import { opId } from './helpers';

describe('recipes', () => {
	beforeEach(resetDb);

	it('drafts save incomplete data but cannot be planned; fractions, optional and unknown amounts round-trip', async () => {
		const alice = await createUser('Alice');
		const salt = await catalogIngredientId('salt');
		const draft = await createRecipe(
			alice.id,
			recipeInput({
				title: 'Half idea',
				status: 'draft',
				baseServings: null,
				ingredients: [],
				steps: []
			})
		);
		const listId = await createList(alice.ctx, 'x');
		await expect(
			addBatch(alice.ctx, {
				listId,
				recipeId: draft,
				servings: d(2),
				clientKey: 'a',
				includeOptional: []
			})
		).rejects.toMatchObject({ status: 409 });
		const full = await createRecipe(
			alice.id,
			recipeInput({
				title: 'Bread',
				ingredients: [
					{
						position: 0,
						name: 'flour',
						ingredientId: await catalogIngredientId('bread flour'),
						amount: d('1.5'),
						unit: 'cup',
						preparation: '',
						groupName: 'Dough',
						optional: false,
						createIdentity: false
					},
					{
						position: 1,
						name: 'flaky salt',
						ingredientId: salt,
						amount: null,
						unit: null,
						preparation: 'to taste',
						groupName: 'Topping',
						optional: true,
						createIdentity: false
					},
					{
						position: 2,
						name: 'yeast',
						ingredientId: null,
						amount: d('0.333333'),
						unit: 'tsp',
						preparation: '',
						groupName: 'Dough',
						optional: false,
						createIdentity: false
					}
				]
			})
		);
		const detail = await getRecipeDetail(db, alice.id, full, alice.householdId);
		expect(detail.ingredients.map((i) => i.amount)).toEqual(['1.5', null, '0.333333']);
		expect(detail.ingredients[1].optional).toBe(true);
		expect(detail.cookable).toBe(true);
	});

	it('scaling never changes base quantities and stock indicators reflect the household', async () => {
		const alice = await createUser('Alice');
		const chicken = await catalogIngredientId('chicken breast');
		const id = await createRecipe(
			alice.id,
			recipeInput({
				ingredients: [
					{
						position: 0,
						name: 'chicken',
						ingredientId: chicken,
						amount: d(500),
						unit: 'g',
						preparation: '',
						groupName: '',
						optional: false,
						createIdentity: false
					}
				]
			})
		);
		await addStock(alice.ctx, {
			operationId: opId(),
			ingredientId: chicken,
			newIngredientName: null,
			quantity: d(1),
			unit: 'kg',
			location: '',
			expiresOn: null,
			note: ''
		});
		const detail = await getRecipeDetail(db, alice.id, id, alice.householdId);
		expect(detail.ingredients[0].stockAvailable).toBe('1000');
		expect(detail.ingredients[0].amount).toBe('500');
	});

	it('duplicating a shared recipe records attribution and becomes a private recipe of the duplicator', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
		const id = await createRecipe(
			alice.id,
			recipeInput({
				title: 'Alice dal',
				ingredients: [
					{
						position: 0,
						name: 'lentils',
						ingredientId: await catalogIngredientId('red lentils'),
						amount: d(300),
						unit: 'g',
						preparation: '',
						groupName: '',
						optional: false,
						createIdentity: false
					}
				]
			})
		);
		await setRecipeShare(alice.id, id, alice.householdId, true);
		const copy = await duplicateRecipe(bob.id, id);
		const detail = await getRecipeDetail(db, bob.id, copy, bob.householdId);
		expect(detail.isOwner).toBe(true);
		expect(detail.sourceAttribution).toContain('Alice');
		expect(detail.ingredients).toHaveLength(1);
		await expect(getRecipeDetail(db, alice.id, copy, alice.householdId)).rejects.toMatchObject({
			status: 404
		});
	});

	it('favorites are per user and search/filter/pagination are bounded', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
		const ids: string[] = [];
		for (let i = 0; i < 30; i++)
			ids.push(
				await createRecipe(
					alice.id,
					recipeInput({
						title: `Recipe ${i}`,
						tags: i % 2 ? ['quick'] : [],
						ingredients: [
							{
								position: 0,
								name: 'x',
								ingredientId: null,
								amount: null,
								unit: null,
								preparation: '',
								groupName: '',
								optional: false,
								createIdentity: false
							}
						]
					})
				)
			);
		await setRecipeShare(alice.id, ids[0], alice.householdId, true);
		await setFavorite(alice.id, ids[3], true);
		const page1 = await listRecipes(db, alice.id, parseListParams(new URL('http://x/recipes')));
		expect(page1.items).toHaveLength(24);
		expect(page1.total).toBe(30);
		expect(page1.pageCount).toBe(2);
		const quick = await listRecipes(
			db,
			alice.id,
			parseListParams(new URL('http://x/recipes?tag=quick'))
		);
		expect(quick.total).toBe(15);
		const fav = await listRecipes(
			db,
			alice.id,
			parseListParams(new URL('http://x/recipes?favorites=1'))
		);
		expect(fav.items.map((r) => r.id)).toEqual([ids[3]]);
		const bobFav = await listRecipes(
			db,
			bob.id,
			parseListParams(new URL('http://x/recipes?favorites=1'))
		);
		expect(bobFav.total).toBe(0);
		const search = await listRecipes(
			db,
			alice.id,
			parseListParams(new URL('http://x/recipes?q=recipe%202'))
		);
		expect(search.total).toBe(11);
		const capped = parseListParams(new URL('http://x/recipes?perPage=5000'));
		expect(capped.perPage).toBe(100);
	});

	it('JSON export is versioned, scoped and preserves ingredient/step data', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const id = await createRecipe(
			alice.id,
			recipeInput({
				title: 'Exportable',
				ingredients: [
					{
						position: 0,
						name: 'chicken',
						ingredientId: await catalogIngredientId('chicken breast'),
						amount: d('1.5'),
						unit: 'kg',
						preparation: 'diced',
						groupName: 'Main',
						optional: false,
						createIdentity: false
					}
				],
				steps: [
					{ position: 0, sectionTitle: 'Prep', text: 'Dice.' },
					{ position: 1, sectionTitle: '', text: 'Cook.' }
				]
			})
		);
		const out = await exportRecipes(db, alice.id, { recipeIds: [id], scope: 'all' });
		expect(out.schemaVersion).toBe(1);
		expect(out.recipes[0].ingredients[0]).toMatchObject({
			amount: '1.5',
			unit: 'kg',
			preparation: 'diced',
			group: 'Main'
		});
		expect(out.recipes[0].steps.map((s) => s.text)).toEqual(['Dice.', 'Cook.']);
		expect(out.units.some((u) => u.id === 'kg')).toBe(true);
		await expect(
			exportRecipes(db, bob.id, { recipeIds: [id], scope: 'all' })
		).rejects.toMatchObject({ status: 404 });
		const collection = await exportRecipes(db, bob.id, { scope: 'mine' });
		expect(collection.recipes).toHaveLength(0);
		await updateRecipe(alice.id, id, recipeInput({ title: 'Exportable 2', ingredients: [] }), null);
	});
});
