import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	addPlanEntry,
	getWeekPlan,
	mondayOf,
	planWeekToGrocery,
	removePlanEntry,
	weekDates
} from '$lib/server/plan';
import { createInvite, acceptInvite } from '$lib/server/households';
import { deleteRecipe } from '$lib/server/recipes';
import { getListDetail, getCurrentListId } from '$lib/server/grocery';
import { households, mealPlanEntries } from '$lib/server/db/schema';
import { createUser, makeChickenRecipe, resetDb } from './helpers';

async function planRevision(householdId: string): Promise<number> {
	const [row] = await db
		.select({ n: households.planRevision })
		.from(households)
		.where(eq(households.id, householdId));
	return row.n;
}

describe('meal plan week maths', () => {
	it('starts the week on Monday and spans seven days', () => {
		// 2026-09-09 is a Wednesday.
		expect(mondayOf('2026-09-09')).toBe('2026-09-07');
		// A Monday is its own week start, a Sunday belongs to the week that just ran.
		expect(mondayOf('2026-09-07')).toBe('2026-09-07');
		expect(mondayOf('2026-09-13')).toBe('2026-09-07');
		expect(weekDates('2026-09-07')).toEqual([
			'2026-09-07',
			'2026-09-08',
			'2026-09-09',
			'2026-09-10',
			'2026-09-11',
			'2026-09-12',
			'2026-09-13'
		]);
	});

	it('crosses month and year boundaries', () => {
		expect(mondayOf('2027-01-01')).toBe('2026-12-28');
		expect(weekDates('2026-12-28')[6]).toBe('2027-01-03');
	});
});

describe('meal plan entries', () => {
	beforeEach(resetDb);

	it('plans a recipe and a free-text note, and returns them grouped by day', async () => {
		const alice = await createUser('Alice');
		const recipeId = await makeChickenRecipe(alice, 'Roast', '400');
		await addPlanEntry(alice.ctx, { plannedOn: '2026-09-07', recipeId });
		await addPlanEntry(alice.ctx, { plannedOn: '2026-09-12', title: 'Takeaway night' });

		const week = await getWeekPlan(db, alice.householdId, '2026-09-07');
		expect(week).toHaveLength(7);
		expect(week.map((d) => d.date)).toEqual(weekDates('2026-09-07'));

		const mon = week[0];
		expect(mon.entries).toHaveLength(1);
		expect(mon.entries[0].title).toBe('Roast');
		expect(mon.entries[0].recipeId).toBe(recipeId);

		const sat = week[5];
		expect(sat.entries[0].title).toBe('Takeaway night');
		expect(sat.entries[0].recipeId).toBeNull();

		// Days with nothing planned come back empty, not missing.
		expect(week[1].entries).toEqual([]);
	});

	it('keeps entries out of neighbouring weeks', async () => {
		const alice = await createUser('Alice');
		await addPlanEntry(alice.ctx, { plannedOn: '2026-09-06', title: 'Last week' });
		await addPlanEntry(alice.ctx, { plannedOn: '2026-09-14', title: 'Next week' });
		const week = await getWeekPlan(db, alice.householdId, '2026-09-07');
		expect(week.flatMap((d) => d.entries)).toEqual([]);
	});

	it('removes an entry and bumps the plan revision on every mutation', async () => {
		const alice = await createUser('Alice');
		const before = await planRevision(alice.householdId);
		const id = await addPlanEntry(alice.ctx, { plannedOn: '2026-09-07', title: 'Soup' });
		const afterAdd = await planRevision(alice.householdId);
		expect(afterAdd).toBeGreaterThan(before);

		await removePlanEntry(alice.ctx, id);
		expect(await planRevision(alice.householdId)).toBeGreaterThan(afterAdd);
		const week = await getWeekPlan(db, alice.householdId, '2026-09-07');
		expect(week.flatMap((d) => d.entries)).toEqual([]);
	});

	it('degrades a planned recipe to a note when the recipe is deleted', async () => {
		const alice = await createUser('Alice');
		const recipeId = await makeChickenRecipe(alice, 'Roast', '400');
		await addPlanEntry(alice.ctx, { plannedOn: '2026-09-07', recipeId });

		await deleteRecipe(alice.id, recipeId);

		const week = await getWeekPlan(db, alice.householdId, '2026-09-07');
		const entry = week[0].entries[0];
		expect(entry.title).toBe('Roast');
		expect(entry.recipeId).toBeNull();
	});

	it('rejects a blank note and a date outside the plan', async () => {
		const alice = await createUser('Alice');
		await expect(
			addPlanEntry(alice.ctx, { plannedOn: '2026-09-07', title: '   ' })
		).rejects.toMatchObject({ status: 400 });
		await expect(
			addPlanEntry(alice.ctx, { plannedOn: 'not-a-date', title: 'Soup' })
		).rejects.toMatchObject({ status: 400 });
	});

	it('is shared with household members and closed to everyone else', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const carol = await createUser('Carol');
		const invite = await createInvite(db, alice.id, alice.householdId);
		await acceptInvite(bob.id, invite.token);

		await addPlanEntry(alice.ctx, { plannedOn: '2026-09-07', title: 'Shared soup' });
		// Bob sees Alice's plan in the shared household.
		const asBob = await getWeekPlan(db, alice.householdId, '2026-09-07');
		expect(asBob[0].entries[0].title).toBe('Shared soup');

		const carolCtx = { ...carol.ctx, householdId: alice.householdId };
		await expect(
			addPlanEntry(carolCtx, { plannedOn: '2026-09-07', title: 'Intruder' })
		).rejects.toMatchObject({ status: 403 });
		void bob;
	});

	it('does not remove an entry belonging to another household', async () => {
		const alice = await createUser('Alice');
		const carol = await createUser('Carol');
		const id = await addPlanEntry(alice.ctx, { plannedOn: '2026-09-07', title: 'Soup' });
		await expect(removePlanEntry(carol.ctx, id)).rejects.toMatchObject({ status: 404 });
		const [still] = await db
			.select({ id: mealPlanEntries.id })
			.from(mealPlanEntries)
			.where(and(eq(mealPlanEntries.id, id)));
		expect(still.id).toBe(id);
	});
});

