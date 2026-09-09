import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Tx } from '$lib/server/db';
import {
	households,
	inventoryEvents,
	inventoryMovements,
	stockLots,
	type EventKind
} from '$lib/server/db/schema';
import { Dec } from '$lib/shared/decimal';
import { convertAmount, unitsCompatible, type Convention } from '$lib/shared/units';
import { AppError } from '$lib/server/errors';

/**
 * Lock order for every inventory transaction:
 *   1. household row (UPDATE ... bumps the revision counter and takes the lock)
 *   2. stock lots, ordered by id, FOR UPDATE
 * Keeping this order everywhere makes deadlocks impossible between app
 * transactions; the guarded UPDATE on quantity is the last line of defence.
 */
export async function lockHousehold(
	tx: Tx,
	householdId: string,
	bump: { pantry?: boolean; grocery?: boolean }
) {
	const [row] = await tx
		.update(households)
		.set({
			pantryRevision: bump.pantry
				? sql`${households.pantryRevision} + 1`
				: households.pantryRevision,
			groceryRevision: bump.grocery
				? sql`${households.groceryRevision} + 1`
				: households.groceryRevision
		})
		.where(eq(households.id, householdId))
		.returning({
			pantryRevision: households.pantryRevision,
			groceryRevision: households.groceryRevision
		});
	if (!row) throw new AppError(404, 'Household not found');
	return row;
}

export interface LockedLot {
	id: string;
	ingredientId: string;
	quantity: Dec;
	unit: string;
	location: string;
	expiresOn: string | null;
	revision: number;
}

export async function lockLots(
	tx: Tx,
	householdId: string,
	lotIds: string[]
): Promise<Map<string, LockedLot>> {
	if (!lotIds.length) return new Map();
	const ids = [...new Set(lotIds)].sort();
	const rows = await tx
		.select({
			id: stockLots.id,
			ingredientId: stockLots.ingredientId,
			quantity: stockLots.quantity,
			unit: stockLots.unit,
			location: stockLots.location,
			expiresOn: stockLots.expiresOn,
			revision: stockLots.revision
		})
		.from(stockLots)
		.where(and(eq(stockLots.householdId, householdId), inArray(stockLots.id, ids)))
		.orderBy(asc(stockLots.id))
		.for('update');
	return new Map(rows.map((r) => [r.id, { ...r, quantity: Dec.from(r.quantity) }]));
}

export interface EventInput {
	householdId: string;
	kind: EventKind;
	actorUserId: string;
	actorName: string;
	operationId?: string | null;
	summary: string;
	details?: Record<string, unknown>;
	recipeId?: string | null;
	recipeTitle?: string | null;
	recipeRevision?: number | null;
	servings?: Dec | null;
	batchId?: string | null;
	plannedServingsFulfilled?: Dec | null;
	unplannedServings?: Dec | null;
	groceryListId?: string | null;
	reversesEventId?: string | null;
}

export async function insertEvent(tx: Tx, input: EventInput): Promise<string> {
	const [row] = await tx
		.insert(inventoryEvents)
		.values({
			householdId: input.householdId,
			kind: input.kind,
			actorUserId: input.actorUserId,
			actorName: input.actorName,
			operationId: input.operationId ?? null,
			summary: input.summary,
			details: input.details ?? {},
			recipeId: input.recipeId ?? null,
			recipeTitle: input.recipeTitle ?? null,
			recipeRevision: input.recipeRevision ?? null,
			servings: input.servings ? input.servings.toDb() : null,
			batchId: input.batchId ?? null,
			plannedServingsFulfilled: input.plannedServingsFulfilled
				? input.plannedServingsFulfilled.toDb()
				: null,
			unplannedServings: input.unplannedServings ? input.unplannedServings.toDb() : null,
			groceryListId: input.groceryListId ?? null,
			reversesEventId: input.reversesEventId ?? null
		})
		.returning({ id: inventoryEvents.id });
	return row.id;
}

/**
 * Apply a signed delta to a lot with a guarded atomic update (never below
 * zero) and record the append-only movement with the resulting balance.
 */
export async function applyMovement(
	tx: Tx,
	args: {
		eventId: string;
		householdId: string;
		lotId: string;
		ingredientId: string;
		delta: Dec;
		unit: string;
	}
): Promise<Dec> {
	const [updated] = await tx
		.update(stockLots)
		.set({
			quantity: sql`${stockLots.quantity} + ${args.delta.toDb()}::numeric`,
			revision: sql`${stockLots.revision} + 1`,
			updatedAt: sql`now()`
		})
		.where(
			and(
				eq(stockLots.id, args.lotId),
				eq(stockLots.householdId, args.householdId),
				sql`${stockLots.quantity} + ${args.delta.toDb()}::numeric >= 0`
			)
		)
		.returning({ quantity: stockLots.quantity });
	if (!updated) throw new AppError(409, 'That change would take a pantry lot below zero');
	const balance = Dec.from(updated.quantity);
	await tx.insert(inventoryMovements).values({
		eventId: args.eventId,
		householdId: args.householdId,
		lotId: args.lotId,
		ingredientId: args.ingredientId,
		delta: args.delta.toDb(),
		unit: args.unit,
		balanceAfter: balance.toDb()
	});
	return balance;
}

