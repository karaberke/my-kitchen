import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { db, type DbOrTx } from '$lib/server/db';
import { mealPlanEntries, recipes } from '$lib/server/db/schema';
import { assertMember, assertRecipeReadable } from '$lib/server/access';
import { AppError, notFound } from '$lib/server/errors';
import { lockHousehold } from '$lib/server/inventory';
import { withTransaction } from '$lib/server/operations';
import { addBatch, createList, getCurrentListId } from '$lib/server/grocery';
import { Dec } from '$lib/shared/decimal';
import type { ActorContext } from '$lib/server/pantry';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const PLAN_DAYS = 7;

function assertIsoDate(value: string): string {
	if (!ISO_DATE.test(value)) throw new AppError(400, 'Pick a day of the week');
	const d = new Date(`${value}T00:00:00Z`);
	if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value)
		throw new AppError(400, 'Pick a day of the week');
	return value;
}

function shift(dateIso: string, days: number): string {
	const d = new Date(`${dateIso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** The Monday of the week containing this calendar date. Weeks run Monday to Sunday. */
export function mondayOf(dateIso: string): string {
	assertIsoDate(dateIso);
	const day = new Date(`${dateIso}T00:00:00Z`).getUTCDay(); // 0 = Sunday
	return shift(dateIso, day === 0 ? -6 : 1 - day);
}

/** The seven calendar dates of the week starting on this Monday. */
export function weekDates(startIso: string): string[] {
	assertIsoDate(startIso);
	return Array.from({ length: PLAN_DAYS }, (_, i) => shift(startIso, i));
}

export interface PlanEntryView {
	id: string;
	title: string;
	/** null once the recipe is gone, or for a free-text note */
	recipeId: string | null;
	prepMinutes: number | null;
	cookMinutes: number | null;
	baseServings: string | null;
	yieldNote: string;
}

export interface PlanDayView {
	date: string;
	entries: PlanEntryView[];
}

/** The week's plan, one bucket per day so empty days render as "Nothing planned". */
export async function getWeekPlan(
	dbx: DbOrTx,
	householdId: string,
	startIso: string
): Promise<PlanDayView[]> {
	const dates = weekDates(startIso);
	const rows = await dbx
		.select({
			id: mealPlanEntries.id,
			plannedOn: mealPlanEntries.plannedOn,
			title: mealPlanEntries.title,
			recipeId: mealPlanEntries.recipeId,
			prepMinutes: recipes.prepMinutes,
			cookMinutes: recipes.cookMinutes,
			baseServings: recipes.baseServings,
			yieldNote: recipes.yieldNote
		})
		.from(mealPlanEntries)
		.leftJoin(recipes, eq(recipes.id, mealPlanEntries.recipeId))
		.where(
			and(
				eq(mealPlanEntries.householdId, householdId),
				gte(mealPlanEntries.plannedOn, dates[0]),
				lte(mealPlanEntries.plannedOn, dates[dates.length - 1])
			)
		)
		.orderBy(
			asc(mealPlanEntries.plannedOn),
			asc(mealPlanEntries.createdAt),
			asc(mealPlanEntries.id)
		);

	return dates.map((date) => ({
		date,
		entries: rows
			.filter((r) => r.plannedOn === date)
			.map((r) => ({
				id: r.id,
				title: r.title,
				recipeId: r.recipeId,
				prepMinutes: r.prepMinutes,
				cookMinutes: r.cookMinutes,
				baseServings: r.baseServings,
				yieldNote: r.yieldNote ?? ''
			}))
	}));
}

export interface AddPlanEntryInput {
	plannedOn: string;
	/** a saved recipe, or a free-text title when there is no recipe */
	recipeId?: string | null;
	title?: string | null;
}

/**
 * Plan one meal. A recipe is stored with its title copied in, so the entry
 * survives the recipe being deleted later (it degrades to a note).
 */
export async function addPlanEntry(ctx: ActorContext, input: AddPlanEntryInput): Promise<string> {
	const plannedOn = assertIsoDate(input.plannedOn);
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		let title = (input.title ?? '').trim().slice(0, 120);
		let recipeId: string | null = null;
		if (input.recipeId) {
			// Only a recipe this user may read can be planned.
			await assertRecipeReadable(tx, input.recipeId, ctx.userId);
			const [full] = await tx
				.select({ title: recipes.title })
				.from(recipes)
				.where(eq(recipes.id, input.recipeId))
				.limit(1);
			recipeId = input.recipeId;
			title = full.title;
		}
		if (!title) throw new AppError(400, 'Pick a recipe, or type a meal name');
		await lockHousehold(tx, ctx.householdId, { plan: true });
		const [row] = await tx
			.insert(mealPlanEntries)
			.values({ householdId: ctx.householdId, plannedOn, recipeId, title, createdBy: ctx.userId })
			.returning({ id: mealPlanEntries.id });
		return row.id;
	});
}

export async function removePlanEntry(ctx: ActorContext, entryId: string): Promise<void> {
	await withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		await lockHousehold(tx, ctx.householdId, { plan: true });
		const [row] = await tx
			.delete(mealPlanEntries)
			.where(and(eq(mealPlanEntries.id, entryId), eq(mealPlanEntries.householdId, ctx.householdId)))
			.returning({ id: mealPlanEntries.id });
		if (!row) throw notFound('That meal is no longer planned');
	});
}

/**
 * Add every recipe planned this week to the open grocery list, at its base
 * servings. Free-text notes have nothing to shop for and are skipped.
 */
export async function planWeekToGrocery(ctx: ActorContext, startIso: string): Promise<string> {
	await assertMember(db, ctx.householdId, ctx.userId);
	const week = await getWeekPlan(db, ctx.householdId, startIso);
	const planned = week.flatMap((d) => d.entries).filter((e) => e.recipeId);
	if (!planned.length) throw new AppError(409, 'Nothing planned with a recipe attached yet');

	const existing = await getCurrentListId(db, ctx.householdId);
	const listId = existing ?? (await createList(ctx, 'This week'));

	for (const entry of planned) {
		await addBatch(ctx, {
			listId,
			recipeId: entry.recipeId!,
			servings: Dec.from(entry.baseServings ?? '4'),
			// Same week planned twice adds one batch per entry, not duplicates.
			clientKey: `plan:${entry.id}`,
			includeOptional: []
		});
	}
	return listId;
}