describe('planning a week into the grocery list', () => {
	beforeEach(resetDb);

	it('adds each planned recipe at its base servings and skips notes', async () => {
		const alice = await createUser('Alice');
		const roast = await makeChickenRecipe(alice, 'Roast', '400', 4);
		const curry = await makeChickenRecipe(alice, 'Curry', '300', 2);
		await addPlanEntry(alice.ctx, { plannedOn: '2026-09-07', recipeId: roast });
		await addPlanEntry(alice.ctx, { plannedOn: '2026-09-09', recipeId: curry });
		await addPlanEntry(alice.ctx, { plannedOn: '2026-09-10', title: 'Takeaway' });

		const listId = await planWeekToGrocery(alice.ctx, '2026-09-07');
		// With no list open beforehand, one is created and returned.
		expect(listId).toBe(await getCurrentListId(db, alice.householdId));

		const detail = await getListDetail(db, alice.householdId, listId);
		const titles = detail.batches.map((b) => b.recipeTitle).sort();
		expect(titles).toEqual(['Curry', 'Roast']);
		const roastBatch = detail.batches.find((b) => b.recipeTitle === 'Roast')!;
		expect(Number(roastBatch.servings)).toBe(4);
		const curryBatch = detail.batches.find((b) => b.recipeTitle === 'Curry')!;
		expect(Number(curryBatch.servings)).toBe(2);
	});

	it('refuses when the week has no recipe attached to anything', async () => {
		const alice = await createUser('Alice');
		await addPlanEntry(alice.ctx, { plannedOn: '2026-09-07', title: 'Takeaway' });
		await expect(planWeekToGrocery(alice.ctx, '2026-09-07')).rejects.toMatchObject({
			status: 409
		});
	});
});
