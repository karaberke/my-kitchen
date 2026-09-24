import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { createUser, opId, recipeInput, resetDb } from './helpers';
import {
	CATEGORIES_PER_HOUSEHOLD_MAX,
	createCategory,
	createCategoryForRecipe,
	deleteCategory,
	listCategories,
	recipeCategoryIds,
	recipeSharedWith,
	renameCategory,
	setRecipeCategory
} from '$lib/server/recipe-categories';
import {
	createRecipe,
	listRecipes,
	parseListParams,
	setFavorite,
	setRecipeArchived,
	setRecipeShare
} from '$lib/server/recipes';
import { acceptInvite, createInvite } from '$lib/server/households';

describe('recipe categories', () => {
	beforeEach(resetDb);

	it('creates, renames and deletes categories; names are trimmed and unique per household regardless of case', async () => {
		const alice = await createUser('Alice');

		const id = await createCategory(alice.ctx, '  Dinner ');
		expect(await listCategories(db, alice.householdId)).toEqual([{ id, name: 'Dinner' }]);

		await expect(createCategory(alice.ctx, 'dinner')).rejects.toMatchObject({ status: 409 });

		await renameCategory(alice.ctx, id, '  Lunch  ');
		expect(await listCategories(db, alice.householdId)).toEqual([{ id, name: 'Lunch' }]);

		const id2 = await createCategory(alice.ctx, 'Snacks');
		await deleteCategory(alice.ctx, id2);
		await expect(deleteCategory(alice.ctx, id2)).rejects.toMatchObject({ status: 404 });
		expect(await listCategories(db, alice.householdId)).toEqual([{ id, name: 'Lunch' }]);
	});

	it('membership is required to manage categories, and a category belongs to exactly one household', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const bobCat = await createCategory(bob.ctx, 'Bob Category');

		await expect(
			createCategory({ ...bob.ctx, householdId: alice.householdId }, 'Intruder')
		).rejects.toMatchObject({ status: 403 });

		await expect(renameCategory(alice.ctx, bobCat, 'Renamed')).rejects.toMatchObject({
			status: 404
		});
		await expect(deleteCategory(alice.ctx, bobCat)).rejects.toMatchObject({ status: 404 });
		await expect(setRecipeCategory(alice.ctx, opId(), bobCat, true)).rejects.toMatchObject({
			status: 404
		});
	});

	it('adding an unshared recipe to a category shares it for the owner; a non-owner cannot share it on the owner’s behalf', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const carol = await createUser('Carol');

		const cat = await createCategory(alice.ctx, 'Mains');
		const recipeId = await createRecipe(
			alice.id,
			recipeInput({ title: 'Owner recipe', ingredients: [] })
		);
		await setRecipeShare(alice.id, recipeId, alice.householdId, false);
		expect(await recipeSharedWith(db, recipeId, alice.householdId)).toBe(false);

		const result = await setRecipeCategory(alice.ctx, recipeId, cat, true);
		expect(result.sharedNow).toBe(true);
		expect(await recipeSharedWith(db, recipeId, alice.householdId)).toBe(true);
		expect(await recipeCategoryIds(db, alice.householdId, recipeId)).toEqual([cat]);

		// Alice and Bob both join Carol's household, so Alice can share into it
		// and Bob can read the next recipe there without it being shared with his own.
		await acceptInvite(alice.id, (await createInvite(db, carol.id, carol.householdId)).token);
		await acceptInvite(bob.id, (await createInvite(db, carol.id, carol.householdId)).token);

		// Bob can read this second recipe only through Carol's household, not his own.
		const recipe2 = await createRecipe(
			alice.id,
			recipeInput({ title: 'Other recipe', ingredients: [] })
		);
		await setRecipeShare(alice.id, recipe2, alice.householdId, false);
		await setRecipeShare(alice.id, recipe2, carol.householdId, true);
		const bobCat = await createCategory(bob.ctx, 'Bob Cat');

		await expect(setRecipeCategory(bob.ctx, recipe2, bobCat, true)).rejects.toMatchObject({
			status: 403
		});
		expect(await recipeSharedWith(db, recipe2, bob.householdId)).toBe(false);
		expect(await recipeCategoryIds(db, bob.householdId, recipe2)).toEqual([]);
	});

	it('unsharing a recipe removes it from its household categories by cascade', async () => {
		const alice = await createUser('Alice');
		const cat = await createCategory(alice.ctx, 'Snacks');
		const recipeId = await createRecipe(alice.id, recipeInput({ title: 'Chips', ingredients: [] }));
		await setRecipeCategory(alice.ctx, recipeId, cat, true);
		expect(await recipeCategoryIds(db, alice.householdId, recipeId)).toEqual([cat]);

		await setRecipeShare(alice.id, recipeId, alice.householdId, false);
		expect(await recipeCategoryIds(db, alice.householdId, recipeId)).toEqual([]);
	});

	it('createCategoryForRecipe is all or nothing: a forbidden share rolls back the new category', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const carol = await createUser('Carol');

		const recipeId = await createRecipe(alice.id, recipeInput({ title: 'Cake', ingredients: [] }));
		await acceptInvite(alice.id, (await createInvite(db, carol.id, carol.householdId)).token);
		await acceptInvite(bob.id, (await createInvite(db, carol.id, carol.householdId)).token);
		await setRecipeShare(alice.id, recipeId, alice.householdId, false);
		await setRecipeShare(alice.id, recipeId, carol.householdId, true);

		await expect(createCategoryForRecipe(bob.ctx, recipeId, 'New Category')).rejects.toMatchObject({
			status: 403
		});
		expect(await listCategories(db, bob.householdId)).toEqual([]);
	});

	it('a household cannot exceed the category cap even under concurrent creates', async () => {
		const alice = await createUser('Alice');
		for (let i = 0; i < CATEGORIES_PER_HOUSEHOLD_MAX - 1; i++) {
			await createCategory(alice.ctx, `Cat ${i}`);
		}
		expect(await listCategories(db, alice.householdId)).toHaveLength(
			CATEGORIES_PER_HOUSEHOLD_MAX - 1
		);

		const results = await Promise.allSettled(
			Array.from({ length: 5 }, (_, i) => createCategory(alice.ctx, `Overflow ${i}`))
		);
		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(4);
		for (const r of rejected) expect(r.reason).toMatchObject({ status: 409 });
		expect(await listCategories(db, alice.householdId)).toHaveLength(CATEGORIES_PER_HOUSEHOLD_MAX);
	});

	it('listRecipes filters by category, favorites, scope and status', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');

		const catA = await createCategory(alice.ctx, 'Category A');
		const catB = await createCategory(alice.ctx, 'Category B');

		const recipe1 = await createRecipe(alice.id, recipeInput({ title: 'R1', ingredients: [] }));
		const recipe1b = await createRecipe(alice.id, recipeInput({ title: 'R1b', ingredients: [] }));
		const recipe2 = await createRecipe(alice.id, recipeInput({ title: 'R2', ingredients: [] }));
		const recipe3 = await createRecipe(
			alice.id,
			recipeInput({ title: 'R3 draft', status: 'draft', ingredients: [] })
		);
		const recipe4 = await createRecipe(
			alice.id,
			recipeInput({ title: 'R4 archived', ingredients: [] })
		);
		await setRecipeArchived(alice.id, recipe4, true);

		await setRecipeCategory(alice.ctx, recipe1, catA, true);
		await setRecipeCategory(alice.ctx, recipe1b, catA, true);
		await setRecipeCategory(alice.ctx, recipe2, catB, true);
		await setFavorite(alice.id, recipe1, true);

		await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
		const bobRecipe = await createRecipe(bob.id, recipeInput({ title: 'Bob R', ingredients: [] }));
		await setRecipeShare(bob.id, bobRecipe, alice.householdId, true);

		async function listIds(qs: string) {
			const params = parseListParams(new URL(`http://test.local/recipes?${qs}`));
			const result = await listRecipes(db, alice.id, params, alice.householdId);
			return result.items.map((r) => r.id).sort();
		}

		expect(await listIds(`cat=${catA}&cat=${catB}&status=all`)).toEqual(
			[recipe1, recipe1b, recipe2].sort()
		);
		expect(await listIds(`cat=${catA}&favorites=1&status=all`)).toEqual([recipe1]);

		expect(await listIds('scope=mine&status=all')).toEqual(
			[recipe1, recipe1b, recipe2, recipe3, recipe4].sort()
		);
		expect(await listIds('scope=shared&status=all')).toEqual([bobRecipe]);
		expect(await listIds('scope=mine&scope=shared&status=all')).toEqual(
			[recipe1, recipe1b, recipe2, recipe3, recipe4, bobRecipe].sort()
		);
		expect(await listIds('status=all')).toEqual(
			[recipe1, recipe1b, recipe2, recipe3, recipe4, bobRecipe].sort()
		);

		expect(await listIds('')).toEqual([recipe1, recipe1b, recipe2, recipe3, bobRecipe].sort());
		expect(await listIds('status=draft')).toEqual([recipe3]);
		expect(await listIds('status=archived')).toEqual([recipe4]);
		expect(await listIds('status=draft&status=archived')).toEqual([recipe3, recipe4].sort());

		const bobCat = await createCategory(bob.ctx, 'Bob Category');
		const params = parseListParams(new URL(`http://test.local/recipes?cat=${bobCat}&status=all`));
		const otherHousehold = await listRecipes(db, alice.id, params, alice.householdId);
		expect(otherHousehold.items).toEqual([]);
		expect(otherHousehold.total).toBe(0);
	});

	it('parseListParams normalizes repeated, legacy, garbage and duplicate query values', () => {
		const uuidA = opId();
		const uuidB = opId();
		const url = (qs: string) => new URL(`http://test.local/recipes?${qs}`);

		expect(parseListParams(url(`cat=${uuidA}&cat=${uuidB}`)).categoryIds).toEqual([
			uuidA.toLowerCase(),
			uuidB.toLowerCase()
		]);
		expect(parseListParams(url(`cat=${uuidA}&cat=${uuidA}`)).categoryIds).toEqual([
			uuidA.toLowerCase()
		]);
		expect(parseListParams(url('cat=not-a-uuid')).categoryIds).toEqual([]);

		expect(parseListParams(url('scope=mine')).scope).toEqual(['mine']);
		expect(parseListParams(url('status=draft')).status).toEqual(['draft']);
		expect(parseListParams(url('status=all')).status).toBe('all');
		expect(parseListParams(url('favorites=1')).favorites).toBe(true);

		expect(parseListParams(url('scope=bogus')).scope).toEqual([]);
		expect(parseListParams(url('status=bogus')).status).toEqual([]);
	});
});
