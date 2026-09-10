import { beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { acceptInvite, createInvite, createHousehold } from '$lib/server/households';
import { addStock } from '$lib/server/pantry';
import { createCustomIngredient } from '$lib/server/ingredients';
import { createUser, d, makeChickenRecipe, opId, resetDb } from './helpers';

const run = promisify(execFile);
const script = async (args: string[]) =>
	run('node', ['--env-file=.env.test', 'scripts/delete-user.mjs', ...args], {
		cwd: process.cwd()
	});

const rows = async (q: string) =>
	(await db.execute(sql.raw(q))) as unknown as Record<string, unknown>[];

describe('scripts/delete-user.mjs', () => {
	beforeEach(resetDb);

	it('deletes a solo household, transfers a shared one, and keeps stocked ingredients', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');

		// A household they share, where Alice is the only owner.
		const shared = await createHousehold(db, alice.id, 'Shared kitchen');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, shared)).token);

		// Alice's own recipe, and a private ingredient stocked in the shared household.
		const recipeId = await makeChickenRecipe(alice, 'Roast', '400');
		const custom = await createCustomIngredient(db, alice.id, 'alice special paste');
		// Alice stocks it herself: the lot lives in the shared household, which
		// outlives her, so the ingredient is still referenced when she is deleted.
		await addStock(
			{ userId: alice.id, actorName: 'Alice', householdId: shared },
			{
				operationId: opId(),
				ingredientId: custom.id,
				newIngredientName: null,
				quantity: d(200),
				unit: 'g',
				location: '',
				expiresOn: null,
				note: ''
			}
		);

		const { stdout } = await script([alice.email, '--yes']);
		expect(stdout).toContain(`Deleted ${alice.email}`);

		// Alice is gone, and so is everything she owned.
		expect(await rows(`select 1 from "user" where email = '${alice.email}'`)).toHaveLength(0);
		expect(await rows(`select 1 from recipe where id = '${recipeId}'`)).toHaveLength(0);

		// Her personal household went with her; Bob's own and the shared one survived.
		const households = await rows(`select name from household order by name`);
		expect(households.map((h) => h.name)).toEqual(["Bob's kitchen", 'Shared kitchen']);

		// Bob now owns the shared one, so it is not left ownerless.
		const owners = await rows(
			`select u.email from household_member hm join "user" u on u.id = hm.user_id
			 where hm.household_id = '${shared}' and hm.role = 'owner'`
		);
		expect(owners.map((o) => o.email)).toEqual([bob.email]);

		// The ingredient Bob has in stock survived as a shared catalog entry.
		const ing = await rows(`select owner_user_id from ingredient where id = '${custom.id}'`);
		expect(ing).toHaveLength(1);
		expect(ing[0].owner_user_id).toBeNull();
		// And the stock lot is untouched.
		expect(await rows(`select 1 from stock_lot where ingredient_id = '${custom.id}'`)).toHaveLength(
			1
		);
	});

	it('leaves a household alone when other owners remain', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const shared = await createHousehold(db, alice.id, 'Two owners');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, shared)).token);
		await db.execute(
			sql.raw(`update household_member set role = 'owner' where user_id = '${bob.id}'`)
		);

		await script([alice.email, '--yes']);
		const owners = await rows(
			`select u.email from household_member hm join "user" u on u.id = hm.user_id
			 where hm.household_id = '${shared}'`
		);
		expect(owners.map((o) => o.email)).toEqual([bob.email]);
	});

	it('changes nothing on --dry-run and refuses an unknown address', async () => {
		const alice = await createUser('Alice');
		const { stdout } = await script([alice.email, '--dry-run']);
		expect(stdout).toContain('nothing was changed');
		expect(await rows(`select 1 from "user" where email = '${alice.email}'`)).toHaveLength(1);

		await expect(script(['nobody@example.test', '--yes'])).rejects.toMatchObject({ code: 1 });
	});
});
