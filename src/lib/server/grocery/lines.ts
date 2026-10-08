import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '$lib/server/db';
import { groceryLines, type ListStatus } from '$lib/server/db/schema';
import { assertMember, type ActorContext } from '$lib/server/access';
import { AppError, ReviewConflict, notFound } from '$lib/server/errors';
import { assertIngredientsVisible, getIngredientMeta } from '$lib/server/ingredients';
import { lockHousehold } from '$lib/server/inventory';
import { withTransaction } from '$lib/server/operations';
import { Dec } from '$lib/shared/decimal';
import { planManualLine } from '$lib/shared/grocery-math';
import { isUnitId } from '$lib/shared/units';
import { NOTE_MAX_CHARS, cleanText } from '$lib/shared/text';
import { parseGroceryEntry } from '$lib/shared/ingredient-line';
import { lockList, bumpList } from './shared';
import { planStock, recalculateDraft } from './draft';

/** The longest name a grocery line keeps. */
export const GROCERY_LINE_NAME_MAX = 120;

export async function addManualLine(
	ctx: ActorContext,
	input: {
		listId: string;
		name: string;
		ingredientId: string | null;
		amount: Dec | null;
		unit: string | null;
		category: string;
		subtractPantry: boolean;
		note: string;
		/**
		 * The name was typed into a form: with no amount and no unit given,
		 * "400 g chopped tomatoes" is read into amount, unit and name. Text that
		 * is not that plain stays as typed.
		 */
		readTypedName?: boolean;
	}
) {
	let amount = input.amount;
	let unit = input.unit;
	let typed = input.name;
	if (input.readTypedName && amount === null && !unit) {
		const entry = parseGroceryEntry(typed);
		if (entry) ({ amount, unit, name: typed } = entry);
	}
	// A unit without an amount says nothing.
	if (!amount) unit = null;
	const name = cleanText(typed, GROCERY_LINE_NAME_MAX);
	if (!name) throw new AppError(400, 'Name the item');
	if (unit && !isUnitId(unit)) throw new AppError(400, 'Unknown unit');
	if (amount && amount.isNegative()) throw new AppError(400, 'Amount cannot be negative');
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		if (input.ingredientId) await assertIngredientsVisible(tx, ctx.userId, [input.ingredientId]);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status === 'completed') throw new AppError(409, 'This trip is completed');
		const meta = input.ingredientId ? await getIngredientMeta(tx, [input.ingredientId]) : null;
		const category = input.category || meta?.get(input.ingredientId!)?.category || 'Other';
		const [{ max }] = await tx
			.select({ max: sql<number>`coalesce(max(${groceryLines.position}), 0)` })
			.from(groceryLines)
			.where(eq(groceryLines.listId, input.listId));
		const [created] = await tx
			.insert(groceryLines)
			.values({
				listId: input.listId,
				kind: 'manual',
				ingredientId: input.ingredientId,
				name,
				category,
				unit,
				demandAmount: amount ? amount.toDb() : null,
				targetAmount: amount ? amount.toDb() : null,
				subtractPantry: input.subtractPantry,
				unresolvedReason: amount ? null : 'unknown_amount',
				note: input.note.trim().slice(0, NOTE_MAX_CHARS),
				position: max + 1
			})
			.returning({ id: groceryLines.id });
		if (list.status === 'draft')
			await recalculateDraft(tx, ctx.householdId, input.listId, pantryRevision);
		else if (input.subtractPantry && input.ingredientId && amount && unit) {
			// Shopping: explicit request to consider current stock once, now, by
			// the same rule as a draft (densities included).
			const { stock, densities } = await planStock(tx, ctx.householdId, [input.ingredientId]);
			const plan = planManualLine(
				{
					lineId: created.id,
					ingredientId: input.ingredientId,
					name,
					unit,
					requested: amount,
					subtractPantry: true
				},
				stock,
				{ densities }
			);
			await tx
				.update(groceryLines)
				.set({
					stockConsidered: plan.stockConsidered?.toDb() ?? null,
					targetAmount: plan.suggested?.toDb() ?? null,
					otherStock: plan.otherStock
				})
				.where(eq(groceryLines.id, created.id));
		}
		await bumpList(tx, input.listId);
		return { lineId: created.id };
	});
}

