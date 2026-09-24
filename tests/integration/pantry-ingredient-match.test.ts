import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { ingredients } from '$lib/server/db/schema';
import { catalogIngredientId, createUser, d, opId, resetDb } from './helpers';
import { addStock } from '$lib/server/pantry';

describe('pantry add-lot ingredient matching', () => {
	beforeEach(resetDb);

	it('links a typed name through a curated alias instead of making a private identity', async () => {
		const user = await createUser('Alice');
		const greenOnion = await catalogIngredientId('green onion');

		const { result } = await addStock(user.ctx, {
			operationId: opId(),
			ingredientId: null,
			newIngredientName: 'Scallions',
			quantity: d(1),
			unit: 'bunch',
			location: '',
			expiresOn: null,
			note: ''
		});

		expect(result.ingredientId).toBe(greenOnion);
		const mine = await db
			.select({ id: ingredients.id })
			.from(ingredients)
			.where(eq(ingredients.ownerUserId, user.id));
		expect(mine).toHaveLength(0);
	});

	it('makes a private identity for a typed name the catalog does not cover', async () => {
		const user = await createUser('Alice');
		const milk = await catalogIngredientId('milk');

		const { result } = await addStock(user.ctx, {
			operationId: opId(),
			ingredientId: null,
			newIngredientName: 'Almond milk',
			quantity: d(1),
			unit: 'l',
			location: '',
			expiresOn: null,
			note: ''
		});

		expect(result.ingredientId).not.toBe(milk);
		const [mine] = await db
			.select({ id: ingredients.id, name: ingredients.name, ownerUserId: ingredients.ownerUserId })
			.from(ingredients)
			.where(eq(ingredients.id, result.ingredientId));
		expect(mine.ownerUserId).toBe(user.id);
		expect(mine.name).toBe('Almond milk');
	});
});