export async function createLot(
	tx: Tx,
	args: {
		eventId: string;
		householdId: string;
		ingredientId: string;
		quantity: Dec;
		unit: string;
		location: string;
		expiresOn: string | null;
		note: string;
	}
): Promise<string> {
	if (args.quantity.isNegative()) throw new AppError(400, 'Quantity cannot be negative');
	const [lot] = await tx
		.insert(stockLots)
		.values({
			householdId: args.householdId,
			ingredientId: args.ingredientId,
			quantity: '0',
			unit: args.unit,
			location: args.location,
			expiresOn: args.expiresOn,
			note: args.note
		})
		.returning({ id: stockLots.id });
	await applyMovement(tx, {
		eventId: args.eventId,
		householdId: args.householdId,
		lotId: lot.id,
		ingredientId: args.ingredientId,
		delta: args.quantity,
		unit: args.unit
	});
	return lot.id;
}

export interface LotSuggestion {
	lotId: string;
	quantity: Dec;
	unit: string;
	location: string;
	expiresOn: string | null;
	revision: number;
	/** amount to take from this lot, in the lot's unit */
	take: Dec;
	/** the same amount expressed in the requested unit */
	takeInRequested: Dec;
}

export interface DeductionPlan {
	ingredientId: string;
	requestedUnit: string;
	requested: Dec;
	covered: Dec;
	shortfall: Dec;
	suggestions: LotSuggestion[];
	/** lots of this ingredient that could not be converted to the requested unit */
	incompatible: { lotId: string; quantity: Dec; unit: string }[];
}

/**
 * Suggest lots to deduct from: earliest expires_on first, then undated,
 * then oldest. Pure planning — nothing is written. Callers may override.
 */
export function planDeduction(
	ingredientId: string,
	requested: Dec,
	requestedUnit: string,
	lots: {
		id: string;
		ingredientId: string;
		quantity: Dec;
		unit: string;
		location: string;
		expiresOn: string | null;
		revision: number;
		createdAt?: string;
	}[],
	convention: Convention,
	gramsPerMl: Dec | null = null
): DeductionPlan {
	const candidates = lots
		.filter((l) => l.ingredientId === ingredientId && l.quantity.isPositive())
		.sort((a, b) => {
			if (a.expiresOn && b.expiresOn)
				return a.expiresOn < b.expiresOn
					? -1
					: a.expiresOn > b.expiresOn
						? 1
						: a.id < b.id
							? -1
							: 1;
			if (a.expiresOn) return -1;
			if (b.expiresOn) return 1;
			const ca = a.createdAt ?? '';
			const cb = b.createdAt ?? '';
			return ca < cb ? -1 : ca > cb ? 1 : a.id < b.id ? -1 : 1;
		});
	let remaining = requested;
	const suggestions: LotSuggestion[] = [];
	const incompatible: DeductionPlan['incompatible'] = [];
	for (const lot of candidates) {
		const compatible = unitsCompatible(lot.unit, requestedUnit);
		const opts = { gramsPerMl };
		const available = compatible
			? convertAmount(lot.quantity, lot.unit, requestedUnit, convention)
			: gramsPerMl
				? convertAmount(lot.quantity, lot.unit, requestedUnit, convention, opts)
				: null;
		if (available === null) {
			incompatible.push({ lotId: lot.id, quantity: lot.quantity, unit: lot.unit });
			continue;
		}
		if (!remaining.isPositive()) break;
		const takeRequested = Dec.min(remaining, available);
		const takeLot = takeRequested.eq(available)
			? lot.quantity
			: (convertAmount(takeRequested, requestedUnit, lot.unit, convention, opts) ?? takeRequested);
		suggestions.push({
			lotId: lot.id,
			quantity: lot.quantity,
			unit: lot.unit,
			location: lot.location,
			expiresOn: lot.expiresOn,
			revision: lot.revision,
			take: takeLot,
			takeInRequested: takeRequested
		});
		remaining = remaining.sub(takeRequested);
	}
	return {
		ingredientId,
		requestedUnit,
		requested,
		covered: requested.sub(Dec.max(Dec.zero, remaining)),
		shortfall: Dec.max(Dec.zero, remaining),
		suggestions,
		incompatible
	};
}

export async function activeLotsForIngredients(
	tx: Tx,
	householdId: string,
	ingredientIds: string[]
) {
	if (!ingredientIds.length) return [];
	const rows = await tx
		.select({
			id: stockLots.id,
			ingredientId: stockLots.ingredientId,
			quantity: stockLots.quantity,
			unit: stockLots.unit,
			location: stockLots.location,
			expiresOn: stockLots.expiresOn,
			revision: stockLots.revision,
			createdAt: stockLots.createdAt
		})
		.from(stockLots)
		.where(
			and(
				eq(stockLots.householdId, householdId),
				inArray(stockLots.ingredientId, [...new Set(ingredientIds)]),
				gt(stockLots.quantity, '0')
			)
		)
		.orderBy(asc(stockLots.id));
	return rows.map((r) => ({ ...r, quantity: Dec.from(r.quantity) }));
}
