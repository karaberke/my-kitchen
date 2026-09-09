import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	acceptInvite,
	createInvite,
	deleteHousehold,
	ensurePersonalHousehold,
	listMemberships
} from '$lib/server/households';
import { addStock } from '$lib/server/pantry';
import { createList } from '$lib/server/grocery';
import { recipes, userPreferences } from '$lib/server/db/schema';
import { catalogIngredientId, createUser, d, makeChickenRecipe, opId, resetDb } from './helpers';

async function count(table: string, householdId: string): Promise<number> {
	const rows = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from ${sql.identifier(table)} where household_id = ${householdId}`
	);
	return rows[0].n;
}

async function householdExists(householdId: string): Promise<boolean> {
	const rows = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from household where id = ${householdId}`
	);
	return rows[0].n > 0;
}

describe('deleteHousehold', () => {
	beforeEach(resetDb);

	it('removes the household and every row scoped to it, keeps recipes, and clears active preferences', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const invite = await createInvite(db, alice.id, alice.householdId);
		await acceptInvite(bob.id, invite.token);

		const chicken = await catalogIngredientId('chicken breast');
		const recipeId = await makeChickenRecipe(alice, 'Roast', '400');
		// add_stock creates stock_lot + inventory_event + inventory_movement (movement -> lot is RESTRICT)
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
		await createList(alice.ctx, 'Weekly');

		expect(await count('stock_lot', alice.householdId)).toBeGreaterThan(0);
		expect(await count('inventory_movement', alice.householdId)).toBeGreaterThan(0);
		expect(await count('grocery_list', alice.householdId)).toBeGreaterThan(0);
		expect(await count('household_member', alice.householdId)).toBe(2);

		await deleteHousehold(alice.id, alice.householdId);

		expect(await householdExists(alice.householdId)).toBe(false);
		for (const t of [
			'household_member',
			'household_invite',
			'stock_lot',
			'inventory_event',
			'inventory_movement',
			'grocery_list'
		]) {
			expect(await count(t, alice.householdId), t).toBe(0);
		}
		// recipes are user-owned and survive
		const [recipe] = await db
			.select({ id: recipes.id })
			.from(recipes)
			.where(eq(recipes.id, recipeId));
		expect(recipe?.id).toBe(recipeId);
		// both members' active-household preference is cleared
		for (const u of [alice, bob]) {
			const [pref] = await db
				.select({ active: userPreferences.activeHouseholdId })
				.from(userPreferences)
				.where(eq(userPreferences.userId, u.id));
			expect(pref?.active ?? null).toBeNull();
		}
	});

	it('rejects a non-owner member', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const invite = await createInvite(db, alice.id, alice.householdId);
		await acceptInvite(bob.id, invite.token);

		await expect(deleteHousehold(bob.id, alice.householdId)).rejects.toMatchObject({ status: 403 });
		expect(await householdExists(alice.householdId)).toBe(true);
	});

	it('rejects a non-member', async () => {
		const alice = await createUser('Alice');
		const carol = await createUser('Carol');
		await expect(deleteHousehold(carol.id, alice.householdId)).rejects.toMatchObject({
			status: 403
		});
		expect(await householdExists(alice.householdId)).toBe(true);
	});

	it('leaves the user with no memberships; ensurePersonalHousehold then recreates one', async () => {
		const alice = await createUser('Alice');
		await deleteHousehold(alice.id, alice.householdId);
		expect(await listMemberships(db, alice.id)).toHaveLength(0);

		const fresh = await ensurePersonalHousehold(db, alice.id, alice.name);
		const memberships = await listMemberships(db, alice.id);
		expect(memberships).toHaveLength(1);
		expect(memberships[0].householdId).toBe(fresh);
		expect(memberships[0].role).toBe('owner');
		expect(fresh).not.toBe(alice.householdId);
	});
});
