import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { catalogIngredientId, createUser, resetDb } from './helpers';
import { matchIngredientNames } from '$lib/server/ingredient-match';
import { createCustomIngredient } from '$lib/server/ingredients';

describe('matchIngredientNames', () => {
	beforeEach(resetDb);

	it('matches an exact catalog name', async () => {
		const user = await createUser('Alice');
		const sugar = await catalogIngredientId('sugar');
		const out = await matchIngredientNames(db, user.id, ['Sugar']);
		expect(out.get('Sugar')).toMatchObject({ ingredientId: sugar, matchedOn: 'name' });
	});

	it('matches through an alias', async () => {
		const user = await createUser('Alice');
		const flour = await catalogIngredientId('all-purpose flour');
		const out = await matchIngredientNames(db, user.id, ['flour']);
		expect(out.get('flour')).toMatchObject({
			ingredientId: flour,
			name: 'all-purpose flour',
			matchedOn: 'alias'
		});
	});

	it('matches after the clean-up rules', async () => {
		const user = await createUser('Alice');
		const cream = await catalogIngredientId('cream');
		const out = await matchIngredientNames(db, user.id, ['heavy cream, cold']);
		expect(out.get('heavy cream, cold')?.ingredientId).toBe(cream);
	});

	it('matches the same words in another order', async () => {
		const user = await createUser('Alice');
		const salt = await catalogIngredientId('salt');
		const out = await matchIngredientNames(db, user.id, ['sea salt (fine)']);
		expect(out.get('sea salt (fine)')?.ingredientId).toBe(salt);
	});

	it('never matches on a prefix', async () => {
		const user = await createUser('Alice');
		const out = await matchIngredientNames(db, user.id, ['chicken']);
		expect(out.get('chicken')).toBeNull();
	});

	it('gives nothing for a name that holds a choice', async () => {
		const user = await createUser('Alice');
		const out = await matchIngredientNames(db, user.id, ['sugar or honey']);
		expect(out.get('sugar or honey')).toBeNull();
	});

	it('prefers the catalog when the user owns the same name', async () => {
		const user = await createUser('Alice');
		const sugar = await catalogIngredientId('sugar');
		const mine = await createCustomIngredient(db, user.id, 'Sugar');
		const out = await matchIngredientNames(db, user.id, ['sugar']);
		expect(out.get('sugar')?.ingredientId).toBe(sugar);
		expect(mine.id).toBeDefined();
	});

	it('matches an ingredient of the user that the catalog does not hold', async () => {
		const user = await createUser('Alice');
		const boba = await createCustomIngredient(db, user.id, 'boba pearls');
		const out = await matchIngredientNames(db, user.id, ['Boba Pearls']);
		expect(out.get('Boba Pearls')?.ingredientId).toBe(boba.id);
	});

	it('never gives an ingredient that belongs to another user', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await createCustomIngredient(db, bob.id, 'bob secret spice');
		const out = await matchIngredientNames(db, alice.id, ['bob secret spice']);
		expect(out.get('bob secret spice')).toBeNull();
	});

	it('answers every name it is given, in one call', async () => {
		const user = await createUser('Alice');
		const out = await matchIngredientNames(db, user.id, ['sugar', 'sugar or honey', 'flour']);
		expect([...out.keys()]).toEqual(['sugar', 'sugar or honey', 'flour']);
	});
});