export interface UpdateLineInput {
	listId: string;
	lineId: string;
	expectedRevision: number;
	/** draft manual lines: requested amount; shopping lines: new remaining target */
	amount?: Dec | null;
	category?: string;
	note?: string;
	status?: 'pending' | 'handled';
	/** manual lines only */
	name?: string;
	/** manual lines only; null clears the unit */
	unit?: string | null;
	/** manual lines only; null unlinks the line from the catalog */
	ingredientId?: string | null;
}

export async function updateLine(ctx: ActorContext, input: UpdateLineInput) {
	checkLineInput(input);
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status === 'completed') throw new AppError(409, 'This trip is completed');
		const { recalculate } = await applyLineUpdate(tx, ctx, list.status, input);
		if (recalculate) await recalculateDraft(tx, ctx.householdId, input.listId, pantryRevision);
		const revision = await bumpList(tx, input.listId);
		return { listRevision: revision };
	});
}

/**
 * Save the grocery tidy changes the user kept, in one transaction with one
 * revision bump and at most one recalculation. A line changed since the
 * proposal is skipped and reported in `conflicts`; any other error saves nothing.
 */
export async function applyTidyChanges(
	ctx: ActorContext,
	listId: string,
	changes: Omit<UpdateLineInput, 'listId'>[]
): Promise<{ applied: number; conflicts: string[] }> {
	const inputs = changes.map((c) => ({ ...c, listId }));
	inputs.forEach(checkLineInput);
	return withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		const { pantryRevision } = await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, listId);
		if (list.status === 'completed') throw new AppError(409, 'This trip is completed');
		const conflicts: string[] = [];
		let applied = 0;
		let recalculate = false;
		for (const input of inputs) {
			try {
				// A ReviewConflict is thrown before this line is written, so the transaction stays usable.
				recalculate =
					(await applyLineUpdate(tx, ctx, list.status, input)).recalculate || recalculate;
				applied++;
			} catch (err) {
				if (err instanceof ReviewConflict) conflicts.push(input.lineId);
				else throw err;
			}
		}
		if (recalculate) await recalculateDraft(tx, ctx.householdId, listId, pantryRevision);
		if (applied) await bumpList(tx, listId);
		return { applied, conflicts };
	});
}

/** The checks on an `UpdateLineInput` that need no database. */
function checkLineInput(input: UpdateLineInput) {
	if (input.name !== undefined && cleanText(input.name, GROCERY_LINE_NAME_MAX) === '')
		throw new AppError(400, 'Name the item');
	if (input.unit && !isUnitId(input.unit)) throw new AppError(400, 'Unknown unit');
}

/**
 * Write one line edit inside a transaction that holds the household and list
 * locks. Returns whether the draft needs a recalculation.
 */
async function applyLineUpdate(
	tx: Tx,
	ctx: ActorContext,
	listStatus: ListStatus,
	input: UpdateLineInput
): Promise<{ recalculate: boolean }> {
	const name = input.name === undefined ? undefined : cleanText(input.name, GROCERY_LINE_NAME_MAX);
	const [line] = await tx
		.select()
		.from(groceryLines)
		.where(and(eq(groceryLines.id, input.lineId), eq(groceryLines.listId, input.listId)))
		.for('update');
	if (!line) throw notFound('Line not found');
	if (line.revision !== input.expectedRevision) {
		throw new ReviewConflict(
			'This line changed since you loaded it. Check the latest amount before editing.',
			{
				line: {
					id: line.id,
					revision: line.revision,
					targetAmount: line.targetAmount,
					purchasedAmount: line.purchasedAmount
				}
			}
		);
	}
	const identityEdit =
		name !== undefined || input.unit !== undefined || input.ingredientId !== undefined;
	if (identityEdit && line.kind !== 'manual')
		throw new AppError(409, 'Only items you added yourself can be renamed or relinked');
	const unitChanged = input.unit !== undefined && input.unit !== line.unit;
	const linkChanged = input.ingredientId !== undefined && input.ingredientId !== line.ingredientId;
	if ((unitChanged || linkChanged) && Dec.from(line.purchasedAmount).isPositive())
		throw new AppError(
			409,
			'Part of this item is already bought; its unit and link stay as they are'
		);
	if (input.ingredientId) await assertIngredientsVisible(tx, ctx.userId, [input.ingredientId]);
	const set: Partial<typeof groceryLines.$inferInsert> = {
		revision: sql`${groceryLines.revision} + 1` as never,
		updatedAt: sql`now()` as never
	};
	if (name !== undefined) set.name = name;
	if (input.unit !== undefined) set.unit = input.unit;
	if (input.ingredientId !== undefined) set.ingredientId = input.ingredientId;
	// While shopping, stock counted in the old unit or for the old item no longer applies.
	if ((unitChanged || linkChanged) && listStatus !== 'draft') set.stockConsidered = null;
	if (input.category !== undefined) set.category = input.category.trim().slice(0, 40) || 'Other';
	if (input.note !== undefined) set.note = input.note.trim().slice(0, NOTE_MAX_CHARS);
	if (input.amount !== undefined) {
		if (input.amount && input.amount.isNegative())
			throw new AppError(400, 'Amount cannot be negative');
		if (listStatus === 'draft') {
			if (line.kind !== 'manual')
				throw new AppError(
					409,
					'Recipe amounts are recalculated from the recipes; adjust servings instead'
				);
			set.demandAmount = input.amount ? input.amount.toDb() : null;
			set.targetAmount = input.amount ? input.amount.toDb() : null;
			set.unresolvedReason = input.amount ? null : 'unknown_amount';
		} else {
			// remaining-target edit: total target = credited purchases + new remaining
			const purchased = Dec.from(line.purchasedAmount);
			const newTarget = input.amount ? purchased.add(input.amount) : null;
			set.targetAmount = newTarget ? newTarget.toDb() : null;
			set.unresolvedReason = newTarget ? null : 'unknown_amount';
			if (newTarget && line.status === 'purchased' && input.amount!.isPositive())
				set.status = 'pending';
			if (newTarget && input.amount!.isZero() && line.status === 'pending')
				set.status = 'purchased';
		}
	}
	if (input.status !== undefined) set.status = input.status;
	await tx.update(groceryLines).set(set).where(eq(groceryLines.id, line.id));
	return {
		recalculate:
			listStatus === 'draft' && (input.amount !== undefined || unitChanged || linkChanged)
	};
}

export async function removeLine(ctx: ActorContext, input: { listId: string; lineId: string }) {
	await withTransaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		await lockHousehold(tx, ctx.householdId, { grocery: true });
		const list = await lockList(tx, ctx.householdId, input.listId);
		if (list.status === 'completed') throw new AppError(409, 'This trip is completed');
		const [line] = await tx
			.select({
				id: groceryLines.id,
				kind: groceryLines.kind,
				purchasedAmount: groceryLines.purchasedAmount
			})
			.from(groceryLines)
			.where(and(eq(groceryLines.id, input.lineId), eq(groceryLines.listId, input.listId)));
		if (!line) throw notFound('Line not found');
		if (line.kind !== 'manual')
			throw new AppError(
				409,
				'Recipe lines follow their batch. Mark it handled or remove the recipe from the plan.'
			);
		if (Dec.from(line.purchasedAmount).isPositive())
			throw new AppError(409, 'This line already has purchases; undo them first');
		await tx.delete(groceryLines).where(eq(groceryLines.id, line.id));
		await bumpList(tx, input.listId);
	});
}
